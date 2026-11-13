import { admin, configurado } from './admin.js';

const SALUD_URL = process.env.ASESOR_SALUD_URL || 'https://horeca-asesor.vercel.app/api/salud';
const NS = 'horeca';
const KEY = 'asesor_pausado';
const AGENTE = 'HorecaCenter-Shopify/1.0';

let shopGid = null;

async function idTienda() {
  if (shopGid) return shopGid;
  const d = await admin(`{ shop { id } }`);
  shopGid = d.shop.id;
  return shopGid;
}

async function pausadoActualEnShopify() {
  const d = await admin(
    `query($ns:String!,$key:String!){ shop{ metafield(namespace:$ns, key:$key){ value } } }`,
    { ns: NS, key: KEY });
  const v = d.shop.metafield?.value;
  return v == null ? null : v === 'true';
}

async function leerPausaVercel() {
  const r = await fetch(SALUD_URL, { headers: { 'User-Agent': AGENTE, Accept: 'application/json' } });
  if (!r.ok) throw new Error(`salud HTTP ${r.status}`);
  const j = await r.json();
  return Boolean(j.pausado);
}

export async function sincronizarPausaMetafield() {
  if (!configurado()) return { omitido: 'sin_config' };
  let pausado;
  try { pausado = await leerPausaVercel(); }
  catch (e) { return { omitido: 'salud_no_disponible', detalle: e.message }; }

  let previo;
  try { previo = await pausadoActualEnShopify(); }
  catch { previo = null; }
  if (previo === pausado) return { pausado, cambiado: false };

  const gid = await idTienda();
  const r = await admin(
    `mutation($m:[MetafieldsSetInput!]!){ metafieldsSet(metafields:$m){ metafields{ id value } userErrors{ field message } } }`,
    { m: [{ ownerId: gid, namespace: NS, key: KEY, type: 'boolean', value: pausado ? 'true' : 'false' }] });
  const ue = r.metafieldsSet.userErrors || [];
  if (ue.length) return { error: JSON.stringify(ue) };
  return { pausado, cambiado: true };
}
