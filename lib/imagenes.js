export const TIPOS_PERMITIDOS = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

const DOCUMENTOS = [
  { clase: 'pdf', mimes: ['application/pdf'], ext: ['pdf'] },
  { clase: 'excel', mimes: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel', 'application/vnd.oasis.opendocument.spreadsheet'], ext: ['xlsx', 'xls', 'xlsm', 'ods'] },
  { clase: 'csv', mimes: ['text/csv', 'text/comma-separated-values'], ext: ['csv', 'tsv'] },
  { clase: 'word', mimes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'], ext: ['docx'] },
  { clase: 'texto', mimes: ['text/plain'], ext: ['txt'] },
];

export const MAX_BYTES = 4_500_000;
export const MAX_BYTES_DOC = 12_000_000;

export const MAX_IMAGENES = 3;
export const MAX_ADJUNTOS = 3;

const MAX_TEXTO_DOC = 40_000;

const normalizaTipo = (t) => {
  const s = String(t || '').toLowerCase().split(';')[0].trim();
  return s === 'image/jpg' ? 'image/jpeg' : s;
};
const extensionDe = (nombre) => (String(nombre || '').toLowerCase().match(/\.([a-z0-9]+)(?:[?#].*)?$/) || [])[1] || '';

export function clasificar(media_type, nombre = '') {
  const m = normalizaTipo(media_type);
  if (TIPOS_PERMITIDOS.has(m)) return 'imagen';
  const ext = extensionDe(nombre);
  for (const d of DOCUMENTOS) if (d.mimes.includes(m) || d.ext.includes(ext)) return d.clase;

  if (/^image\//.test(m)) return null;
  return null;
}

async function textoDeExcel(buf) {
  const XLSX = (await import('xlsx')).default ?? (await import('xlsx'));
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: true });
  const partes = [];
  for (const nombre of wb.SheetNames) {
    const hoja = wb.Sheets[nombre];
    const csv = XLSX.utils.sheet_to_csv(hoja, { blankrows: false, FS: ' | ' });
    if (csv.trim()) partes.push(`== Hoja «${nombre}» ==\n${csv.trim()}`);
  }
  return partes.join('\n\n');
}
async function textoDeWord(buf) {
  const mammoth = await import('mammoth');
  const r = await (mammoth.extractRawText ? mammoth.extractRawText({ buffer: buf }) : mammoth.default.extractRawText({ buffer: buf }));
  return String(r.value || '');
}

export async function prepararAdjunto({ clase, media_type, buffer, nombre = '' }) {
  try {
    if (clase === 'imagen') return { clase, media_type: normalizaTipo(media_type), data: buffer.toString('base64'), nombre };
    if (clase === 'pdf') return { clase, media_type: 'application/pdf', data: buffer.toString('base64'), nombre };
    let texto = '';
    if (clase === 'excel') texto = await textoDeExcel(buffer);
    else if (clase === 'word') texto = await textoDeWord(buffer);
    else texto = buffer.toString('utf8');
    texto = texto.replace(/\r/g, '').trim();
    if (!texto) return null;
    if (texto.length > MAX_TEXTO_DOC) texto = texto.slice(0, MAX_TEXTO_DOC) + '\n[… archivo recortado …]';
    return { clase, texto, nombre };
  } catch {
    return null;
  }
}

export async function validarAdjunto(entrada) {
  if (!entrada || typeof entrada !== 'object') return null;
  const media_type = normalizaTipo(entrada.tipo);
  const nombre = String(entrada.nombre || '');
  const clase = clasificar(media_type, nombre);
  if (!clase) return null;
  let data = String(entrada.datos || '');
  const coma = data.indexOf(',');
  if (data.startsWith('data:') && coma > 0) data = data.slice(coma + 1);
  data = data.replace(/\s+/g, '');
  if (!data || !/^[A-Za-z0-9+/=]+$/.test(data)) return null;
  const bytes = (data.length * 3) / 4;
  if (bytes > (clase === 'imagen' ? MAX_BYTES : MAX_BYTES)) return null;
  const buffer = Buffer.from(data, 'base64');
  return prepararAdjunto({ clase, media_type, buffer, nombre });
}

export function validarImagen(entrada) {
  if (!entrada || typeof entrada !== 'object') return null;
  const media_type = normalizaTipo(entrada.tipo);
  if (!TIPOS_PERMITIDOS.has(media_type)) return null;
  let data = String(entrada.datos || '');
  const coma = data.indexOf(',');
  if (data.startsWith('data:') && coma > 0) data = data.slice(coma + 1);
  data = data.replace(/\s+/g, '');
  if (!data || !/^[A-Za-z0-9+/=]+$/.test(data)) return null;
  if ((data.length * 3) / 4 > MAX_BYTES) return null;
  return { clase: 'imagen', media_type, data };
}

export async function descargarAdjunto(url, { token = null, timeoutMs = 20_000, nombre = '' } = {}) {
  if (!url || !/^https?:\/\//i.test(url)) return { adjunto: null, motivo: 'url_invalida' };
  const ctrl = new AbortController();
  const reloj = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const cabeceras = token ? { api_access_token: token } : {};
    const r = await fetch(url, { headers: cabeceras, signal: ctrl.signal, redirect: 'follow' });
    if (!r.ok) return { adjunto: null, motivo: `http_${r.status}` };
    const media_type = normalizaTipo(r.headers.get('content-type'));
    const nom = nombre || decodeURIComponent((new URL(r.url || url).pathname.split('/').pop() || '')).slice(0, 120);
    const clase = clasificar(media_type, nom);
    if (!clase) return { adjunto: null, motivo: `tipo_${media_type || 'desconocido'}` };
    const tope = clase === 'imagen' ? MAX_BYTES : MAX_BYTES_DOC;
    const largo = Number(r.headers.get('content-length') || 0);
    if (largo && largo > tope) return { adjunto: null, motivo: 'demasiado_grande' };
    const buffer = Buffer.from(await r.arrayBuffer());
    if (!buffer.length) return { adjunto: null, motivo: 'vacio' };
    if (buffer.length > tope) return { adjunto: null, motivo: 'demasiado_grande' };
    const adjunto = await prepararAdjunto({ clase, media_type, buffer, nombre: nom });
    return adjunto ? { adjunto, motivo: null } : { adjunto: null, motivo: 'no_legible' };
  } catch (e) {
    return { adjunto: null, motivo: e?.name === 'AbortError' ? 'tiempo_agotado' : 'error_descarga' };
  } finally {
    clearTimeout(reloj);
  }
}

export async function descargarImagen(url, opts = {}) {
  const r = await descargarAdjunto(url, opts);
  if (r.adjunto && r.adjunto.clase !== 'imagen') return { imagen: null, motivo: 'no_es_imagen' };
  return { imagen: r.adjunto ? { media_type: r.adjunto.media_type, data: r.adjunto.data } : null, motivo: r.motivo };
}

export function bloquesDeAdjuntos(adjuntos = []) {
  const out = [];
  for (const a of (adjuntos || []).filter(Boolean).slice(0, MAX_ADJUNTOS)) {
    const clase = a.clase || (a.media_type && TIPOS_PERMITIDOS.has(a.media_type) ? 'imagen' : null);
    if (clase === 'imagen' && a.data) out.push({ type: 'image', source: { type: 'base64', media_type: a.media_type, data: a.data } });
    else if (clase === 'pdf' && a.data) out.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: a.data }, title: a.nombre || 'documento.pdf' });
    else if (a.texto) out.push({ type: 'text', text: `ARCHIVO ADJUNTO «${a.nombre || clase}» (contenido extraído tal cual):\n${a.texto}` });
  }
  return out;
}

export const bloquesDeImagen = (imagenes = []) => bloquesDeAdjuntos((imagenes || []).map((im) => ({ ...im, clase: 'imagen' })));

export const describirAdjunto = (a) => {
  const n = a?.nombre ? ` ${a.nombre}` : '';
  return { imagen: 'una foto', pdf: `un PDF${n}`, excel: `un Excel${n}`, csv: `un CSV${n}`, word: `un Word${n}`, texto: `un archivo de texto${n}` }[a?.clase] || 'un archivo';
};
