const BASE = (process.env.MAYASIS_BASE || 'https://mysapi.mayasisla.com/v1/').replace(/\/?$/, '/');
const USUARIO = (process.env.MAYASIS_USUARIO || '').trim();
const CLAVE = (process.env.MAYASIS_CLAVE || '').trim();
const AGENTE = 'HorecaCenter-Shopify/1.0';
const RITMO_MS = Number(process.env.MAYASIS_RITMO_MS || 3000);

export const configurado = () => Boolean(USUARIO && CLAVE);

export class ErrorMayasis extends Error {
  constructor(mensaje, estado = 0, cuerpo = null) { super(mensaje); this.name = 'ErrorMayasis'; this.estado = estado; this.cuerpo = cuerpo; }
}

let token = null, expira = 0, entrando = null, ultima = 0;
const pausa = (ms) => new Promise((r) => setTimeout(r, ms));

function vencimiento(jwt) {
  try { const p = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8')); return p.exp ? p.exp * 1000 : Date.now() + 50 * 60_000; } catch { return Date.now() + 50 * 60_000; }
}

async function entrar() {
  if (entrando) return entrando;
  entrando = (async () => {
    const r = await fetch(BASE + 'login', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': AGENTE }, body: JSON.stringify({ username: USUARIO, password: CLAVE }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { entrando = null; throw new ErrorMayasis(j.error || j.message || `login HTTP ${r.status}`, r.status, j); }
    token = j.token || j.access_token || j.data?.token;
    if (!token) { entrando = null; throw new ErrorMayasis('login sin token'); }
    expira = vencimiento(token);
    entrando = null;
    return token;
  })();
  return entrando;
}

async function tokenVigente() {
  if (!configurado()) throw new ErrorMayasis('MAYASIS_USUARIO/MAYASIS_CLAVE no configurados');
  if (token && Date.now() < expira - 60_000) return token;
  return entrar();
}

async function turno() {
  const desde = Date.now() - ultima;
  if (desde < RITMO_MS) await pausa(RITMO_MS - desde);
  ultima = Date.now();
}

async function llamar(metodo, ruta, { params = {}, body = null, intento = 0 } = {}) {
  const url = new URL(BASE + ruta);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  await turno();
  const r = await fetch(url, {
    method: metodo,
    headers: { Accept: 'application/json', 'User-Agent': AGENTE, Authorization: `Bearer ${await tokenVigente()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const texto = await r.text();
  let j; try { j = JSON.parse(texto); } catch { j = { raw: texto.slice(0, 300) }; }
  if (r.status === 401 && intento === 0) { token = null; return llamar(metodo, ruta, { params, body, intento: 1 }); }
  if ((r.status === 429 || (r.status === 403 && metodo === 'GET')) && intento < 4) {
    const espera = Math.min(60_000, 5_000 * 2 ** intento);
    console.warn(`[mayasis] ${r.status} en ${ruta}: espero ${espera / 1000}s`);
    await pausa(espera);
    return llamar(metodo, ruta, { params, body, intento: intento + 1 });
  }
  if (!r.ok) throw new ErrorMayasis(j.error || j.message || `HTTP ${r.status} en ${ruta}`, r.status, j);
  return j;
}

export async function bodegas() {
  const j = await llamar('GET', 'bodegas');
  return j.data || [];
}

export async function existenciasDeBodega(codigoBodega) {
  const out = new Map();
  let after = null, paginas = 0;
  do {
    const j = await llamar('GET', 'productos', { params: { codigo_bodega: codigoBodega, limit: 1000, after } });
    for (const p of j.data || []) {
      out.set(String(p.codigo), { stock: Math.max(0, Math.floor(Number(p.available_stock) || 0)), precio: Number(p.precio) || 0, descripcion: p.descripcion || '', activo: String(p.activo || '').toUpperCase() === 'ACTIVO' });
    }
    after = j.pagination?.has_more ? j.pagination.next_after : null;
    paginas++;
  } while (after && paginas < 20);
  return out;
}

export async function clientePorNit(nit) {
  const limpio = String(nit || '').replace(/\D/g, '');
  if (!limpio) return null;
  const j = await llamar('GET', 'clientes', { params: { nitcli: limpio, limit: 5 } });
  return (j.data || [])[0] || null;
}

export async function crearCliente({ nombre, nit, direccion, telefono, email = '' }) {
  const limpio = String(nit || '').replace(/\D/g, '');
  if (!limpio || !nombre) throw new ErrorMayasis('crearCliente: faltan nombre o NIT');
  const j = await llamar('POST', 'clientes', { body: {
    nomcli: String(nombre).slice(0, 80),
    nitcli: limpio,
    direcli: String(direccion || 'SIN DIRECCION').slice(0, 120),
    telecli: String(telefono || '').replace(/\D/g, '').slice(-10) || '0000000',
    ...(email ? { email: String(email).slice(0, 80) } : {}),
  } });
  const creado = j.data || j.cliente || j;
  if (creado && (creado.codigo || creado.codcli)) return creado;
  return clientePorNit(limpio);
}

export async function pedidoPorOrden(orden) {
  try { const j = await llamar('GET', 'pedidos', { params: { orden } }); return (j.data || [])[0] || null; } catch (e) { if (e.estado === 404) return null; throw e; }
}

export async function crearPedido(cuerpo) {
  try {
    const j = await llamar('POST', 'pedidos', { body: cuerpo });
    return { ok: true, respuesta: j };
  } catch (e) {
    const sinStock = e.cuerpo?.productos_sin_stock || e.cuerpo?.data?.productos_sin_stock || null;
    if (e.estado === 400 && sinStock) return { ok: false, sinStock, mensaje: e.message };
    return { ok: false, error: e.message, estado: e.estado, cuerpo: e.cuerpo };
  }
}

export async function descuentoAplicable(codigoProducto) {
  const codigo = String(codigoProducto ?? '').trim();
  if (!codigo) throw new ErrorMayasis('descuentoAplicable: falta codigo_producto');
  const j = await llamar('GET', 'ofertas/aplicable', { params: { codigo_producto: codigo } });
  const d = j.data || j;
  return {
    tiene_oferta: Boolean(d.tiene_oferta),
    codigo_oferta: d.codigo_oferta ?? null,
    descuento_ficha: Number(d.descuento_ficha) || 0,
    descuento_oferta: Number(d.descuento_oferta) || 0,
    descuento_total: Number(d.descuento_total) || 0,
  };
}

export async function productosConOfertaActiva() {
  const out = new Set();
  let after = null, paginas = 0;
  do {
    const j = await llamar('GET', 'ofertas', { params: { estado: 'activas', limit: 100, after } });
    for (const of of j.data || []) {

      for (const p of of.productos || []) {
        const cp = p?.codigo_producto ?? p?.codigo;
        if (cp != null) out.add(String(cp));
      }
    }
    after = j.pagination?.has_more ? j.pagination.next_after : null;
    paginas++;
  } while (after && paginas < 50);
  return out;
}
