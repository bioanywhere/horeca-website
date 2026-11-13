import fs from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { admin } from '../lib/admin.js';
import { consultar } from '../lib/bd.js';

const MODELO = (process.env.SEO_MODELO || 'claude-haiku-4-5-20251001').trim();
const cliente = new Anthropic(process.env.ANTHROPIC_WORKSPACE_ID ? { defaultHeaders: { 'anthropic-workspace-id': process.env.ANTHROPIC_WORKSPACE_ID } } : {});
const [accion, ruta] = process.argv.slice(2);
const limpiarHtml = (h) => String(h || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

async function juzgar(p) {
  const r = await cliente.messages.create({
    model: MODELO, max_tokens: 900, ...(/haiku/i.test(MODELO) ? { temperature: 0 } : {}),
    system: 'Eres el jefe de catálogo de HORECA CENTER, distribuidor mayorista en Colombia. Conoces precios típicos del mercado colombiano de insumos para hoteles y restaurantes. Respondes SOLO con JSON válido.',
    messages: [{ role: 'user', content: `Este producto tiene en el título un número de unidades. Decide si el PRECIO corresponde a UNA sola unidad (y el número es solo el empaque del proveedor) o si de verdad se vende el paquete completo.

MÉTODO: calcula precio ÷ N y compáralo con lo que cuesta UNA unidad de ese producto en Colombia (2026, canal institucional). Si precio ÷ N queda muy por debajo de cualquier precio unitario posible, la venta es UNITARIA y N es el empaque. Referencias de precio unitario: escoba o cepillo sin mango $4.000–$9.000; trapero/mecha sin mango $5.000–$12.000; rastrillo/sacaagua sin mango $5.000–$9.000; carpeta legajadora $2.000–$4.000; gancho de ropa $1.200–$3.000; capa de lluvia desechable $3.000–$8.000; gorro de malla desechable $300–$800; guante desechable $150–$300 (caja x100 = $15.000–$30.000); tapabocas $100–$200 (caja x50 = $5.000–$9.000); palo mezclador de madera $10–$20 (paquete x500 = $4.000–$8.000); paño abrasivo $300–$600; portacomida desechable $900–$1.500; rollo de toalla 150 m $40.000–$60.000; papel higiénico institucional: se vende por paquete/rollo, «x250» suele ser hojas. Ejemplos: «Escoba x 12 unds» a $6.100 → UNITARIA (una escoba vale eso; 12 escobas no pueden valer $6.100). «Guante x100» a $21.900 → PAQUETE (un guante no vale $21.900).

Título: ${p.titulo}
Precio de venta: $${p.precio.toLocaleString('es-CO')} COP
Presentación (metacampo): ${p.presentacion || '(vacía)'}
Tipo: ${p.tipo || '(sin tipo)'} · Marca: ${p.marca || '(sin marca)'}
Descripción: ${limpiarHtml(p.descripcion).slice(0, 700) || '(vacía)'}

Devuelve: {"unitario": true|false, "confianza": 0..1, "motivo": "máximo 12 palabras", "tituloNuevo": "título sin el multiplicador si es unitario (conserva marca, medida y color; sin 'und'/'unds' sueltos; mismo estilo de mayúsculas que el original); si no es unitario, el título original tal cual", "presentacion": "texto corto de la unidad de venta, p. ej. 'Unidad' o 'Paquete x 100'"}` }],
  });
  const t = r.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return JSON.parse((t.match(/\{[\s\S]*\}/) || [t])[0]);
}

async function candidatos() {
  const reUnd = /\b\d*\s?(unid(ad(es)?)?|unds?)\b|\bund\./i;
  const reX = /\bx\s?(\d{2,})\b(?!\s?(gr?s?|grs|g|ml|cc|cm3|cm|lt|lts|l|litros?|oz|onz|mts?|m|kg|kilo|yds?|yardas|mm|pulg|w|v)\b)/i;
  const out = []; let after = null;
  do {
    const d = await admin(`query($after:String){ products(first:250, after:$after, query:"status:active"){ nodes{ id title handle vendor productType metafield(namespace:"custom", key:"presentacion"){ value } variants(first:1){ nodes{ sku price } } } pageInfo{ hasNextPage endCursor } } }`, { after });
    for (const p of d.products.nodes) {
      if (reUnd.test(p.title) || reX.test(p.title)) {
        const v = p.variants.nodes[0] || {};
        out.push({ id: p.id, titulo: p.title, handle: p.handle, sku: v.sku || '', precio: Number(v.price || 0), presentacion: p.metafield?.value || '', tipo: p.productType || '', marca: p.vendor || '' });
      }
    }
    after = d.products.pageInfo.hasNextPage ? d.products.pageInfo.endCursor : null;
  } while (after);
  return out;
}

if (accion === 'juzgar') {
  const cand = ruta ? JSON.parse(fs.readFileSync(ruta, 'utf8')) : await candidatos();
  console.log('candidatos:', cand.length);

  const porHandle = new Map();
  for (let i = 0; i < cand.length; i += 40) {
    const q = cand.slice(i, i + 40).map((c) => `handle:${c.handle}`).join(' OR ');
    const d = await admin(`query($q:String!){ products(first:50, query:$q){ nodes{ id handle descriptionHtml seo{ title description } metafield(namespace:"horeca", key:"faq"){ value } } } }`, { q });
    for (const n of d.products.nodes) porHandle.set(n.handle, n);
  }
  const out = []; const cola = [...cand];
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (cola.length) {
      const c = cola.shift(); const sh = porHandle.get(c.handle);
      try {
        const j = await juzgar({ ...c, descripcion: sh?.descriptionHtml });
        out.push({ ...c, id: sh?.id, ...j });
        console.log('ITEM', j.unitario ? 'UNITARIO' : 'paquete ', (j.confianza * 100).toFixed(0) + '%', '|', c.titulo, '→', j.tituloNuevo, '|', j.motivo);
      } catch (e) { console.error('ERROR', c.handle, e.message); }
    }
  }));
  fs.writeFileSync('/tmp/decisiones.json', JSON.stringify(out));
  console.log('RESUMEN', JSON.stringify({ total: out.length, unitarios: out.filter((x) => x.unitario).length, unitariosSeguros: out.filter((x) => x.unitario && x.confianza >= 0.8).length }));
}

