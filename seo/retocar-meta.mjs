import Anthropic from '@anthropic-ai/sdk';
import { admin } from '../lib/admin.js';
import { consultar } from '../lib/bd.js';

const MODELO = (process.env.SEO_MODELO || 'claude-haiku-4-5-20251001').trim();
const cliente = new Anthropic(process.env.ANTHROPIC_WORKSPACE_ID ? { defaultHeaders: { 'anthropic-workspace-id': process.env.ANTHROPIC_WORKSPACE_ID } } : {});
const MAX = Number(process.argv[2]) || 5000;

const filas = await consultar(
  `select owner_id, tipo, datos from seo_contenido
    where publicado is not null and datos->>'seoDescription' !~ '[.!?»)]\\s*$'
    order by generado limit $1`, [MAX]);
console.log('a retocar:', filas.length);

async function nuevaMeta(f) {
  const d = f.datos;
  const r = await cliente.messages.create({
    model: MODELO, max_tokens: 200, temperature: 0.2,
    system: 'Redactas meta descripciones SEO en español de Colombia (sin voseo) para HORECA CENTER, mayorista de insumos para hoteles, restaurantes, cafeterías y oficinas. Respondes SOLO con la frase, sin comillas.',
    messages: [{ role: 'user', content: `Reescribe esta meta descripción para que sea UNA o dos frases completas de entre 110 y 145 caracteres (cuenta con cuidado; no puede pasar de 150), terminada en punto, conservando el sentido:\n"${d.seoDescription}"\nTítulo SEO del elemento: ${d.seoTitle}` }],
  });
  let t = r.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim().replace(/^["«]|["»]$/g, '').replace(/\s+/g, ' ');
  if (t.length > 155) { const c = t.slice(0, 152); t = c.slice(0, c.lastIndexOf(' ')).replace(/[,;:\s]+$/, '') + '.'; }
  if (!/[.!?]$/.test(t)) t += '.';
  return t;
}

let ok = 0, fallos = 0;
const cola = [...filas];
await Promise.all(Array.from({ length: 4 }, async () => {
  while (cola.length) {
    const f = cola.shift();
    try {
      const meta = await nuevaMeta(f);
      const datos = { ...f.datos, seoDescription: meta };
      const q = f.tipo === 'productos'
        ? await admin(`mutation($input: ProductInput!){ productUpdate(input:$input){ userErrors{ message } } }`, { input: { id: f.owner_id, seo: { description: meta } } })
        : await admin(`mutation($input: CollectionInput!){ collectionUpdate(input:$input){ userErrors{ message } } }`, { input: { id: f.owner_id, seo: { description: meta } } });
      const err = (q.productUpdate || q.collectionUpdate).userErrors;
      if (err.length) { fallos++; console.error('ERROR', f.owner_id, JSON.stringify(err)); continue; }
      await consultar(`update seo_contenido set datos=$2::jsonb, publicado=now() where owner_id=$1`, [f.owner_id, JSON.stringify(datos)]);
      ok++;
      console.log('ITEM', f.tipo, f.owner_id.split('/').pop(), '|', meta.length, '|', meta);
    } catch (e) { fallos++; console.error('ERROR', f.owner_id, e?.message); }
  }
}));
console.log('RESUMEN', JSON.stringify({ retocadas: ok, fallos }));
