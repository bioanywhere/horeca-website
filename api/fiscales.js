import { firmaValida, selloReciente } from '../lib/firma.js';
import { admin, configurado } from '../lib/admin.js';

const ESPACIO = 'fiscal';

const CAMPOS = {
  tipo_persona: 200,
  tipo_documento: 200,
  numero_documento: 40,
  dv: 2,
  razon_social: 300,
  responsabilidad_fiscal: 200,
  correo_fe: 300,
};

export default async function handler(req, res) {
  if (!configurado()) {
    return res.status(503).json({ error: 'servicio sin configurar' });
  }
  if (!firmaValida(req.query, process.env.SHOPIFY_APP_SECRET) || !selloReciente(req.query)) {
    return res.status(403).json({ error: 'firma no valida' });
  }

  const idCliente = req.query.logged_in_customer_id;
  if (!idCliente) {

    return res.status(200).json({ sesion: false, datos: {} });
  }
  const gid = `gid://shopify/Customer/${idCliente}`;

  try {
    if (req.query.recompra) return await recompra(gid, res);
    if (req.method === 'GET') return await leer(gid, res);
    if (req.method === 'POST') return await guardar(gid, req, res);
    return res.status(405).json({ error: 'metodo no permitido' });
  } catch (e) {
    console.error('fiscales:', e.message);
    return res.status(500).json({ error: 'no se pudo completar la operacion' });
  }
}

async function recompra(gid, res) {
  const d = await admin(
    `query($id: ID!) {
       customer(id: $id) {
         orders(first: 1, sortKey: CREATED_AT, reverse: true) {
           nodes {
             name
             processedAt
             lineItems(first: 100) {
               nodes {
                 quantity
                 title
                 variant {
                   id
                   availableForSale
                   price
                   image { url }
                   product { featuredImage { url } }
                 }
               }
             }
           }
         }
       }
     }`,
    { id: gid }
  );

  const orden = d.customer?.orders?.nodes?.[0];
  if (!orden) return res.status(200).json({ sesion: true, pedido: null, items: [] });

  const items = [];
  for (const li of orden.lineItems?.nodes ?? []) {
    const vgid = li.variant?.id;
    if (!vgid) continue;
    items.push({
      variante: String(vgid).split('/').pop(),
      cantidad: li.quantity,
      titulo: li.title,
      imagen: li.variant?.image?.url || li.variant?.product?.featuredImage?.url || null,
      precio: li.variant?.price || null,
      disponible: Boolean(li.variant?.availableForSale),
    });
  }

  const permalink = items
    .filter((i) => i.disponible)
    .map((i) => `${i.variante}:${i.cantidad}`)
    .join(',');

  return res.status(200).json({
    sesion: true,
    pedido: { nombre: orden.name, fecha: orden.processedAt },
    items,
    carrito: permalink ? `/cart/${permalink}` : null,
  });
}

async function leer(gid, res) {
  const d = await admin(
    `query($id: ID!, $ns: String!) {
       customer(id: $id) { metafields(first: 10, namespace: $ns) { nodes { key value } } }
     }`,
    { id: gid, ns: ESPACIO }
  );

  const datos = {};
  for (const m of d.customer?.metafields?.nodes ?? []) {
    if (m.key in CAMPOS) datos[m.key] = m.value;
  }
  return res.status(200).json({ sesion: true, datos });
}

async function guardar(gid, req, res) {
  const cuerpo = typeof req.body === 'string' ? JSON.parse(req.body) : req.body ?? {};

  const metafields = [];
  for (const [clave, limite] of Object.entries(CAMPOS)) {
    const v = cuerpo[clave];
    if (typeof v !== 'string' || !v.trim()) continue;
    metafields.push({
      ownerId: gid,
      namespace: ESPACIO,
      key: clave,
      type: 'single_line_text_field',
      value: v.trim().slice(0, limite),
    });
  }
  if (!metafields.length) return res.status(400).json({ error: 'nada que guardar' });

  const d = await admin(
    `mutation($m: [MetafieldsSetInput!]!) {
       metafieldsSet(metafields: $m) { userErrors { field message } }
     }`,
    { m: metafields }
  );

  const errores = d.metafieldsSet?.userErrors ?? [];
  if (errores.length) {
    console.error('fiscales guardar:', JSON.stringify(errores));
    return res.status(400).json({ error: 'datos rechazados', detalle: errores });
  }
  return res.status(200).json({ ok: true, guardados: metafields.length });
}
