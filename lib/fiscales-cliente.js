import { admin, configurado } from './admin.js';

const ESPACIO = 'fiscal';

const PESOS = [3, 7, 13, 17, 19, 23, 29, 37, 41, 43, 47, 53, 59, 67, 71];
export function calcularDv(nit) {
  const d = String(nit || '').replace(/\D/g, '');
  if (!d) return '';
  let suma = 0;
  for (let i = 0; i < d.length && i < PESOS.length; i++) {
    suma += parseInt(d.charAt(d.length - 1 - i), 10) * PESOS[i];
  }
  const r = suma % 11;
  return String(r < 2 ? r : 11 - r);
}

function e164(crudo) {
  const d = String(crudo || '').replace(/\D/g, '');
  if (!d) return null;
  const t10 = d.slice(-10);
  if (t10.length === 10 && t10.startsWith('3')) return '+57' + t10;
  if (d.length < 8 || d.length > 15) return null;
  return '+' + d;
}

const TIPOS_DOC = [
  ['13 - Cédula de ciudadanía', ['13', 'cc', 'cedula', 'cédula', 'cedula de ciudadania', 'cédula de ciudadanía', 'ciudadania']],
  ['31 - NIT', ['31', 'nit']],
  ['22 - Cédula de extranjería', ['22', 'ce', 'cedula de extranjeria', 'cédula de extranjería', 'extranjeria']],
  ['12 - Tarjeta de identidad', ['12', 'ti', 'tarjeta de identidad']],
  ['41 - Pasaporte', ['41', 'pasaporte']],
  ['47 - PEP', ['47', 'pep']],
  ['50 - NIT de otro país', ['50', 'nit de otro pais', 'nit de otro país', 'nit extranjero']],
];
const RESPS = [

  ['R-99-PN - No aplica / Otros', ['r-99-pn', 'r99pn', 'r-99', 'no aplica', 'no aplica / otros', 'otros', 'ninguna', 'no responsable de iva', 'no responsable', 'r-99-pn - no responsable de iva']],
  ['O-13 - Gran contribuyente', ['o-13', 'o13', 'gran contribuyente']],
  ['O-15 - Autorretenedor', ['o-15', 'o15', 'autorretenedor']],
  ['O-23 - Agente de retención de IVA', ['o-23', 'o23', 'agente de retencion de iva', 'agente de retención de iva', 'agente de retencion']],
  ['O-47 - Régimen simple de tributación', ['o-47', 'o47', 'regimen simple de tributacion', 'régimen simple de tributación', 'regimen simple', 'simple']],
];

function normaliza(valor, tabla) {
  const v = String(valor || '').trim().toLowerCase();
  if (!v) return '';
  for (const [canon, alias] of tabla) {
    if (canon.toLowerCase() === v) return canon;
    if (alias.some((a) => v === a || v.startsWith(a + ' ') || v.startsWith(a + '-'))) return canon;
  }

  const cod = v.match(/^(\d{2})/);
  if (cod) for (const [canon] of tabla) if (canon.startsWith(cod[1] + ' ')) return canon;
  return '';
}

function normalizaPersona(v) {
  const s = String(v || '').trim().toLowerCase();
  if (/jur/.test(s) || /empresa|sociedad|compan|s\.?a\.?s|ltda/.test(s)) return 'Jurídica';
  if (/natur|persona|cc|cedula|cédula/.test(s)) return 'Natural';
  return '';
}

const esNit = (tipoDoc) => /^31\b/.test(tipoDoc || '');
const CONSULTA = `
  query($q: String!) {
    customers(first: 5, query: $q) {
      nodes {
        id
        email
        phone
        numberOfOrders
        orders(first: 1) { nodes { id } }
        metafields(first: 10, namespace: "fiscal") { nodes { key value } }
      }
    }
  }`;

async function clientesPorTelefono(tel) {
  const d = await admin(CONSULTA, { q: `phone:${tel}` });
  return d.customers?.nodes ?? [];
}

function fiscalDeNodo(c) {
  const out = {};
  for (const m of c.metafields?.nodes ?? []) out[m.key] = m.value;
  return out;
}

