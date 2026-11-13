import { consultar, hayBaseDeDatos } from '../lib/bd.js';

export const config = { api: { bodyParser: { sizeLimit: '4mb' } } };

export default async function handler(req, res) {

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-ingesta');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const secreto = process.env.INGESTA_SECRET;
  if (!secreto || !hayBaseDeDatos) return res.status(503).json({ error: 'no_disponible' });

  if (req.headers['x-ingesta'] !== secreto) return res.status(403).json({ error: 'prohibido' });

  await consultar(`create table if not exists ingesta (
      clave text primary key,
      datos jsonb not null,
      creado timestamptz not null default now()
    )`);

  if (req.method === 'GET') {
    const filas = await consultar('select clave, jsonb_array_length(datos) n, creado from ingesta');
    return res.status(200).json({ buzones: filas });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'metodo_no_permitido' });
  }

  const cuerpo = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  const clave = String(cuerpo?.clave || '').slice(0, 60);
  const datos = cuerpo?.datos;
  if (!clave || !Array.isArray(datos)) return res.status(400).json({ error: 'faltan clave o datos' });

  await consultar(
    `insert into ingesta (clave, datos) values ($1, $2::jsonb)
     on conflict (clave) do update set datos = excluded.datos, creado = now()`,
    [clave, JSON.stringify(datos)]
  );

  return res.status(200).json({ clave, guardados: datos.length });
}
