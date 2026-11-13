import { firmaValida, selloReciente } from '../lib/firma.js';
import { consumir, purgar } from '../lib/limite.js';
import { compararProducto, candidatosDeBusqueda, resumenPrecios, hayFuentes } from '../lib/precios.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'metodo_no_permitido' });
  }
  const secreto = process.env.SHOPIFY_APP_SECRET;
  if (!secreto) return res.status(503).json({ error: 'servicio_no_configurado' });
  const query = req.query || {};
  if (!firmaValida(query, secreto)) return res.status(403).json({ error: 'firma_invalida' });
  if (!selloReciente(query)) return res.status(403).json({ error: 'peticion_caducada' });

  res.setHeader('Cache-Control', 'no-store');

  try {
    if (query.resumen === '1') {
      return res.status(200).json({ ok: true, resumen: await resumenPrecios(), fuentes: Boolean(hayFuentes()) });
    }
    const q = String(query.q || '').slice(0, 120).trim();
    if (q && !query.producto) {
      return res.status(200).json({ ok: true, candidatos: candidatosDeBusqueda(q) });
    }
    const handle = String(query.producto || '').slice(0, 200).trim();
    if (!/^[a-z0-9-]+$/i.test(handle)) return res.status(400).json({ error: 'producto_invalido' });

    const forzar = query.forzar === '1';
    const enCache = await compararProducto(handle, { soloCache: true });
    if (!forzar && enCache.ok && enCache.estado === 'cache') return res.status(200).json(enCache);

    purgar();
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'desconocida';
    const cupo = await consumir(`precios:${ip}`, Number(process.env.PRECIOS_LIMITE_HORA || 20));
    if (!cupo.permitido) {

      return res.status(200).json({ ...enCache, estado: enCache.estado === 'pendiente' ? 'limite' : enCache.estado, limite: true });
    }
    const r = await compararProducto(handle, { forzar });
    return res.status(200).json(r);
  } catch (e) {
    console.error('[comparar]', e?.message);
    return res.status(502).json({ error: 'no_se_pudo_comparar' });
  }
}
