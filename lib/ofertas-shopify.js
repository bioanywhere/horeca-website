import { admin, configurado as adminConfigurado } from './admin.js';
import { configurado as mayasisConfigurado, productosConOfertaActiva, descuentoAplicable } from './mayasis.js';

const NS = 'horeca';
const KEY = 'oferta_mayasis';
const ACTIVO = /^(1|aplicar|si|true)$/i.test(String(process.env.OFERTAS_SHOPIFY || ''));
const MAX_CANDIDATOS = Number(process.env.OFERTAS_MAX || 400);

const pesos = (n) => String(Math.max(0, Math.round(Number(n) || 0)));

async function descuentosVigentes() {
  const candidatos = [...(await productosConOfertaActiva())].slice(0, MAX_CANDIDATOS);
  const out = new Map();
  for (const codigo of candidatos) {
    try {
      const d = await descuentoAplicable(codigo);
      if (d.tiene_oferta && d.descuento_total > 0) out.set(codigo, { desc: d.descuento_total, oferta: d.codigo_oferta });
    } catch {  }
  }
  return out;
}

async function cargarVariantes() {
  const out = new Map();
  let after = null, paginas = 0;
  do {
    const d = await admin(
      `query($after:String){
         productVariants(first:200, after:$after){
           nodes{ id sku price compareAtPrice product{ id }
             metafield(namespace:"${NS}", key:"${KEY}"){ value } }
           pageInfo{ hasNextPage endCursor } } }`,
      { after }
    );
    for (const v of d.productVariants.nodes) {
      if (!v.sku) continue;
      let meta = null;
      if (v.metafield?.value) { try { meta = JSON.parse(v.metafield.value); } catch { meta = null; } }
      out.set(v.sku.trim(), {
        sku: v.sku.trim(), variantId: v.id, productId: v.product?.id,
        price: Number(v.price) || 0, compareAt: v.compareAtPrice == null ? null : Number(v.compareAtPrice), meta,
      });
    }
    after = d.productVariants.pageInfo.hasNextPage ? d.productVariants.pageInfo.endCursor : null;
    paginas++;
  } while (after && paginas < 60);
  return out;
}

async function escribirVariante(productId, variantId, { price, compareAtPrice, meta }) {
  const r = await admin(
    `mutation($pid:ID!,$vars:[ProductVariantsBulkInput!]!){
       productVariantsBulkUpdate(productId:$pid, variants:$vars){ userErrors{ field message } } }`,
    { pid: productId, vars: [{
      id: variantId,
      price: pesos(price),
      compareAtPrice: compareAtPrice == null ? null : pesos(compareAtPrice),
      metafields: [{ namespace: NS, key: KEY, type: 'json', value: JSON.stringify(meta) }],
    }] }
  );
  const ue = r.productVariantsBulkUpdate?.userErrors || [];
  if (ue.length) throw new Error(ue.map((e) => e.message).join('; '));
}

export async function sincronizarOfertas({ soloInforme = false } = {}) {
  if (!adminConfigurado() || !mayasisConfigurado()) return { omitido: 'sin_config' };
  let descuentos;
  try { descuentos = await descuentosVigentes(); }
  catch (e) {
    if (/permiso|403|forbidden/i.test(String(e.message)) || e.estado === 403) return { omitido: 'sin_permiso_ofertas' };
    throw e;
  }
  const variantes = await cargarVariantes();
  const aplicar = [], revertir = [];
  for (const v of variantes.values()) {
    const info = descuentos.get(v.sku);
    const gestionada = v.meta && Number(v.meta.desc) > 0;
    if (info) {
      const base = gestionada ? Number(v.meta.base) || v.price : v.price;
      const nuevo = Math.max(0, Math.round(base * (1 - info.desc / 100)));
      const hayCambio = v.price !== nuevo || v.compareAt !== base || !gestionada || Number(v.meta.desc) !== info.desc;
      if (base > 0 && nuevo > 0 && hayCambio) {
        aplicar.push({ v, base, nuevo, info });
      }
    } else if (gestionada) {
      revertir.push(v);
    }
  }

  const resumen = { candidatos: descuentos.size, aplicar: aplicar.length, revertir: revertir.length };
  if (soloInforme || !ACTIVO) return { ...resumen, modo: 'informe', nota: ACTIVO ? undefined : 'OFERTAS_SHOPIFY no está en «aplicar»' };

  let aplicados = 0, revertidos = 0; const errores = [];
  for (const { v, base, nuevo, info } of aplicar) {
    try {
      await escribirVariante(v.productId, v.variantId, {
        price: nuevo, compareAtPrice: base,
        meta: { base, oferta: info.oferta, desc: info.desc, at: new Date().toISOString() },
      });
      aplicados++;
    } catch (e) { errores.push(`${v.sku}: ${e.message}`); }
  }
  for (const v of revertir) {
    const base = Number(v.meta.base) || v.compareAt || v.price;
    try {
      await escribirVariante(v.productId, v.variantId, {
        price: base, compareAtPrice: null,
        meta: { base, oferta: null, desc: 0, at: new Date().toISOString() },
      });
      revertidos++;
    } catch (e) { errores.push(`${v.sku}: ${e.message}`); }
  }
  return { ...resumen, modo: 'aplicado', aplicados, revertidos, errores: errores.slice(0, 10) };
}
