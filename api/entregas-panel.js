import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { hayBaseDeDatos } from '../lib/bd.js';
import {
  listaEntregas, resumenEntregas, entregaPorId, cambiarEstado, asignarYNotificar,
  parametrosDeAviso, configEntregas, ESTADOS, ETIQUETAS,
} from '../lib/entregas.js';

let pagina = null;
const leerPagina = () => (pagina ??= readFileSync(new URL('../datos/entregas.html', import.meta.url), 'utf8'));

function claveValida(recibida, esperada) {
  if (!esperada || typeof recibida !== 'string') return false;
  const a = Buffer.from(recibida);
  const b = Buffer.from(esperada);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const CUERPO_PLANTILLA = `🛵 *Nueva entrega asignada*

Pedido: {{1}}
Cliente: {{2}}
Dirección: {{3}}
Teléfono: {{4}}
Indicaciones: {{5}}
Contenido: {{6}}
Cobrar al entregar: {{7}}

Toca el mapa para abrir la ubicación y confirma con el botón cuando recibas esta entrega.`;

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
    const id = Number(c.id);
    try {
      if (c.accion === 'estado') {
        const r = await cambiarEstado(id, String(c.estado || ''), c.nota ? String(c.nota).slice(0, 200) : 'desde el panel');
        return res.status(r.ok ? 200 : 400).json(r);
      }
      if (c.accion === 'reenviar' || c.accion === 'prueba') {
        const e = await entregaPorId(id);
        if (!e) return res.status(404).json({ ok: false, motivo: 'no_existe' });
        const destino = c.accion === 'prueba' ? String(c.telefono || '').replace(/\D/g, '') : null;
        if (c.accion === 'prueba' && destino.length < 10) return res.status(400).json({ ok: false, motivo: 'telefono_invalido' });
        const r = await asignarYNotificar(e, { forzar: true, destino });
        return res.status(r.ok ? 200 : 502).json(r);
      }
      return res.status(400).json({ error: 'accion_desconocida' });
    } catch (e) {
      console.error('entregas-panel POST:', e.message);
      return res.status(502).json({ error: 'no_se_pudo' });
    }
  }

  if (req.query.datos !== '1') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(leerPagina());
  }

  try {
    const [resumen, lista] = hayBaseDeDatos ? await Promise.all([resumenEntregas(), listaEntregas()]) : [{}, []];
    return res.status(200).json({
      config: configEntregas(),
      resumen,
      lista: lista.map((e) => ({ ...e, parametros: parametrosDeAviso(e) })),
      estados: ESTADOS,
      etiquetas: ETIQUETAS,
      plantilla: { nombre: 'entrega_asignada', fallback: 'entrega_asignada_texto', categoria: 'UTILITY', cuerpo: CUERPO_PLANTILLA, pie: '', botones: ['Ver pedido', 'Pedido recibido'] },
    });
  } catch (e) {
    console.error('entregas-panel:', e.message);
    return res.status(502).json({ error: 'no_se_pudo_consultar' });
  }
}
