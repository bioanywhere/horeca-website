import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { hayBaseDeDatos } from '../lib/bd.js';
import { leerConfig, guardarConfig, resumenReferidos, listaReferidos } from '../lib/referidos.js';

let pagina = null;
const leerPagina = () =>
  (pagina ??= readFileSync(new URL('../datos/referidos.html', import.meta.url), 'utf8'));

function claveValida(recibida, esperada) {
  if (!esperada || typeof recibida !== 'string') return false;
  const a = Buffer.from(recibida);
  const b = Buffer.from(esperada);
  return a.length === b.length && timingSafeEqual(a, b);
}

const TIPOS = new Set(['domicilio', 'porcentaje', 'monto', 'producto']);

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
    const c = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    const tipo = TIPOS.has(c.tipo) ? c.tipo : 'domicilio';
    if ((tipo === 'porcentaje' || tipo === 'monto') && !(Number(c.valor) > 0)) {
      return res.status(400).json({ error: 'valor_requerido' });
    }
    if (tipo === 'producto' && !String(c.producto_variante || '').trim()) {
      return res.status(400).json({ error: 'variante_requerida' });
    }
    try {
      const guardada = await guardarConfig({
        activo: Boolean(c.activo),
        tipo,
        valor: c.valor != null && c.valor !== '' ? Number(c.valor) : null,
        producto_variante: String(c.producto_variante || '').trim() || null,
        producto_titulo: String(c.producto_titulo || '').trim() || null,
        vence_dias: Number(c.vence_dias) > 0 ? Number(c.vence_dias) : 30,
      });
      return res.status(200).json({ ok: true, config: guardada });
    } catch (e) {
      console.error('referidos-panel POST:', e.message);
      return res.status(502).json({ error: 'no_se_pudo_guardar' });
    }
  }

  if (req.query.datos !== '1') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(leerPagina());
  }

  if (!hayBaseDeDatos) return res.status(503).json({ error: 'sin_base_de_datos' });
  try {
    const [config, resumen, lista] = await Promise.all([leerConfig(), resumenReferidos(), listaReferidos()]);
    return res.status(200).json({ config, resumen, lista });
  } catch (e) {
    console.error('referidos-panel:', e.message);
    return res.status(502).json({ error: 'no_se_pudo_consultar' });
  }
}
