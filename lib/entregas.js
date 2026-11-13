import { consultar, unaFila, hayBaseDeDatos } from './bd.js';
import { enviarEntregaAsignada, enviarPedidoEntregado, enviarEncuestaEntrega, plantillasConfiguradas } from './wa-plantilla.js';

const ENCUESTA_HORAS = Number(process.env.ENTREGA_ENCUESTA_HORAS || 2);
const ENCUESTA_ACTIVA = (process.env.ENTREGA_ENCUESTA_ACTIVA ?? '1') !== '0';

export const ESTADOS = ['pendiente_pago', 'confirmada', 'asignada', 'notificada', 'aceptada', 'recogida', 'en_camino', 'entregada', 'cancelada'];
export const ETIQUETAS = {
  pendiente_pago: 'Pendiente de pago',
  confirmada: 'Compra confirmada',
  asignada: 'Asignada',
  notificada: 'Domiciliario notificado',
  aceptada: 'Aceptada por el domiciliario',
  recogida: 'Recogida',
  en_camino: 'En camino',
  entregada: 'Entregada',
  cancelada: 'Cancelada',
};

const DOMICILIARIO = (process.env.ENTREGA_DOMICILIARIO || '').trim();
const DOMICILIARIO_NOMBRE = (process.env.ENTREGA_DOMICILIARIO_NOMBRE || 'Domiciliario').trim();
const COPIA = (process.env.ENTREGA_COPIA || '').trim();

const soloDigitos = (t) => String(t || '').replace(/\D/g, '');
const ult10 = (t) => soloDigitos(t).slice(-10);
export const esDomiciliario = (telefono) => Boolean(DOMICILIARIO) && ult10(telefono) === ult10(DOMICILIARIO);

const pesos = (n) => '$' + Math.round(Number(n) || 0).toLocaleString('es-CO');

const ES_COD = /contra\s*entrega|cash on delivery|\bcod\b|efectivo|pago al recibir/i;

const ES_RECOGIDA = /recog|pickup|retiro|en tienda/i;

export function datosEntregaDesdeOrden(orden) {
  const env = orden.shipping_address || null;
  const fac = orden.billing_address || null;
  const lineaEnvio = (orden.shipping_lines || [])[0] || null;
  const esRecogida =
    !env ||
    (lineaEnvio && ES_RECOGIDA.test(`${lineaEnvio.title || ''} ${lineaEnvio.code || ''}`)) ||
    (orden.fulfillment_status === null && Array.isArray(orden.fulfillments) && false);

  const pasarelas = (orden.payment_gateway_names || [orden.gateway]).filter(Boolean).join(' | ');
  const pagada = String(orden.financial_status || '').toLowerCase() === 'paid';
  const cod = !pagada && ES_COD.test(pasarelas);
  const total = Number(orden.total_price ?? orden.current_total_price ?? 0) || 0;

  const nombre =
    [env?.first_name, env?.last_name].filter(Boolean).join(' ').trim() ||
    [orden.customer?.first_name, orden.customer?.last_name].filter(Boolean).join(' ').trim() ||
    [fac?.first_name, fac?.last_name].filter(Boolean).join(' ').trim() ||
    'Cliente';
  const direccion = env
    ? [env.address1, env.address2, env.city, env.province].filter(Boolean).join(', ')
    : null;
  const telefono = env?.phone || orden.customer?.phone || orden.phone || fac?.phone || null;

  const lat = env && env.latitude != null ? Number(env.latitude) : null;
  const lng = env && env.longitude != null ? Number(env.longitude) : null;
  const coordsOk = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);

  const lineas = (orden.line_items || []).map((l) => `${l.quantity} x ${String(l.title || '').trim()}`);
  const resumen = lineas.slice(0, 4).join(', ') + (lineas.length > 4 ? ` (+${lineas.length - 4} más)` : '');

  const notas = [orden.note, env?.company ? `Empresa: ${env.company}` : null]
    .concat((orden.note_attributes || []).filter((a) => /instruc|referenc|entrega|nota/i.test(a.name || '')).map((a) => `${a.name}: ${a.value}`))
    .filter(Boolean)
    .join(' · ');

  return {
    pedidoId: String(orden.id),
    pedidoNombre: orden.name || `#${orden.order_number || orden.id}`,
    cliente: nombre,
    telefono,
    direccion,
    ciudad: env?.city || null,
    lat: coordsOk ? lat : null,
    lng: coordsOk ? lng : null,
    notas: notas || null,
    resumen: resumen || null,
    total,
    cobrar: cod ? total : 0,
    pagada,
    statusUrl: orden.order_status_url || null,
    esRecogida: Boolean(esRecogida),
    lista: pagada || cod,
  };
}

