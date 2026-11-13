import { consultar, hayBaseDeDatos } from './bd.js';
import { admin, configurado as adminConfigurado } from './admin.js';
import { existenciasDeBodega, configurado as mayasisConfigurado } from './mayasis.js';
import { avisar } from './alerta.js';

export function bodegasMapeadas() {
  const raw = (process.env.MAYASIS_BODEGAS || '').trim();
  if (!raw) return {};
  try { return JSON.parse(raw); } catch {  }
  const out = {};
  for (const m of raw.matchAll(/"?(\d+)"?\s*:\s*"?(gid:\/\/shopify\/Location\/\d+)"?/g)) out[m[1]] = m[2];
  return out;
}

let tablas = false;
async function asegurarTablas() {
  if (tablas) return;
  await consultar(`create table if not exists inventario_items (sku text primary key, inventory_item_id text not null, variant_id text, titulo text, actualizado timestamptz not null default now())`);
  await consultar(`create table if not exists inventario_mayasis (sku text not null, bodega text not null, cantidad integer not null, actualizado timestamptz not null default now(), primary key (sku, bodega))`);
  await consultar(`create table if not exists cerrojos (nombre text primary key, hasta timestamptz not null, dueno text)`);
  tablas = true;
}


async function tomarCerrojo(nombre, segundos, dueno) {
  const f = await consultar(
    `insert into cerrojos (nombre, hasta, dueno) values ($1, now() + ($2 || ' seconds')::interval, $3)
     on conflict (nombre) do update set hasta = excluded.hasta, dueno = excluded.dueno where cerrojos.hasta < now()
     returning nombre`, [nombre, String(segundos), dueno]);
  return f.length > 0;
}


let _items = null, _itemsEn = 0;
async function itemsPorSku({ forzar = false } = {}) {
  if (_items && !forzar && Date.now() - _itemsEn < 24 * 3600 * 1000) return _items;
  {
    let after = null, filas = [];
    do {
      const d = await admin(`query($after:String){ productVariants(first:250, after:$after){ nodes{ id sku product{ title } inventoryItem{ id tracked } } pageInfo{ hasNextPage endCursor } } }`, { after });
      for (const v of d.productVariants.nodes) if (v.sku && v.inventoryItem?.id) filas.push([v.sku.trim(), v.inventoryItem.id, v.id, v.product?.title || '']);
      after = d.productVariants.pageInfo.hasNextPage ? d.productVariants.pageInfo.endCursor : null;
    } while (after);
    for (let i = 0; i < filas.length; i += 500) {
      const lote = filas.slice(i, i + 500);
      const valores = lote.map((_, k) => `($${k * 4 + 1},$${k * 4 + 2},$${k * 4 + 3},$${k * 4 + 4},now())`).join(',');
      await consultar(`insert into inventario_items (sku, inventory_item_id, variant_id, titulo, actualizado) values ${valores}
        on conflict (sku) do update set inventory_item_id=excluded.inventory_item_id, variant_id=excluded.variant_id, titulo=excluded.titulo, actualizado=now()`, lote.flat());
    }
    _items = new Map(filas.map(([sku, itemId]) => [sku, itemId]));
  }
  _itemsEn = Date.now();
  return _items;
}


const _estado = new Map();
async function estadoDe(bodega, locationId) {
  if (_estado.has(bodega)) return _estado.get(bodega);
  await estadoInicial(bodega, locationId);
  const m = new Map((await consultar(`select sku, cantidad from inventario_mayasis where bodega = $1`, [bodega])).map((r) => [r.sku, r.cantidad]));
  _estado.set(bodega, m);
  return m;
}


async function estadoInicial(bodega, locationId) {
  const [f] = await consultar(`select count(*)::int n from inventario_mayasis where bodega = $1`, [bodega]);
  if (f.n) return;
  let after = null, filas = [];
  do {
    const d = await admin(`query($id:ID!,$after:String){ location(id:$id){ inventoryLevels(first:250, after:$after){ nodes{ item{ sku } quantities(names:["available"]){ quantity } } pageInfo{ hasNextPage endCursor } } } }`, { id: locationId, after });
    for (const n of d.location.inventoryLevels.nodes) if (n.item?.sku) filas.push([n.item.sku.trim(), bodega, Number(n.quantities?.[0]?.quantity || 0)]);
    after = d.location.inventoryLevels.pageInfo.hasNextPage ? d.location.inventoryLevels.pageInfo.endCursor : null;
  } while (after);
  for (let i = 0; i < filas.length; i += 500) {
    const lote = filas.slice(i, i + 500);
    const valores = lote.map((_, k) => `($${k * 3 + 1},$${k * 3 + 2},$${k * 3 + 3})`).join(',');
    await consultar(`insert into inventario_mayasis (sku, bodega, cantidad) values ${valores} on conflict (sku, bodega) do nothing`, lote.flat());
  }
}


