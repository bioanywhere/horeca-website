import { consultar, hayBaseDeDatos } from './bd.js';
import { responder, hayChatwoot } from './chatwoot.js';
import { enviarConfirmacionCompra, plantillasConfiguradas } from './wa-plantilla.js';
import { leerFiscalesDe } from './fiscales-cliente.js';
import { configurado as adminConfigurado } from './admin.js';

const ult10 = (t) => String(t || '').replace(/\D/g, '').slice(-10);

async function conversacionDe(telefono) {
  const t10 = ult10(telefono);
  if (!t10) return null;
  const f = (await consultar(
    `select cuenta_id, conversacion_id
       from trabajos
      where origen = 'chatwoot'
        and cuenta_id is not null and conversacion_id is not null
        and right(regexp_replace(telefono, '\\D', '', 'g'), 10) = $1
      order by creado desc
      limit 1`,
    [t10]
  ))[0];
  return f || null;
}

async function dentroDeVentana(t10, horas = 24) {
  if (!t10) return false;
  const f = (await consultar(
    `select max(creado) as ultimo from mensajes
      where rol = 'cliente' and right(regexp_replace(telefono, '\\D', '', 'g'), 10) = $1`,
    [t10]
  ))[0];
  const ultimo = f?.ultimo ? new Date(f.ultimo) : null;
  return ultimo ? Date.now() - ultimo.getTime() < horas * 3600 * 1000 : false;
}

export async function notificarCompra({ telefono, nombre = '', pedido = '', total = '', statusUrl = '' }) {
  if (!hayBaseDeDatos) return { ok: false, motivo: 'sin_canal' };
  const t10 = ult10(telefono);
  if (!t10) return { ok: false, motivo: 'sin_telefono' };
  try {
    const [conv, dentro] = await Promise.all([conversacionDe(telefono), dentroDeVentana(t10)]);

    if (hayChatwoot && conv && dentro) {
      const nom = nombre ? `, ${nombre}` : '';
      const ref = pedido ? ` ${pedido}` : '';
      const val = total ? ` por ${total}` : '';
      const link = statusUrl ? `\nVer tu pedido: ${statusUrl}` : '';

      let fiscal = '';
      if (adminConfigurado()) {
        const datos = await leerFiscalesDe(telefono);
        if (!datos || !datos.numero_documento) {
          fiscal =
            `\n\n🧾 Para emitir tu factura electrónica necesito tus datos de facturación. ` +
            `Respóndeme por aquí: si eres persona *natural* o *jurídica*, tu documento o *NIT*, y el correo para la factura.`;
        }
      }

      const msg =
        `¡Gracias por tu compra${nom}! 🎉 Recibimos tu pedido${ref}${val} y ya lo estamos preparando. ` +
        `Te aviso apenas esté listo. Si necesitas algo más, aquí estoy 😊${link}${fiscal}`;
      const id = await responder(conv.cuenta_id, conv.conversacion_id, msg);
      if (id) return { ok: true, via: 'libre', conversacion: conv.conversacion_id };
    }

    if (plantillasConfiguradas) {
      const r = await enviarConfirmacionCompra({ telefono, nombre, pedido, total, statusUrl });
      return r.ok ? { ok: true, via: 'plantilla', id: r.id } : { ok: false, motivo: `plantilla_${r.motivo || 'error'}` };
    }

    return { ok: false, motivo: conv ? 'fuera_ventana_sin_plantilla' : 'sin_whatsapp' };
  } catch (e) {
    return { ok: false, motivo: 'excepcion', detalle: e?.message };
  }
}
