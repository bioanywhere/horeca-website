import crypto from 'node:crypto';

export function firmaValida(query, secreto) {
  if (!secreto) return false;
  const { signature, ...resto } = query;
  if (!signature || typeof signature !== 'string') return false;

  const mensaje = Object.keys(resto)
    .sort()
    .map((k) => {
      const v = resto[k];
      return `${k}=${Array.isArray(v) ? v.join(',') : v}`;
    })
    .join('');

  const esperado = crypto.createHmac('sha256', secreto).update(mensaje).digest('hex');

  const a = Buffer.from(esperado, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function selloReciente(query, margenSegundos = 300) {
  const t = Number(query.timestamp);
  if (!Number.isFinite(t)) return false;
  return Math.abs(Date.now() / 1000 - t) <= margenSegundos;
}
