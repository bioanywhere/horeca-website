import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const aqui = dirname(fileURLToPath(import.meta.url));
const TOKEN = readFileSync(join(aqui, '..', '..', 'token_admin.txt'), 'utf8').trim();
const TIENDA = 'hwmtxn-nj.myshopify.com';
const API = `https://${TIENDA}/admin/api/2024-10/graphql.json`;

const [, , comando = 'ver', ...flags] = process.argv;
const DRY = flags.includes('--dry');

const RECREAR = flags.includes('--recrear');
const esCompuesta = (t) => String(t.id).includes('?source=');

async function gql(query, variables) {
  const r = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': TOKEN },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json();
  if (j.errors?.length) throw new Error(j.errors.map((e) => e.message).join(' | '));
  return j.data;
}

const pesos = (n) => '$' + Math.round(Number(n) || 0).toLocaleString('es-CO');

async function leerPerfil() {
  const d = await gql(`{
    deliveryProfiles(first: 5) { nodes { id name default
      profileLocationGroups { locationGroup { id }
        locationGroupZones(first: 30) { nodes {
          zone { id name countries { code { countryCode } provinces { code name } } }
          methodDefinitions(first: 30) { nodes { id name active
            rateProvider { __typename ... on DeliveryRateDefinition { id price { amount currencyCode } } }
            methodConditions { id field operator conditionCriteria { __typename ... on MoneyV2 { amount } ... on Weight { value unit } } }
          } } } } } } } }`);
  const perfil = d.deliveryProfiles.nodes.find((p) => p.default) || d.deliveryProfiles.nodes[0];
  const grupo = perfil.profileLocationGroups[0];
  const zonas = grupo.locationGroupZones.nodes.map((lz) => ({
    id: lz.zone.id,
    nombre: lz.zone.name,
    provincias: (lz.zone.countries.find((c) => c.code.countryCode === 'CO')?.provinces || []).map((p) => p.code),
    provinciasNombres: Object.fromEntries((lz.zone.countries[0]?.provinces || []).map((p) => [p.code, p.name])),
    tarifas: lz.methodDefinitions.nodes
      .map((m) => {
        const min = m.methodConditions.find((c) => c.field === 'TOTAL_PRICE' && c.operator === 'GREATER_THAN_OR_EQUAL_TO');
        const max = m.methodConditions.find((c) => c.field === 'TOTAL_PRICE' && c.operator === 'LESS_THAN_OR_EQUAL_TO');
        return {
          id: m.id,
          nombre: m.name,
          activa: m.active,
          precio: Number(m.rateProvider?.price?.amount ?? 0),
          rateId: m.rateProvider?.id,
          desde: min ? Number(min.conditionCriteria.amount) : 0,
          hasta: max ? Number(max.conditionCriteria.amount) : null,
          condMinId: min?.id || null,
          condMaxId: max?.id || null,
          otrasCond: m.methodConditions.filter((c) => c !== min && c !== max).length,
        };
      })
      .sort((a, b) => a.desde - b.desde),
  }));
  return { perfilId: perfil.id, grupoId: grupo.locationGroup.id, zonas };
}

function imprimir({ zonas }) {
  for (const z of zonas) {
    console.log(`\n${z.nombre}  [${z.provincias.length} dptos: ${z.provincias.join(', ')}]`);
    if (!z.tarifas.length) console.log('   (sin tarifas)');
    for (const t of z.tarifas) {
      const rango = t.hasta == null ? `desde ${pesos(t.desde)}` : `${pesos(t.desde)} – ${pesos(t.hasta)}`;
      console.log(`   ${t.nombre.padEnd(38)} ${rango.padEnd(28)} → ${t.precio ? pesos(t.precio) : 'gratis'}${t.activa ? '' : '  (inactiva)'}`);
    }
  }
}

function rangosDe(zona) {
  let desde = 0;
  return zona.rangos.map((r) => {
    const out = { desde, hasta: r.hasta, precio: Number(r.precio) };
    desde = r.hasta == null ? null : Math.round((r.hasta + 0.01) * 100) / 100;
    return out;
  });
}

