import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { hayBaseDeDatos } from './bd.js';
import { metricas } from './metricas.js';

let pagina = null;
const leerPagina = () =>
  (pagina ??= readFileSync(new URL('../datos/metricas.html', import.meta.url), 'utf8'));

function claveValida(recibida, esperada) {
  if (!esperada || typeof recibida !== 'string') return false;
  const a = Buffer.from(recibida);
  const b = Buffer.from(esperada);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'metodo_no_permitido' });
  }
  const esperada = (process.env.PANEL_CHATWOOT_CLAVE || '').trim();
  if (!esperada) return res.status(503).send('Panel sin configurar: falta PANEL_CHATWOOT_CLAVE.');
  if (!claveValida(req.query.k, esperada)) return res.status(403).send('Clave no valida.');

  if (req.query.datos !== '1') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(leerPagina());
  }

  if (!hayBaseDeDatos) return res.status(503).json({ error: 'sin_base_de_datos' });
  try {
    return res.status(200).json(await metricas());
  } catch (e) {
    console.error('metricas-panel:', e.message);
    return res.status(502).json({ error: 'no_se_pudo_consultar' });
  }
}
