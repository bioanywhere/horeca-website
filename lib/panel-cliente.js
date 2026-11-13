import { admin } from './admin.js';
import { consultar, unaFila, hayBaseDeDatos } from './bd.js';

export function telefonoE164(crudo) {
  const d = String(crudo || '').replace(/\D/g, '');
  if (!d) return null;

  if (d.length === 10 && d.startsWith('3')) return '+57' + d;
  if (d.length < 8 || d.length > 15) return null;
  return '+' + d;
}

export function correoLimpio(crudo) {
  const c = String(crudo || '').trim().toLowerCase();
  return /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(c) ? c : null;
}

export const CONSULTA_CLIENTE = `
  query($q: String!) {
    customers(first: 3, query: $q) {
      nodes {
        id
        displayName
        email
        phone
        createdAt
        numberOfOrders
        amountSpent { amount currencyCode }
        tags
        note
        metafields(first: 10, namespace: "fiscal") { nodes { key value } }
        orders(first: 10, sortKey: CREATED_AT, reverse: true) {
          nodes {
            id
            name
            createdAt
            displayFinancialStatus
            displayFulfillmentStatus
            totalPriceSet { shopMoney { amount currencyCode } }
            lineItems(first: 6) { nodes { title quantity } }
          }
        }
      }
    }
  }`;

async function buscarEnShopify(tel, correo) {
  const intentos = [];
  if (tel) intentos.push({ q: `phone:${tel}`, via: 'telefono' });
  if (correo) intentos.push({ q: `email:${correo}`, via: 'correo' });

  const porId = new Map();
  let via = null;
  for (const { q, via: v } of intentos) {
    const d = await admin(CONSULTA_CLIENTE, { q });
    const nodos = d.customers?.nodes ?? [];
    for (const c of nodos) if (!porId.has(c.id)) porId.set(c.id, c);
    if (!via && nodos.length) via = v;
  }
  return { candidatos: [...porId.values()], via };
}

async function leerAsesor(tel) {
  if (!hayBaseDeDatos || !tel) return null;

  const clave = tel.replace(/^\+/, '');
  const [conv, mensajes] = await Promise.all([
    unaFila('select nombre, memoria, creada, actualizada from conversaciones where telefono = $1', [clave]),
    consultar(
      `select rol, texto, creado from mensajes
        where telefono = $1 order by creado desc, id desc limit 6`,
      [clave]
    ),
  ]);
  if (!conv) return null;
  return {
    nombre: conv.nombre,
    memoria: conv.memoria || {},
    desde: conv.creada,
    ultimaVez: conv.actualizada,
    mensajes: mensajes.reverse(),
  };
}

export async function fichaCliente({ telefono, correo }) {
  const tel = telefonoE164(telefono);
  const mail = correoLimpio(correo);

  const [shop, asesor] = await Promise.all([buscarEnShopify(tel, mail), leerAsesor(tel)]);
  const candidatos = shop.candidatos || [];

  const porPedido = new Map();
  for (const c of candidatos) {
    for (const o of c.orders?.nodes ?? []) if (!porPedido.has(o.id)) porPedido.set(o.id, o);
  }
  const pedidos = [...porPedido.values()]
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map((o) => ({
      id: o.id.split('/').pop(),
      nombre: o.name,
      fecha: o.createdAt,
      pago: o.displayFinancialStatus,
      despacho: o.displayFulfillmentStatus,
      total: o.totalPriceSet?.shopMoney,
      lineas: (o.lineItems?.nodes ?? []).map((l) => ({ titulo: l.title, cantidad: l.quantity })),
    }));

  const c =
    candidatos.find((x) => (x.metafields?.nodes ?? []).length) ||
    candidatos.find((x) => (x.orders?.nodes ?? []).length) ||
    candidatos[0] || null;

  const correoFicha = c?.email || candidatos.map((x) => x.email).find(Boolean) || null;
  const telFicha = c?.phone || candidatos.map((x) => x.phone).find(Boolean) || null;

  return {
    buscado: { telefono: tel, correo: mail },
    encontradoPor: shop.via,
    duplicados: candidatos.length > 1 ? candidatos.length : undefined,
    cliente: c && {
      id: c.id.split('/').pop(),
      nombre: c.displayName,
      correo: correoFicha,
      telefono: telFicha,
      desde: c.createdAt,
      pedidos: pedidos.length,
      gastado: c.amountSpent,
      etiquetas: c.tags,
      nota: c.note,
      fiscal: Object.fromEntries((c.metafields?.nodes ?? []).map((m) => [m.key, m.value])),
    },
    pedidos,
    asesor,
  };
}
