import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { hayBaseDeDatos } from '../lib/bd.js';
import { carritosDeTelefono, resumenRecuperacion, recordarCarrito } from '../lib/recuperacion.js';

let pagina = null;
const leerPagina = () =>
  (pagina ??= readFileSync(new URL('../datos/recuperacion.html', import.meta.url), 'utf8'));

function claveValida(recibida, esperada) {
  if (!esperada || typeof recibida !== 'string') return false;
  const a = Buffer.from(recibida);
  const b = Buffer.from(esperada);
  return a.length === b.length && timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'metodo_no_permitido' });
  }
  const esperada = (process.env.PANEL_CHATWOOT_CLAVE || '').trim();
  if (!esperada) return res.status(503).send('Panel sin configurar: falta PANEL_CHATWOOT_CLAVE.');
  if (!claveValida(req.query.k, esperada)) return res.status(403).send('Clave no valida.');

  if (req.method === 'POST') {
    if (!hayBaseDeDatos) return res.status(503).json({ error: 'sin_base_de_datos' });
    const cuerpo = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    const id = Number(cuerpo.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'id_no_valido' });
    const r = await recordarCarrito(id);
    return res.status(r.ok ? 200 : 502).json(r);
  }

  if (req.query.datos !== '1') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(leerPagina());
  }

  if (!hayBaseDeDatos) return res.status(503).json({ error: 'sin_base_de_datos' });

  const telefono = String(req.query.tel || '').slice(0, 30);
  try {
    const [carritos, resumen] = await Promise.all([
      telefono ? carritosDeTelefono(telefono) : [],
      resumenRecuperacion(),
    ]);
    return res.status(200).json({ telefono, carritos, resumen });
  } catch (e) {
    console.error('recup-panel:', e.message);
    return res.status(502).json({ error: 'no_se_pudo_consultar' });
  }
}
