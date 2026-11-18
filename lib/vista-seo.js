import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { hayBaseDeDatos, consultar } from './bd.js';
import { configurado, rendimiento, sitemaps, enviarSitemap } from './search-console.js';

let pagina = null;
const leerPagina = () => (pagina ??= readFileSync(new URL('../datos/seo.html', import.meta.url), 'utf8'));

function claveValida(recibida, esperada) {
  if (!esperada || typeof recibida !== 'string') return false;
  const a = Buffer.from(recibida);
  const b = Buffer.from(esperada);
  return a.length === b.length && timingSafeEqual(a, b);
}

const PROPIEDAD = (process.env.GSC_PROPIEDAD || 'sc-domain:horecacenter.co').trim();
const fmt = (d) => d.toISOString().slice(0, 10);

async function contenidoPublicado() {
  if (!hayBaseDeDatos) return null;
  try {
    const filas = await consultar(`select tipo, count(*)::int n, max(publicado) ultimo from seo_contenido where publicado is not null group by tipo`);
    const out = { productos: 0, colecciones: 0, ultimo: null };
    for (const f of filas) { out[f.tipo] = f.n; if (!out.ultimo || f.ultimo > out.ultimo) out.ultimo = f.ultimo; }
    return out;
  } catch { return null; }
}

export async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'metodo_no_permitido' });
  }
  const esperada = (process.env.PANEL_CHATWOOT_CLAVE || '').trim();
  if (!esperada) return res.status(503).send('Panel sin configurar: falta PANEL_CHATWOOT_CLAVE.');
  if (!claveValida(req.query.k, esperada)) return res.status(403).send('Clave no valida.');

  if (req.method === 'POST') {
    const c = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    if (c.accion === 'sitemap') {
      try {
        const estado = await enviarSitemap();
        return res.status(estado < 300 ? 200 : 502).json({ ok: estado < 300, estado });
      } catch (e) {
        return res.status(502).json({ ok: false, motivo: e.message.slice(0, 200) });
      }
    }
    return res.status(400).json({ error: 'accion_desconocida' });
  }

  if (req.query.datos !== '1') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(leerPagina());
  }

  const dias = Math.min(90, Math.max(7, Number(req.query.dias) || 28));
  const hasta = new Date(Date.now() - 2 * 864e5);
  const desde = new Date(hasta.getTime() - (dias - 1) * 864e5);
  const hastaAnt = new Date(desde.getTime() - 864e5);
  const desdeAnt = new Date(hastaAnt.getTime() - (dias - 1) * 864e5);
  const periodo = { desde: fmt(desde), hasta: fmt(hasta), dias };

  if (!configurado()) {
    return res.status(200).json({ propiedad: PROPIEDAD, periodo, sinConfig: true, contenido: await contenidoPublicado() });
  }

  const suma = (filas) => filas.reduce((s, r) => ({ clics: s.clics + r.clics, impresiones: s.impresiones + r.impresiones, posPond: s.posPond + r.posicion * r.impresiones }), { clics: 0, impresiones: 0, posPond: 0 });
  const totalesDe = (filas) => { const t = suma(filas); return { clics: t.clics, impresiones: t.impresiones, ctr: t.impresiones ? t.clics / t.impresiones : 0, posicion: t.impresiones ? t.posPond / t.impresiones : 0 }; };

  try {
    const [tendencia, tendenciaAnt, consultas, paginas, dispositivos, sm] = await Promise.all([
      rendimiento({ desde, hasta, dimensiones: ['date'], filas: 100 }),
      rendimiento({ desde: desdeAnt, hasta: hastaAnt, dimensiones: ['date'], filas: 100 }),
      rendimiento({ desde, hasta, dimensiones: ['query'], filas: 40 }),
      rendimiento({ desde, hasta, dimensiones: ['page'], filas: 40 }),
      rendimiento({ desde, hasta, dimensiones: ['device'], filas: 5 }),
      sitemaps().catch(() => ({})),
    ]);
    return res.status(200).json({
      propiedad: PROPIEDAD,
      periodo,
      totales: totalesDe(tendencia),
      anteriores: totalesDe(tendenciaAnt),
      tendencia: tendencia.map((r) => ({ fecha: r.claves[0], clics: r.clics, impresiones: r.impresiones })).sort((a, b) => a.fecha.localeCompare(b.fecha)),
      consultas: consultas.map((r) => ({ consulta: r.claves[0], clics: r.clics, impresiones: r.impresiones, ctr: r.ctr, posicion: r.posicion })),
      paginas: paginas.map((r) => ({ url: r.claves[0], clics: r.clics, impresiones: r.impresiones, ctr: r.ctr, posicion: r.posicion })),
      dispositivos: dispositivos.map((r) => ({ dispositivo: r.claves[0], clics: r.clics, impresiones: r.impresiones })),
      sitemaps: (sm.sitemap || []).map((s) => ({ url: s.path, enviado: s.lastSubmitted, leido: s.lastDownloaded, errores: Number(s.errors || 0), avisos: Number(s.warnings || 0), pendiente: Boolean(s.isPending), urls: (s.contents || []).reduce((n, c) => n + Number(c.submitted || 0), 0), indexadas: (s.contents || []).reduce((n, c) => n + Number(c.indexed || 0), 0) })),
      contenido: await contenidoPublicado(),
    });
  } catch (e) {
    console.error('seo-panel:', e.message);
    return res.status(502).json({ error: 'no_se_pudo', detalle: e.message.slice(0, 200), propiedad: PROPIEDAD, periodo, contenido: await contenidoPublicado() });
  }
}
