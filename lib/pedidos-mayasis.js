import { consultar, hayBaseDeDatos } from './bd.js';
import { admin, configurado as adminConfigurado } from './admin.js';
import { crearPedido, clientePorNit, crearCliente, configurado as mayasisConfigurado } from './mayasis.js';
import { avisar } from './alerta.js';

const MODO = (process.env.MAYASIS_PEDIDOS || 'ensayo').trim();
const ORDEN_BODEGAS = (process.env.MAYASIS_BODEGAS_ORDEN || '6,4').split(',').map((s) => s.trim()).filter(Boolean);

function vendedorPara(bodega) {
  let mapa = {};
  try { mapa = JSON.parse(process.env.MAYASIS_VENDEDORES || '{}'); } catch {  }
  if (!Object.keys(mapa).length) for (const m of String(process.env.MAYASIS_VENDEDORES || '').matchAll(/"?(\d+)"?\s*:\s*"?(\d+)"?/g)) mapa[m[1]] = m[2];
  return String(mapa[String(bodega)] || process.env.MAYASIS_VENDEDOR || '122');
}

let tabla = false;
async function asegurarTabla() {
  if (tabla) return;
  await consultar(`create table if not exists pedidos_mayasis (
    orden_id text primary key, nombre text, bodega text, estado text not null, mayasis_id text,
    cuerpo jsonb, respuesta jsonb, error text, creado timestamptz not null default now(), actualizado timestamptz not null default now())`);

  await consultar(`alter table pedidos_mayasis add column if not exists orden jsonb`);
  tabla = true;
}

const atributo = (orden, ...claves) => {
  const attrs = orden.note_attributes || [];
  for (const k of claves) { const a = attrs.find((x) => String(x.name || '').replace(/\+/g, ' ').toLowerCase() === k.toLowerCase()); if (a?.value) return String(a.value).trim(); }
  return '';
};

export function documentoDe(orden) {
  const num = atributo(orden, 'Número de documento', 'Numero de documento');
  return num.replace(/\D/g, '');
}

const CODIGO_FLETE = String(process.env.MAYASIS_CODIGO_FLETE || '2301');
const MAX_OBSERVACION = 500;
const redondear = (n) => Math.round(Number(n || 0) * 100) / 100;
const pesos = (n) => '$' + Math.round(Number(n || 0)).toLocaleString('es-CO');

function precioFinal(l) {
  const cantidad = Number(l.quantity) || 1;
  const descuento = (l.discount_allocations || []).reduce((s, d) => s + Number(d.amount || 0), 0);
  return redondear((Number(l.price) * cantidad - descuento) / cantidad);
}

function envioDe(orden) {
  const lineas = orden.shipping_lines || [];
  const valor = lineas.reduce((s, x) => s + Number(x.discounted_price ?? x.price ?? 0), 0);
  const titulo = lineas.map((x) => x.title).filter(Boolean).join(' + ');
  const esRetiro = !orden.shipping_address && lineas.length > 0;
  return { valor: redondear(valor), titulo, esRetiro };
}

function textoObservacion(orden) {
  const pago = [(orden.payment_gateway_names || [])[0] || orden.gateway, orden.financial_status === 'paid' ? 'pagado' : orden.financial_status].filter(Boolean).join(' ');
  const env = envioDe(orden);
  const dir = orden.shipping_address;
  const entrega = env.esRetiro
    ? `Retiro en tienda: ${env.titulo || 'sede'}`
    : dir
      ? `Domicilio ${env.titulo ? `(${env.titulo}) ` : ''}${pesos(env.valor)} · Entregar en ${[dir.address1, dir.address2, dir.city].filter(Boolean).join(', ')}${dir.name ? ` · Recibe ${dir.name}` : ''}${dir.phone ? ` · Tel ${dir.phone}` : ''}`
      : '';
  const razon = atributo(orden, 'Razón social', 'Razon social');
  const dv = atributo(orden, 'DV');
  const doc = documentoDe(orden);
  const correoFe = atributo(orden, 'Correo factura electrónica', 'Correo factura electronica');
  const factura = doc ? `FE: ${razon || ''} ${atributo(orden, 'Tipo de documento') || ''} ${doc}${dv ? '-' + dv : ''}${correoFe ? ' · ' + correoFe : ''}`.replace(/\s+/g, ' ').trim() : '';
  const codigos = (orden.discount_codes || []).map((d) => `${d.code} (-${pesos(d.amount)})`).join(', ');
  const partes = [
    `Shopify ${orden.name || orden.id}`,
    pago && `Pago: ${pago}`,
    entrega,
    orden.phone || orden.customer?.phone ? `Cliente tel ${orden.phone || orden.customer?.phone}` : '',
    factura,
    codigos && `Descuentos: ${codigos}`,
    `Total Shopify ${pesos(orden.total_price)}`,
    orden.note ? `Nota: ${String(orden.note).replace(/\s+/g, ' ')}` : '',
  ].filter(Boolean);
  const t = partes.join(' · ');
  return t.length > MAX_OBSERVACION ? t.slice(0, MAX_OBSERVACION - 1) + '…' : t;
}

