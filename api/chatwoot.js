import { firmaValida, mensajeDe, mensajeFallido, mensajeParaHistorial, pasarAHumano, responder } from '../lib/chatwoot.js';
import { asegurarConversacion, guardarMensaje } from '../lib/conversacion.js';
import { consultar, hayBaseDeDatos } from '../lib/bd.js';
import { reintentarEntrega } from '../lib/reintentos.js';
import { despertarWorker } from '../lib/worker-cliente.js';
import { avisar } from '../lib/alerta.js';


export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'metodo_no_permitido' });
  }

  if (!process.env.CHATWOOT_BOT_SECRET) {
    return res.status(503).json({ error: 'servicio_no_configurado' });
  }

  let crudo;
  try {
    crudo = await leerCuerpo(req);
  } catch {
    return res.status(400).json({ error: 'cuerpo_ilegible' });
  }

  if (!firmaValida(crudo, req.headers)) {
    return res.status(403).json({ error: 'firma_invalida' });
  }

  let evento;
  try {
    evento = JSON.parse(crudo.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'json_invalido' });
  }


  const fallido = mensajeFallido(evento);
  if (fallido) {
    try {
      const r = await reintentarEntrega(fallido);
      console.log(
        `[chatwoot] entrega FALLIDA · msg=${fallido.idMensaje} · conv=${fallido.conversacionId} · ${fallido.error} → ${r.hecho ? `reenviado como ${r.reenviadoId}${r.cambiado ? ' (texto saneado)' : ''}` : r.motivo}`
      );
      return res.status(200).json({ reintento: r });
    } catch (e) {
      console.error('[chatwoot] no se pudo procesar la entrega fallida', fallido.idMensaje, e?.message);
      return res.status(200).json({ reintento: { hecho: false, motivo: 'excepcion' } });
    }
  }



  if (evento?.event === 'message_created' && evento?.message_type === 'outgoing' && !evento?.private) {
    console.log('[chatwoot] diag saliente · sender=' + JSON.stringify({ tipo: evento.sender?.type, claves: Object.keys(evento.sender || {}), nombre: evento.sender?.name, meta: Boolean(evento.conversation?.meta), cattr: evento.content_attributes && Object.keys(evento.content_attributes) }));
  }
  const paraHistorial = mensajeParaHistorial(evento);
  if (paraHistorial && hayBaseDeDatos) await registrarEnHistorial(paraHistorial);

  const m = mensajeDe(evento);
  if (m?.ignorar) {
    console.log(
      `[chatwoot] entrante NO atendido · ${m.ignorar} · conv=${evento?.conversation?.id} · «${String(evento?.content || '').slice(0, 40)}»`
    );
    return res.status(200).json({ ignorado: true, motivo: m.ignorar });
  }
  if (!m) {

    console.log(
      `[chatwoot] ignorado · evento=${evento?.event} tipo=${evento?.message_type} estado=${evento?.conversation?.status}`
    );
    return res.status(200).json({ ignorado: true });
  }


  if (process.env.ASESOR_PAUSADO === '1') {
    try {
      await pasarAHumano(
        m.cuentaId,
        m.conversacionId,
        'el asesor automático está pausado; atiende esta conversación por favor.'
      );
      console.log(`[chatwoot] PAUSADO · pasado a un humano · conv=${m.conversacionId}`);
    } catch (e) {
      console.error('[chatwoot] PAUSADO pero no se pudo traspasar:', e?.message);
    }
    return res.status(200).json({ pausado: true });
  }

  if (!hayBaseDeDatos) {
    console.error('[chatwoot] llegó un mensaje pero falta DATABASE_URL');
    const r = m.conversacionId && m.cuentaId ? await rescatarSinCola(m, 'falta DATABASE_URL') : null;
    return res.status(200).json({ recibidos: 1, encolados: 0, rescatado: r });
  }

  if (!m.conversacionId || !m.cuentaId) {
    console.error('[chatwoot] evento sin conversación o cuenta; no se puede responder');
    return res.status(200).json({ recibidos: 1, encolados: 0 });
  }

  try {

    const filas = await consultar(
      `insert into trabajos (wa_id, telefono, nombre, texto, origen, cuenta_id, conversacion_id, adjuntos)
       values ($1, $2, $3, $4, 'chatwoot', $5, $6, $7::jsonb)
       on conflict (wa_id) do nothing
       returning id`,
      [
        `chatwoot:${m.idMensaje}`,
        m.telefono || `cw:${m.conversacionId}`,
        m.nombre,
        m.texto,
        m.cuentaId,
        m.conversacionId,

        m.adjuntos?.length ? JSON.stringify(m.adjuntos) : null,
      ]
    );


    const despierto = filas.length ? await despertarWorker() : { ok: true };
    console.log(
      `[chatwoot] ${filas.length ? 'encolado' : 'repetido'} · conv=${m.conversacionId} · ${m.telefono} · «${m.texto.slice(0, 40)}»${m.adjuntos?.length ? ` · ${m.adjuntos.length} foto(s)` : ''}${m.audio ? ' · nota de voz transcrita' : ''}${despierto.ok ? '' : ` · worker NO avisado (${despierto.error})`}`
    );
    return res.status(200).json({ recibidos: 1, encolados: filas.length });
  } catch (e) {
    console.error('[chatwoot] no se pudo encolar', m.idMensaje, e?.message);
    const r = await rescatarSinCola(m, e?.message);
    return res.status(200).json({ recibidos: 1, encolados: 0, rescatado: r });
  }
}