if (accion === 'retocar') {
  const dec = JSON.parse(fs.readFileSync(ruta, 'utf8')).filter((x) => x.unitario && x.confianza >= 0.8 && x.id && x.tituloNuevo && x.tituloNuevo !== x.titulo);
  let ok = 0;
  for (const x of dec) {
    const d = await admin(`query($id:ID!){ product(id:$id){ descriptionHtml } }`, { id: x.id });
    let h = String(d.product?.descriptionHtml || '');

    const nueva = h
      .replace(/(<strong>)?Empaque:(<\/strong>)?\s*x?\s?(\d+)\s?(unidades|unds?|und\.)/gi, '$1Venta:$2 por unidad · empaque del proveedor de $3 unidades')
      .replace(/(<strong>)?Presentación:(<\/strong>)?\s*x?\s?(\d+)\s?(unidades|unds?)/gi, '$1Presentación:$2 unidad (empaque del proveedor de $3 unidades)');
    if (nueva !== h) {
      const r = await admin(`mutation($input: ProductInput!){ productUpdate(input:$input){ userErrors{ message } } }`, { input: { id: x.id, descriptionHtml: nueva } });
      if (r.productUpdate.userErrors.length) { console.error('ERROR', x.handle, JSON.stringify(r.productUpdate.userErrors)); continue; }
    }
    if (process.env.REGENERAR === '1') await consultar(`delete from seo_contenido where owner_id = $1`, [x.id]).catch(() => {});
    ok++; console.log('OK', x.handle, nueva !== h ? '(descripción ajustada)' : '(sin cambio en descripción)');
  }
  console.log('RESUMEN', JSON.stringify({ retocados: ok }));
}

if (accion === 'aplicar') {
  const dec = JSON.parse(fs.readFileSync(ruta, 'utf8')).filter((x) => x.unitario && x.confianza >= 0.8 && x.id && x.tituloNuevo && x.tituloNuevo !== x.titulo);
  let ok = 0, fallos = 0;
  for (const x of dec) {
    try {
      const d = await admin(`query($id:ID!){ product(id:$id){ descriptionHtml seo{ title description } } }`, { id: x.id });
      const p = d.product;
      const viejo = x.titulo.trim();
      const esc = viejo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

      const descripcion = String(p.descriptionHtml || '').split(viejo).join(x.tituloNuevo);
      const r = await admin(`mutation($input: ProductInput!){ productUpdate(input:$input){ userErrors{ field message } } }`, {
        input: { id: x.id, title: x.tituloNuevo, descriptionHtml: descripcion,
          metafields: [{ namespace: 'custom', key: 'presentacion', type: 'single_line_text_field', value: x.presentacion || 'Unidad' }] } });
      const err = r.productUpdate.userErrors;
      if (err.length) { fallos++; console.error('ERROR', x.handle, JSON.stringify(err)); continue; }

      await consultar(`delete from seo_contenido where owner_id = $1`, [x.id]).catch(() => {});
      ok++; console.log('OK', x.handle, '|', viejo, '→', x.tituloNuevo, '|', x.presentacion);
    } catch (e) { fallos++; console.error('ERROR', x.handle, e.message); }
  }
  console.log('RESUMEN', JSON.stringify({ aplicados: ok, fallos, candidatos: dec.length }));
}
