import { consultar } from './bd.js';

const SILENCIO_SEG = Number(process.env.WA_AGRUPAR_SILENCIO_SEG || 4);
const MAX_SEG = Number(process.env.WA_AGRUPAR_MAX_SEG || 12);

const cerrarAgrupados = (ids, principal) =>
  ids.length
    ? consultar(`update trabajos set estado = 'hecho', error = $2, terminado = now() where id = any($1::bigint[])`, [ids, `agrupado en ${principal}`])
    : Promise.resolve();

export async function reclamarAgrupado() {
  const filas = await consultar(
    `update trabajos
        set estado = 'en_curso', reclamado = now(), intentos = intentos + 1
      where id = (
        select t.id from trabajos t
         where (t.estado = 'pendiente'
                and (now() - (select max(p.creado) from trabajos p where p.telefono = t.telefono and p.estado = 'pendiente') >= ($1 || ' seconds')::interval
                     or now() - t.creado >= ($2 || ' seconds')::interval))
            or (t.estado = 'en_curso' and t.reclamado < now() - interval '5 minutes')
         order by t.creado
         limit 1
         for update skip locked)
      returning *`,
    [String(SILENCIO_SEG), String(MAX_SEG)]
  );
  const trabajo = filas[0];
  if (!trabajo || Number(trabajo.intentos) > 1) return trabajo || null;

  const otros = await consultar(
    `update trabajos set estado = 'en_curso', reclamado = now()
      where telefono = $1 and estado = 'pendiente' and id <> $2
      returning *`,
    [trabajo.telefono, trabajo.id]
  );
  if (!otros.length) return trabajo;
  otros.sort((a, b) => new Date(a.creado) - new Date(b.creado));

  const texto = [trabajo.texto, ...otros.map((o) => o.texto)].map((t) => String(t || '').trim()).filter(Boolean).join('\n');
  const adjuntos = [trabajo.adjuntos, ...otros.map((o) => o.adjuntos)].filter(Array.isArray).flat();
  await consultar(`update trabajos set texto = $2, adjuntos = $3::jsonb where id = $1`, [trabajo.id, texto, adjuntos.length ? JSON.stringify(adjuntos) : null]);
  await cerrarAgrupados(otros.map((o) => o.id), trabajo.id);
  console.log(`[agrupar] ${otros.length + 1} mensajes de ${trabajo.telefono} en un solo turno (trabajo ${trabajo.id})`);
  return { ...trabajo, texto, adjuntos: adjuntos.length ? adjuntos : null, agrupados: otros.map((o) => o.id) };
}

export async function reclamarNuevosDe(telefono, idActual) {
  const nuevos = await consultar(
    `update trabajos set estado = 'en_curso', reclamado = now()
      where telefono = $1 and estado = 'pendiente' and id <> $2 and adjuntos is null
      returning *`,
    [telefono, idActual]
  );
  nuevos.sort((a, b) => new Date(a.creado) - new Date(b.creado));
  await cerrarAgrupados(nuevos.map((n) => n.id), idActual);
  return nuevos;
}