export async function leerFiscalesDe(telefono) {
  if (!configurado()) return null;
  const tel = e164(telefono);
  if (!tel) return null;
  try {
    const nodos = await clientesPorTelefono(tel);
    let mejor = null,
      puntos = -1;
    for (const c of nodos) {
      const f = fiscalDeNodo(c);
      const n = Object.values(f).filter(Boolean).length;
      if (n > puntos) {
        puntos = n;
        mejor = n ? f : mejor;
      }
    }
    return mejor && Object.keys(mejor).length ? mejor : null;
  } catch {
    return null;
  }
}

export async function guardarFiscalesDe({
  telefono,
  tipoPersona,
  tipoDocumento,
  numeroDocumento,
  razonSocial = '',
  responsabilidadFiscal = '',
  correoFe = '',
  nombre = '',
}) {
  if (!configurado()) return { ok: false, motivo: 'sin_admin' };
  const tel = e164(telefono);
  if (!tel) return { ok: false, motivo: 'sin_telefono' };

  const { datos, error } = armarDatos({ tipoPersona, tipoDocumento, numeroDocumento, razonSocial, responsabilidadFiscal, correoFe });
  if (error) return error;

  try {
    let objetivos = (await clientesPorTelefono(tel)).map((c) => c.id);

    if (!objetivos.length) {
      const partesNombre = String(nombre || '').trim().split(/\s+/);
      const d = await admin(
        `mutation($input: CustomerInput!) { customerCreate(input: $input) { customer { id } userErrors { field message } } }`,
        {
          input: {
            phone: tel,
            firstName: partesNombre[0] || undefined,
            lastName: partesNombre.slice(1).join(' ') || undefined,
          },
        }
      );
      const err = d.customerCreate?.userErrors ?? [];
      const nuevo = d.customerCreate?.customer?.id;
      if (nuevo) objetivos = [nuevo];
      else return { ok: false, motivo: 'no_pude_crear', detalle: err.map((e) => e.message).join(' | ') };
    }

    return await escribirFiscales(objetivos, datos);
  } catch (e) {
    return { ok: false, motivo: 'excepcion', detalle: e?.message };
  }
}

function armarDatos({ tipoPersona, tipoDocumento, numeroDocumento, razonSocial, responsabilidadFiscal, correoFe }) {
  const numero = String(numeroDocumento || '').replace(/[^0-9A-Za-z-]/g, '').trim();
  if (!numero) return { error: { ok: false, motivo: 'falta_numero' } };
  const persona = normalizaPersona(tipoPersona) || 'Natural';
  const tipoDoc = normaliza(tipoDocumento, TIPOS_DOC) || (persona === 'Jurídica' ? '31 - NIT' : '13 - Cédula de ciudadanía');
  const correo = String(correoFe || '').trim().toLowerCase();
  if (correo && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(correo)) return { error: { ok: false, motivo: 'correo_invalido' } };
  const razon = persona === 'Jurídica' ? String(razonSocial || '').trim() : '';
  if (persona === 'Jurídica' && !razon) return { error: { ok: false, motivo: 'falta_razon_social' } };
  const resp = persona === 'Jurídica' ? normaliza(responsabilidadFiscal, RESPS) : '';
  return {
    datos: {
      tipo_persona: persona,
      tipo_documento: tipoDoc,
      numero_documento: numero,
      dv: esNit(tipoDoc) ? calcularDv(numero) : '',
      razon_social: razon,
      responsabilidad_fiscal: resp,
      correo_fe: correo,
    },
  };
}

const LIMITES = { tipo_persona: 200, tipo_documento: 200, numero_documento: 40, dv: 2, razon_social: 300, responsabilidad_fiscal: 200, correo_fe: 300 };