async function anotar(id, estado, nota = null) {
  await consultar(
    `update entregas
        set estado = $2,
            historial = historial || jsonb_build_array(jsonb_build_object('estado', $2::text, 'en', now(), 'nota', $3::text)),
            actualizado = now()
      where id = $1`,
    [id, estado, nota]
  );

  if (estado === 'entregada') {
    await avisarClienteEntregado(id).catch(() => {});

    await consultar(
      `update entregas set encuesta_en = coalesce(encuesta_en, now() + ($2 || ' hours')::interval) where id = $1 and encuesta_enviada is null`,
      [id, String(ENCUESTA_HORAS)]
    ).catch(() => {});
  }
}

const RESPUESTAS_ENCUESTA = [
  [/^\s*todo bien\b/i, 'bien'],
  [/^\s*tuve un problema\b/i, 'problema'],
];

export async function enviarEncuesta(id, { forzar = false, destino = null } = {}) {
  const e = await unaFila('select * from entregas where id = $1', [id]);
  if (!e) return { ok: false, motivo: 'no_existe' };
  if (!plantillasConfiguradas) return { ok: false, motivo: 'plantillas_sin_config' };
  const tel = destino || e.telefono;
  if (!tel) return { ok: false, motivo: 'sin_telefono' };
  if (!forzar && e.encuesta_enviada) return { ok: false, motivo: 'ya_enviada' };
  const r = await enviarEncuestaEntrega({ telefono: tel, nombre: String(e.cliente || '').split(' ')[0], pedido: e.pedido_nombre });
  if (!destino) {
    await consultar(
      `update entregas set encuesta_enviada = case when $2 then now() else encuesta_enviada end, encuesta_id = coalesce($3, encuesta_id), encuesta_error = $4, actualizado = now() where id = $1`,
      [id, r.ok, r.ok ? r.id : null, r.ok ? null : String(r.motivo || 'error').slice(0, 300)]
    );
  }
  return r.ok ? { ok: true, id: r.id } : { ok: false, motivo: r.motivo };
}

export async function pasarEncuestas() {
  if (!ENCUESTA_ACTIVA || !hayBaseDeDatos || !plantillasConfiguradas) return { revisadas: 0, enviadas: 0 };
  const h = (new Date().getUTCHours() + 19) % 24;
  if (h < 8 || h >= 20) return { revisadas: 0, enviadas: 0, motivo: 'fuera_de_horario' };
  const filas = await consultar(
    `select id from entregas
      where estado = 'entregada' and encuesta_en is not null and encuesta_en <= now()
        and encuesta_enviada is null and encuesta_error is null and telefono is not null
        and encuesta_en > now() - interval '7 days'
      order by encuesta_en asc limit 20`
  );
  let enviadas = 0;
  for (const f of filas) {
    try { if ((await enviarEncuesta(f.id)).ok) enviadas++; } catch (e) { console.error('[entregas] encuesta falló', f.id, e?.message); }
  }
  return { revisadas: filas.length, enviadas };
}

