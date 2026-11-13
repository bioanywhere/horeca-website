import Anthropic from '@anthropic-ai/sdk';
import { bloquesDeAdjuntos } from './imagenes.js';

const MODELO = (process.env.LECTURA_MODELO || 'claude-sonnet-5').trim();
const cliente = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;

const HERRAMIENTA = {
  name: 'registrar_lectura',
  description: 'Registra la transcripción de la lista de pedido del adjunto.',
  input_schema: {
    type: 'object',
    properties: {
      es_lista: { type: 'boolean', description: 'true si el adjunto es una lista, tabla, pedido, orden de compra o cotización con 2 o más productos. false si es la foto de UN producto, de un empaque o de un espacio.' },
      lineas: {
        type: 'array',
        maxItems: 80,
        items: {
          type: 'object',
          properties: {
            producto: { type: 'string', description: 'Descripción tal como aparece (sin corregir ni completar).' },
            cantidad: { type: 'string', description: 'Cantidad tal como aparece; vacío si no hay.' },
            unidad: { type: 'string', description: 'Unidad o presentación tal como aparece (Unidad, Paq, Caja, Galón…); vacío si no hay.' },
          },
          required: ['producto'],
        },
      },
    },
    required: ['es_lista', 'lineas'],
  },
};

const INSTRUCCION = 'Transcribe LITERALMENTE cada renglón de producto del adjunto, en el mismo orden, con su cantidad y unidad. ' +
  'No interpretes, no corrijas, no agregues productos ni completes datos que no se vean. Omite encabezados, totales y firmas. ' +
  'Si una celda no se puede leer, escribe «?» en ese campo. Si el adjunto no es una lista de varios productos, es_lista=false y lineas vacío.';


export async function leerLista(adjuntos = []) {
  if (!cliente || !adjuntos.length) return null;
  const bloques = bloquesDeAdjuntos(adjuntos);
  if (!bloques.length) return null;
  try {
    const r = await cliente.messages.create({
      model: MODELO,
      max_tokens: 2000,
      tools: [HERRAMIENTA],
      tool_choice: { type: 'tool', name: HERRAMIENTA.name },
      messages: [{ role: 'user', content: [...bloques, { type: 'text', text: INSTRUCCION }] }],
    });
    const uso = r.content.find((b) => b.type === 'tool_use');
    const d = uso?.input;
    const lineas = (d?.lineas || [])
      .map((l) => ({ producto: String(l.producto || '').trim(), cantidad: String(l.cantidad ?? '').trim(), unidad: String(l.unidad ?? '').trim() }))
      .filter((l) => l.producto);
    if (!d?.es_lista || lineas.length < 2) return null;
    return { lineas };
  } catch (e) {
    console.warn('[lectura-adjuntos] no se pudo leer la lista:', e?.message);
    return null;
  }
}


export function listaEscrita(texto = '') {
  const renglones = String(texto || '').split(/\r?\n/).map((r) => r.trim()).filter(Boolean);
  const conNumero = renglones.filter((r) => /\d/.test(r));
  if (renglones.length < 4 || conNumero.length < 3) return '';
  return renglones.map((r) => `• ${r.replace(/^[-•*·]\s*/, '')}`).join('\n');
}


export function listaComoTexto(lista) {
  return (lista?.lineas || [])
    .map((l) => `• ${l.producto}${l.cantidad ? ` — ${l.cantidad}${l.unidad ? ' ' + l.unidad : ''}` : l.unidad ? ` — ${l.unidad}` : ''}`)
    .join('\n');
}