async function escribirFiscales(objetivos, datos) {
  const campos = (ownerId) =>
    Object.entries(datos)
      .filter(([, v]) => v !== '' && v != null)
      .map(([key, value]) => ({ ownerId, namespace: ESPACIO, key, type: 'single_line_text_field', value: String(value).slice(0, LIMITES[key]) }));
  const metafields = objetivos.flatMap(campos);

  for (let i = 0; i < metafields.length; i += 25) {
    const lote = metafields.slice(i, i + 25);
    const d = await admin(
      `mutation($m: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $m) { userErrors { field message } } }`,
      { m: lote }
    );
    const err = d.metafieldsSet?.userErrors ?? [];
    if (err.length) return { ok: false, motivo: 'rechazado', detalle: JSON.stringify(err).slice(0, 200) };
  }
  return { ok: true, datos, clientes: objetivos.length };
}

const gidCliente = (id) => (String(id).startsWith('gid://') ? String(id) : `gid://shopify/Customer/${String(id).replace(/\D/g, '')}`);

export async function leerFiscalesDeCliente(clienteId) {
  if (!configurado() || !clienteId) return null;
  try {
    const d = await admin(
      `query($id: ID!) { customer(id: $id) { metafields(first: 10, namespace: "fiscal") { nodes { key value } } } }`,
      { id: gidCliente(clienteId) }
    );
    const f = fiscalDeNodo(d.customer || {});
    return Object.values(f).some(Boolean) ? f : null;
  } catch {
    return null;
  }
}

export async function guardarFiscalesDeCliente({ clienteId, ...resto }) {
  if (!configurado()) return { ok: false, motivo: 'sin_admin' };
  if (!clienteId) return { ok: false, motivo: 'sin_cliente' };
  const { datos, error } = armarDatos(resto);
  if (error) return error;
  try {
    return await escribirFiscales([gidCliente(clienteId)], datos);
  } catch (e) {
    return { ok: false, motivo: 'excepcion', detalle: e?.message };
  }
}

export async function parametrosCheckoutPorTelefono(telefono, { nombre = '' } = {}) {
  if (!configurado()) return '';
  const tel = e164(telefono);
  if (!tel) return '';
  try {
    const d = await admin(
      `query($q: String!) {
         customers(first: 5, query: $q) {
           nodes {
             firstName lastName email phone
             defaultAddress { firstName lastName company address1 address2 city province zip country phone }
             orders(first: 1, sortKey: CREATED_AT, reverse: true) { nodes { shippingAddress { firstName lastName company address1 address2 city province zip country phone } email } }
             metafields(first: 10, namespace: "fiscal") { nodes { key value } }
           }
         }
       }`,
      { q: `phone:${tel}` }
    );
    const nodos = d.customers?.nodes ?? [];
    if (!nodos.length && !nombre) return '';

    const conDir = nodos.find((c) => c.defaultAddress?.address1) || nodos.find((c) => c.orders?.nodes?.[0]?.shippingAddress?.address1) || nodos[0] || {};
    const dir = conDir.defaultAddress?.address1 ? conDir.defaultAddress : conDir.orders?.nodes?.[0]?.shippingAddress || {};
    const fiscal = Object.fromEntries((conDir.metafields?.nodes ?? []).map((m) => [m.key, m.value]));
    const partes = String(nombre || '').trim().split(/\s+/);
    const p = new URLSearchParams();
    const email = fiscal.correo_fe || conDir.email || conDir.orders?.nodes?.[0]?.email;
    if (email) p.set('checkout[email]', email);
    const campos = {
      first_name: dir.firstName || conDir.firstName || partes[0] || '',
      last_name: dir.lastName || conDir.lastName || partes.slice(1).join(' ') || '',
      company: /jur/i.test(fiscal.tipo_persona || '') && fiscal.razon_social ? fiscal.razon_social : dir.company || '',
      phone: dir.phone || conDir.phone || tel,
      address1: dir.address1 || '', address2: dir.address2 || '', city: dir.city || '', province: dir.province || '', zip: dir.zip || '', country: dir.country || (dir.address1 ? 'Colombia' : ''),
    };
    for (const [k, v] of Object.entries(campos)) if (v) p.set(`checkout[shipping_address][${k}]`, String(v).slice(0, 120));

    for (const [k, v] of Object.entries(atributosFiscales(fiscal))) p.set(`attributes[${k}]`, v);
    return p.toString();
  } catch {
    return '';
  }
}