export async function atenderEncuesta({ telefono, texto }) {
  if (!hayBaseDeDatos) return null;
  const t = String(texto || '');
  const m = RESPUESTAS_ENCUESTA.find(([re]) => re.test(t));
  if (!m) return null;
  const e = await unaFila(
    `select * from entregas
      where right(regexp_replace(coalesce(telefono,''), '\\D', '', 'g'), 10) = $1
        and encuesta_enviada is not null and encuesta_respuesta is null
        and encuesta_enviada > now() - interval '7 days'
      order by encuesta_enviada desc limit 1`,
    [ult10(telefono)]
  );
  if (!e) return null;
  await consultar(`update entregas set encuesta_respuesta = $2, encuesta_respondida = now(), actualizado = now() where id = $1`, [e.id, m[1]]);
  const nombre = String(e.cliente || '').split(' ')[0];
  if (m[1] === 'bien') {
    return { respuesta: `¡Gracias${nombre ? ', ' + nombre : ''}! 🙌 Nos alegra que todo saliera bien con el pedido ${e.pedido_nombre}. Cuando necesites reponer, aquí estoy.`, entregaId: e.id, resultado: 'bien' };
  }
  return {
    respuesta: `Lamento que hayas tenido un problema con la entrega del pedido ${e.pedido_nombre}${nombre ? ', ' + nombre : ''}. Ya le aviso a una persona del equipo para que te contacte en breve. Si quieres, cuéntame aquí qué pasó.`,
    traspaso: `El cliente reportó un PROBLEMA con la entrega del pedido ${e.pedido_nombre} (encuesta post-entrega). Por favor contáctalo.`,
    entregaId: e.id,
    resultado: 'problema',
  };
}

export async function entregasDeTelefono(telefono, limite = 3) {
  if (!hayBaseDeDatos) return [];
  const t = ult10(telefono);
  if (!t) return [];
  return consultar(
    `select pedido_nombre, estado, direccion, status_url, creado, actualizado, domiciliario_nombre
       from entregas
      where right(regexp_replace(coalesce(telefono,''), '\\D', '', 'g'), 10) = $1
      order by creado desc limit $2`,
    [t, limite]
  );
}

async function avisarClienteEntregado(id) {
  const e = await unaFila('select * from entregas where id = $1', [id]);
  if (!e || !e.telefono || !plantillasConfiguradas) return false;
  const ya = (Array.isArray(e.historial) ? e.historial : []).some((h) => h && h.nota && /cliente avisado/.test(h.nota));
  if (ya) return false;
  const r = await enviarPedidoEntregado({ telefono: e.telefono, nombre: String(e.cliente || '').split(' ')[0], pedido: e.pedido_nombre, statusUrl: e.status_url });
  await consultar(
    `update entregas set historial = historial || jsonb_build_array(jsonb_build_object('estado','entregada','en',now(),'nota',$2::text)), actualizado = now() where id = $1`,
    [id, r.ok ? `cliente avisado (pedido_entregado ${r.id})` : `cliente NO avisado: ${r.motivo || 'error'}`]
  );
  return r.ok;
}

export async function registrarEntrega(orden) {
  if (!hayBaseDeDatos) return null;
  const d = datosEntregaDesdeOrden(orden);
  if (d.esRecogida) return null;
  const estadoInicial = d.lista ? 'confirmada' : 'pendiente_pago';
  const fila = await unaFila(
    `insert into entregas (pedido_id, pedido_nombre, cliente, telefono, direccion, ciudad, lat, lng, notas, resumen, total, cobrar, pagada, status_url, estado, historial)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, jsonb_build_array(jsonb_build_object('estado',$15::text,'en',now(),'nota','desde la orden')))
     on conflict (pedido_id) do update set
       pagada = excluded.pagada, cobrar = excluded.cobrar, total = excluded.total,
       telefono = coalesce(excluded.telefono, entregas.telefono),
       lat = coalesce(excluded.lat, entregas.lat), lng = coalesce(excluded.lng, entregas.lng),
       notas = coalesce(excluded.notas, entregas.notas), status_url = coalesce(excluded.status_url, entregas.status_url),
       /* Solo se promueve de pendiente_pago a confirmada; un estado más avanzado no retrocede. */
       estado = case when entregas.estado = 'pendiente_pago' and $15 = 'confirmada' then 'confirmada' else entregas.estado end,
       actualizado = now()
     returning *`,
    [d.pedidoId, d.pedidoNombre, d.cliente, d.telefono, d.direccion, d.ciudad, d.lat, d.lng, d.notas, d.resumen, d.total, d.cobrar, d.pagada, d.statusUrl, estadoInicial]
  );
  return fila;
}

