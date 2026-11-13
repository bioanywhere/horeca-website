import { consultar, hayBaseDeDatos } from './bd.js';
import { admin, configurado as adminConfigurado } from './admin.js';
import { crearRecompensa, describirRecompensa } from './descuentos.js';

const NUMERO = (process.env.WA_NUMERO_TIENDA || '573113521593').replace(/\D/g, '');
const ALFABETO = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const ult10 = (t) => String(t || '').replace(/\D/g, '').slice(-10);

let tablasListas = false;
async function asegurarTablas() {
  if (tablasListas) return;
  await consultar(`create table if not exists referidores (
      telefono        text primary key,
      codigo          text unique not null,
      nombre          text,
      cuenta_id       text,
      conversacion_id text,
      creado          timestamptz not null default now()
    )`);
  await consultar(`create table if not exists referidos (
      id                        bigserial primary key,
      codigo                    text not null,
      referidor_tel             text not null,
      referido_tel              text not null,
      nombre                    text,
      cuenta_id                 text,
      conversacion_id           text,
      estado                    text not null default 'pendiente',
      recompensa_desc           text,
      recompensa_referidor_cod  text,
      recompensa_referido_cod   text,
      entregado_referidor       boolean not null default false,
      entregado_referido        boolean not null default false,
      creado                    timestamptz not null default now(),
      cumplido_en               timestamptz
    )`);
  await consultar(`create index if not exists referidos_refdo on referidos (referido_tel, estado)`);
  await consultar(`create index if not exists referidos_refdor on referidos (referidor_tel, estado)`);
  await consultar(`create table if not exists referidos_config (
      id                int primary key default 1,
      activo            boolean not null default false,
      tipo              text not null default 'domicilio',
      valor             numeric,
      producto_variante text,
      producto_titulo   text,
      vence_dias        int not null default 30,
      actualizado       timestamptz not null default now()
    )`);
  tablasListas = true;
}

const CONFIG_DEF = { activo: false, tipo: 'domicilio', valor: null, producto_variante: null, producto_titulo: null, vence_dias: 30 };

export async function leerConfig() {
  if (!hayBaseDeDatos) return { ...CONFIG_DEF };
  try {
    await asegurarTablas();
    const f = (await consultar(`select * from referidos_config where id = 1`))[0];
    return f ? { ...CONFIG_DEF, ...f } : { ...CONFIG_DEF };
  } catch {
    return { ...CONFIG_DEF };
  }
}

export async function guardarConfig(patch = {}) {
  await asegurarTablas();
  const actual = await leerConfig();
  const c = { ...actual, ...patch };
  await consultar(
    `insert into referidos_config (id, activo, tipo, valor, producto_variante, producto_titulo, vence_dias, actualizado)
     values (1, $1, $2, $3, $4, $5, $6, now())
     on conflict (id) do update set
       activo=excluded.activo, tipo=excluded.tipo, valor=excluded.valor,
       producto_variante=excluded.producto_variante, producto_titulo=excluded.producto_titulo,
       vence_dias=excluded.vence_dias, actualizado=now()`,
    [Boolean(c.activo), String(c.tipo || 'domicilio'), c.valor != null ? Number(c.valor) : null,
     c.producto_variante || null, c.producto_titulo || null, Number(c.vence_dias) || 30]
  );
  return leerConfig();
}

function nuevoCodigo() {
  let s = 'HC';
  for (let i = 0; i < 5; i++) s += ALFABETO[Math.floor(Math.random() * ALFABETO.length)];
  return s;
}

