import { admin, configurado } from './admin.js';

const DEPARTAMENTOS = {
  amazonas: 'AMA', antioquia: 'ANT', arauca: 'ARA', atlantico: 'ATL', bogota: 'DC', 'bogota dc': 'DC', 'bogota d.c.': 'DC', bolivar: 'BOL', boyaca: 'BOY', caldas: 'CAL', caqueta: 'CAQ', casanare: 'CAS', cauca: 'CAU', cesar: 'CES', choco: 'CHO', cordoba: 'COR', cundinamarca: 'CUN', guainia: 'GUA', guaviare: 'GUV', huila: 'HUI', 'la guajira': 'LAG', guajira: 'LAG', magdalena: 'MAG', meta: 'MET', narino: 'NAR', 'norte de santander': 'NSA', putumayo: 'PUT', quindio: 'QUI', risaralda: 'RIS', 'san andres': 'SAP', 'san andres y providencia': 'SAP', santander: 'SAN', sucre: 'SUC', tolima: 'TOL', 'valle del cauca': 'VAC', valle: 'VAC', vaupes: 'VAU', vichada: 'VID',
};

const CIUDAD_DEP = { barranquilla: 'ATL', soledad: 'ATL', malambo: 'ATL', 'puerto colombia': 'ATL', galapa: 'ATL', sabanalarga: 'ATL', baranoa: 'ATL', cartagena: 'BOL', 'santa marta': 'MAG', bogota: 'DC', medellin: 'ANT', cali: 'VAC', bucaramanga: 'SAN', cucuta: 'NSA', pereira: 'RIS', manizales: 'CAL', armenia: 'QUI', ibague: 'TOL', neiva: 'HUI', pasto: 'NAR', monteria: 'COR', sincelejo: 'SUC', valledupar: 'CES', riohacha: 'LAG', villavicencio: 'MET', tunja: 'BOY', popayan: 'CAU' };

const sinTildes = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
function e164(crudo) {
  const d = String(crudo || '').replace(/\D/g, '');
  if (!d) return null;
  const t10 = d.slice(-10);
  if (t10.length === 10 && t10.startsWith('3')) return '+57' + t10;
  return d.length >= 8 && d.length <= 15 ? '+' + d : null;
}
function codigoDepartamento(departamento, ciudad) {
  const d = sinTildes(departamento).replace(/\bd\.?c\.?\b/, 'dc');
  if (d && DEPARTAMENTOS[d]) return DEPARTAMENTOS[d];
  const c = sinTildes(ciudad);
  if (c && CIUDAD_DEP[c]) return CIUDAD_DEP[c];
  return null;
}

const CAMPOS_DIR = `id firstName lastName company address1 address2 city province provinceCode zip phone`;

async function clientesPorTelefono(tel) {
  const d = await admin(
    `query($q: String!) { customers(first: 5, query: $q) { nodes { id firstName lastName defaultAddress { id } addresses(first: 10) { ${CAMPOS_DIR} } } } }`,
    { q: `phone:${tel}` }
  );
  return d.customers?.nodes ?? [];
}

const legible = (a) => ({
  id: a.id,
  etiqueta: [a.company, a.address1, a.address2, a.city, a.province].filter(Boolean).join(', '),
  direccion: a.address1 || '',
  complemento: a.address2 || '',
  ciudad: a.city || '',
  departamento: a.province || '',
  empresa: a.company || '',
  nombre: [a.firstName, a.lastName].filter(Boolean).join(' '),
});

export async function direccionesDe(telefono) {
  if (!configurado()) return [];
  const tel = e164(telefono);
  if (!tel) return [];
  try {
    const nodos = await clientesPorTelefono(tel);
    const vistas = new Set();
    const out = [];
    for (const c of nodos) {
      const pred = c.defaultAddress?.id;
      for (const a of c.addresses ?? []) {
        const clave = sinTildes(`${a.address1}|${a.city}`);
        if (!a.address1 || vistas.has(clave)) continue;
        vistas.add(clave);
        out.push({ ...legible(a), predeterminada: a.id === pred });
      }
    }
    return out.sort((x, y) => Number(y.predeterminada) - Number(x.predeterminada));
  } catch {
    return [];
  }
}

export async function guardarDireccionDe({ telefono, nombre = '', direccion, complemento = '', ciudad, departamento = '', empresa = '', indicaciones = '' }) {
  if (!configurado()) return { ok: false, motivo: 'sin_admin' };
  const tel = e164(telefono);
  if (!tel) return { ok: false, motivo: 'sin_telefono' };
  const dir1 = String(direccion || '').trim();
  const city = String(ciudad || '').trim();
  if (!dir1) return { ok: false, motivo: 'falta_direccion' };
  if (!city) return { ok: false, motivo: 'falta_ciudad' };
  const provinceCode = codigoDepartamento(departamento, city);
  if (!provinceCode) return { ok: false, motivo: 'falta_departamento', detalle: 'No reconocí el departamento; pídeselo al cliente (p. ej. Atlántico, Bolívar, Cundinamarca).' };

  const partes = String(nombre || '').trim().split(/\s+/).filter(Boolean);
  const address2 = [String(complemento || '').trim(), String(indicaciones || '').trim()].filter(Boolean).join(' · ').slice(0, 250);
  try {
    let nodos = await clientesPorTelefono(tel);
    let cliente = nodos[0];
    if (!cliente) {
      const d = await admin(
        `mutation($input: CustomerInput!) { customerCreate(input: $input) { customer { id firstName lastName } userErrors { message } } }`,
        { input: { phone: tel, firstName: partes[0] || undefined, lastName: partes.slice(1).join(' ') || undefined } }
      );
      cliente = d.customerCreate?.customer;
      if (!cliente) return { ok: false, motivo: 'no_pude_crear', detalle: (d.customerCreate?.userErrors ?? []).map((e) => e.message).join(' | ') };
    }
    const address = {
      firstName: partes[0] || cliente.firstName || undefined,
      lastName: partes.slice(1).join(' ') || cliente.lastName || undefined,
      company: String(empresa || '').trim() || undefined,
      address1: dir1.slice(0, 250),
      address2: address2 || undefined,
      city: city.slice(0, 100),
      provinceCode,
      countryCode: 'CO',
      phone: tel,
    };
    const r = await admin(
      `mutation($id: ID!, $address: MailingAddressInput!) { customerAddressCreate(customerId: $id, address: $address, setAsDefault: true) { address { ${CAMPOS_DIR} } userErrors { field message } } }`,
      { id: cliente.id, address }
    );
    const err = r.customerAddressCreate?.userErrors ?? [];
    if (err.length) return { ok: false, motivo: 'rechazada', detalle: err.map((e) => e.message).join(' | ') };
    return { ok: true, direccion: { ...legible(r.customerAddressCreate.address), predeterminada: true } };
  } catch (e) {
    return { ok: false, motivo: 'excepcion', detalle: e?.message };
  }
}

export async function borrarDireccion(clienteId, direccionId) {
  const r = await admin(`mutation($c: ID!, $id: ID!) { customerAddressDelete(customerId: $c, addressId: $id) { deletedAddressId userErrors { message } } }`, { c: clienteId, id: direccionId });
  return Boolean(r.customerAddressDelete?.deletedAddressId);
}
