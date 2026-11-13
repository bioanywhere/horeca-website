import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { consultar, hayBaseDeDatos } from '../lib/bd.js';

let pagina = null;
let datos = null;
const leerPagina = () => (pagina ??= readFileSync(new URL('../datos/revision.html', import.meta.url), 'utf8'));
const leerDatos = () => (datos ??= readFileSync(new URL('../datos/revision-data.json', import.meta.url), 'utf8'));

function claveValida(recibida, esperada) {
  if (!esperada || typeof recibida !== 'string') return false;
  const a = Buffer.from(recibida);
  const b = Buffer.from(esperada);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function asegurarTabla() {
  await consultar(`create table if not exists revision (
      id          text primary key,
      kathe       text not null default '',
      urlk        text not null default '',
      urlh        text not null default '',
      actualizado timestamptz not null default now()
    )`);

  await consultar(`alter table revision add column if not exists urlk text not null default ''`);
  await consultar(`alter table revision add column if not exists urlh text not null default ''`);
}

const CAMPOS = new Set(['kathe', 'urlk', 'urlh']);

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const esperada = (process.env.REVISION_CLAVE || '').trim();
  if (!esperada) return res.status(503).send('Revisión sin configurar.');
  if (!claveValida(req.query.k, esperada)) return res.status(403).send('Clave no válida.');

  if (req.method === 'GET' && req.query.tabla === '1') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.status(200).send(leerDatos());
  }
  if (req.method === 'GET' && req.query.datos !== '1') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(leerPagina());
  }

  if (!hayBaseDeDatos) return res.status(503).json({ error: 'sin_base_de_datos' });
  await asegurarTabla();

  if (req.method === 'GET') {
    const filas = await consultar('select id, kathe, urlk, urlh from revision');
    const respuestas = {};
    for (const f of filas) respuestas[f.id] = { kathe: f.kathe, urlk: f.urlk, urlh: f.urlh };
    return res.status(200).json({ respuestas });
  }

  if (req.method === 'POST') {
    const cuerpo = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    const id = String(cuerpo.id ?? '').slice(0, 40);
    const campo = String(cuerpo.campo ?? 'kathe');
    const valor = String(cuerpo.valor ?? '').slice(0, 2000);
    if (!/^[A-Za-z0-9]+$/.test(id)) return res.status(400).json({ error: 'id_no_valido' });
    if (!CAMPOS.has(campo)) return res.status(400).json({ error: 'campo_no_valido' });

    await consultar(
      `insert into revision (id, ${campo}, actualizado) values ($1, $2, now())
       on conflict (id) do update set ${campo} = excluded.${campo}, actualizado = now()`,
      [id, valor]
    );
    return res.status(200).json({ ok: true });
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'metodo_no_permitido' });
}
