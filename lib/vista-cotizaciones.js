import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { hayBaseDeDatos } from './bd.js';
import {
  listaCotizaciones, resumenCotizaciones, enviarSeguimiento, cambiarEstadoCotizacion,
  configCotizaciones, ESTADOS_COT, ETIQUETAS_COT,
} from './cotizaciones.js';

let pagina = null;
const leerPagina = () => (pagina ??= readFileSync(new URL('../datos/cotizaciones.html', import.meta.url), 'utf8'));

function claveValida(recibida, esperada) {
  if (!esperada || typeof recibida !== 'string') return false;
  const a = Buffer.from(recibida);
  const b = Buffer.from(esperada);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const CUERPO_PLANTILLA = `Hola {{1}}, soy Camila de HORECA CENTER 👋

Hace unos días te envié la cotización *{{2}}* por *{{3}}*. ¿Ya la aprobaron o quieres que ajuste algo (cantidades, presentaciones, productos)?

Respóndeme por aquí y lo dejamos listo.`;

export async function handler(req, res) {
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
    const numero = String(c.numero || '').slice(0, 60);
    try {
      if (c.accion === 'estado') {
        const r = await cambiarEstadoCotizacion(numero, String(c.estado || ''));
        return res.status(r.ok ? 200 : 400).json(r);
      }
      if (c.accion === 'seguimiento' || c.accion === 'prueba') {
        const destino = c.accion === 'prueba' ? String(c.telefono || '').replace(/\D/g, '') : null;
        if (c.accion === 'prueba' && destino.length < 10) return res.status(400).json({ ok: false, motivo: 'telefono_invalido' });
        const r = await enviarSeguimiento(numero, { forzar: true, destino });
        return res.status(r.ok ? 200 : 502).json(r);
      }
      return res.status(400).json({ error: 'accion_desconocida' });
    } catch (e) {
      console.error('cotizaciones-panel POST:', e.message);
      return res.status(502).json({ error: 'no_se_pudo' });
    }
  }

  if (req.query.datos !== '1') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(leerPagina());
  }

  try {
    const [resumen, lista] = hayBaseDeDatos ? await Promise.all([resumenCotizaciones(), listaCotizaciones()]) : [{}, []];
    return res.status(200).json({
      config: configCotizaciones(),
      resumen,
      lista,
      estados: ESTADOS_COT,
      etiquetas: ETIQUETAS_COT,
      plantilla: { nombre: 'cotizacion_seguimiento', categoria: 'UTILITY', cuerpo: CUERPO_PLANTILLA, pie: '', botones: ['Comprar', 'Ajustar cotización'] },
    });
  } catch (e) {
    console.error('cotizaciones-panel:', e.message);
    return res.status(502).json({ error: 'no_se_pudo_consultar' });
  }
}
