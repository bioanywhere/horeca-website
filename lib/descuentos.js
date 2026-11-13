import { admin, configurado } from './admin.js';

const ALFABETO = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function sufijo(n = 5) {
  let s = '';
  for (let i = 0; i < n; i++) s += ALFABETO[Math.floor(Math.random() * ALFABETO.length)];
  return s;
}

function esFaltaDePermiso(msg) {
  return /access denied|write_discounts|required access/i.test(String(msg || ''));
}

export function describirRecompensa({ tipo, valor }) {
  switch (tipo) {
    case 'porcentaje': return `${Number(valor)}% de descuento en tu próximo pedido`;
    case 'monto':      return `$${Number(valor).toLocaleString('es-CO')} de descuento en tu próximo pedido`;
    case 'domicilio':  return 'domicilio gratis en tu próximo pedido';
    case 'producto':   return 'un producto de regalo en tu próximo pedido';
    default:           return 'un beneficio en tu próximo pedido';
  }
}

function entradaBasica({ codigo, tipo, valor, venceDias, etiqueta }) {
  const startsAt = new Date().toISOString();
  const endsAt = venceDias ? new Date(Date.now() + venceDias * 86400000).toISOString() : null;
  const value =
    tipo === 'porcentaje'
      ? { percentage: Math.max(0, Math.min(1, Number(valor) / 100)) }
      : { discountAmount: { amount: String(Number(valor)), appliesOnEachItem: false } };
  return {
    title: etiqueta,
    code: codigo,
    startsAt,
    ...(endsAt ? { endsAt } : {}),
    customerSelection: { all: true },
    customerGets: { value, items: { all: true } },
    appliesOncePerCustomer: true,
    usageLimit: 1,
  };
}

async function crearBasico(input) {
  const q = `mutation($d:DiscountCodeBasicInput!){
    discountCodeBasicCreate(basicCodeDiscount:$d){
      codeDiscountNode{ id } userErrors{ field message } } }`;
  const r = await admin(q, { d: input });
  return r.discountCodeBasicCreate;
}

async function crearEnvio({ codigo, venceDias, etiqueta }) {
  const startsAt = new Date().toISOString();
  const endsAt = venceDias ? new Date(Date.now() + venceDias * 86400000).toISOString() : null;
  const q = `mutation($d:DiscountCodeFreeShippingInput!){
    discountCodeFreeShippingCreate(freeShippingCodeDiscount:$d){
      codeDiscountNode{ id } userErrors{ field message } } }`;
  const input = {
    title: etiqueta, code: codigo, startsAt, ...(endsAt ? { endsAt } : {}),
    customerSelection: { all: true },
    destination: { all: true },
    appliesOncePerCustomer: true,
    usageLimit: 1,
  };
  const r = await admin(q, { d: input });
  return r.discountCodeFreeShippingCreate;
}

async function crearRegalo({ codigo, productoVariante, venceDias, etiqueta }) {
  const startsAt = new Date().toISOString();
  const endsAt = venceDias ? new Date(Date.now() + venceDias * 86400000).toISOString() : null;
  const gid = String(productoVariante).startsWith('gid://')
    ? productoVariante
    : `gid://shopify/ProductVariant/${productoVariante}`;
  const q = `mutation($d:DiscountCodeBxgyInput!){
    discountCodeBxgyCreate(bxgyCodeDiscount:$d){
      codeDiscountNode{ id } userErrors{ field message } } }`;
  const input = {
    title: etiqueta, code: codigo, startsAt, ...(endsAt ? { endsAt } : {}),
    customerSelection: { all: true },
    customerBuys: { value: { quantity: '1' }, items: { all: true } },
    customerGets: {
      value: { discountOnQuantity: { quantity: '1', effect: { percentage: 1.0 } } },
      items: { products: { productVariantsToAdd: [gid] } },
    },
    usesPerOrderLimit: '1',
    appliesOncePerCustomer: true,
    usageLimit: 1,
  };
  const r = await admin(q, { d: input });
  return r.discountCodeBxgyCreate;
}

export async function crearRecompensa({ tipo, valor, productoVariante, venceDias = 30, etiqueta = 'Referido HORECA' }) {
  if (!configurado()) return { ok: false, motivo: 'no_configurado' };
  if ((tipo === 'porcentaje' || tipo === 'monto') && !(Number(valor) > 0)) return { ok: false, motivo: 'datos_incompletos' };
  if (tipo === 'producto' && !productoVariante) return { ok: false, motivo: 'datos_incompletos' };

  const codigo = 'AMIGO' + sufijo();
  try {
    let res;
    if (tipo === 'domicilio') res = await crearEnvio({ codigo, venceDias, etiqueta });
    else if (tipo === 'producto') res = await crearRegalo({ codigo, productoVariante, venceDias, etiqueta });
    else res = await crearBasico(entradaBasica({ codigo, tipo, valor, venceDias, etiqueta }));

    if (res.userErrors?.length) {
      const msg = res.userErrors.map((e) => e.message).join(' | ');
      return { ok: false, motivo: esFaltaDePermiso(msg) ? 'sin_permiso' : 'error', detalle: msg };
    }
    return { ok: true, codigo, id: res.codeDiscountNode?.id, descripcion: describirRecompensa({ tipo, valor }) };
  } catch (e) {
    return { ok: false, motivo: esFaltaDePermiso(e?.message) ? 'sin_permiso' : 'error', detalle: e?.message };
  }
}
