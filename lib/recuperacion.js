import { consultar } from './bd.js';
import { responder, hayChatwoot } from './chatwoot.js';
import { admin, configurado as adminConfigurado } from './admin.js';

const ACTIVO = (process.env.WA_RECUP_ACTIVO ?? '1') !== '0';
const HORAS_ESPERA = Number(process.env.WA_RECUP_HORAS || 3);
const HORAS_LIMITE = Number(process.env.WA_RECUP_MAX_HORAS || 23);

let tablaLista = false;
async function asegurarTabla() {
  if (tablaLista) return;
  await consultar(`create table if not exists carritos (
      id              bigserial primary key,
      telefono        text not null,
      cuenta_id       text,
      conversacion_id text,
      nombre          text,
      enlace          text not null,
      total           integer,
      estado          text not null default 'pendiente',
      creado          timestamptz not null default now(),
      recordado_en    timestamptz
    )`);
  await consultar(`create index if not exists carritos_pend on carritos (estado, creado)`);

  await consultar(`alter table carritos add column if not exists resumen text`);

  await consultar(`alter table carritos add column if not exists lineas jsonb`);
  tablaLista = true;
}

export async function guardarCarrito({ telefono, cuentaId, conversacionId, nombre, enlace, total, resumen = null, lineas = null }) {
  if (!ACTIVO || !enlace || !telefono) return;
  try {
    await asegurarTabla();
    await consultar(`update carritos set estado='descartado' where telefono=$1 and estado='pendiente'`, [telefono]);
    await consultar(
      `insert into carritos (telefono, cuenta_id, conversacion_id, nombre, enlace, total, resumen, lineas)
       values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
      [telefono, cuentaId || null, conversacionId || null, nombre || null, enlace, total || null, resumen ? String(resumen).slice(0, 900) : null, Array.isArray(lineas) ? JSON.stringify(lineas.slice(0, 40)) : null]
    );
  } catch {

  }
}

export async function ultimoCarritoDe(telefono, { horas = 6 } = {}) {
  if (!telefono) return null;
  try {
    await asegurarTabla();
    const tel10 = String(telefono).replace(/\D/g, '').slice(-10);
    const f = await consultar(
      `select enlace, total, resumen, lineas, creado from carritos
        where right(regexp_replace(telefono, '\\D', '', 'g'), 10) = $1 and estado in ('pendiente','recordado')
          and creado > now() - ($2 || ' hours')::interval
        order by creado desc limit 1`,
      [tel10, String(Number(horas) || 6)]
    );
    return f[0] || null;
  } catch {
    return null;
  }
}

export async function marcarCompradoPorTelefono(telefono) {
  const tel10 = String(telefono || '').replace(/\D/g, '').slice(-10);
  if (!tel10) return 0;
  await asegurarTabla();
  const r = await consultar(
    `update carritos set estado='comprado'
       where right(regexp_replace(telefono, '\\D', '', 'g'), 10) = $1
         and estado in ('pendiente','recordado')
     returning id`,
    [tel10]
  );
  return Array.isArray(r) ? r.length : 0;
}

export async function descartarCarritos(telefono) {
  if (!telefono) return 0;
  try {
    await asegurarTabla();
    const tel10 = String(telefono).replace(/\D/g, '').slice(-10);
    const r = await consultar(
      `update carritos set estado='descartado'
        where right(regexp_replace(telefono, '\\D', '', 'g'), 10) = $1 and estado in ('pendiente','recordado')
        returning id`,
      [tel10]
    );
    return Array.isArray(r) ? r.length : 0;
  } catch {
    return 0;
  }
}

export async function cerrarCarritos(telefono) {
  if (!ACTIVO || !telefono) return;
  try {
    await asegurarTabla();
    await consultar(`update carritos set estado='cerrado' where telefono=$1 and estado='pendiente'`, [telefono]);
  } catch {

  }
}

export async function carritosDeTelefono(telefono) {
  if (!telefono) return [];
  try {
    await asegurarTabla();
    const tel10 = String(telefono).replace(/\D/g, '').slice(-10);
    if (!tel10) return [];
    return await consultar(
      `select id, nombre, enlace, total, estado, creado, recordado_en
         from carritos
        where right(regexp_replace(telefono, '\\D', '', 'g'), 10) = $1
        order by creado desc
        limit 20`,
      [tel10]
    );
  } catch {
    return [];
  }
}

export async function resumenRecuperacion() {
  const base = { pendiente: 0, recordado: 0, comprado: 0, cerrado: 0, descartado: 0, error: 0 };
  try {
    await asegurarTabla();
    const filas = await consultar(
      `select estado, count(*)::int n from carritos where creado > now() - interval '30 days' group by estado`
    );
    for (const f of filas) if (f.estado in base) base[f.estado] = f.n;
  } catch {

  }
  return base;
}

async function comproEnShopify(telefono, desde) {
  if (!adminConfigurado()) return false;
  try {
    const tel10 = String(telefono).replace(/\D/g, '').slice(-10);
    const iso = new Date(desde).toISOString();
    const d = await admin(
      `query($q:String!){ orders(first:20, query:$q){ nodes{ phone customer{ phone } shippingAddress{ phone } } } }`,
      { q: `created_at:>=${iso}` }
    );
    const nodes = d?.orders?.nodes || [];
    return nodes.some((o) => {
      const p = `${o.phone || ''}${o.customer?.phone || ''}${o.shippingAddress?.phone || ''}`.replace(/\D/g, '');
      return tel10 && p.includes(tel10);
    });
  } catch {
    return false;
  }
}

function mensajeRecordatorio(c) {
  const nom = c.nombre ? `, ${c.nombre}` : '';
  return (
    `¿Pudiste revisar tu carrito${nom}? 🛒 Sigue listo para pagar 😊\n${c.enlace}\n\n` +
    `Si quieres le agrego o quito algo, me dices.`
  );
}

export async function recordarCarrito(id) {
  try {
    await asegurarTabla();
    const filas = await consultar(`select * from carritos where id=$1`, [id]);
    const c = filas[0];
    if (!c) return { ok: false, error: 'no_existe' };
    if (!c.cuenta_id || !c.conversacion_id) return { ok: false, error: 'sin_conversacion' };
    const idMsg = await responder(c.cuenta_id, c.conversacion_id, mensajeRecordatorio(c));
    if (!idMsg) return { ok: false, error: 'no_se_envio' };
    await consultar(`update carritos set estado='recordado', recordado_en=now() where id=$1`, [id]);
    return { ok: true };
  } catch {
    return { ok: false, error: 'excepcion' };
  }
}

export async function pasarRecuperacion() {
  if (!ACTIVO || !hayChatwoot) return { revisados: 0, enviados: 0 };
  await asegurarTabla();
  const filas = await consultar(
    `select * from carritos
       where estado='pendiente'
         and creado <  now() - ($1 || ' hours')::interval
         and creado >  now() - ($2 || ' hours')::interval
       order by creado asc
       limit 20`,
    [String(HORAS_ESPERA), String(HORAS_LIMITE)]
  );
  let enviados = 0;
  for (const c of filas) {
    try {
      if (await comproEnShopify(c.telefono, c.creado)) {
        await consultar(`update carritos set estado='comprado' where id=$1`, [c.id]);
        continue;
      }
      const idMsg = await responder(c.cuenta_id, c.conversacion_id, mensajeRecordatorio(c));
      await consultar(`update carritos set estado=$2, recordado_en=now() where id=$1`, [c.id, idMsg ? 'recordado' : 'error']);
      if (idMsg) enviados++;
    } catch {

    }
  }
  return { revisados: filas.length, enviados };
}
