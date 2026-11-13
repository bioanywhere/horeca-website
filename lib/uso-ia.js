import { AsyncLocalStorage } from 'node:async_hooks';
import { consultar, hayBaseDeDatos } from './bd.js';

const als = new AsyncLocalStorage();

const PRECIOS_BASE = {
  haiku: { in: 1, out: 5, cw: 1.25, cr: 0.1 },
  sonnet: { in: 3, out: 15, cw: 3.75, cr: 0.3 },
  opus: { in: 15, out: 75, cw: 18.75, cr: 1.5 },
};
let PRECIOS = PRECIOS_BASE;
try { if (process.env.IA_PRECIOS_JSON) PRECIOS = { ...PRECIOS_BASE, ...JSON.parse(process.env.IA_PRECIOS_JSON) }; } catch {  }

export function precioDe(modelo) {
  const m = String(modelo || '').toLowerCase();
  return PRECIOS[m.includes('opus') ? 'opus' : m.includes('sonnet') ? 'sonnet' : 'haiku'];
}

export function costoUSD(modelo, u) {
  if (!u) return 0;
  const p = precioDe(modelo);
  return (u.entrada * p.in + u.salida * p.out + u.cache_escritura * p.cw + u.cache_lectura * p.cr) / 1e6;
}

const vacio = () => ({ entrada: 0, salida: 0, cache_escritura: 0, cache_lectura: 0, llamadas: 0 });

function acumular(usage) {
  const c = als.getStore();
  if (!c || !usage) return;
  c.entrada += Number(usage.input_tokens || 0);
  c.salida += Number(usage.output_tokens || 0);
  c.cache_escritura += Number(usage.cache_creation_input_tokens || 0);
  c.cache_lectura += Number(usage.cache_read_input_tokens || 0);
  c.llamadas += 1;
}

export async function fetchConUso(url, init) {
  const r = await fetch(url, init);
  try {
    if (String(url).includes('/v1/messages') && als.getStore() && /application\/json/.test(r.headers.get('content-type') || '')) {
      const j = await r.clone().json();
      if (j && j.usage) acumular(j.usage);
    }
  } catch {  }
  return r;
}

export async function conMedicion(fn) {
  const c = vacio();
  const resultado = await als.run(c, fn);
  return { resultado, uso: { ...c } };
}

let tablaLista = false;
async function asegurarTabla() {
  if (tablaLista) return;
  await consultar(`create table if not exists uso_ia (
      id bigserial primary key,
      canal text not null,
      telefono text,
      cliente_id text,
      trabajo_id text,
      modelo text,
      entrada integer not null default 0,
      salida integer not null default 0,
      cache_escritura integer not null default 0,
      cache_lectura integer not null default 0,
      llamadas integer not null default 0,
      costo_usd numeric(10,6) not null default 0,
      creado timestamptz not null default now())`);
  await consultar(`create index if not exists uso_ia_creado on uso_ia (creado)`);
  await consultar(`create index if not exists uso_ia_tel on uso_ia (telefono)`);
  tablaLista = true;
}

