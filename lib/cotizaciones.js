import { consultar, unaFila, hayBaseDeDatos } from './bd.js';
import { enviarSeguimientoCotizacion, plantillasConfiguradas } from './wa-plantilla.js';
import { asegurarConversacion, guardarMensaje } from './conversacion.js';

const ACTIVO = (process.env.COTIZACION_SEGUIMIENTO_ACTIVO ?? '1') !== '0';

const HORAS_ESPERA = Number(process.env.COTIZACION_SEGUIMIENTO_HORAS || 48);

const HORAS_LIMITE = Number(process.env.COTIZACION_SEGUIMIENTO_MAX_HORAS || 24 * 10);

const HORA_MIN = 8, HORA_MAX = 19;

export const ESTADOS_COT = ['abierta', 'comprada', 'cerrada'];
export const ETIQUETAS_COT = { abierta: 'Abierta', comprada: 'Comprada', cerrada: 'Cerrada' };

const soloDigitos = (t) => String(t || '').replace(/\D/g, '');
const pesos = (n) => '$' + Math.round(Number(n) || 0).toLocaleString('es-CO');

export async function registrarCotizacion({ numero, telefono = null, clienteId = null, nombre = null, canal = 'whatsapp', cuentaId = null, conversacionId = null, lineas = [], total = 0, enlaceCarrito = null }) {
  if (!hayBaseDeDatos || !numero) return null;
  const resumen = (lineas || []).map((l) => ({ titulo: l.titulo, cantidad: l.cantidad, precio: l.precio, subtotal: l.subtotal }));
  try {
    return await unaFila(
      `insert into cotizaciones (numero, telefono, cliente_id, nombre, canal, cuenta_id, conversacion_id, lineas, total, enlace_carrito, seguimiento_en)
       values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10, now() + ($11 || ' hours')::interval)
       on conflict (numero) do update set lineas = excluded.lineas, total = excluded.total, enlace_carrito = excluded.enlace_carrito, actualizada = now()
       returning *`,
      [numero, telefono ? soloDigitos(telefono) : null, clienteId ? String(clienteId) : null, nombre, canal, cuentaId, conversacionId, JSON.stringify(resumen), total, enlaceCarrito, String(HORAS_ESPERA)]
    );
  } catch (e) {
    console.error('[cotizaciones] no se pudo registrar', numero, e?.message);
    return null;
  }
}

export async function marcarCompradas(orden) {
  if (!hayBaseDeDatos) return 0;
  const tels = [orden.customer?.phone, orden.phone, orden.shipping_address?.phone, orden.billing_address?.phone]
    .map((t) => soloDigitos(t).slice(-10)).filter((t) => t.length === 10);
  const clienteId = orden.customer?.id ? String(orden.customer.id) : null;
  if (!tels.length && !clienteId) return 0;
  try {
    const r = await consultar(
      `update cotizaciones
          set estado = 'comprada', pedido_id = $1, pedido_nombre = $2, actualizada = now()
        where estado = 'abierta'
          and creada > now() - interval '30 days'
          and (right(coalesce(telefono, ''), 10) = any($3::text[]) or ($4::text is not null and cliente_id = $4))
        returning numero`,
      [String(orden.id), orden.name || null, tels, clienteId]
    );
    return r.length;
  } catch {
    return 0;
  }
}

export async function cerrarCotizacion(numero, nota = null) {
  const r = await consultar(`update cotizaciones set estado = 'cerrada', seguimiento_respuesta = coalesce($2, seguimiento_respuesta), actualizada = now() where numero = $1 returning numero`, [numero, nota]);
  return r.length > 0;
}

export async function cambiarEstadoCotizacion(numero, estado) {
  if (!ESTADOS_COT.includes(estado)) return { ok: false, motivo: 'estado_invalido' };
  const r = await consultar(`update cotizaciones set estado = $2, actualizada = now() where numero = $1 returning numero`, [numero, estado]);
  return r.length ? { ok: true } : { ok: false, motivo: 'no_existe' };
}

function horaColombia() {
  return (new Date().getUTCHours() + 24 - 5) % 24;
}