const condNueva = (operator, amount, moneda) => ({ operator, criteria: { amount: String(amount), currencyCode: moneda } });
const condActualizar = (id, operator, amount, moneda) => ({ id, field: 'TOTAL_PRICE', operator, criteria: Number(amount), criteriaUnit: moneda });

function definicionNueva(zona, r, moneda) {
  const priceConditionsToCreate = [condNueva('GREATER_THAN_OR_EQUAL_TO', r.desde, moneda)];
  if (r.hasta != null) priceConditionsToCreate.push(condNueva('LESS_THAN_OR_EQUAL_TO', r.hasta, moneda));

  const sinRangos = zona.rangos.length === 1 && r.hasta == null && r.desde === 0;
  return {
    name: zona.tarifa,
    active: true,
    rateDefinition: { price: { amount: String(r.precio), currencyCode: moneda } },
    ...(sinRangos ? {} : { priceConditionsToCreate }),
  };
}

function planear(actual, deseado) {
  const moneda = deseado.moneda || 'COP';
  const zonesToCreate = [];
  const zonesToUpdate = [];
  const methodDefinitionsToDelete = [];
  const avisos = [];
  const resumen = [];

  for (const zd of deseado.zonas) {
    const rangos = rangosDe(zd);
    const za = actual.zonas.find((z) => z.nombre.trim().toLowerCase() === zd.nombre.trim().toLowerCase());
    const countries = [{ code: 'CO', provinces: zd.provincias.map((code) => ({ code })) }];

    if (!za) {
      zonesToCreate.push({ name: zd.nombre, countries, methodDefinitionsToCreate: rangos.map((r) => definicionNueva(zd, r, moneda)) });
      resumen.push(`CREAR zona «${zd.nombre}» (${zd.provincias.length} dptos, ${rangos.length} rango(s))`);
      continue;
    }

    const cambiosZona = { id: za.id, name: zd.nombre };
    const provIguales = za.provincias.length === zd.provincias.length && zd.provincias.every((c) => za.provincias.includes(c));
    if (!provIguales) {
      cambiosZona.countries = countries;
      resumen.push(`«${zd.nombre}»: departamentos ${za.provincias.join(',')} → ${zd.provincias.join(',')}`);
    }

    const compuestas = za.tarifas.some(esCompuesta);
    const mismoNumero = !RECREAR && !compuestas && za.tarifas.length === rangos.length && za.tarifas.every((t) => t.otrasCond === 0);
    if (!mismoNumero && !RECREAR && compuestas) {

      const igual = za.tarifas.length === rangos.length && za.tarifas.every((t, i) => t.precio === rangos[i].precio && t.desde === rangos[i].desde && (t.hasta ?? null) === (rangos[i].hasta ?? null) && t.nombre === zd.tarifa);
      if (igual && provIguales) {
        avisos.push(`«${zd.nombre}»: coincide, pero sus tarifas son de solo lectura por API (creadas en la UI); usa --recrear una vez para poder editarlas por script.`);
        continue;
      }
    }
    if (mismoNumero) {
      const updates = [];
      za.tarifas.forEach((t, i) => {
        const r = rangos[i];
        const difiere = t.precio !== r.precio || t.desde !== r.desde || (t.hasta ?? null) !== (r.hasta ?? null) || t.nombre !== zd.tarifa || !t.activa;
        if (!difiere) return;
        const u = { id: t.id, name: zd.tarifa, active: true, rateDefinition: { id: t.rateId, price: { amount: String(r.precio), currencyCode: moneda } } };
        const conditionsToUpdate = [];
        const priceConditionsToCreate = [];
        if (t.condMinId) conditionsToUpdate.push(condActualizar(t.condMinId, 'GREATER_THAN_OR_EQUAL_TO', r.desde, moneda));
        else if (!(rangos.length === 1 && r.hasta == null)) priceConditionsToCreate.push(condNueva('GREATER_THAN_OR_EQUAL_TO', r.desde, moneda));
        if (r.hasta != null) {
          if (t.condMaxId) conditionsToUpdate.push(condActualizar(t.condMaxId, 'LESS_THAN_OR_EQUAL_TO', r.hasta, moneda));
          else priceConditionsToCreate.push(condNueva('LESS_THAN_OR_EQUAL_TO', r.hasta, moneda));
        } else if (t.condMaxId) {

          methodDefinitionsToDelete.push(t.id);
          (cambiosZona.methodDefinitionsToCreate ??= []).push(definicionNueva(zd, r, moneda));
          resumen.push(`«${zd.nombre}» rango ${i + 1}: se recrea (pierde tope)`);
          return;
        }
        if (conditionsToUpdate.length) u.conditionsToUpdate = conditionsToUpdate;
        if (priceConditionsToCreate.length) u.priceConditionsToCreate = priceConditionsToCreate;
        updates.push(u);
        resumen.push(`«${zd.nombre}» rango ${i + 1}: ${pesos(t.desde)}–${t.hasta == null ? '∞' : pesos(t.hasta)} ${pesos(t.precio)} → ${pesos(r.desde)}–${r.hasta == null ? '∞' : pesos(r.hasta)} ${pesos(r.precio)}`);
      });
      if (updates.length) cambiosZona.methodDefinitionsToUpdate = updates;
    } else {
      methodDefinitionsToDelete.push(...za.tarifas.map((t) => t.id));
      cambiosZona.methodDefinitionsToCreate = rangos.map((r) => definicionNueva(zd, r, moneda));
      resumen.push(`«${zd.nombre}»: ${za.tarifas.length} tarifa(s) → ${rangos.length} rango(s) (se recrean${compuestas ? ' en modelo clásico editable' : ''}; sin tiempo de tránsito)`);
    }

    if (Object.keys(cambiosZona).length > 2) zonesToUpdate.push(cambiosZona);
  }

  for (const za of actual.zonas) {
    if (!deseado.zonas.some((zd) => zd.nombre.trim().toLowerCase() === za.nombre.trim().toLowerCase())) {
      avisos.push(`La zona «${za.nombre}» está en Shopify pero no en envios.json: se deja como está.`);
    }
  }
  return { zonesToCreate, zonesToUpdate, methodDefinitionsToDelete, resumen, avisos };
}

