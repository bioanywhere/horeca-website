import { consultar, hayBaseDeDatos } from './bd.js';
import { resumenOrigenes } from './origenes.js';
import { resumenResoluciones } from './resoluciones.js';
import { costosIA } from './uso-ia.js';

import { resumenBusquedasFallidas } from './busquedas-fallidas.js';

export async function metricas() {
  if (!hayBaseDeDatos) return { sinBase: true };

  const [t] = await consultar(`
    select
      count(*) filter (where estado='hecho'   and creado > now()-interval '1 day')::int  as at_hoy,
      count(*) filter (where estado='hecho'   and creado > now()-interval '7 days')::int  as at_sem,
      count(*) filter (where estado='hecho'   and creado > now()-interval '30 days')::int as at_mes,
      count(*) filter (where estado='fallido' and creado > now()-interval '1 day')::int  as fa_hoy,
      count(*) filter (where estado='fallido' and creado > now()-interval '7 days')::int  as fa_sem,
      count(*) filter (where estado='fallido' and creado > now()-interval '30 days')::int as fa_mes,
      count(*) filter (where error like 'traspasado%' and creado > now()-interval '1 day')::int  as tr_hoy,
      count(*) filter (where error like 'traspasado%' and creado > now()-interval '7 days')::int  as tr_sem,
      count(*) filter (where error like 'traspasado%' and creado > now()-interval '30 days')::int as tr_mes,
      count(distinct telefono) filter (where creado > now()-interval '1 day')::int  as cl_hoy,
      count(distinct telefono) filter (where creado > now()-interval '7 days')::int  as cl_sem,
      count(distinct telefono) filter (where creado > now()-interval '30 days')::int as cl_mes,
      coalesce(round(avg(extract(epoch from (terminado-creado))) filter (
        where estado='hecho' and terminado is not null
          and creado > now()-interval '7 days')), 0)::int as seg_prom_sem
    from trabajos
    where creado > now()-interval '30 days'
  `);

  const [c] = await consultar(`
    select
      count(*) filter (where creado > now()-interval '7 days')::int  as ar_sem,
      count(*) filter (where creado > now()-interval '30 days')::int as ar_mes,
      count(*) filter (where estado='comprado' and creado > now()-interval '7 days')::int  as co_sem,
      count(*) filter (where estado='comprado' and creado > now()-interval '30 days')::int as co_mes,
      coalesce(sum(total) filter (where estado='comprado' and creado > now()-interval '30 days'),0)::bigint as valor_mes
    from carritos
  `).catch(() => [{}]);

  const anuncios = await resumenOrigenes();
  const resueltas = await resumenResoluciones();
  const costos = await costosIA(30);
  const busquedasFallidas = await resumenBusquedasFallidas({ dias: 7 }).catch(() => null);

  const cc = c || {};
  return {
    anuncios,
    resueltas,
    costos,
    busquedasFallidas,
    turnos: {
      hoy:    { atendidos: t.at_hoy, fallidos: t.fa_hoy, traspasos: t.tr_hoy },
      semana: { atendidos: t.at_sem, fallidos: t.fa_sem, traspasos: t.tr_sem },
      mes:    { atendidos: t.at_mes, fallidos: t.fa_mes, traspasos: t.tr_mes },
    },
    clientes: { hoy: t.cl_hoy, semana: t.cl_sem, mes: t.cl_mes },
    carritos: {
      armados_sem: Number(cc.ar_sem || 0),
      armados_mes: Number(cc.ar_mes || 0),
      comprados_sem: Number(cc.co_sem || 0),
      comprados_mes: Number(cc.co_mes || 0),
      valor_mes: Number(cc.valor_mes || 0),
    },
    respuesta_seg_prom: Number(t.seg_prom_sem || 0),
    generado: new Date().toISOString(),
  };
}