export async function codigoDe(telefono, nombre = null, { cuentaId = null, conversacionId = null } = {}) {
  if (!hayBaseDeDatos || !telefono) return null;
  await asegurarTablas();
  const ya = (await consultar(`select codigo from referidores where telefono = $1`, [telefono]))[0];
  if (ya) {
    await consultar(
      `update referidores set nombre = coalesce($2, nombre),
         cuenta_id = coalesce($3, cuenta_id), conversacion_id = coalesce($4, conversacion_id)
       where telefono = $1`,
      [telefono, nombre, cuentaId, conversacionId]
    );
    return ya.codigo;
  }
  for (let intento = 0; intento < 6; intento++) {
    const codigo = nuevoCodigo();
    try {
      await consultar(
        `insert into referidores (telefono, codigo, nombre, cuenta_id, conversacion_id)
         values ($1, $2, $3, $4, $5)`,
        [telefono, codigo, nombre, cuentaId, conversacionId]
      );
      return codigo;
    } catch (e) {

      const otra = (await consultar(`select codigo from referidores where telefono = $1`, [telefono]))[0];
      if (otra) return otra.codigo;
    }
  }
  return null;
}

export function enlaceReferido(codigo) {
  const texto = `Hola 👋 Vengo recomendado por un cliente de HORECA Center. Mi código de referido es ${codigo}. Quiero hacer un pedido para mi negocio.`;
  return `https://wa.me/${NUMERO}?text=${encodeURIComponent(texto)}`;
}

export function mensajeParaCompartir(codigo, recompensaDesc) {
  return (
    `Comparte HORECA con otro negocio y ambos ganan: cuando haga su primer pedido, ` +
    `tú y tu colega reciben ${recompensaDesc}.\n\n` +
    `Este es tu enlace para compartir 👇\n${enlaceReferido(codigo)}\n\n` +
    `(O que te mencionen tu código: ${codigo})`
  );
}

const RE_CODIGO = /\bHC[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}\b/i;
export function detectarCodigo(texto) {
  const m = String(texto || '').toUpperCase().match(RE_CODIGO);
  return m ? m[0].toUpperCase() : null;
}

async function tieneComprasPrevias(telefono) {
  if (!adminConfigurado()) return false;
  try {
    const tel10 = ult10(telefono);
    const d = await admin(
      `query($q:String!){ orders(first:1, query:$q){ nodes{ id } } }`,
      { q: `phone:${tel10}` }
    );
    return (d?.orders?.nodes || []).length > 0;
  } catch {
    return false;
  }
}

export async function registrarReferido({ codigo, referidoTel, nombre = null, cuentaId = null, conversacionId = null }) {
  if (!hayBaseDeDatos || !codigo || !referidoTel) return { ok: false, motivo: 'datos' };
  await asegurarTablas();
  const cfg = await leerConfig();
  if (!cfg.activo) return { ok: false, motivo: 'inactivo' };

  const ref = (await consultar(`select telefono from referidores where codigo = $1`, [codigo.toUpperCase()]))[0];
  if (!ref) return { ok: false, motivo: 'codigo_invalido' };
  if (ult10(ref.telefono) === ult10(referidoTel)) return { ok: false, motivo: 'auto_referido' };

  const dup = (await consultar(
    `select id from referidos where right(regexp_replace(referido_tel,'\\D','','g'),10) = $1 limit 1`,
    [ult10(referidoTel)]
  ))[0];
  if (dup) return { ok: false, motivo: 'ya_registrado' };

  if (await tieneComprasPrevias(referidoTel)) return { ok: false, motivo: 'no_nuevo' };

  await consultar(
    `insert into referidos (codigo, referidor_tel, referido_tel, nombre, cuenta_id, conversacion_id)
     values ($1, $2, $3, $4, $5, $6)`,
    [codigo.toUpperCase(), ref.telefono, referidoTel, nombre, cuentaId, conversacionId]
  );
  return { ok: true, referidorTel: ref.telefono };
}

