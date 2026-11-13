import { consultar, hayBaseDeDatos } from './bd.js';

let tablaLista = false;
async function asegurarTabla() {
  if (tablaLista) return;
  await consultar(`create table if not exists catalogo_cache (
      id       int primary key default 1,
      datos    jsonb not null,
      total    int not null,
      generado timestamptz not null default now()
    )`);
  tablaLista = true;
}

export async function guardarIndice(indice) {
  if (!hayBaseDeDatos || !Array.isArray(indice) || !indice.length) return false;
  await asegurarTabla();
  await consultar(
    `insert into catalogo_cache (id, datos, total, generado)
     values (1, $1::jsonb, $2, now())
     on conflict (id) do update set datos = excluded.datos, total = excluded.total, generado = now()`,
    [JSON.stringify(indice), indice.length]
  );
  return true;
}

export async function leerIndicePersistido() {
  if (!hayBaseDeDatos) return null;
  try {
    await asegurarTabla();
    const f = (await consultar(`select datos, total, generado from catalogo_cache where id = 1`))[0];
    if (!f || !Array.isArray(f.datos) || !f.datos.length) return null;
    return { indice: f.datos, total: f.total, generado: f.generado };
  } catch {
    return null;
  }
}