function fechaPedido(orden) {
  const d = new Date(orden.created_at || Date.now());
  const col = new Date(d.getTime() - 5 * 3600 * 1000);
  return col.toISOString().slice(0, 19).replace('T', ' ');
}

export function cuerpoPedido(orden, codigoBodega, cliente) {
  const items = (orden.line_items || []).filter((l) => l.sku && Number(l.quantity) > 0).map((l) => ({
    codigo: String(l.sku).trim(),
    quantity: Number(l.quantity),
    price: precioFinal(l),
  }));
  const env = envioDe(orden);
  if (env.valor > 0) items.push({ codigo: CODIGO_FLETE, quantity: 1, price: env.valor });
  return {
    external_order_id: String(orden.name || orden.id),
    codigo_cliente: cliente?.codigo || cliente?.codcli || null,
    codigo_vendedor: vendedorPara(codigoBodega),
    codigo_bodega: Number(codigoBodega),
    fecha_pedido: fechaPedido(orden),
    observation: textoObservacion(orden),
    items,
  };
}

async function etiquetar(ordenId, etiqueta) {
  if (!adminConfigurado()) return;
  try {
    await admin(`mutation($id:ID!,$tags:[String!]!){ tagsAdd(id:$id, tags:$tags){ userErrors{ message } } }`, { id: `gid://shopify/Order/${ordenId}`, tags: [etiqueta] });
  } catch (e) { console.warn('[pedidos-mayasis] no se pudo etiquetar:', e?.message); }
}

