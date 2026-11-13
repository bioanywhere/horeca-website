import crypto from 'node:crypto';

const BASE = (process.env.CHATWOOT_URL || 'https://app.chatwoot.com').replace(/\/+$/, '');
const TOKEN = process.env.CHATWOOT_BOT_TOKEN || null;
const SECRETO = process.env.CHATWOOT_BOT_SECRET || null;


const VENTANA_SEG = 300;

export const hayChatwoot = Boolean(TOKEN && SECRETO);


export function firmaValida(cuerpoCrudo, cabeceras, secreto = SECRETO) {
  if (!secreto) return false;

  const firma = cabeceras['x-chatwoot-signature'];
  const sello = cabeceras['x-chatwoot-timestamp'];
  if (!firma || !sello) return false;

  const edad = Math.abs(Math.floor(Date.now() / 1000) - Number(sello));
  if (!Number.isFinite(edad) || edad > VENTANA_SEG) return false;

  const recibida = String(firma).replace(/^sha256=/, '');
  const calculada = crypto
    .createHmac('sha256', secreto)
    .update(`${sello}.`)
    .update(cuerpoCrudo)
    .digest('hex');

  const a = Buffer.from(recibida, 'hex');
  const b = Buffer.from(calculada, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}


export function mensajeDe(evento) {
  if (evento?.event !== 'message_created' && evento?.event !== 'message_updated') return null;
  if (evento.message_type !== 'incoming') return null;

  const escrito = String(evento.content || '').trim();
  const crudos = Array.isArray(evento.attachments) ? evento.attachments : [];


  const audios = crudos.filter((a) => a && a.file_type === 'audio');
  const transcripcion = audios
    .map((a) => String(a.transcribed_text || '').trim())
    .filter(Boolean)
    .join('\n');
  if (evento.event === 'message_updated') {
    if (!audios.length || !transcripcion) return null;
  } else if (audios.length && !transcripcion) {
    return { ignorar: 'audio_sin_transcribir' };
  }

  const texto = [escrito, transcripcion ? `🎤 (nota de voz) ${transcripcion}` : ''].filter(Boolean).join('\n');


  const adjuntos = crudos
    .filter((a) => a && a.data_url && (a.file_type === 'image' || a.file_type === 'file'))
    .map((a) => ({
      tipo: a.file_type === 'image' ? 'image' : 'file',
      url: String(a.data_url),
      id: a.id ?? null,

      nombre: String(a.file_name || a.filename || decodeURIComponent(String(a.data_url).split('?')[0].split('/').pop() || '')).slice(0, 120),
    }))
    .slice(0, 3);

  if (!texto && !adjuntos.length) return null;

  const conversacion = evento.conversation || {};


  const estado = conversacion.status || evento.status;
  if (estado && estado !== 'pending') {

    return { ignorar: `estado=${estado}` };
  }

  return {
    idMensaje: String(evento.id ?? ''),
    cuentaId: String(evento.account?.id ?? conversacion.account_id ?? ''),
    conversacionId: String(conversacion.id ?? evento.conversation_id ?? ''),
    telefono: (evento.sender?.phone_number || '').replace(/^\+/, ''),
    nombre: evento.sender?.name || null,
    texto,
    adjuntos,
    audio: Boolean(transcripcion),
  };
}



export function mensajeParaHistorial(evento) {
  const tipoEvento = evento?.event;
  if (tipoEvento !== 'message_created' && tipoEvento !== 'message_updated') return null;
  if (evento.private) return null;
  const conversacion = evento.conversation || {};
  const base = {
    conversacionId: String(conversacion.id ?? evento.conversation_id ?? ''),
    waId: `chatwoot:${evento.id}`,
  };
  const adjuntos = Array.isArray(evento.attachments) ? evento.attachments : [];
  const marcaAdjuntos = (quien) => {
    const n = adjuntos.filter((a) => a && a.file_type !== 'audio').length;
    return n ? `[${quien} ${n === 1 ? 'un adjunto' : n + ' adjuntos'}]` : '';
  };

  if (evento.message_type === 'incoming') {
    const estado = conversacion.status || evento.status;
    if (!estado || estado === 'pending') return null;
    const audios = adjuntos.filter((a) => a && a.file_type === 'audio');
    const transcripcion = audios.map((a) => String(a.transcribed_text || '').trim()).filter(Boolean).join('\n');
    if (tipoEvento === 'message_updated' && !transcripcion) return null;
    if (tipoEvento === 'message_created' && audios.length && !transcripcion) return null;
    const texto = [marcaAdjuntos('El cliente envió'), String(evento.content || '').trim(), transcripcion ? `🎤 (nota de voz) ${transcripcion}` : '']
      .filter(Boolean).join('\n');
    if (!texto) return null;
    return {
      ...base,
      telefono: (evento.sender?.phone_number || conversacion.meta?.sender?.phone_number || '').replace(/^\+/, '') || null,
      nombre: evento.sender?.name || null,
      rol: 'cliente',
      texto,
    };
  }

  if (evento.message_type === 'outgoing' && tipoEvento === 'message_created') {

    const tipoRemitente = String(evento.sender?.type || '').toLowerCase();
    if (tipoRemitente === 'agent_bot' || tipoRemitente === 'agentbot') return null;
    const cuerpo = [String(evento.content || '').trim(), marcaAdjuntos('Envió')].filter(Boolean).join('\n');
    if (!cuerpo) return null;
    const quien = String(evento.sender?.available_name || evento.sender?.name || '').trim();
    return {
      ...base,
      telefono: (conversacion.meta?.sender?.phone_number || '').replace(/^\+/, '') || null,
      nombre: null,
      rol: 'asesor',
      texto: `[Asesor humano${quien ? ': ' + quien : ''}] ${cuerpo}`,
    };
  }
  return null;
}

export function mensajeFallido(evento) {
  if (evento?.event !== 'message_updated') return null;
  if (evento.message_type !== 'outgoing') return null;
  if (evento.status !== 'failed') return null;
  if (evento.private) return null;

  const tipoRemitente = String(evento.sender?.type || '').toLowerCase();
  if (tipoRemitente && tipoRemitente !== 'agent_bot') return null;

  const texto = String(evento.content || '').trim();
  if (!texto) return null;

  const conversacion = evento.conversation || {};
  return {
    idMensaje: String(evento.id ?? ''),
    cuentaId: String(evento.account?.id ?? conversacion.account_id ?? ''),
    conversacionId: String(conversacion.id ?? evento.conversation_id ?? ''),
    texto,
    error: String(evento.content_attributes?.external_error || 'sin detalle').slice(0, 300),
  };
}

async function llamar(ruta, cuerpo, metodo = 'POST') {
  if (!TOKEN) throw new Error('Falta CHATWOOT_BOT_TOKEN.');
  const r = await fetch(`${BASE}/api/v1/${ruta}`, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', api_access_token: TOKEN },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });
  const datos = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(`Chatwoot ${r.status}: ${datos?.message || datos?.error || 'sin detalle'}`);

    if (r.status === 401 || r.status === 403) e.permanente = true;
    throw e;
  }
  return datos;
}


export async function anotarContactoPorId(cuentaId, contactoId, atributos = {}) {
  const entradas = Object.entries(atributos || {}).filter(([, v]) => v != null && String(v).trim());
  if (!contactoId || !entradas.length) return false;
  try {
    await llamar(
      `accounts/${cuentaId}/contacts/${contactoId}`,
      {
        custom_attributes: Object.fromEntries(
          entradas.map(([k, v]) => [String(k).toLowerCase().trim().replace(/\s+/g, '_'), String(v).slice(0, 200)])
        ),
      },
      'PUT'
    );
    return true;
  } catch {
    return false;
  }
}


export async function enviarImagen(cuentaId, conversacionId, url, caption = '') {
  if (!TOKEN) return false;
  try {
    const r = await fetch(url);
    if (!r.ok) return false;
    const buf = Buffer.from(await r.arrayBuffer());
    const tipo = r.headers.get('content-type') || 'image/jpeg';
    const ext = tipo.includes('png') ? 'png' : tipo.includes('webp') ? 'webp' : 'jpg';
    const form = new FormData();
    if (caption) form.append('content', String(caption).slice(0, 300));
    form.append('message_type', 'outgoing');
    form.append('attachments[]', new Blob([buf], { type: tipo }), `producto.${ext}`);
    const res = await fetch(`${BASE}/api/v1/accounts/${cuentaId}/conversations/${conversacionId}/messages`, {
      method: 'POST',
      headers: { api_access_token: TOKEN },
      body: form,
    });
    return res.ok;
  } catch {
    return false;
  }
}


export async function enviarAdjunto(cuentaId, conversacionId, buffer, nombre, tipo = 'application/pdf', caption = '') {
  if (!TOKEN || !buffer?.length) return false;
  try {
    const form = new FormData();
    if (caption) form.append('content', String(caption).slice(0, 300));
    form.append('message_type', 'outgoing');
    form.append('attachments[]', new Blob([buffer], { type: tipo }), nombre || 'archivo.pdf');
    const res = await fetch(`${BASE}/api/v1/accounts/${cuentaId}/conversations/${conversacionId}/messages`, {
      method: 'POST',
      headers: { api_access_token: TOKEN },
      body: form,
    });
    return res.ok;
  } catch {
    return false;
  }
}


export async function responderOpciones(cuentaId, conversacionId, texto, opciones) {
  const lista = (Array.isArray(opciones) ? opciones : []).map((o) => String(o || '').trim()).filter(Boolean).slice(0, 10);
  if (!lista.length) return responder(cuentaId, conversacionId, texto);
  const max = lista.length <= 3 ? 20 : 24;
  const items = lista.map((t, i) => ({ title: t.slice(0, max), value: t.slice(0, max) || `opcion_${i + 1}` }));
  const d = await llamar(`accounts/${cuentaId}/conversations/${conversacionId}/messages`, {
    content: texto,
    content_type: 'input_select',
    content_attributes: { items },
    message_type: 'outgoing',
  });
  return d?.id ? String(d.id) : null;
}


export async function enviarPlantilla(cuentaId, conversacionId, { nombre, texto, idioma = 'es', categoria = 'UTILITY', cuerpo = {}, botones = [] }) {

  const d = await llamar(`accounts/${cuentaId}/conversations/${conversacionId}/messages`, {
    content: texto,
    message_type: 'outgoing',
    template_params: {
      name: nombre,
      category: categoria,
      language: idioma,
      processed_params: { body: cuerpo, ...(botones.length ? { buttons: botones } : {}) },
    },
  });
  return d?.id ? String(d.id) : null;
}


export async function responder(cuentaId, conversacionId, texto) {
  const d = await llamar(`accounts/${cuentaId}/conversations/${conversacionId}/messages`, {
    content: texto,
    message_type: 'outgoing',
  });
  return d?.id ? String(d.id) : null;
}


export async function escribiendo(cuentaId, conversacionId, activo = true) {
  try {
    await llamar(`accounts/${cuentaId}/conversations/${conversacionId}/toggle_typing_status`, {
      typing_status: activo ? 'on' : 'off',
    });
  } catch {

  }
}


export async function resolver(cuentaId, conversacionId) {
  try {
    await llamar(`accounts/${cuentaId}/conversations/${conversacionId}/toggle_status`, { status: 'resolved' });
    return true;
  } catch {
    return false;
  }
}


export async function etiquetar(cuentaId, conversacionId, etiquetas = []) {
  const limpias = [
    ...new Set(
      (etiquetas || [])
        .filter(Boolean)
        .map((e) => String(e).toLowerCase().trim().replace(/\s+/g, '-'))
        .filter(Boolean)
    ),
  ];
  if (!limpias.length) return;
  try {
    const actual = await llamar(`accounts/${cuentaId}/conversations/${conversacionId}/labels`, null, 'GET');
    const previas = Array.isArray(actual?.payload) ? actual.payload : [];
    await llamar(`accounts/${cuentaId}/conversations/${conversacionId}/labels`, {
      labels: [...new Set([...previas, ...limpias])],
    });
  } catch {

  }
}


export async function anotarContacto(cuentaId, conversacionId, atributos = {}) {
  const entradas = Object.entries(atributos || {}).filter(([, v]) => v != null && String(v).trim());
  if (!entradas.length) return;
  try {
    const conv = await llamar(`accounts/${cuentaId}/conversations/${conversacionId}`, null, 'GET');
    const contactoId = conv?.meta?.sender?.id;
    if (!contactoId) return;
    await llamar(
      `accounts/${cuentaId}/contacts/${contactoId}`,
      {
        custom_attributes: Object.fromEntries(
          entradas.map(([k, v]) => [String(k).toLowerCase().trim().replace(/\s+/g, '_'), String(v).slice(0, 200)])
        ),
      },
      'PUT'
    );
  } catch {

  }
}



export async function notaPrivada(cuentaId, conversacionId, texto) {
  const d = await llamar(`accounts/${cuentaId}/conversations/${conversacionId}/messages`, {
    content: texto,
    message_type: 'outgoing',
    private: true,
  }).catch(() => null);
  return d?.id ? String(d.id) : null;
}

export async function pasarAHumano(cuentaId, conversacionId, motivo) {
  if (motivo) {
    await llamar(`accounts/${cuentaId}/conversations/${conversacionId}/messages`, {
      content: `El asesor automático pasa esta conversación: ${motivo}`,
      message_type: 'outgoing',
      private: true,
    }).catch(() => {});
  }
  await llamar(`accounts/${cuentaId}/conversations/${conversacionId}/toggle_status`, {
    status: 'open',
  });
}
