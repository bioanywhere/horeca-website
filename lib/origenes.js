import { consultar, hayBaseDeDatos } from './bd.js';

const ult10 = (t) => String(t || '').replace(/\D/g, '').slice(-10);

const RE_ANUNCIO = /\[\s*anuncio\s*:\s*([A-Za-z0-9_-]{1,30})\s*\]/i;

let tablaLista = false;
async function asegurarTabla() {
  if (tablaLista) return;
  await consultar(`create table if not exists origenes (
      id        bigserial primary key,
      telefono  text not null,
      canal     text not null default 'anuncio',
      campana   text,
      detalle   text,
      creado    timestamptz not null default now()
    )`);
  await consultar(`create index if not exists origenes_creado on origenes (creado)`);
  tablaLista = true;
}

export function detectarOrigen(texto) {
  const m = String(texto || '').match(RE_ANUNCIO);
  if (!m) return null;
  const campana = m[1].toLowerCase();
  const limpio = String(texto).replace(RE_ANUNCIO, '').replace(/\s{2,}/g, ' ').trim();
  return { campana, limpio };
}

export async function registrarOrigen({ telefono, campana, detalle = null }) {
  if (!hayBaseDeDatos || !telefono) return;
  try {
    await asegurarTabla();
    await consultar(
      `insert into origenes (telefono, canal, campana, detalle) values ($1, 'anuncio', $2, $3)`,
      [telefono, campana || null, detalle]
    );
  } catch {

  }
}

export async function campanaDe(telefono) {
  if (!hayBaseDeDatos || !telefono) return null;
  try {
    await asegurarTabla();
    const f = (await consultar(
      `select campana from origenes
        where right(regexp_replace(telefono,'\\D','','g'),10) = $1
        order by creado desc limit 1`,
      [ult10(telefono)]
    ))[0];
    return f?.campana || null;
  } catch {
    return null;
  }
}

export async function resumenOrigenes() {
  const base = { anuncio_sem: 0, anuncio_mes: 0, campanas: [] };
  if (!hayBaseDeDatos) return base;
  try {
    await asegurarTabla();
    const [r] = await consultar(`
      select
        count(distinct right(regexp_replace(telefono,'\\D','','g'),10)) filter (where creado > now()-interval '7 days')::int  as anuncio_sem,
        count(distinct right(regexp_replace(telefono,'\\D','','g'),10)) filter (where creado > now()-interval '30 days')::int as anuncio_mes
      from origenes`);
    const camp = await consultar(`
      select coalesce(campana,'(sin campaña)') as campana,
             count(distinct right(regexp_replace(telefono,'\\D','','g'),10))::int as n
        from origenes
       where creado > now()-interval '30 days'
       group by campana order by n desc limit 6`);
    return { anuncio_sem: Number(r?.anuncio_sem || 0), anuncio_mes: Number(r?.anuncio_mes || 0), campanas: camp || [] };
  } catch {
    return base;
  }
}
