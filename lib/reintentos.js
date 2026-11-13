import { consultar, hayBaseDeDatos } from './bd.js';
import { responder } from './chatwoot.js';
import { avisar } from './alerta.js';

export function sanearParaMeta(texto) {
  return String(texto)

    .replace(/(\d)\*(\d)/g, '$1x$2')

    .replace(/\*\*+/g, '*')

    .split('\n')
    .map((l) => ((l.match(/\*/g) || []).length % 2 === 1 ? l.replace(/\*/g, '') : l))
    .join('\n')

    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .trim()
    .slice(0, 4000);
}

export async function reintentarEntrega({ idMensaje, cuentaId, conversacionId, texto, error }) {
  if (!hayBaseDeDatos) return { hecho: false, motivo: 'sin_bd' };
  if (!idMensaje || !cuentaId || !conversacionId) return { hecho: false, motivo: 'incompleto' };

  const previo = await consultar(
    `select mensaje_id from reintentos_entrega where reenviado_id = $1 limit 1`,
    [idMensaje]
  );
  if (previo.length) {
    await consultar(
      `update reintentos_entrega set error = error || ' · reenvío también falló: ' || $2 where mensaje_id = $1`,
      [previo[0].mensaje_id, error]
    );
    await avisar(
      `WhatsApp no entregó un mensaje de Camila ni su reintento · conv=${conversacionId} · ${error}`
    );
    return { hecho: false, motivo: 'reintento_fallido' };
  }

  const candado = await consultar(
    `insert into reintentos_entrega (mensaje_id, conversacion_id, error)
     values ($1, $2, $3)
     on conflict (mensaje_id) do nothing
     returning mensaje_id`,
    [idMensaje, conversacionId, error]
  );
  if (!candado.length) return { hecho: false, motivo: 'ya_reintentado' };

  const saneado = sanearParaMeta(texto);
  try {
    const nuevoId = await responder(cuentaId, conversacionId, saneado);
    await consultar(`update reintentos_entrega set reenviado_id = $2 where mensaje_id = $1`, [
      idMensaje,
      nuevoId,
    ]);
    return { hecho: true, reenviadoId: nuevoId, cambiado: saneado !== String(texto).trim() };
  } catch (e) {
    await consultar(
      `update reintentos_entrega set error = error || ' · no se pudo reenviar: ' || $2 where mensaje_id = $1`,
      [idMensaje, String(e?.message || e).slice(0, 200)]
    );
    await avisar(`No se pudo reenviar un mensaje fallido · conv=${conversacionId} · ${e?.message}`);
    return { hecho: false, motivo: 'error_reenvio' };
  }
}
