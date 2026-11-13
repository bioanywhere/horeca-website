import Anthropic from '@anthropic-ai/sdk';
import { consultar, unaFila, hayBaseDeDatos } from './bd.js';
import { porHandle, buscarProductos } from './catalogo.js';

const SERPAPI_KEY = (process.env.SERPAPI_KEY || '').trim();
const ML_ID = (process.env.ML_CLIENT_ID || '').trim();
const ML_SECRET = (process.env.ML_CLIENT_SECRET || '').trim();
const FRESCO_HORAS = Number(process.env.PRECIOS_FRESCO_HORAS || 24);
const MAX_DIAS = Number(process.env.PRECIOS_MAX_DIAS || 7);
const CONFIANZA_MIN = Number(process.env.PRECIOS_CONFIANZA_MIN || 85);
const MODELO_JUEZ = process.env.PRECIOS_MODELO || 'claude-haiku-4-5-20251001';

export const fuentesConfiguradas = () => ({ google_shopping: Boolean(SERPAPI_KEY), mercadolibre: Boolean(ML_ID && ML_SECRET) });
export const hayFuentes = () => SERPAPI_KEY || (ML_ID && ML_SECRET);

const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;

const ML_POR = { ml: 1, l: 1000, lt: 1000, litro: 1000, litros: 1000, gal: 3785, galon: 3785, galón: 3785, galones: 3785, cuñete: 20000, cunete: 20000, garrafa: 20000, cc: 1 };
const G_POR = { g: 1, gr: 1, grs: 1, gramos: 1, kg: 1000, kilo: 1000, kilos: 1000, lb: 500, libra: 500, libras: 500 };
const M_POR = { m: 1, mt: 1, mts: 1, metro: 1, metros: 1, cm: 0.01 };

function num(s) {
  return Number(String(s).replace(/\./g, (m, i, all) => (/\d{3}(\D|$)/.test(all.slice(i + 1)) ? '' : '.')).replace(',', '.'));
}

export function parsearPresentacion(titulo) {
  const t = String(titulo || '').toLowerCase().replace(/\s+/g, ' ');
  const out = { cantidad: null, unidad: null, empaque: 1, texto: '' };

  let m = t.match(/(\d+(?:[.,]\d+)?)\s*(ml|cc|lt|l|litros?|gal(?:on|ón|ones)?)\b/);
  if (m) { out.cantidad = num(m[1]) * ML_POR[m[2].replace(/ó/g, 'o')] ; out.unidad = 'ml'; out.texto = m[0]; }
  else if (/\b(galon|galón)\b/.test(t)) { out.cantidad = 3785; out.unidad = 'ml'; out.texto = 'galón'; }
  else if (/\b(cuñete|cunete|garrafa)\b/.test(t)) { out.cantidad = 20000; out.unidad = 'ml'; out.texto = 'cuñete 20 L'; }

  if (!out.unidad) {
    m = t.match(/(\d+(?:[.,]\d+)?)\s*(kg|kilos?|g|gr|grs|gramos|lb|libras?)\b/);
    if (m) { out.cantidad = num(m[1]) * G_POR[m[2]]; out.unidad = 'g'; out.texto = m[0]; }
  }

  if (!out.unidad) {
    m = t.match(/(\d+(?:[.,]\d+)?)\s*(m|mt|mts|metros?)\b(?!\s*x)/);
    if (m) { out.cantidad = num(m[1]) * M_POR[m[2]]; out.unidad = 'm'; out.texto = m[0]; }
  }

  const sinCaja = t.replace(/\*\s*\d+(?:\.\d+)?/g, ' ').replace(/\b[cd]x\s*\d+\b/g, ' ');
  m = sinCaja.match(/\bpx\s*(\d+)\b/);
  if (m) out.empaque = Number(m[1]);
  else {

    const xs = [...sinCaja.matchAll(/(?<![\d.])x\s?(\d{1,5})(?!\d)(?!\s*(?:ml|l|g|kg|cm|m)\b)/g)].map((x) => Number(x[1])).filter((n) => n > 1 && n <= 10000);
    if (xs.length) out.empaque = xs[0];
  }
  if (!out.unidad) { out.unidad = 'und'; out.cantidad = out.empaque; out.texto = out.empaque > 1 ? `x${out.empaque}` : ''; }
  else if (out.empaque > 1) out.cantidad *= out.empaque;
  return out;
}

