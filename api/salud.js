import { consultar, hayBaseDeDatos } from '../lib/bd.js';

const ATASCO_MIN = 5;

export default async function handler(req, res) {
  const salida = {
    ok: true,
    servicio: 'horeca-asesor',
    fase: '3 — asesor en web y WhatsApp',
    configurado: {
      SHOPIFY_APP_SECRET: Boolean(process.env.SHOPIFY_APP_SECRET),
      ANTHROPIC_API_KEY: Boolean(process.env.ANTHROPIC_API_KEY),
      TIENDA_MYSHOPIFY: Boolean(process.env.TIENDA_MYSHOPIFY),
      META_APP_SECRET: Boolean(process.env.META_APP_SECRET),
      DATABASE_URL: hayBaseDeDatos,
      CHATWOOT_BOT_TOKEN: Boolean(process.env.CHATWOOT_BOT_TOKEN),
      ALERTA_WEBHOOK: Boolean(process.env.ALERTA_WEBHOOK),
      PANEL_CHATWOOT_CLAVE: Boolean(process.env.PANEL_CHATWOOT_CLAVE),
    },

    pausado: process.env.ASESOR_PAUSADO === '1',
  };

  if (hayBaseDeDatos) {
    try {
      const [f] = await consultar(`
        select
          count(*) filter (where estado = 'pendiente')::int                       as pendientes,
          count(*) filter (where estado = 'en_curso')::int                        as en_curso,
          count(*) filter (where estado = 'fallido'
                             and creado > now() - interval '24 hours')::int       as fallidos_24h,
          count(*) filter (where estado = 'hecho'
                             and creado > now() - interval '24 hours')::int       as atendidos_24h,
          coalesce(extract(epoch from (now() - min(creado) filter (
                     where estado in ('pendiente', 'en_curso'))))::int, 0)      as espera_seg
        from trabajos
        where estado in ('pendiente', 'en_curso')
           or creado > now() - interval '24 hours'
      `);

      const espera = Number(f.espera_seg || 0);
      const atascado = Number(f.pendientes) + Number(f.en_curso) > 0 && espera > ATASCO_MIN * 60;

      salida.cola = {
        pendientes: Number(f.pendientes),
        en_curso: Number(f.en_curso),
        atendidos_24h: Number(f.atendidos_24h),
        fallidos_24h: Number(f.fallidos_24h),
        espera_mas_antigua_seg: espera,
        atascada: atascado,
      };

      if (atascado) {
        salida.ok = false;
        salida.motivo = `hay trabajo sin atender desde hace ${Math.round(espera / 60)} min`;
      } else if (Number(f.fallidos_24h) >= 5) {
        salida.ok = false;
        salida.motivo = `${f.fallidos_24h} turnos fallidos en 24 h`;
      }
    } catch (e) {
      salida.ok = false;
      salida.motivo = 'no se pudo consultar la cola: ' + e.message;
    }
  }

  res.setHeader('Cache-Control', 'no-store');
  res.status(salida.ok ? 200 : 503).json(salida);
}
