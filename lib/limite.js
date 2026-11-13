import { consultar, hayBaseDeDatos } from './bd.js';

const URL_REDIS = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || null;
const TOKEN_REDIS = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || null;

const hayRedis = Boolean(URL_REDIS && TOKEN_REDIS);

export const hayAlmacenCompartido = hayRedis || hayBaseDeDatos;

const contadores = new Map();

async function redis(comando) {
  const r = await fetch(URL_REDIS, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN_REDIS}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(comando),
  });
  if (!r.ok) throw new Error(`redis ${r.status}`);
  return (await r.json()).result;
}

export async function consumir(identidad, maximo, ventanaSeg = 3600) {
  if (hayRedis) {
    try {
      const clave = `cupo:${identidad}`;
      const usos = await redis(['INCR', clave]);
      if (usos === 1) await redis(['EXPIRE', clave, String(ventanaSeg)]);
      const restantes = maximo - usos;
      return { permitido: restantes >= 0, restantes: Math.max(0, restantes), reinicioEn: ventanaSeg * 1000, global: true };
    } catch (e) {
      console.error('redis no disponible, se prueba con Postgres:', e.message);
    }
  }

  if (hayBaseDeDatos) {
    try {

      const filas = await consultar(
        `insert into cupos (clave, ventana, usos)
         values ($1, to_timestamp(floor(extract(epoch from now()) / $2::int) * $2::int), 1)
         on conflict (clave, ventana) do update set usos = cupos.usos + 1
         returning usos`,
        [identidad, ventanaSeg]
      );
      const usos = Number(filas[0]?.usos || 1);
      const restantes = maximo - usos;
      return {
        permitido: restantes >= 0,
        restantes: Math.max(0, restantes),
        reinicioEn: ventanaSeg * 1000,
        global: true,
      };
    } catch (e) {
      console.error('postgres no disponible, se usa el contador local:', e.message);
    }
  }

  const ahora = Date.now();
  const ventanaMs = ventanaSeg * 1000;
  const registro = contadores.get(identidad);
  if (!registro || ahora > registro.expira) {
    contadores.set(identidad, { usos: 1, expira: ahora + ventanaMs });
    return { permitido: true, restantes: maximo - 1, reinicioEn: ventanaMs, global: false };
  }
  registro.usos += 1;
  const restantes = maximo - registro.usos;
  return { permitido: restantes >= 0, restantes: Math.max(0, restantes), reinicioEn: registro.expira - ahora, global: false };
}

export function purgar() {
  const ahora = Date.now();
  for (const [k, v] of contadores) if (ahora > v.expira) contadores.delete(k);
}