function textoSeguimiento(c) {
  return `Hola ${c.nombre || ''}, soy Camila de HORECA CENTER 👋\n\nHace unos días te envié la cotización *${c.numero}* por *${pesos(c.total)}*. ¿Ya la aprobaron o quieres que ajuste algo (cantidades, presentaciones, productos)?\n\nRespóndeme por aquí y lo dejamos listo.\n[Seguimiento automático de cotización enviado por plantilla]`;
}

export async function enviarSeguimiento(numero, { forzar = false, destino = null } = {}) {
  const c = await unaFila(`select * from cotizaciones where numero = $1`, [numero]);
  if (!c) return { ok: false, motivo: 'no_existe' };
  if (!plantillasConfiguradas) return { ok: false, motivo: 'plantillas_sin_config' };
  const tel = destino || c.telefono;
  if (!tel) return { ok: false, motivo: 'sin_telefono' };
  if (!forzar && c.seguimiento_enviado) return { ok: false, motivo: 'ya_enviado' };

  const r = await enviarSeguimientoCotizacion({
    telefono: tel,
    nombre: String(c.nombre || '').split(' ')[0],
    numero: c.numero,
    total: pesos(c.total),
    enlaceCarrito: c.enlace_carrito,
  });
  if (!destino) {
    await consultar(
      `update cotizaciones set seguimiento_enviado = case when $2 then now() else seguimiento_enviado end, seguimiento_id = coalesce($3, seguimiento_id), seguimiento_error = $4, actualizada = now() where numero = $1`,
      [numero, r.ok, r.ok ? r.id : null, r.ok ? null : String(r.motivo || 'error').slice(0, 300)]
    );

    if (r.ok && c.telefono) {
      try {
        await asegurarConversacion(c.telefono, c.nombre);
        await guardarMensaje(c.telefono, 'asesor', textoSeguimiento(c));
      } catch {  }
    }
  }
  return r.ok ? { ok: true, id: r.id } : { ok: false, motivo: r.motivo };
}

export async function pasarSeguimientos() {
  if (!ACTIVO || !hayBaseDeDatos || !plantillasConfiguradas) return { revisadas: 0, enviados: 0 };
  const h = horaColombia();
  if (h < HORA_MIN || h >= HORA_MAX) return { revisadas: 0, enviados: 0, motivo: 'fuera_de_horario' };
  const filas = await consultar(
    `select numero from cotizaciones
      where estado = 'abierta' and seguimiento_enviado is null and seguimiento_error is null
        and telefono is not null
        and seguimiento_en <= now()
        and creada > now() - ($1 || ' hours')::interval
      order by seguimiento_en asc
      limit 20`,
    [String(HORAS_LIMITE)]
  );
  let enviados = 0;
  for (const f of filas) {
    try {
      const r = await enviarSeguimiento(f.numero);
      if (r.ok) enviados++;
    } catch (e) {
      console.error('[cotizaciones] seguimiento falló', f.numero, e?.message);
    }
  }
  return { revisadas: filas.length, enviados };
}

export async function cotizacionesDeTelefono(telefono, limite = 5) {
  if (!hayBaseDeDatos) return [];
  const t10 = soloDigitos(telefono).slice(-10);
  if (!t10) return [];
  return consultar(`select numero, estado, total, creada, pedido_nombre, enlace_carrito, lineas from cotizaciones where right(coalesce(telefono,''),10) = $1 order by creada desc limit $2`, [t10, limite]);
}
export async function listaCotizaciones(limite = 80) {
  if (!hayBaseDeDatos) return [];
  return consultar(`select * from cotizaciones order by creada desc limit $1`, [limite]);
}
export async function resumenCotizaciones() {
  if (!hayBaseDeDatos) return {};
  const f = await consultar(`select estado, count(*)::int as n, coalesce(sum(total),0)::numeric as total from cotizaciones where creada > now() - interval '30 days' group by estado`);
  return Object.fromEntries(f.map((x) => [x.estado, { n: x.n, total: Number(x.total) }]));
}
export const configCotizaciones = () => ({ activo: ACTIVO, horasEspera: HORAS_ESPERA, horasLimite: HORAS_LIMITE, plantillas: plantillasConfiguradas });