export async function cumplirReferido(referidoTel) {
  if (!hayBaseDeDatos || !referidoTel) return null;
  await asegurarTablas();
  const fila = (await consultar(
    `select * from referidos
       where right(regexp_replace(referido_tel,'\\D','','g'),10) = $1 and estado = 'pendiente'
       order by creado asc limit 1`,
    [ult10(referidoTel)]
  ))[0];
  if (!fila) return null;

  const cfg = await leerConfig();
  const desc = describirRecompensa(cfg);
  const etiqueta = `Referido HORECA (${cfg.tipo})`;
  const opts = { tipo: cfg.tipo, valor: cfg.valor, productoVariante: cfg.producto_variante, venceDias: cfg.vence_dias, etiqueta };

  const [rDor, rDo] = await Promise.all([crearRecompensa(opts), crearRecompensa(opts)]);
  const manual = !(rDor.ok && rDo.ok);

  await consultar(
    `update referidos set estado='cumplido', recompensa_desc=$2,
       recompensa_referidor_cod=$3, recompensa_referido_cod=$4, cumplido_en=now()
     where id = $1`,
    [fila.id, desc, rDor.ok ? rDor.codigo : null, rDo.ok ? rDo.codigo : null]
  );

  return {
    id: fila.id,
    referidorTel: fila.referidor_tel,
    referidoTel: fila.referido_tel,
    descripcion: desc,
    codigoReferidor: rDor.ok ? rDor.codigo : null,
    codigoReferido: rDo.ok ? rDo.codigo : null,
    manual,
    motivo: manual ? (rDor.motivo || rDo.motivo) : null,
  };
}

export async function recompensasPorEntregar(telefono) {
  if (!hayBaseDeDatos || !telefono) return [];
  try {
    await asegurarTablas();
    const t = ult10(telefono);
    const filas = await consultar(
      `select id, recompensa_desc, recompensa_referidor_cod, recompensa_referido_cod,
              entregado_referidor, entregado_referido, referidor_tel, referido_tel
         from referidos
        where estado='cumplido'
          and ( (right(regexp_replace(referidor_tel,'\\D','','g'),10) = $1 and entregado_referidor = false and recompensa_referidor_cod is not null)
             or (right(regexp_replace(referido_tel,'\\D','','g'),10)  = $1 and entregado_referido  = false and recompensa_referido_cod  is not null) )`,
      [t]
    );
    const out = [];
    for (const f of filas) {
      if (ult10(f.referidor_tel) === t && !f.entregado_referidor && f.recompensa_referidor_cod) {
        out.push({ id: f.id, rol: 'referidor', codigo: f.recompensa_referidor_cod, desc: f.recompensa_desc });
      }
      if (ult10(f.referido_tel) === t && !f.entregado_referido && f.recompensa_referido_cod) {
        out.push({ id: f.id, rol: 'referido', codigo: f.recompensa_referido_cod, desc: f.recompensa_desc });
      }
    }
    return out;
  } catch {
    return [];
  }
}

export async function marcarEntregada(id, rol) {
  const col = rol === 'referidor' ? 'entregado_referidor' : 'entregado_referido';
  try {
    await consultar(`update referidos set ${col} = true where id = $1`, [id]);
  } catch {

  }
}

export function mensajeDeRecompensa({ rol, codigo, desc }) {
  const intro = rol === 'referidor'
    ? '¡Tu referido ya hizo su primer pedido! 🎉 Como gracias, tienes'
    : '¡Gracias por tu primer pedido! 🎉 Por venir recomendado, tienes';
  return `${intro} ${desc}.\nUsa este código al pagar: *${codigo}*`;
}

export async function resumenReferidos() {
  const base = { pendientes: 0, cumplidos: 0, por_honrar_manual: 0, referidores: 0 };
  if (!hayBaseDeDatos) return base;
  try {
    await asegurarTablas();
    const [r] = await consultar(`
      select
        count(*) filter (where estado='pendiente')::int as pendientes,
        count(*) filter (where estado='cumplido')::int  as cumplidos,
        count(*) filter (where estado='cumplido' and recompensa_referido_cod is null)::int as por_honrar_manual
      from referidos where creado > now() - interval '90 days'`);
    const [rr] = await consultar(`select count(*)::int as n from referidores`);
    return { ...base, ...r, referidores: Number(rr?.n || 0) };
  } catch {
    return base;
  }
}

export async function listaReferidos(limite = 30) {
  if (!hayBaseDeDatos) return [];
  try {
    await asegurarTablas();
    return await consultar(
      `select id, codigo, referidor_tel, referido_tel, nombre, estado, recompensa_desc,
              recompensa_referidor_cod, recompensa_referido_cod, creado, cumplido_en
         from referidos order by creado desc limit $1`,
      [limite]
    );
  } catch {
    return [];
  }
}
