import { pasarAHumano, hayChatwoot } from './chatwoot.js';

const WEBHOOK = process.env.ALERTA_WEBHOOK || null;
const UMBRAL = Number(process.env.ALERTA_FALLOS_SEGUIDOS || 3);

const ESPERA_MS = 30 * 60 * 1000;
let ultimoAviso = 0;
let seguidos = 0;

export async function rescatar(trabajo, error) {
  if (trabajo.origen !== 'chatwoot' || !hayChatwoot) return false;
  if (!trabajo.cuenta_id || !trabajo.conversacion_id) return false;

  try {
    await pasarAHumano(
      trabajo.cuenta_id,
      trabajo.conversacion_id,
      `el asesor automático no pudo responder (${String(error).slice(0, 120)}). Por favor continúe usted.`
    );
    return true;
  } catch {
    return false;
  }
}

export function todoBien() {
  seguidos = 0;
}

export async function avisar(texto) {
  console.error('[alerta] ' + texto);
  if (!WEBHOOK) return false;
  try {
    await fetch(WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: texto, content: texto }),
    });
    return true;
  } catch (e) {
    console.error('[alerta] no se pudo avisar:', e?.message);
    return false;
  }
}

export async function contarFallo(detalle, { permanente = false } = {}) {
  seguidos += 1;
  if (!permanente && seguidos < UMBRAL) return false;

  const ahora = Date.now();
  if (ahora - ultimoAviso < ESPERA_MS) return false;
  ultimoAviso = ahora;

  const texto = permanente
    ? `Asesor de WhatsApp CAÍDO: error permanente (saldo/clave de Anthropic). No responderá hasta resolverlo. Detalle: ${String(detalle).slice(0, 300)}`
    : `Asesor de WhatsApp: ${seguidos} turnos fallidos seguidos. Último error: ${String(detalle).slice(0, 300)}`;
  console.error('[alerta] ' + texto);

  if (!WEBHOOK) return false;
  try {
    await fetch(WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },

      body: JSON.stringify({ text: texto, content: texto, seguidos, detalle: String(detalle) }),
    });
    return true;
  } catch (e) {
    console.error('[alerta] no se pudo avisar:', e?.message);
    return false;
  }
}

export function rachaActual() {
  return seguidos;
}