async function rescatarSinCola(m, error) {
  let traspaso = false, acuse = false;
  try {
    await pasarAHumano(m.cuentaId, m.conversacionId,
      `el asesor automático no está disponible en este momento (no se pudo registrar el mensaje: ${String(error || '').slice(0, 120)}). Por favor atiende esta conversación.`);
    traspaso = true;
  } catch (e) {
    console.error('[chatwoot] rescate: no se pudo pasar a humano', e?.message);
  }
  if (traspaso) {
    try {
      await responder(m.cuentaId, m.conversacionId, '¡Gracias por escribirnos! 🙌 En un momento una persona de nuestro equipo te atiende por aquí.');
      acuse = true;
    } catch (e) {
      console.error('[chatwoot] rescate: no se pudo enviar el acuse', e?.message);
    }
  }
  await avisar(`Mensaje de WhatsApp NO encolado (conv ${m.conversacionId}, ${m.telefono || 'sin tel'}): ${traspaso ? 'pasado a un humano en Chatwoot' : 'NI SIQUIERA se pudo pasar a un humano, revisar Chatwoot'}. Error: ${String(error || '').slice(0, 200)}`).catch(() => {});
  return { traspaso, acuse };
}

function leerCuerpo(req) {
  return new Promise((resolver, rechazar) => {
    const trozos = [];
    let bytes = 0;
    req.on('data', (t) => {
      bytes += t.length;
      if (bytes > 1_000_000) {
        rechazar(new Error('cuerpo demasiado grande'));
        req.destroy();
        return;
      }
      trozos.push(t);
    });
    req.on('end', () => resolver(Buffer.concat(trozos)));
    req.on('error', rechazar);
  });
}


async function registrarEnHistorial(h) {
  try {
    let telefono = h.telefono;
    if (!telefono && h.conversacionId) {
      const f = await consultar(`select telefono from trabajos where conversacion_id = $1 order by creado desc limit 1`, [h.conversacionId]);
      telefono = f[0]?.telefono || null;
    }
    if (!telefono) return;
    await asegurarConversacion(telefono, h.nombre);
    await guardarMensaje(telefono, h.rol, h.texto.slice(0, 4000), h.waId);
    console.log(`[chatwoot] al historial (${h.rol}) · conv=${h.conversacionId} · «${h.texto.slice(0, 50)}»`);
  } catch (e) {
    console.warn('[chatwoot] no se pudo registrar en el historial:', e?.message);
  }
}
