import { createHash } from 'node:crypto';
import { guardarIndice } from './catalogo-bd.js';
import { reemplazarIndice } from './catalogo.js';

const TIENDA = (process.env.TIENDA_PUBLICA || 'horecacenter.co').replace(/^https?:\/\//, '');

const sinPrefijo = (tags, prefijo) =>
  tags.filter((t) => t.startsWith(prefijo)).map((t) => t.slice(prefijo.length).trim());

function comprimir(p) {
  const tags = p.tags || [];
  const v = (p.variants || [])[0];
  if (!v) return null;
  return {
    v: String(v.id),
    t: p.title,
    h: p.handle,
    p: Number(v.price),
    d: v.available !== false,
    f: sinPrefijo(tags, 'Familia:')[0] || null,
    c: sinPrefijo(tags, 'Cliente:'),
    m: sinPrefijo(tags, 'Marca:')[0] || p.vendor || null,
    tp: p.product_type || null,
    s: v.sku || null,
    i: (p.images || [])[0]?.src?.split('?')[0] || null,
  };
}

async function descargar() {
  const productos = [];
  for (let pagina = 1; pagina <= 40; pagina++) {
    const url = `https://${TIENDA}/products.json?limit=250&page=${pagina}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`pagina ${pagina} -> HTTP ${r.status}`);
    const { products } = await r.json();
    if (!products || products.length === 0) break;
    productos.push(...products);
  }
  return productos;
}

let ultimaHuella = null;

export async function reconstruirCatalogo() {
  const productos = await descargar();
  const indice = productos.map(comprimir).filter(Boolean);
  if (!indice.length) throw new Error('descarga vacía: no se reemplaza el índice');

  const huella = createHash('sha1').update(JSON.stringify(indice)).digest('hex');
  const cambio = huella !== ultimaHuella;
  if (cambio) {
    await guardarIndice(indice);
    ultimaHuella = huella;
  }
  const info = reemplazarIndice(indice);
  return { total: indice.length, disponibles: info.disponibles, guardado: cambio, generado: new Date().toISOString() };
}
