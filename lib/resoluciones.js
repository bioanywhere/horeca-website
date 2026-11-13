import { consultar, hayBaseDeDatos } from './bd.js';

let tablaLista = false;
async function asegurarTabla() {
  if (tablaLista) return;
  await consultar(`create table if not exists resoluciones (
      id       bigserial primary key,
      telefono text,
      creado   timestamptz not null default now()
    )`);
  await consultar(`create index if not exists resoluciones_creado on resoluciones (creado)`);
  tablaLista = true;
}

export async function registrarResolucion(telefono) {
  if (!hayBaseDeDatos) return;
  try {
    await asegurarTabla();
    await consultar(`insert into resoluciones (telefono) values ($1)`, [telefono || null]);
  } catch {

  }
}

export async function resumenResoluciones() {
  const base = { hoy: 0, semana: 0, mes: 0 };
  if (!hayBaseDeDatos) return base;
  try {
    await asegurarTabla();
    const [r] = await consultar(`
      select
        count(*) filter (where creado > now()-interval '1 day')::int  as hoy,
        count(*) filter (where creado > now()-interval '7 days')::int  as semana,
        count(*) filter (where creado > now()-interval '30 days')::int as mes
      from resoluciones`);
    return { hoy: Number(r?.hoy || 0), semana: Number(r?.semana || 0), mes: Number(r?.mes || 0) };
  } catch {
    return base;
  }
}