const CLAVES_ATRIBUTO = {
  tipo_persona: 'Tipo de persona',
  tipo_documento: 'Tipo de documento',
  numero_documento: 'Número de documento',
  dv: 'DV',
  razon_social: 'Razón social',
  responsabilidad_fiscal: 'Responsabilidad fiscal',
  correo_fe: 'Correo factura electrónica',
};
export function atributosFiscales(fiscal) {
  const out = {};
  if (!fiscal || !fiscal.numero_documento) return out;
  for (const [k, clave] of Object.entries(CLAVES_ATRIBUTO)) if (fiscal[k]) out[clave] = String(fiscal[k]).slice(0, 250);
  return out;
}

export async function anotarFiscalEnPedido({ orderId, customerId, telefono, atributosActuales = [] }) {
  if (!configurado() || !orderId) return false;
  const yaTiene = (atributosActuales || []).some((a) => /n[uú]mero de documento/i.test(a?.name || a?.key || '') && String(a?.value || '').trim());
  if (yaTiene) return false;
  try {
    let fiscal = null;
    if (customerId) {
      const d = await admin(
        `query($id: ID!) { customer(id: $id) { metafields(first: 10, namespace: "fiscal") { nodes { key value } } } }`,
        { id: gidCliente(customerId) }
      );
      fiscal = fiscalDeNodo(d.customer || {});
    }
    if (!fiscal?.numero_documento && telefono) fiscal = await leerFiscalesDe(telefono);
    const nuevos = atributosFiscales(fiscal);
    if (!Object.keys(nuevos).length) return false;
    const actuales = (atributosActuales || []).filter((a) => (a?.name || a?.key) && a?.value != null).map((a) => ({ key: a.name || a.key, value: String(a.value) }));
    const fusion = [...actuales.filter((a) => !(a.key in nuevos)), ...Object.entries(nuevos).map(([key, value]) => ({ key, value }))];
    const gidOrden = String(orderId).startsWith('gid://') ? String(orderId) : `gid://shopify/Order/${String(orderId).replace(/\D/g, '')}`;
    const r = await admin(
      `mutation($input: OrderInput!) { orderUpdate(input: $input) { order { id } userErrors { field message } } }`,
      { input: { id: gidOrden, customAttributes: fusion } }
    );
    const err = r.orderUpdate?.userErrors ?? [];
    if (err.length) { console.error('[fiscal] orderUpdate rechazado:', err.map((e) => e.message).join(' | ')); return false; }
    return true;
  } catch (e) {
    console.error('[fiscal] no se pudo anotar el pedido:', e?.message);
    return false;
  }
}

export async function datosDeCliente(clienteId) {
  if (!configurado() || !clienteId) return null;
  try {
    const d = await admin(`query($id: ID!) { customer(id: $id) { displayName email phone } }`, { id: gidCliente(clienteId) });
    const c = d.customer;
    return c ? { nombre: c.displayName || '', correo: c.email || '', telefono: c.phone || '' } : null;
  } catch {
    return null;
  }
}

export async function asegurarFiscalDelPedido({ customerId, telefono }) {
  if (!configurado() || !customerId) return false;
  try {
    const gid = `gid://shopify/Customer/${customerId}`;

    const yaTiene = await admin(
      `query($id: ID!) { customer(id: $id) { metafields(first: 10, namespace: "fiscal") { nodes { key value } } } }`,
      { id: gid }
    );
    const actuales = (yaTiene.customer?.metafields?.nodes ?? []).filter((m) => m.value);
    if (actuales.some((m) => m.key === 'numero_documento')) return false;

    const datos = await leerFiscalesDe(telefono);
    if (!datos || !datos.numero_documento) return false;

    const metafields = Object.entries(datos)
      .filter(([k, v]) => v && k in LIMITES)
      .map(([key, value]) => ({ ownerId: gid, namespace: ESPACIO, key, type: 'single_line_text_field', value: String(value).slice(0, LIMITES[key]) }));
    if (!metafields.length) return false;

    const d = await admin(
      `mutation($m: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $m) { userErrors { message } } }`,
      { m: metafields }
    );
    return !(d.metafieldsSet?.userErrors ?? []).length;
  } catch {
    return false;
  }
}
