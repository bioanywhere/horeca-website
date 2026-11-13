import { consultar, hayBaseDeDatos } from './bd.js';

let tablaLista = false;
async function asegurarTabla() {
  if (tablaLista) return;
  await consultar(`create table if not exists busquedas_fallidas (
      id         bigserial primary key,
      canal      text not null,
      persona    text,
      consulta   text not null,
      familia    text,
      cliente    text,
      resultado  text not null,
      ejemplos   jsonb,
      creado     timestamptz not null default now()
    )`);
  await consultar(`create index if not exists busquedas_fallidas_creado_idx on busquedas_fallidas (creado)`);
  tablaLista = true;
}


export async function registrarBusquedaFallida({ canal, persona = null, consulta, familia = null, cliente = null, resultado, ejemplos = [] }) {
  if (!hayBaseDeDatos || !consulta) return;
  try {
    await asegurarTabla();
    await consultar(
      `insert into busquedas_fallidas (canal, persona, consulta, familia, cliente, resultado, ejemplos)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [canal, persona, String(consulta).slice(0, 300), familia, cliente, resultado, ejemplos.length ? JSON.stringify(ejemplos.slice(0, 3)) : null]
    );
  } catch (e) {
    console.warn('[busquedas-fallidas] no se pudo registrar:', e?.message);
  }
}


export async function resumenBusquedasFallidas({ dias = 7, limite = 60 } = {}) {
  if (!hayBaseDeDatos) return { total: 0, filas: [] };
  await asegurarTabla();
  const filas = await consultar(
    `select lower(regexp_replace(trim(consulta), '\\s+', ' ', 'g')) as consulta,
            count(*)::int as veces,
            count(distinct persona)::int as personas,
            mode() within group (order by resultado) as resultado,
            (array_agg(ejemplos order by creado desc) filter (where ejemplos is not null))[1] as ejemplos,
            max(creado) as ultima
       from busquedas_fallidas
      where creado > now() - ($1 || ' days')::interval
      group by 1
      order by veces desc, ultima desc
      limit $2`,
    [String(dias), limite]
  );
  const [t] = await consultar(`select count(*)::int as n from busquedas_fallidas where creado > now() - ($1 || ' days')::interval`, [String(dias)]);
  return { total: t?.n || 0, dias, filas };
}
