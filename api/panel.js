import { handler as cliente } from '../lib/vista-cliente.js';
import { handler as recuperacion } from '../lib/vista-recuperacion.js';
import { handler as metricas } from '../lib/vista-metricas.js';
import { handler as referidos } from '../lib/vista-referidos.js';
import { handler as entregas } from '../lib/vista-entregas.js';
import { handler as cotizaciones } from '../lib/vista-cotizaciones.js';
import { handler as seo } from '../lib/vista-seo.js';

const VISTAS = { cliente, recuperacion, metricas, referidos, entregas, cotizaciones, seo };

export default function handler(req, res) {
  const v = String(req.query.v || 'cliente');
  const vista = VISTAS[v];
  if (!vista) return res.status(404).json({ error: 'vista_desconocida' });
  return vista(req, res);
}
