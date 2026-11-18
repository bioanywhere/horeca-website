import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { configurado } from './admin.js';
import { consumirCupo } from './conversacion.js';
import { hayBaseDeDatos } from './bd.js';
import { fichaCliente } from './panel-cliente.js';

const CUPO_HORA = 600;

let pagina = null;
const leerPagina = () =>
  (pagina ??= readFileSync(new URL('../datos/panel.html', import.meta.url), 'utf8'));

export function claveValida(recibida, esperada) {
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

  if (!configurado()) return res.status(503).json({ error: 'shopify_sin_configurar' });

  if (hayBaseDeDatos) {
    const cupo = await consumirCupo('panel', CUPO_HORA);
    if (!cupo.permitido) return res.status(429).json({ error: 'demasiadas_consultas' });
  }

  const telefono = String(req.query.tel || '').slice(0, 30);
  const correo = String(req.query.correo || '').slice(0, 200);
  if (!telefono && !correo) return res.status(400).json({ error: 'falta_telefono_o_correo' });

  try {
    const ficha = await fichaCliente({ telefono, correo });
    ficha.tienda = (process.env.TIENDA_MYSHOPIFY || '').replace('.myshopify.com', '').trim();
    return res.status(200).json(ficha);
  } catch (e) {
    console.error('panel:', e.message);
    return res.status(502).json({ error: 'no_se_pudo_consultar_shopify' });
  }
}
