const URL_WORKER = (process.env.WORKER_URL || 'https://horeca-whatsapp.fly.dev').replace(/\/+$/, '');
const CLAVE = (process.env.WORKER_CLAVE || '').trim();

async function llamar(ruta, { metodo = 'GET', timeoutMs = 2500 } = {}) {
  if (!CLAVE) return { ok: false, error: 'sin WORKER_CLAVE' };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(URL_WORKER + ruta, { method: metodo, headers: { 'x-clave': CLAVE }, signal: ctrl.signal });
    const datos = await r.json().catch(() => ({}));
    return r.ok ? { ok: true, ...datos } : { ok: false, error: `HTTP ${r.status}`, ...datos };
  } catch (e) {
    return { ok: false, error: e?.name === 'AbortError' ? 'timeout' : e?.message };
  } finally {
    clearTimeout(t);
  }
}

export const despertarWorker = () => llamar('/despertar', { metodo: 'POST', timeoutMs: 2000 });
export const saludWorker = () => llamar('/salud', { timeoutMs: 5000 });
