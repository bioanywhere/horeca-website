import crypto from 'node:crypto';
import { procesarOrdenParaEntrega } from '../lib/entregas.js';

export const config = { api: { bodyParser: false } };

function leerCuerpo(req) {
  return new Promise((resolver, rechazar) => {
    const trozos = [];
    let bytes = 0;
    req.on('data', (t) => {
      bytes += t.length;
      if (bytes > 2_000_000) { rechazar(new Error('cuerpo demasiado grande')); req.destroy(); return; }
      trozos.push(t);
    });
    req.on('end', () => resolver(Buffer.concat(trozos)));
    req.on('error', rechazar);
  });
}

function hmacValido(crudo, header, secreto) {
  if (!secreto || !header) return false;
  const calc = crypto.createHmac('sha256', secreto).update(crudo).digest('base64');
  const a = Buffer.from(calc);
  const b = Buffer.from(String(header));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'metodo_no_permitido' });
  }
  const secreto = (process.env.SHOPIFY_CLIENT_SECRET || '').trim();
  if (!secreto) return res.status(503).json({ error: 'sin_secreto' });

  let crudo;
  try { crudo = await leerCuerpo(req); } catch { return res.status(400).json({ error: 'cuerpo_ilegible' }); }
  if (!hmacValido(crudo, req.headers['x-shopify-hmac-sha256'], secreto)) return res.status(401).json({ error: 'hmac_invalido' });

  let orden;
  try { orden = JSON.parse(crudo.toString('utf8')); } catch { return res.status(400).json({ error: 'json_invalido' }); }

  try {
    const r = await procesarOrdenParaEntrega(orden, { evento: 'paid' });
    console.log(`[shopify-pago] ${orden.name || ''} · entrega: ${JSON.stringify(r)}`);
  } catch (e) {
    console.error('[shopify-pago]', e?.message);
  }
  return res.status(200).json({ ok: true });
}