export function normalizarPrecio(precio, pres) {
  const p = Number(precio) || 0;
  if (!pres || !pres.cantidad) return { valor: p, base: 'und', etiqueta: 'por unidad' };
  switch (pres.unidad) {
    case 'ml': return { valor: (p / pres.cantidad) * 1000, base: 'L', etiqueta: 'por litro' };
    case 'g': return { valor: (p / pres.cantidad) * 1000, base: 'kg', etiqueta: 'por kilo' };
    case 'm': return { valor: p / pres.cantidad, base: 'm', etiqueta: 'por metro' };
    default:
      return pres.cantidad >= 50
        ? { valor: (p / pres.cantidad) * 100, base: '100und', etiqueta: 'por 100 unidades' }
        : { valor: p / pres.cantidad, base: 'und', etiqueta: 'por unidad' };
  }
}

const ABREV = { serv: 'servilleta', bco: 'blanco', bca: 'blanca', nat: 'natural', liq: 'líquido', ind: 'industrial', paq: 'paquete', desech: 'desechable', desinf: 'desinfectante', deterg: 'detergente', jab: 'jabón', ph: 'papel higiénico', pte: 'pegante', tte: 'transparente', 'c/t': 'con tapa', 's/t': 'sin tapa', gde: 'grande', med: 'mediano', peq: 'pequeño', neg: 'negro', bol: 'bolsa', unid: 'unidades', und: 'unidades', cja: 'caja', rll: 'rollo' };
export function consultaDesdeTitulo(titulo) {
  let t = String(titulo || '')
    .replace(/\*\d+(?:\.\d+)?\*?/g, ' ')
    .replace(/\b[pbcd]x\s*\d+(\*\d+)?\b/gi, ' ')
    .replace(/\bcal\s*[\d.]+\b/gi, ' ')
    .replace(/\b[a-z]\b/gi, ' ')
    .replace(/\s+\d{1,6}\s*$/g, ' ')
    .replace(/\b(?:ref|cod|m-|mf)[\s-]*[\w-]+\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  t = t.split(' ').map((w) => ABREV[w.toLowerCase()] || w).join(' ');
  return t.slice(0, 90);
}

export async function consultaInteligente(nuestro) {
  if (!anthropic) return null;
  try {
    const r = await anthropic.messages.create({
      model: MODELO_JUEZ,
      max_tokens: 80,
      temperature: 0,
      system: 'Conviertes nombres de productos de un ERP colombiano (abreviados, en mayúsculas, con códigos de empaque) en la consulta corta que escribiría un comprador en Google Shopping Colombia. Conserva marca, tipo de producto, presentación/tamaño y unidades por paquete si se venden así; quita códigos internos, cajas mayoristas y referencias. Responde SOLO con la consulta, sin comillas.',
      messages: [{ role: 'user', content: `Título del ERP: ${nuestro.titulo}${nuestro.marca && !/horeca/i.test(nuestro.marca) ? `\nMarca: ${nuestro.marca}` : ''}${nuestro.familia ? `\nFamilia: ${nuestro.familia}` : ''}\n\nEscribe solo la consulta de búsqueda (3 a 8 palabras, en minúsculas, sin códigos ni símbolos).` }],
    });
    const q = r.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim().split('\n')[0].replace(/^["«']|["»']$/g, '').replace(/[/|*#]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 90);
    return q && q.length > 3 ? q : null;
  } catch {
    return null;
  }
}

async function buscarGoogleShopping(q) {
  if (!SERPAPI_KEY) return [];
  const u = new URL('https://serpapi.com/search.json');

  u.search = new URLSearchParams({ engine: process.env.SERPAPI_ENGINE || 'google_shopping_light', q, gl: 'co', hl: 'es', google_domain: 'google.com.co', api_key: SERPAPI_KEY }).toString();

  const r = await fetch(u, { signal: AbortSignal.timeout(Number(process.env.SERPAPI_TIMEOUT_MS || 60000)) });
  if (!r.ok) throw new Error(`serpapi ${r.status}`);
  const j = await r.json();
  return (j.shopping_results || []).slice(0, 20).map((x) => ({
    fuente: 'google_shopping',
    vendedor: String(x.source || x.seller || 'Google Shopping').slice(0, 80),
    titulo: String(x.title || '').slice(0, 200),
    precio: Number(x.extracted_price) || num(String(x.price || '').replace(/[^\d.,]/g, '')) || 0,
    url: x.product_link || x.link || null,
    imagen: x.thumbnail || null,
  })).filter((x) => x.precio > 0 && x.titulo);
}

let mlToken = null, mlTokenExp = 0;
async function tokenML() {
  if (!ML_ID || !ML_SECRET) return null;
  if (mlToken && Date.now() < mlTokenExp) return mlToken;
  const r = await fetch('https://api.mercadolibre.com/oauth/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: ML_ID, client_secret: ML_SECRET }).toString(),
    signal: AbortSignal.timeout(10000),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.access_token) throw new Error('mercadolibre token: ' + (j.message || r.status));
  mlToken = j.access_token; mlTokenExp = Date.now() + (Number(j.expires_in || 3600) - 60) * 1000;
  return mlToken;
}
async function buscarMercadoLibre(q) {
  const tk = await tokenML();
  if (!tk) return [];
  const u = `https://api.mercadolibre.com/sites/MCO/search?q=${encodeURIComponent(q)}&limit=20`;
  const r = await fetch(u, { headers: { Authorization: `Bearer ${tk}` }, signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error(`mercadolibre ${r.status}`);
  const j = await r.json();
  return (j.results || []).slice(0, 20).map((x) => ({
    fuente: 'mercadolibre',
    vendedor: String(x.seller?.nickname || 'Mercado Libre').slice(0, 80),
    titulo: String(x.title || '').slice(0, 200),
    precio: Number(x.price) || 0,
    url: x.permalink || null,
    imagen: x.thumbnail || null,
    marca: (x.attributes || []).find((a) => a.id === 'BRAND')?.value_name || null,
  })).filter((x) => x.precio > 0 && x.titulo);
}

const CLASES = { 1: 'igual', 2: 'otra_presentacion', 3: 'equivalente', 4: 'similar' };

async function juzgar(nuestro, candidatos) {
  if (!anthropic || !candidatos.length) return candidatos.map(() => ({ clase: 4, confianza: 0, motivo: 'sin juez' }));
  const lista = candidatos.map((c, i) => `${i + 1}. [${c.fuente}] ${c.titulo} — ${c.precio} COP${c.marca ? ` — marca: ${c.marca}` : ''}`).join('\n');
  const prompt = `Eres el juez de emparejamiento de un comparador de precios de insumos HoReCa en Colombia. Decide, para cada candidato, si es comparable con NUESTRO producto.

NUESTRO PRODUCTO: «${nuestro.titulo}» — marca: ${nuestro.marca || 'no indicada'} — presentación detectada: ${nuestro.presentacion.texto || 'unidad'}${nuestro.presentacion.empaque > 1 ? ` (empaque de ${nuestro.presentacion.empaque})` : ''} — familia: ${nuestro.familia || ''}.

CANDIDATOS:
${lista}

Clases:
1 = exactamente el mismo producto (misma marca, misma referencia/tipo, misma presentación y cantidad).
2 = misma marca y mismo producto, pero otra presentación o cantidad por empaque.
3 = equivalente funcional de OTRA marca (mismo tipo de producto, misma categoría de uso y rango de calidad).
4 = similar pero NO comparable (otro uso, otra concentración/calidad, accesorio, repuesto, lote mayorista de otra escala, o no se puede saber).

Sé estricto: ante la duda, clase 4. Un «combo», «kit» o «pack de 12 galones» frente a un galón suelto es clase 2 solo si es claramente el mismo producto de la misma marca; si la marca no coincide o no se ve, no es 1 ni 2.
${/horeca/i.test(nuestro.marca || '') ? 'OJO: nuestra marca figura como «HORECA CENTER», que es genérica (puede ser marca propia o un producto sin marca en el título). Para dar clase 1 o 2 la marca REAL debe verse en NUESTRO título y coincidir con la del candidato (p. ej. «Abro» en ambos); si en nuestro título no hay marca, lo máximo es clase 3.' : ''}
En el campo «empaque» pon las unidades que se VENDEN juntas en ese candidato (un tubo = 1; «x12» = 12); no cuentes cajas mayoristas.
Para cada candidato extrae también la presentación (cantidad y unidad: ml, g, m o und) y las unidades por empaque si el título lo dice.

NUESTRA presentación de venta: el título del ERP es ambiguo («DX100 10» puede ser la caja de 100 que se vende o una caja mayorista). Nuestro precio es ${Math.round(nuestro.precio)} COP: deduce la presentación de VENTA más plausible para ese precio en Colombia (p. ej. 22.700 COP solo tiene sentido para una caja de 100 guantes, no para un guante; 5.000 COP es un tubo de pegante, no 12). Devuélvela en "nuestro".

Responde SOLO con JSON: {"nuestro":{"cantidad":100,"unidad":"und","empaque":100},"resultados":[{"i":1,"clase":1,"confianza":0-100,"motivo":"máx 12 palabras","cantidad":3785,"unidad":"ml","empaque":1}, ...]}`;
  const r = await anthropic.messages.create({ model: MODELO_JUEZ, max_tokens: 2500, temperature: 0, messages: [{ role: 'user', content: prompt }] });
  const texto = r.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const json = texto.match(/\{[\s\S]*\}/);
  let res = [];
  let mio = null;
  try { const j = JSON.parse(json ? json[0] : '{}'); res = j.resultados || []; mio = j.nuestro || null; } catch { res = []; }

  if (mio && mio.unidad && Number(mio.cantidad) > 0) {
    const cant = Number(mio.cantidad), emp = Number(mio.empaque) || 1;

    const und = mio.unidad === 'und';
    nuestro.presentacion = { cantidad: und ? cant : cant * (emp > 1 ? emp : 1), unidad: String(mio.unidad), empaque: und ? cant : emp, texto: und ? `x${cant}` : `${cant} ${mio.unidad}${emp > 1 ? ` x${emp}` : ''}`, juez: true };
  }
  return candidatos.map((c, i) => {
    const x = res.find((y) => Number(y.i) === i + 1) || {};
    let clase = [1, 2, 3, 4].includes(Number(x.clase)) ? Number(x.clase) : 4;

    if (clase <= 2 && /horeca/i.test(nuestro.marca || '')) {
      const marcaCand = String(c.marca || '').toLowerCase();
      const titNuestro = String(nuestro.titulo || '').toLowerCase();
      const comparte = marcaCand && marcaCand.split(/\s+/).some((w) => w.length > 2 && titNuestro.includes(w));
      if (!comparte) clase = 3;
    }
    const pres = x.unidad && x.cantidad ? { cantidad: Number(x.cantidad) * (Number(x.empaque) > 1 && x.unidad !== 'und' ? Number(x.empaque) : 1), unidad: String(x.unidad), empaque: Number(x.empaque) || 1, texto: `${x.cantidad} ${x.unidad}` } : parsearPresentacion(c.titulo);
    if (pres.unidad === 'und' && Number(x.empaque) > 1) { pres.cantidad = Number(x.empaque); pres.empaque = Number(x.empaque); }
    return { clase, confianza: Math.max(0, Math.min(100, Number(x.confianza) || 0)), motivo: String(x.motivo || '').slice(0, 120), presentacion: pres };
  });
}

function productoDesdeCatalogo(p) {
  return { handle: p.h, variante: String(p.v), titulo: p.t, precio: Number(p.p) || 0, marca: p.m || null, familia: p.f || null, imagen: p.i || null, disponible: Boolean(p.d) };
}

async function guardarObservaciones(nuestro, filas) {
  if (!hayBaseDeDatos) return;
  await consultar(`update comparaciones set activo = false where producto_handle = $1`, [nuestro.handle]);
  for (const f of filas) {
    await consultar(
      `insert into comparaciones (producto_handle, variante_id, fuente, vendedor, titulo_vendedor, precio, url, imagen, cantidad, unidad, empaque, precio_normalizado, base, clase, confianza, motivo, verificado_en, activo)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, now(), true)`,
      [nuestro.handle, nuestro.variante, f.fuente, f.vendedor, f.titulo, f.precio, f.url, f.imagen, f.presentacion?.cantidad ?? null, f.presentacion?.unidad ?? null, f.presentacion?.empaque ?? 1, f.normalizado?.valor ?? null, f.normalizado?.base ?? null, f.clase, f.confianza, f.motivo]
    );
  }
  await consultar(
    `insert into comparaciones_productos (producto_handle, variante_id, titulo, precio, consultas, verificado_en, error, presentacion)
     values ($1,$2,$3,$4,1, now(), null, $5::jsonb)
     on conflict (producto_handle) do update set titulo = excluded.titulo, precio = excluded.precio, verificado_en = now(), error = null, consultas = comparaciones_productos.consultas + 1, presentacion = excluded.presentacion`,
    [nuestro.handle, nuestro.variante, nuestro.titulo, nuestro.precio, nuestro.presentacion ? JSON.stringify(nuestro.presentacion) : null]
  );
}

async function leerCache(handle) {
  if (!hayBaseDeDatos) return null;
  const cab = await unaFila(`select * from comparaciones_productos where producto_handle = $1`, [handle]);
  if (!cab || !cab.verificado_en) return null;
  const filas = await consultar(`select * from comparaciones where producto_handle = $1 and activo order by precio_normalizado nulls last, precio`, [handle]);
  return { cabecera: cab, filas };
}

export async function refrescarProducto(handle) {
  const p = porHandle(handle);
  if (!p) return { ok: false, motivo: 'producto_no_existe' };
  const nuestro = { ...productoDesdeCatalogo(p), presentacion: parsearPresentacion(p.t) };
  if (!hayFuentes()) return { ok: false, motivo: 'sin_fuentes', nuestro };

  const qLimpia = consultaDesdeTitulo(p.t);
  const qModelo = await consultaInteligente(nuestro);
  const consultas = [...new Set([qModelo, qLimpia].filter(Boolean))];
  let errores = [];
  let candidatos = [];
  let consultaUsada = null;
  for (const q of consultas) {
    const [gs, ml] = await Promise.allSettled([buscarGoogleShopping(q), buscarMercadoLibre(q)]);
    errores = [gs, ml].filter((x) => x.status === 'rejected').map((x) => String(x.reason?.message || x.reason).slice(0, 120));
    candidatos = [...(gs.status === 'fulfilled' ? gs.value : []), ...(ml.status === 'fulfilled' ? ml.value : [])];
    consultaUsada = q;
    if (candidatos.length) break;
  }
  nuestro.consulta = consultaUsada;

  candidatos = candidatos.filter((c) => !/horeca\s*center|horecacenter/i.test(`${c.vendedor} ${c.url || ''}`)).slice(0, 25);

  if (!candidatos.length && errores.length && errores.length >= [SERPAPI_KEY, ML_ID && ML_SECRET].filter(Boolean).length) {
    if (hayBaseDeDatos) await consultar(`insert into comparaciones_productos (producto_handle, variante_id, titulo, precio, consultas, error) values ($1,$2,$3,$4,1,$5) on conflict (producto_handle) do update set error = excluded.error, consultas = comparaciones_productos.consultas + 1`, [handle, nuestro.variante, nuestro.titulo, nuestro.precio, ('fuentes: ' + errores.join(' | ')).slice(0, 300)]).catch(() => {});
    return { ok: false, motivo: 'fuente_no_disponible', nuestro, errores };
  }

  let juicios = [];
  if (candidatos.length) {
    try { juicios = await juzgar(nuestro, candidatos); } catch (e) {
      console.error('[precios] juez no disponible:', e?.message);
      if (hayBaseDeDatos) await consultar(`insert into comparaciones_productos (producto_handle, variante_id, titulo, precio, consultas, error) values ($1,$2,$3,$4,1,$5) on conflict (producto_handle) do update set error = excluded.error, consultas = comparaciones_productos.consultas + 1`, [handle, nuestro.variante, nuestro.titulo, nuestro.precio, ('juez: ' + (e?.message || 'error')).slice(0, 300)]).catch(() => {});
      return { ok: false, motivo: 'juez_no_disponible', nuestro, candidatos: candidatos.length };
    }
  }
  const filas = candidatos.map((c, i) => {
    const j = juicios[i];
    const normalizado = normalizarPrecio(c.precio, j.presentacion);
    return { ...c, ...j, normalizado };
  });
  try { await guardarObservaciones(nuestro, filas); } catch (e) { errores.push('bd: ' + e.message); }
  if (errores.length && hayBaseDeDatos) await consultar(`update comparaciones_productos set error = $2 where producto_handle = $1`, [handle, errores.join(' | ').slice(0, 300)]).catch(() => {});
  return { ok: true, nuestro, filas, errores };
}

export async function compararProducto(handle, { soloCache = false, forzar = false } = {}) {
  const p = porHandle(handle);
  if (!p) return { ok: false, motivo: 'producto_no_existe' };
  const nuestro = { ...productoDesdeCatalogo(p), presentacion: parsearPresentacion(p.t) };
  nuestro.normalizado = normalizarPrecio(nuestro.precio, nuestro.presentacion);

  let cache = forzar ? null : await leerCache(handle).catch(() => null);
  const edadH = cache?.cabecera?.verificado_en ? (Date.now() - new Date(cache.cabecera.verificado_en).getTime()) / 3600000 : Infinity;
  let filas, verificadoEn, estado = 'cache';

  const usarPresentacion = (pres) => {
    if (pres && pres.unidad && Number(pres.cantidad) > 0) { nuestro.presentacion = pres; nuestro.normalizado = normalizarPrecio(nuestro.precio, pres); }
  };
  if (cache?.cabecera?.presentacion) usarPresentacion(cache.cabecera.presentacion);
  if (cache && edadH <= FRESCO_HORAS) {
    filas = cache.filas; verificadoEn = cache.cabecera.verificado_en;
    if (hayBaseDeDatos) consultar(`update comparaciones_productos set consultas = consultas + 1 where producto_handle = $1`, [handle]).catch(() => {});
  } else if (soloCache && cache && edadH <= MAX_DIAS * 24) {
    filas = cache.filas; verificadoEn = cache.cabecera.verificado_en; estado = 'viejo';
  } else if (soloCache) {
    return { ok: true, nuestro, competidores: [], estado: 'pendiente', verificadoEn: null, fuentes: fuentesConfiguradas() };
  } else {
    const r = await refrescarProducto(handle);
    if (!r.ok) return { ok: true, nuestro, competidores: [], estado: r.motivo, verificadoEn: null, fuentes: fuentesConfiguradas() };
    if (r.nuestro?.presentacion?.juez) usarPresentacion(r.nuestro.presentacion);
    filas = r.filas.map((f) => ({ ...f, titulo_vendedor: f.titulo, precio_normalizado: f.normalizado.valor, base: f.normalizado.base, cantidad: f.presentacion.cantidad, unidad: f.presentacion.unidad, empaque: f.presentacion.empaque, verificado_en: new Date().toISOString() }));
    verificadoEn = new Date().toISOString(); estado = 'vivo';
    if (r.errores?.length) estado = 'vivo_parcial';
  }
  return armarRespuesta(nuestro, filas, verificadoEn, estado);
}

function armarRespuesta(nuestro, filas, verificadoEn, estado) {
  const publicables = filas
    .filter((f) => [1, 2].includes(Number(f.clase)) && Number(f.confianza) >= CONFIANZA_MIN && Number(f.precio) > 0)
    .map((f) => ({
      vendedor: f.vendedor, fuente: f.fuente, titulo: f.titulo_vendedor || f.titulo, precio: Number(f.precio), url: f.url, imagen: f.imagen,
      clase: Number(f.clase), confianza: Number(f.confianza), motivo: f.motivo,
      presentacion: { cantidad: f.cantidad != null ? Number(f.cantidad) : null, unidad: f.unidad, empaque: Number(f.empaque) || 1 },
      normalizado: f.precio_normalizado != null ? { valor: Number(f.precio_normalizado), base: f.base } : null,
      verificadoEn: f.verificado_en || verificadoEn,
    }));

  const porVendedor = new Map();
  for (const c of publicables.sort((a, b) => a.precio - b.precio)) if (!porVendedor.has(c.vendedor)) porVendedor.set(c.vendedor, c);
  const competidores = [...porVendedor.values()];

  const mismaBase = competidores.every((c) => c.normalizado && c.normalizado.base === nuestro.normalizado.base);
  const clave = (x) => (mismaBase && x.normalizado ? x.normalizado.valor : x.precio);
  const todos = [{ vendedor: 'HORECA CENTER', precio: nuestro.precio, normalizado: nuestro.normalizado, nosotros: true }, ...competidores].sort((a, b) => clave(a) - clave(b));
  const posicion = todos.findIndex((x) => x.nosotros) + 1;
  const precios = competidores.map((c) => c.precio);
  const maximo = precios.length ? Math.max(...precios) : null;
  const promedio = precios.length ? precios.reduce((a, b) => a + b, 0) / precios.length : null;
  const ahorro = maximo != null && maximo > nuestro.precio ? { pesos: Math.round(maximo - nuestro.precio), porcentaje: Math.round(((maximo - nuestro.precio) / maximo) * 100) } : null;
  const vsPromedio = promedio != null ? Math.round(((nuestro.precio - promedio) / promedio) * 100) : null;
  const clase3 = filas.filter((f) => Number(f.clase) === 3).length;
  return {
    ok: true,
    nuestro,
    competidores,
    ranking: { posicion, total: todos.length, mejorPrecio: posicion === 1 && competidores.length > 0, criterio: mismaBase ? nuestro.normalizado.etiqueta : 'precio' },
    ahorro,
    promedio: promedio != null ? { valor: Math.round(promedio), diferenciaPct: vsPromedio } : null,
    equivalentesNoMostrados: clase3,
    vendedoresConsultados: filas.length,
    verificadoEn,
    edadHoras: verificadoEn ? Math.round((Date.now() - new Date(verificadoEn).getTime()) / 3600000) : null,
    estado,
    fuentes: fuentesConfiguradas(),
  };
}

export function candidatosDeBusqueda(consulta, limite = 6) {
  return buscarProductos({ consulta, limite }).map((p) => ({ handle: p.h, titulo: p.t, precio: p.p, imagen: p.i, disponible: p.d }));
}

export async function pasarComparaciones({ limite = 60 } = {}) {
  if (!hayBaseDeDatos || !hayFuentes()) return { revisados: 0, refrescados: 0 };
  const filas = await consultar(
    `select producto_handle from comparaciones_productos
      where (verificado_en is null or verificado_en < now() - ($1 || ' hours')::interval)
      order by consultas desc, verificado_en asc nulls first limit $2`,
    [String(FRESCO_HORAS - 2), limite]
  );
  let refrescados = 0;
  for (const f of filas) {
    try { const r = await refrescarProducto(f.producto_handle); if (r.ok) refrescados++; } catch (e) { console.error('[precios] refresco falló', f.producto_handle, e?.message); }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return { revisados: filas.length, refrescados };
}

export async function resumenPrecios() {
  if (!hayBaseDeDatos) return { productos: 0, conComparacion: 0, masBaratos: 0, masCaros: 0 };
  const f = await consultar(
    `with pub as (
       select c.producto_handle, p.precio as nuestro, min(c.precio) as minimo
         from comparaciones c join comparaciones_productos p on p.producto_handle = c.producto_handle
        where c.activo and c.clase in (1,2) and c.confianza >= $1 and c.verificado_en > now() - ($2 || ' days')::interval
        group by c.producto_handle, p.precio)
     select count(*)::int as con_comparacion,
            count(*) filter (where nuestro <= minimo)::int as mas_baratos,
            count(*) filter (where nuestro > minimo)::int as mas_caros,
            (select count(*) from comparaciones_productos)::int as productos
       from pub`,
    [CONFIANZA_MIN, String(MAX_DIAS)]
  );
  const r = f[0] || {};
  return { productos: r.productos || 0, conComparacion: r.con_comparacion || 0, masBaratos: r.mas_baratos || 0, masCaros: r.mas_caros || 0 };
}