export function parametrosDeAviso(e) {
  const cobrar = Number(e.cobrar) > 0 ? `${pesos(e.cobrar)} en efectivo` : 'Nada (pedido ya pagado)';
  return {
    conMapa: Number.isFinite(Number(e.lat)) && Number.isFinite(Number(e.lng)) && e.lat != null && e.lng != null,
    ubicacion: e.lat != null && e.lng != null ? { lat: Number(e.lat), lng: Number(e.lng), nombre: e.cliente || 'Entrega', direccion: e.direccion || '' } : null,
    pedido: e.pedido_nombre || e.pedidoNombre || '',
    cliente: e.cliente || 'Cliente',
    direccion: e.direccion || 'Sin dirección',
    telefonoCliente: e.telefono ? soloDigitos(e.telefono).replace(/^57(?=\d{10}$)/, '') : 'No registrado',
    indicaciones: e.notas || 'Ninguna',
    contenido: e.resumen || 'Ver pedido',
    cobrar,
    statusUrl: e.status_url || e.statusUrl || '',
  };
}

export async function asignarYNotificar(entrega, { forzar = false, destino = null } = {}) {
  if (!entrega) return { ok: false, motivo: 'sin_entrega' };
  if (!plantillasConfiguradas) return { ok: false, motivo: 'plantillas_sin_config' };
  const tel = destino || DOMICILIARIO;
  if (!tel) return { ok: false, motivo: 'sin_domiciliario' };
  const avanzada = ESTADOS.indexOf(entrega.estado) >= ESTADOS.indexOf('notificada');
  if (avanzada && !forzar) return { ok: false, motivo: 'ya_notificada' };

  await consultar(`update entregas set domiciliario = $2, domiciliario_nombre = $3, actualizado = now() where id = $1`, [entrega.id, tel, DOMICILIARIO_NOMBRE]);
  if (!avanzada) await anotar(entrega.id, 'asignada', DOMICILIARIO_NOMBRE);

  const p = parametrosDeAviso(entrega);
  const r = await enviarEntregaAsignada({ telefono: tel, ...p });
  if (!r.ok) {
    await consultar(`update entregas set error = $2, actualizado = now() where id = $1`, [entrega.id, String(r.motivo || 'error').slice(0, 300)]);
    return { ok: false, motivo: r.motivo };
  }
  let copiaId = null;
  if (COPIA && !destino) {
    const c = await enviarEntregaAsignada({ telefono: COPIA, ...p });
    copiaId = c.ok ? c.id : null;
  }
  await consultar(`update entregas set mensaje_id = $2, copia_id = $3, plantilla = $4, error = null, actualizado = now() where id = $1`, [entrega.id, r.id, copiaId, r.plantilla]);
  if (!avanzada) await anotar(entrega.id, 'notificada', `WhatsApp ${r.plantilla}${copiaId ? ' + copia' : ''}`);
  return { ok: true, id: r.id, copia: copiaId, plantilla: r.plantilla, conMapa: p.conMapa };
}

export async function procesarOrdenParaEntrega(orden, { evento = 'create' } = {}) {
  const fila = await registrarEntrega(orden);
  if (!fila) return { registrada: false, motivo: 'recogida_en_tienda_o_sin_bd' };
  if (fila.estado !== 'confirmada') return { registrada: true, estado: fila.estado, notificada: false };
  const r = await asignarYNotificar(fila);
  return { registrada: true, estado: r.ok ? 'notificada' : fila.estado, notificada: r.ok, motivo: r.motivo || null, evento };
}