export async function registrarUso({ canal, telefono = null, clienteId = null, trabajoId = null, modelo = null, uso }) {
  if (!hayBaseDeDatos || !uso || !uso.llamadas) return;
  try {
    await asegurarTabla();
    await consultar(
      `insert into uso_ia (canal, telefono, cliente_id, trabajo_id, modelo, entrada, salida, cache_escritura, cache_lectura, llamadas, costo_usd)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [canal, telefono ? String(telefono).replace(/\D/g, '') : null, clienteId ? String(clienteId) : null, trabajoId ? String(trabajoId) : null, modelo,
        uso.entrada, uso.salida, uso.cache_escritura, uso.cache_lectura, uso.llamadas, costoUSD(modelo, uso).toFixed(6)]
    );
  } catch (e) {
    console.warn('[uso-ia] no se pudo registrar:', e?.message);
  }
}

export async function costosIA(dias = 30) {
  if (!hayBaseDeDatos) return null;
  try {
    await asegurarTabla();
    const [tot] = await consultar(`
      select
        coalesce(sum(costo_usd) filter (where creado > now()-interval '1 day'),0)::float as hoy,
        coalesce(sum(costo_usd) filter (where creado > now()-interval '7 days'),0)::float as semana,
        coalesce(sum(costo_usd) filter (where creado > now()-interval '30 days'),0)::float as mes,
        count(*) filter (where creado > now()-interval '30 days')::int as turnos_mes,
        count(distinct coalesce(telefono, cliente_id)) filter (where creado > now()-interval '30 days')::int as personas_mes,
        coalesce(sum(entrada+salida+cache_escritura+cache_lectura) filter (where creado > now()-interval '30 days'),0)::bigint as tokens_mes,
        coalesce(sum(cache_lectura) filter (where creado > now()-interval '30 days'),0)::bigint as cache_mes
      from uso_ia where creado > now()-interval '30 days'`);
    const personas = await consultar(`
      with u as (
        select coalesce(telefono, 'web:' || cliente_id) as persona, canal, telefono,
               count(*)::int as turnos, sum(costo_usd)::float as costo,
               sum(entrada+salida+cache_escritura+cache_lectura)::bigint as tokens,
               max(creado) as ultimo
          from uso_ia where creado > now()-($1 || ' days')::interval
         group by 1,2,3)
      select u.*,
             (select count(*) from carritos c where u.telefono is not null and right(regexp_replace(c.telefono,'\\D','','g'),10) = right(u.telefono,10) and c.creado > now()-($1 || ' days')::interval and c.creado >= (select min(creado) from uso_ia))::int as carritos,
             (select count(*) from carritos c where u.telefono is not null and right(regexp_replace(c.telefono,'\\D','','g'),10) = right(u.telefono,10) and c.estado='comprado' and c.creado > now()-($1 || ' days')::interval)::int as comprados,
             (select coalesce(sum(total),0) from carritos c where u.telefono is not null and right(regexp_replace(c.telefono,'\\D','','g'),10) = right(u.telefono,10) and c.estado='comprado' and c.creado > now()-($1 || ' days')::interval)::bigint as valor_comprado,
             (select nombre from carritos c where u.telefono is not null and right(regexp_replace(c.telefono,'\\D','','g'),10) = right(u.telefono,10) and nombre is not null order by creado desc limit 1) as nombre
        from u order by costo desc limit 40`, [String(dias)]);

    const [car] = await consultar(`select count(*)::int as armados, count(*) filter (where estado='comprado')::int as comprados from carritos
      where creado > now()-($1 || ' days')::interval and creado >= coalesce((select min(creado) from uso_ia), now())`, [String(dias)]).catch(() => [{ armados: 0, comprados: 0 }]);
    const porDia = await consultar(`select to_char(creado at time zone 'America/Bogota','YYYY-MM-DD') as dia, sum(costo_usd)::float as costo, count(*)::int as turnos from uso_ia where creado > now()-interval '14 days' group by 1 order by 1`);
    return {
      dias,
      hoy: tot.hoy, semana: tot.semana, mes: tot.mes,
      turnos_mes: tot.turnos_mes, personas_mes: tot.personas_mes, tokens_mes: Number(tot.tokens_mes), cache_mes: Number(tot.cache_mes),
      costo_turno: tot.turnos_mes ? tot.mes / tot.turnos_mes : 0,
      costo_persona: tot.personas_mes ? tot.mes / tot.personas_mes : 0,
      costo_carrito: car.armados ? tot.mes / car.armados : 0,
      costo_compra: car.comprados ? tot.mes / car.comprados : 0,
      personas: personas.map((p) => ({ ...p, costo: Number(p.costo), tokens: Number(p.tokens), valor_comprado: Number(p.valor_comprado) })),
      por_dia: porDia.map((d) => ({ dia: d.dia, costo: Number(d.costo), turnos: d.turnos })),
    };
  } catch (e) {
    console.warn('[uso-ia] costos:', e?.message);
    return null;
  }
}