const actual = await leerPerfil();

if (comando === 'ver') {
  console.log(`Perfil ${actual.perfilId} · grupo ${actual.grupoId}`);
  imprimir(actual);
  console.log('\n(Entrega local por radio y retiro en tienda no salen aquí: solo en el admin.)');
  process.exit(0);
}

if (comando !== 'aplicar') {
  console.error('Uso: node scripts/envios.js ver | aplicar [--dry]');
  process.exit(1);
}

const deseado = JSON.parse(readFileSync(join(aqui, '..', 'datos', 'envios.json'), 'utf8'));
const plan = planear(actual, deseado);
for (const a of plan.avisos) console.log('AVISO ' + a);
if (!plan.resumen.length) {
  console.log('Sin cambios: Shopify ya coincide con datos/envios.json.');
  process.exit(0);
}
console.log((DRY ? 'CAMBIOS PREVISTOS' : 'APLICANDO') + ':');
for (const r of plan.resumen) console.log(' - ' + r);
if (DRY) process.exit(0);

const profile = {
  locationGroupsToUpdate: [{ id: actual.grupoId, ...(plan.zonesToCreate.length ? { zonesToCreate: plan.zonesToCreate } : {}), ...(plan.zonesToUpdate.length ? { zonesToUpdate: plan.zonesToUpdate } : {}) }],
  ...(plan.methodDefinitionsToDelete.length ? { methodDefinitionsToDelete: plan.methodDefinitionsToDelete } : {}),
};
const d = await gql(
  `mutation($id: ID!, $profile: DeliveryProfileInput!) {
     deliveryProfileUpdate(id: $id, profile: $profile) { profile { id } userErrors { field message } } }`,
  { id: actual.perfilId, profile }
);
const errores = d.deliveryProfileUpdate.userErrors;
if (errores.length) {
  console.error('Shopify rechazó los cambios:');
  for (const e of errores) console.error(' - ' + (e.field?.join('.') || '') + ': ' + e.message);
  process.exit(1);
}
console.log('\nAplicado. Estado actual:');
imprimir(await leerPerfil());