async function activarEnUbicacion(itemIds, locationId) {

  let activados = 0;
  const pausa = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < itemIds.length; i += 20) {
    const lote = itemIds.slice(i, i + 20);
    const cuerpo = lote.map((id, k) => `a${k}: inventoryActivate(inventoryItemId: "${id}", locationId: "${locationId}", available: 0) { userErrors { message } }`).join(' ');
    for (let intento = 0; intento < 4; intento++) {
      try {
        const r = await admin(`mutation { ${cuerpo} }`);
        activados += Object.values(r || {}).filter((x) => !(x?.userErrors || []).length).length;
        break;
      } catch (e) {
        if (!/throttl/i.test(e?.message || '') || intento === 3) throw e;
        await pausa(6000 * (intento + 1));
      }
    }
    await pausa(2500);
  }
  return activados;
}


export async function sincronizarInventario({ soloInforme = false, dueno = process.env.FLY_MACHINE_ID || 'local' } = {}) {
  if (!hayBaseDeDatos || !adminConfigurado() || !mayasisConfigurado()) return { omitido: 'sin_config' };
  const mapa = bodegasMapeadas();
  const bodegas = Object.keys(mapa);
  if (!bodegas.length) return { omitido: 'sin_bodegas' };

  if (!_estado.size || !_items) await asegurarTablas();
  const resumen = {};
  let cerrojoTomado = false;
  try {
    const items = await itemsPorSku();
    for (const bodega of bodegas) {
      const locationId = mapa[bodega];
      const t0 = Date.now();
      try {
        const erp = await existenciasDeBodega(bodega);
        const estado = await estadoDe(bodega, locationId);
        const cambios = [];
        for (const [sku, info] of erp) {
          const itemId = items.get(sku);
          if (!itemId) continue;
          const actual = estado.get(sku);
          if (actual === undefined || actual !== info.stock) cambios.push({ sku, inventoryItemId: itemId, cantidad: info.stock, antes: actual ?? null });
        }
        let escritos = 0, errores = [];
        if (!soloInforme && cambios.length && !cerrojoTomado) {
          await asegurarTablas();
          if (!(await tomarCerrojo('inventario_mayasis', 240, dueno))) return { omitido: 'otra_instancia' };
          cerrojoTomado = true;
        }
        if (!soloInforme && cambios.length) {
          for (let i = 0; i < cambios.length; i += 250) {
            const lote = cambios.slice(i, i + 250);
            const setear = async (intento = 0) => {
              try {
                return await admin(`mutation($input: InventorySetQuantitiesInput!){ inventorySetQuantities(input:$input){ userErrors{ field message } } }`, {
                  input: { name: 'available', reason: 'correction', ignoreCompareQuantity: true, quantities: lote.map((c) => ({ inventoryItemId: c.inventoryItemId, locationId, quantity: c.cantidad })) } });
              } catch (e) {
                if (/throttl/i.test(e?.message || '') && intento < 3) { await new Promise((r) => setTimeout(r, 6000 * (intento + 1))); return setear(intento + 1); }
                throw e;
              }
            };
            const r = await setear();
            let ue = r.inventorySetQuantities?.userErrors || [];

            if (ue.some((u) => /not stocked/i.test(u.message))) {
              const n = await activarEnUbicacion(lote.map((c) => c.inventoryItemId), locationId);
              console.log(`[inventario-mayasis] bodega ${bodega}: ${n} ítems activados en la ubicación`);
              const r2 = await admin(`mutation($input: InventorySetQuantitiesInput!){ inventorySetQuantities(input:$input){ userErrors{ field message } } }`, {
                input: { name: 'available', reason: 'correction', ignoreCompareQuantity: true, quantities: lote.map((c) => ({ inventoryItemId: c.inventoryItemId, locationId, quantity: c.cantidad })) } });
              ue = r2.inventorySetQuantities?.userErrors || [];
            }
            if (ue.length) { errores.push(...[...new Set(ue.map((u) => u.message))].slice(0, 3)); continue; }
            escritos += lote.length;
            const valores = lote.map((_, k) => `($${k * 3 + 1},$${k * 3 + 2},$${k * 3 + 3},now())`).join(',');
            await consultar(`insert into inventario_mayasis (sku, bodega, cantidad, actualizado) values ${valores} on conflict (sku, bodega) do update set cantidad=excluded.cantidad, actualizado=now()`, lote.flatMap((c) => [c.sku, bodega, c.cantidad]));
            for (const c of lote) estado.set(c.sku, c.cantidad);
          }
        }
        resumen[bodega] = { productosErp: erp.size, cambios: cambios.length, escritos, errores, ms: Date.now() - t0, muestra: cambios.slice(0, 5).map((c) => `${c.sku}: ${c.antes}→${c.cantidad}`) };
      } catch (e) {
        resumen[bodega] = { error: e.message, ms: Date.now() - t0 };
        await avisar(`Inventario MAYASIS bodega ${bodega}: ${e.message}`).catch(() => {});
      }
    }
  } finally {

  }
  return resumen;
}


export async function existenciaPorBodega(sku) {
  if (!hayBaseDeDatos) return [];
  await asegurarTablas();
  return consultar(`select bodega, cantidad, actualizado from inventario_mayasis where sku = $1 order by bodega`, [String(sku)]);
}