export async function cambiarEstado(id, estado, nota = null) {
  if (!ESTADOS.includes(estado)) return { ok: false, motivo: 'estado_invalido' };
  const e = await unaFila('select id, estado from entregas where id = $1', [id]);
  if (!e) return { ok: false, motivo: 'no_existe' };
  await anotar(id, estado, nota);
  return { ok: true, antes: e.estado, ahora: estado };
}

const ORDENES = [
  [/pedido recibido|recibido|acepto|listo/i, 'aceptada'],
  [/recog[ií]|ya lo tengo|lo tengo/i, 'recogida'],
  [/en camino|sal[ií]|voy/i, 'en_camino'],
  [/entregad|entregu[eé]/i, 'entregada'],
];

export async function atenderDomiciliario({ telefono, texto }) {
  if (!esDomiciliario(telefono)) return null;
  if (!hayBaseDeDatos) return { respuesta: 'Recibido.' };
  const t = String(texto || '');
  const orden = ORDENES.find(([re]) => re.test(t));

  const num = (t.match(/#\s?(\d{3,})/) || [])[1];
  const activa = num
    ? await unaFila(`select * from entregas where pedido_nombre = $1 order by creado desc limit 1`, [`#${num}`])
    : await unaFila(`select * from entregas where estado not in ('entregada','cancelada','pendiente_pago') order by creado desc limit 1`);
  if (!orden) {
    const lista = await consultar(`select pedido_nombre, estado from entregas where estado not in ('entregada','cancelada','pendiente_pago') order by creado desc limit 5`);
    const pend = lista.length ? lista.map((x) => `• ${x.pedido_nombre} — ${ETIQUETAS[x.estado]}`).join('\n') : '• (ninguna)';
    return { respuesta: `Hola ${DOMICILIARIO_NOMBRE.split(' ')[0]} 👋 Entregas activas:\n${pend}\n\nRespóndeme «recibido», «recogido», «en camino» o «entregado» (puedes añadir el número, p. ej. «entregado #1002»).` };
  }
  if (!activa) return { respuesta: 'No tengo entregas activas asignadas ahora mismo. 👍' };
  const nuevo = orden[1];
  if (ESTADOS.indexOf(nuevo) <= ESTADOS.indexOf(activa.estado) && activa.estado !== 'notificada') {
    return { respuesta: `${activa.pedido_nombre} ya está en «${ETIQUETAS[activa.estado]}». ✅` };
  }
  await anotar(activa.id, nuevo, `por WhatsApp: «${t.slice(0, 80)}»`);
  const sig = { aceptada: 'Avísame «recogido» cuando tengas el pedido.', recogida: 'Escríbeme «en camino» al salir.', en_camino: 'Al entregar, responde «entregado». 🙌', entregada: '¡Gracias! Entrega cerrada. 🎉' }[nuevo] || '';
  return { respuesta: `${activa.pedido_nombre} → ${ETIQUETAS[nuevo]}. ${sig}`.trim(), entregaId: activa.id, estado: nuevo };
}

export async function listaEntregas(limite = 60) {
  if (!hayBaseDeDatos) return [];
  return consultar(`select * from entregas order by creado desc limit $1`, [limite]);
}
export async function resumenEntregas() {
  if (!hayBaseDeDatos) return {};
  const f = await consultar(`select estado, count(*)::int as n from entregas group by estado`);
  return Object.fromEntries(f.map((x) => [x.estado, x.n]));
}
export async function entregaPorId(id) {
  return unaFila('select * from entregas where id = $1', [id]);
}
export const configEntregas = () => ({ domiciliario: DOMICILIARIO || null, domiciliarioNombre: DOMICILIARIO_NOMBRE, copia: COPIA || null, plantillas: plantillasConfiguradas });
