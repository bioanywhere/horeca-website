import { vigilar } from '../lib/vigilancia.js';

export default async function handler(req, res) {
  const secreto = (process.env.CRON_SECRET || '').trim();
  if (secreto && req.headers.authorization !== `Bearer ${secreto}`) {
    return res.status(401).json({ error: 'no_autorizado' });
  }

  try {
    const r = await vigilar();
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ revisado: true, ...r });
  } catch (e) {
    console.error('[vigilante]', e?.message);
    return res.status(500).json({ error: 'fallo_al_revisar', detalle: e?.message });
  }
}
