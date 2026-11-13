import Anthropic from '@anthropic-ai/sdk';
import { admin } from '../lib/admin.js';
import { consultar } from '../lib/bd.js';

const MODELO = (process.env.SEO_MODELO || 'claude-haiku-4-5-20251001').trim();
const cliente = new Anthropic(process.env.ANTHROPIC_WORKSPACE_ID ? { defaultHeaders: { 'anthropic-workspace-id': process.env.ANTHROPIC_WORKSPACE_ID } } : {});

const [accion = 'muestra', tipo = 'productos', limiteArg = '10'] = process.argv.slice(2);
const LIMITE = Math.max(1, Number(limiteArg) || 10);
const PUBLICAR = accion === 'publicar';

async function asegurarTabla() {
  await consultar(`create table if not exists seo_contenido (
    owner_id text primary key, tipo text not null, datos jsonb not null,
    generado timestamptz not null default now(), publicado timestamptz)`);
}

const recortar = (t, max) => { t = String(t || '').trim(); if (t.length <= max) return t; const c = t.slice(0, max); return c.slice(0, c.lastIndexOf(' ') > max - 25 ? c.lastIndexOf(' ') : max).replace(/[,;:\s]+$/, ''); };
const limpiarHtml = (h) => String(h || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

async function pedirJson(prompt) {
  const r = await cliente.messages.create({
    model: MODELO, max_tokens: 1200, temperature: 0.3,
    system: 'Eres el redactor SEO de HORECA CENTER (Barranquilla, Colombia), distribuidor mayorista de insumos para hoteles, restaurantes, cafeterías y oficinas. Escribes en español de Colombia (tuteo o usted; NUNCA voseo: nada de «encontrás», «tenés»), claro y concreto, para compradores institucionales. NUNCA inventes especificaciones, marcas, medidas ni rendimientos que no estén en los datos. Respondes SOLO con un JSON válido, sin texto alrededor.',
    messages: [{ role: 'user', content: prompt }],
  });
  const t = r.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const m = t.match(/\{[\s\S]*\}/);
  return { json: JSON.parse(m ? m[0] : t), uso: r.usage };
}

async function generarProducto(p) {
  const pres = p.metafield?.value ? `\nPresentación (unidad de venta): ${p.metafield.value}` : '';
  const precio = p.priceRangeV2?.minVariantPrice?.amount ? `\nPrecio: $${Math.round(Number(p.priceRangeV2.minVariantPrice.amount)).toLocaleString('es-CO')} COP` : '';
  const prompt = `PRODUCTO
Título (del sistema, no lo cambies): ${p.title}
Marca: ${p.vendor || '(sin marca)'}
Categoría: ${p.productType || '(sin categoría)'}${pres}${precio}
Descripción actual: ${limpiarHtml(p.descriptionHtml).slice(0, 1500) || '(vacía)'}

Devuelve este JSON:
{
 "seoTitle": "título para Google, máximo 60 caracteres, con el producto legible (sin abreviaturas del ERP como Bco, Dh, C/m, S/m), presentación y 'Horeca Center' si cabe",
 "seoDescription": "meta descripción de 120 a 150 caracteres (cuenta los caracteres; no la cortes a la mitad): qué es, para quién (hotel/restaurante/cafetería/oficina), presentación y un motivo de compra (mayorista, envío a toda Colombia)",
 "alt": "texto alternativo de la imagen, máximo 100 caracteres, descriptivo y sin 'imagen de'",
 "faq": [ {"p": "pregunta real que haría un comprador institucional", "r": "respuesta de 1 a 3 frases, solo con datos que tengas; si el dato no está, responde cómo confirmarlo con el asesor por WhatsApp"} , {..}, {..} ]
}
Las 3 preguntas deben ser distintas: presentación/unidad de venta y rendimiento, uso o compatibilidad, y compra (mínimos, envío, factura). Nada inventado.
REGLA DE UNIDAD DE VENTA: la «Presentación (unidad de venta)» manda. Si dice «Unidad», el producto se vende por UNA unidad: no digas «x12», «paquete de 12» ni «presentación x12 unidades» aunque la referencia del ERP o la descripción mencionen un empaque del proveedor (ese número es solo cómo lo recibe la bodega). Puedes mencionar «también disponible por caja de N» solo si los datos lo dicen explícitamente.`;
  const { json, uso } = await pedirJson(prompt);
  return { datos: {
    seoTitle: recortar(json.seoTitle, 65),
    seoDescription: recortar(json.seoDescription, 155),
    alt: String(json.alt || '').slice(0, 120),
    faq: (json.faq || []).slice(0, 3).map((q) => ({ p: String(q.p || '').slice(0, 200), r: String(q.r || '').slice(0, 600) })).filter((q) => q.p && q.r),
  }, uso };
}

async function generarColeccion(c) {
  const muestra = (c.products?.nodes || []).map((p) => p.title).slice(0, 25).join('; ');
  const prompt = `COLECCIÓN de la tienda
Nombre: ${c.title}
Productos que contiene (${c.productsCount?.count ?? '?'}): ${muestra || '(sin muestra)'}
Descripción actual: ${limpiarHtml(c.descriptionHtml) || '(vacía)'}

Devuelve este JSON:
{
 "seoTitle": "máximo 60 caracteres, con la categoría y 'Horeca Center'",
 "seoDescription": "120 a 150 caracteres, frase completa",
 "descripcionHtml": "2 párrafos en HTML (<p>), 120 a 180 palabras en total: qué incluye la categoría, para qué tipo de negocio y necesidad, cómo elegir (presentaciones, rendimiento), y que se compra al por mayor con envío a toda Colombia y asesoría por WhatsApp. Sin listas de productos inventadas: solo lo que se ve en la muestra.",
 "faq": [ {"p": "...", "r": "..."}, {"p": "...", "r": "..."}, {"p": "...", "r": "..."} ]
}`;
  const { json, uso } = await pedirJson(prompt);
  return { datos: {
    seoTitle: recortar(json.seoTitle, 65),
    seoDescription: recortar(json.seoDescription, 155),
    descripcionHtml: String(json.descripcionHtml || '').slice(0, 3000),
    faq: (json.faq || []).slice(0, 3).map((q) => ({ p: String(q.p || '').slice(0, 200), r: String(q.r || '').slice(0, 600) })).filter((q) => q.p && q.r),
  }, uso };
}

async function listar(tipo, hechos) {
  const out = []; let after = null;
  while (out.length < LIMITE) {
    if (tipo === 'productos') {
      const d = await admin(`query($after:String){ products(first:50, after:$after, query:"status:active"){ nodes{ id title handle vendor productType descriptionHtml seo{ title description } priceRangeV2{ minVariantPrice{ amount } } metafield(namespace:"custom", key:"presentacion"){ value } media(first:1){ nodes{ id alt } } } pageInfo{ hasNextPage endCursor } } }`, { after });
      for (const p of d.products.nodes) if (!hechos.has(p.id) && out.length < LIMITE) out.push(p);
      after = d.products.pageInfo.hasNextPage ? d.products.pageInfo.endCursor : null;
    } else {
      const d = await admin(`query($after:String){ collections(first:50, after:$after){ nodes{ id title handle descriptionHtml seo{ title description } productsCount{ count } products(first:25){ nodes{ title } } } pageInfo{ hasNextPage endCursor } } }`, { after });
      for (const c of d.collections.nodes) if (!hechos.has(c.id) && c.productsCount.count > 0 && !/^(frontpage|all)$/.test(c.handle) && out.length < LIMITE) out.push(c);
      after = d.collections.pageInfo.hasNextPage ? d.collections.pageInfo.endCursor : null;
    }
    if (!after) break;
  }
  return out;
}

async function publicarProducto(p, datos) {
  const r1 = await admin(`mutation($input: ProductInput!){ productUpdate(input:$input){ userErrors{ field message } } }`,
    { input: { id: p.id, seo: { title: datos.seoTitle, description: datos.seoDescription }, metafields: [{ namespace: 'horeca', key: 'faq', type: 'json', value: JSON.stringify(datos.faq) }] } });
  const e1 = r1.productUpdate.userErrors;
  let e2 = [];
  const media = p.media?.nodes?.[0];
  if (media && datos.alt && (!media.alt || media.alt === p.title)) {
    const r2 = await admin(`mutation($id: ID!, $media: [UpdateMediaInput!]!){ productUpdateMedia(productId:$id, media:$media){ mediaUserErrors{ message } } }`, { id: p.id, media: [{ id: media.id, alt: datos.alt }] });
    e2 = r2.productUpdateMedia.mediaUserErrors;
  }
  return [...e1, ...e2];
}

async function publicarColeccion(c, datos) {
  const r = await admin(`mutation($input: CollectionInput!){ collectionUpdate(input:$input){ userErrors{ field message } } }`,
    { input: { id: c.id, descriptionHtml: datos.descripcionHtml, seo: { title: datos.seoTitle, description: datos.seoDescription }, metafields: [{ namespace: 'horeca', key: 'faq', type: 'json', value: JSON.stringify(datos.faq) }] } });
  return r.collectionUpdate.userErrors;
}

await asegurarTabla();
const hechos = new Set((await consultar(`select owner_id from seo_contenido where publicado is not null`)).map((f) => f.owner_id));
const items = await listar(tipo, hechos);
let tokens = { in: 0, out: 0 }, ok = 0, fallos = 0;
const CONCURRENCIA = Math.max(1, Number(process.env.SEO_CONCURRENCIA) || 4);
const cola = [...items];
async function procesar(it) {
  try {
    const { datos, uso } = tipo === 'productos' ? await generarProducto(it) : await generarColeccion(it);
    tokens.in += uso.input_tokens; tokens.out += uso.output_tokens;
    if (PUBLICAR) {
      const errores = tipo === 'productos' ? await publicarProducto(it, datos) : await publicarColeccion(it, datos);
      if (errores.length) { fallos++; console.error('ERROR', it.handle, JSON.stringify(errores)); return; }
      await consultar(`insert into seo_contenido (owner_id, tipo, datos, publicado) values ($1,$2,$3::jsonb, now()) on conflict (owner_id) do update set datos=excluded.datos, publicado=now()`, [it.id, tipo, JSON.stringify(datos)]);
    }
    ok++;
    console.log('ITEM ' + JSON.stringify({ handle: it.handle, titulo: it.title, ...datos }));
  } catch (e) {
    fallos++; console.error('ERROR', it.handle, e?.message);
  }
}
await Promise.all(Array.from({ length: CONCURRENCIA }, async () => { while (cola.length) await procesar(cola.shift()); }));
console.log('RESUMEN ' + JSON.stringify({ accion, tipo, ok, fallos, tokens, costoAproxUSD: Number(((tokens.in / 1e6) * 1 + (tokens.out / 1e6) * 5).toFixed(3)) }));