export async function enviarPedidoAMayasis(orden) {
  if (MODO === 'off') return { estado: 'omitido', motivo: 'MAYASIS_PEDIDOS=off' };
  if (!hayBaseDeDatos || !mayasisConfigurado()) return { estado: 'omitido', motivo: 'sin_config' };
  await asegurarTabla();
  const id = String(orden.id);
  const previo = await consultar(`select estado from pedidos_mayasis where orden_id = $1`, [id]);
  if (previo[0] && ['enviado', 'ensayo'].includes(previo[0].estado)) return { estado: 'omitido', motivo: 'ya_registrado' };

  const doc = documentoDe(orden);
  let cliente = null;
  if (doc) {
    try { cliente = await clientePorNit(doc); } catch (e) { console.warn('[pedidos-mayasis] cliente:', e?.message); }
    if (!cliente && MODO !== 'ensayo') {
      try {
        cliente = await crearCliente({
          nombre: [orden.customer?.first_name, orden.customer?.last_name].filter(Boolean).join(' ') || orden.billing_address?.name || orden.billing_address?.company || orden.email,
          nit: doc,
          direccion: [orden.billing_address?.address1 || orden.shipping_address?.address1, orden.billing_address?.city || orden.shipping_address?.city].filter(Boolean).join(', '),
          telefono: orden.phone || orden.customer?.phone || orden.shipping_address?.phone || orden.billing_address?.phone,
          email: orden.email || orden.customer?.email || '',
        });
        console.log(`[pedidos-mayasis] cliente creado en MAYASIS para ${orden.name}: ${cliente?.codigo || cliente?.codcli || '?'}`);
      } catch (e) { console.warn('[pedidos-mayasis] no se pudo crear el cliente:', e?.message); }
    }
  }
  if (!cliente && MODO !== 'ensayo') {
    await consultar(`insert into pedidos_mayasis (orden_id, nombre, bodega, estado, cuerpo, error) values ($1,$2,$3,'sin_cliente',$4::jsonb,$5)
      on conflict (orden_id) do update set estado='sin_cliente', error=excluded.error, actualizado=now()`,
      [id, orden.name || null, ORDEN_BODEGAS[0], JSON.stringify(cuerpoPedido(orden, ORDEN_BODEGAS[0], null)), doc ? 'cliente no existe y no se pudo crear' : 'pedido sin documento del comprador']);
    await etiquetar(id, 'mayasis:sin-cliente');
    await avisar(`Pedido ${orden.name} NO se registró en MAYASIS: ${doc ? `el cliente con documento ${doc} no existe en el ERP y no se pudo crear` : 'el comprador no dejó número de documento'}. Regístralo a mano.`).catch(() => {});
    return { estado: 'sin_cliente', documento: doc || null };
  }

  const intentos = [];
  for (const bodega of ORDEN_BODEGAS) {
    const cuerpo = cuerpoPedido(orden, bodega, cliente);
    if (!cuerpo.items.some((i) => i.codigo !== CODIGO_FLETE)) return { estado: 'omitido', motivo: 'sin_lineas_con_sku' };
    if (MODO === 'ensayo') {
      await consultar(`insert into pedidos_mayasis (orden_id, nombre, bodega, estado, cuerpo) values ($1,$2,$3,'ensayo',$4::jsonb)
        on conflict (orden_id) do update set bodega=excluded.bodega, estado='ensayo', cuerpo=excluded.cuerpo, actualizado=now()`, [id, orden.name || null, bodega, JSON.stringify(cuerpo)]);
      console.log(`[pedidos-mayasis] ENSAYO ${orden.name}: cuerpo registrado (bodega ${bodega}, ${cuerpo.items.length} líneas, cliente ${cliente ? 'encontrado' : 'NO encontrado'})`);
      return { estado: 'ensayo', bodega, lineas: cuerpo.items.length, clienteEncontrado: Boolean(cliente) };
    }
    const r = await crearPedido(cuerpo);
    if (r.ok) {
      const mid = String(r.respuesta?.codfactol || r.respuesta?.id || r.respuesta?.data?.codfactol || r.respuesta?.data?.id || '');
      await consultar(`insert into pedidos_mayasis (orden_id, nombre, bodega, estado, mayasis_id, cuerpo, respuesta) values ($1,$2,$3,'enviado',$4,$5::jsonb,$6::jsonb)
        on conflict (orden_id) do update set bodega=excluded.bodega, estado='enviado', mayasis_id=excluded.mayasis_id, cuerpo=excluded.cuerpo, respuesta=excluded.respuesta, error=null, actualizado=now()`,
        [id, orden.name || null, bodega, mid || null, JSON.stringify(cuerpo), JSON.stringify(r.respuesta || {})]);
      await consultar(`update pedidos_mayasis set orden = $2::jsonb where orden_id = $1`, [id, JSON.stringify(orden)]);
      await etiquetar(id, `mayasis:${mid || 'ok'}`);
      return { estado: 'enviado', bodega, mayasisId: mid || null };
    }
    intentos.push({ bodega, sinStock: r.sinStock || null, error: r.error || r.mensaje || null });
    if (!r.sinStock) break;
  }
  const conStock = intentos.every((i) => i.sinStock);
  const estado = conStock ? 'sin_stock' : 'error';
  const detalle = JSON.stringify(intentos).slice(0, 1500);
  await consultar(`insert into pedidos_mayasis (orden_id, nombre, bodega, estado, cuerpo, error) values ($1,$2,$3,$4,$5::jsonb,$6)
    on conflict (orden_id) do update set estado=excluded.estado, error=excluded.error, actualizado=now()`, [id, orden.name || null, intentos.at(-1)?.bodega || null, estado, JSON.stringify(cuerpoPedido(orden, ORDEN_BODEGAS[0], cliente)), detalle]);
  await consultar(`update pedidos_mayasis set orden = $2::jsonb where orden_id = $1`, [id, JSON.stringify(orden)]);
  await etiquetar(id, conStock ? 'mayasis:sin-stock' : 'mayasis:error');
  await avisar(`Pedido ${orden.name} NO se registró en MAYASIS (${estado}): ${detalle.slice(0, 400)}`).catch(() => {});
  return { estado, intentos };
}

export async function reintentarPedido(ordenId) {
  const f = await consultar(`select orden from pedidos_mayasis where orden_id = $1`, [String(ordenId)]);
  if (!f[0]) return { ok: false, motivo: 'no_existe' };
  if (!f[0].orden) return { ok: false, motivo: 'sin_copia_del_pedido: reenviarlo desde el webhook o el admin' };
  await consultar(`delete from pedidos_mayasis where orden_id = $1`, [String(ordenId)]);
  return enviarPedidoAMayasis(f[0].orden);
}
