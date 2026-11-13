import { consultar, unaFila } from './bd.js';


const TURNOS = Number(process.env.WA_HISTORIAL_MENSAJES || 20);

export async function asegurarConversacion(telefono, nombre) {
  await consultar(
    `insert into conversaciones (telefono, nombre)
     values ($1, $2)
     on conflict (telefono) do update
        set nombre = coalesce(excluded.nombre, conversaciones.nombre),
            actualizada = now()`,
    [telefono, nombre]
  );
}


export async function guardarMensaje(telefono, rol, texto, waId = null) {
  await consultar(
    `insert into mensajes (telefono, rol, texto, wa_id)
     values ($1, $2, $3, $4)
     on conflict (wa_id) where wa_id is not null do nothing`,
    [telefono, rol, texto, waId]
  );
}


export async function historial(telefono, excluirWaId = null) {
  const filas = await consultar(
    `select rol, texto from (
       select rol, texto, creado, id
         from mensajes
        where telefono = $1
          and ($2::text is null or wa_id is distinct from $2)
        order by creado desc, id desc
        limit $3
     ) ultimos
     order by creado asc, id asc`,
    [telefono, excluirWaId, TURNOS]
  );
  return filas.map((f) => ({ rol: f.rol, texto: f.texto }));
}


export async function consumirCupo(clave, maximo, ventanaSeg = 3600) {
  const fila = await unaFila(
    `insert into cupos (clave, ventana, usos)
     values ($1, to_timestamp(floor(extract(epoch from now()) / $2::int) * $2::int), 1)
     on conflict (clave, ventana) do update set usos = cupos.usos + 1
     returning usos`,
    [clave, ventanaSeg]
  );
  const usos = Number(fila?.usos || 1);
  return { permitido: usos <= maximo, restantes: Math.max(0, maximo - usos) };
}


export async function inicioDeSesion(telefono, excluirWaId = null, horas = 6) {
  const f = await unaFila(
    `select max(creado) as ultimo
       from mensajes
      where telefono = $1
        and ($2::text is null or wa_id is distinct from $2)`,
    [telefono, excluirWaId]
  );
  const ultimo = f?.ultimo ? new Date(f.ultimo) : null;
  return !ultimo || Date.now() - ultimo.getTime() > horas * 3600 * 1000;
}


export async function leerMemoria(telefono) {
  const f = await unaFila('select memoria from conversaciones where telefono = $1', [telefono]);
  return f?.memoria || {};
}


export async function guardarMemoria(telefono, nuevos) {
  if (!nuevos || !Object.keys(nuevos).length) return;
  await consultar(
    `update conversaciones
        set memoria = coalesce(memoria, '{}'::jsonb) || $2::jsonb,
            actualizada = now()
      where telefono = $1`,
    [telefono, JSON.stringify(nuevos)]
  );
}


export async function purgarCupos() {
  await consultar("delete from cupos where ventana < now() - interval '2 days'");
}
