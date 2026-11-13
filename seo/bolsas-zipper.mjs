import { admin } from '../lib/admin.js';
import { consultar } from '../lib/bd.js';

const APLICAR = process.argv[2] === 'aplicar';
let after = null; const hits = [];
do {
  const d = await admin(`query($a:String){ products(first:250, after:$a, query:"status:active"){ nodes{ id title handle descriptionHtml metafield(namespace:"custom",key:"presentacion"){ value } } pageInfo{ hasNextPage endCursor } } }`, { a: after });
  for (const p of d.products.nodes) {
    const m = p.title.match(/^\s*bolsa\s+zipper\s+(\d+)\s?L\s?x\s?(\d+)\s?[LA]\b/i);
    if (m) hits.push({ ...p, largo: Number(m[1]), ancho: Number(m[2]) });
  }
  after = d.products.pageInfo.hasNextPage ? d.products.pageInfo.endCursor : null;
} while (after);
console.log('bolsas zipper con notación L x A:', hits.length);

let ok = 0;
for (const p of hits) {
  const titulo = `Bolsa Zipper ${p.largo} x ${p.ancho} cm x100`;
  const presentacion = `Paquete x 100 · ${p.largo} cm de largo x ${p.ancho} cm de ancho`;
  const medida = `${p.largo} cm de largo x ${p.ancho} cm de ancho`;
  let h = String(p.descriptionHtml || '');
  h = h.split(p.title.trim()).join(titulo)
    .replace(/(<strong>)?medida:(<\/strong>)?\s*[^<]*?(?=<\/li>|<\/p>|$)/i, `$1Medida:$2 ${medida} (largo x ancho)`)
    .replace(/(<strong>)?Empaque:(<\/strong>)?\s*[^<]*?(?=<\/li>|<\/p>|$)/i, `$1Empaque:$2 Paquete x 100 unidades`);
  console.log(APLICAR ? 'OK' : 'PLAN', p.handle, '|', p.title, '→', titulo, '|', presentacion);
  if (!APLICAR) continue;
  const r = await admin(`mutation($input: ProductInput!){ productUpdate(input:$input){ userErrors{ field message } } }`, {
    input: { id: p.id, title: titulo, descriptionHtml: h, metafields: [{ namespace: 'custom', key: 'presentacion', type: 'single_line_text_field', value: presentacion }] } });
  if (r.productUpdate.userErrors.length) { console.error('ERROR', p.handle, JSON.stringify(r.productUpdate.userErrors)); continue; }
  await consultar(`delete from seo_contenido where owner_id = $1`, [p.id]).catch(() => {});
  ok++;
}
console.log('RESUMEN', JSON.stringify({ encontradas: hits.length, aplicadas: ok }));
