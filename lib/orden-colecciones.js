import { admin } from './admin.js';

const CLAVE_SORT = {
  BEST_SELLING: ['BEST_SELLING', false],
  CREATED: ['CREATED', false],
  CREATED_DESC: ['CREATED', true],
  ALPHA_ASC: ['TITLE', false],
  ALPHA_DESC: ['TITLE', true],
  PRICE_ASC: ['PRICE', false],
  PRICE_DESC: ['PRICE', true],
  MANUAL: ['MANUAL', false],
};
const pausa = (ms) => new Promise((r) => setTimeout(r, ms));

async function colecciones() {
  const out = [];
  let after = null;
  do {
    const d = await admin(`query($a:String){ collections(first:100, after:$a){ nodes{ id handle sortOrder base: metafield(namespace:"horeca", key:"orden_base"){ value } } pageInfo{ hasNextPage endCursor } } }`, { a: after });
    out.push(...d.collections.nodes);
    after = d.collections.pageInfo.hasNextPage ? d.collections.pageInfo.endCursor : null;
  } while (after);
  return out;
}

async function productosEnOrden(id, sortKey, reverse) {
  const out = [];
  let after = null;
  do {
    const d = await admin(`query($id:ID!,$a:String,$k:ProductCollectionSortKeys,$r:Boolean){ collection(id:$id){ products(first:250, after:$a, sortKey:$k, reverse:$r){ nodes{ id variants(first:5){ nodes{ availableForSale } } } pageInfo{ hasNextPage endCursor } } } }`, { id, a: after, k: sortKey, r: reverse });
    const p = d.collection.products;
    for (const n of p.nodes) out.push({ id: n.id, disponible: n.variants.nodes.some((v) => v.availableForSale) });
    after = p.pageInfo.hasNextPage ? p.pageInfo.endCursor : null;
  } while (after);
  return out;
}


function movimientos(actual, objetivo) {
  const lista = [...actual];
  const moves = [];
  for (let p = 0; p < objetivo.length; p++) {
    if (lista[p] === objetivo[p]) continue;
    const i = lista.indexOf(objetivo[p], p);
    lista.splice(i, 1);
    lista.splice(p, 0, objetivo[p]);
    moves.push({ id: objetivo[p], newPosition: String(p) });
  }
  return moves;
}

async function esperarTrabajo(jobId) {
  for (let i = 0; i < 30 && jobId; i++) {
    const d = await admin(`query($id:ID!){ job(id:$id){ done } }`, { id: jobId });
    if (d.job?.done) return true;
    await pausa(1000);
  }
  return false;
}

async function ordenarUna(c) {

  const base = c.base?.value || c.sortOrder;
  const [sortKey, reverse] = CLAVE_SORT[base] || CLAVE_SORT.MANUAL;
  if (c.sortOrder !== 'MANUAL' && !c.base?.value) {
    const m = await admin(`mutation($m:[MetafieldsSetInput!]!){ metafieldsSet(metafields:$m){ userErrors{ message } } }`,
      { m: [{ ownerId: c.id, namespace: 'horeca', key: 'orden_base', type: 'single_line_text_field', value: c.sortOrder }] });
    const ue = m.metafieldsSet.userErrors;
    if (ue.length) throw new Error('no se pudo guardar el orden base: ' + ue[0].message);
  }

  const enBase = await productosEnOrden(c.id, sortKey, reverse);
  const objetivo = [...enBase.filter((p) => p.disponible), ...enBase.filter((p) => !p.disponible)].map((p) => p.id);


  let actual = objetivo;
  if (c.sortOrder === 'MANUAL') actual = (await productosEnOrden(c.id, 'MANUAL', false)).map((p) => p.id);
  else {
    const u = await admin(`mutation($c:CollectionInput!){ collectionUpdate(input:$c){ userErrors{ message } } }`, { c: { id: c.id, sortOrder: 'MANUAL' } });
    if (u.collectionUpdate.userErrors.length) throw new Error(u.collectionUpdate.userErrors[0].message);
    actual = enBase.map((p) => p.id);
  }

  const moves = movimientos(actual, objetivo);
  for (let i = 0; i < moves.length; i += 250) {
    const r = await admin(`mutation($id:ID!,$m:[MoveInput!]!){ collectionReorderProducts(id:$id, moves:$m){ job{ id } userErrors{ message } } }`, { id: c.id, m: moves.slice(i, i + 250) });
    const ue = r.collectionReorderProducts.userErrors;
    if (ue.length) throw new Error(ue[0].message);
    await esperarTrabajo(r.collectionReorderProducts.job?.id);
  }
  return { productos: enBase.length, agotados: enBase.filter((p) => !p.disponible).length, movidos: moves.length, base };
}


export async function agotadosAlFinal({ soloHandles = null } = {}) {
  const resumen = { colecciones: 0, movidos: 0, errores: [] };
  for (const c of await colecciones()) {
    if (soloHandles && !soloHandles.includes(c.handle)) continue;
    try {
      const r = await ordenarUna(c);
      resumen.colecciones += 1;
      resumen.movidos += r.movidos;
      if (r.movidos) resumen[c.handle] = r;
    } catch (e) {
      resumen.errores.push(`${c.handle}: ${e.message}`.slice(0, 200));
    }
  }
  return resumen;
}
