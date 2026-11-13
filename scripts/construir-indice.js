import fs from 'node:fs/promises';

const TIENDA = process.env.TIENDA_PUBLICA || 'horecacenter.co';

const sinPrefijo = (tags, prefijo) =>
  tags.filter((t) => t.startsWith(prefijo)).map((t) => t.slice(prefijo.length).trim());

async function descargar() {
  const productos = [];
  for (let pagina = 1; pagina <= 40; pagina++) {
    const url = `https://${TIENDA}/products.json?limit=250&page=${pagina}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`pagina ${pagina} -> HTTP ${r.status}`);
    const { products } = await r.json();
    if (!products || products.length === 0) break;
    productos.push(...products);
    process.stdout.write(`\r  descargando… ${productos.length} productos`);
  }
  process.stdout.write('\n');
  return productos;
}

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

const productos = await descargar();
const indice = productos.map(comprimir).filter(Boolean);

const censo = (clave) => {
  const m = new Map();
  for (const x of indice) {
    const vals = Array.isArray(x[clave]) ? x[clave] : [x[clave]];
    for (const v of vals) if (v) m.set(v, (m.get(v) || 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
};

await fs.mkdir('datos', { recursive: true });
await fs.writeFile('datos/catalogo.json', JSON.stringify(indice), 'utf8');

const bytes = (await fs.stat('datos/catalogo.json')).size;
console.log(`\n  ${indice.length} productos indexados  |  ${(bytes / 1024).toFixed(0)} KB`);
console.log(`  disponibles: ${indice.filter((x) => x.d).length}  |  sin familia: ${indice.filter((x) => !x.f).length}`);
console.log('\n  FAMILIAS');
for (const [k, n] of censo('f')) console.log(`    ${String(n).padStart(5)}  ${k}`);
console.log('\n  TIPOS DE CLIENTE');
for (const [k, n] of censo('c')) console.log(`    ${String(n).padStart(5)}  ${k}`);
