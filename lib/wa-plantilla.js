const TOKEN = (process.env.WHATSAPP_TOKEN || '').trim();
const PHONE_ID = (process.env.WHATSAPP_PHONE_ID || '').trim();
const V = process.env.WHATSAPP_API_VERSION || 'v21.0';
const IDIOMA = process.env.WHATSAPP_PLANTILLA_IDIOMA || 'es';

export const plantillasConfiguradas = Boolean(TOKEN && PHONE_ID);

const soloDigitos = (t) => String(t || '').replace(/\D/g, '');

async function enviar(payload) {
  const r = await fetch(`https://graph.facebook.com/${V}/${PHONE_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }),
  });
  const j = await r.json().catch(() => ({}));
  if (j.error) return { ok: false, motivo: j.error.message, code: j.error.code };
  return { ok: true, id: j.messages?.[0]?.id || null };
}

const limpiarParam = (t, max = 300) =>
  String(t ?? '').replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max) || '—';

export async function enviarEntregaAsignada({ telefono, ubicacion = null, pedido, cliente, direccion, telefonoCliente, indicaciones, contenido, cobrar, statusUrl }) {
  if (!plantillasConfiguradas) return { ok: false, motivo: 'sin_config' };
  const to = soloDigitos(telefono);
  if (!to) return { ok: false, motivo: 'sin_telefono' };
  const sufijo = String(statusUrl || '').replace(/^https?:\/\/[^/]+\//, '').trim() || 'pages/asesor';
  const lat = Number(ubicacion?.lat), lng = Number(ubicacion?.lng);
  const conMapa = ubicacion && Number.isFinite(lat) && Number.isFinite(lng);
  const nombre = conMapa ? 'entrega_asignada' : 'entrega_asignada_texto';

  const components = [];
  if (conMapa) {
    components.push({
      type: 'header',
      parameters: [{ type: 'location', location: { latitude: String(lat), longitude: String(lng), name: limpiarParam(ubicacion.nombre || cliente, 100), address: limpiarParam(ubicacion.direccion || direccion, 200) } }],
    });
  }
  components.push({
    type: 'body',
    parameters: [pedido, cliente, direccion, telefonoCliente, indicaciones, contenido, cobrar].map((v) => ({ type: 'text', text: limpiarParam(v) })),
  });
  components.push({ type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: sufijo }] });

  const r = await enviar({ to, type: 'template', template: { name: nombre, language: { code: IDIOMA }, components } });
  return { ...r, plantilla: nombre, conMapa: Boolean(conMapa) };
}

export async function enviarPedidoEntregado({ telefono, nombre, pedido, statusUrl }) {
  if (!plantillasConfiguradas) return { ok: false, motivo: 'sin_config' };
  const to = soloDigitos(telefono);
  if (!to) return { ok: false, motivo: 'sin_telefono' };
  const sufijo = String(statusUrl || '').replace(/^https?:\/\/[^/]+\//, '').trim() || 'pages/asesor';
  return enviar({
    to,
    type: 'template',
    template: {
      name: 'pedido_entregado',
      language: { code: IDIOMA },
      components: [
        { type: 'body', parameters: [{ type: 'text', text: limpiarParam(nombre || 'cliente', 60) }, { type: 'text', text: limpiarParam(pedido, 30) }] },
        { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: sufijo }] },
      ],
    },
  });
}

export async function enviarSeguimientoCotizacion({ telefono, nombre, numero, total, enlaceCarrito }) {
  if (!plantillasConfiguradas) return { ok: false, motivo: 'sin_config' };
  const to = soloDigitos(telefono);
  if (!to) return { ok: false, motivo: 'sin_telefono' };
  const sufijo = String(enlaceCarrito || '').replace(/^https?:\/\/[^/]+\//, '').trim() || 'pages/asesor';
  return enviar({
    to,
    type: 'template',
    template: {
      name: 'cotizacion_seguimiento',
      language: { code: IDIOMA },
      components: [
        { type: 'body', parameters: [nombre || 'cliente', numero, total].map((v) => ({ type: 'text', text: limpiarParam(v, 60) })) },
        { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: sufijo }] },
      ],
    },
  });
}

export async function enviarCarritoListo({ telefono, codigo = 'WEB', conteo, total, sufijo, nombre = 'pago_pedido' }) {
  if (!plantillasConfiguradas) return { ok: false, motivo: 'sin_config' };
  const to = soloDigitos(telefono);
  if (!to) return { ok: false, motivo: 'sin_telefono' };
  return enviar({
    to,
    type: 'template',
    template: {
      name: nombre,
      language: { code: IDIOMA },
      components: [
        { type: 'body', parameters: [codigo, conteo, total].map((v) => ({ type: 'text', text: limpiarParam(v, 60) })) },
        { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: String(sufijo || '').replace(/^\/+/, '') }] },
      ],
    },
  });
}

export async function enviarEncuestaEntrega({ telefono, nombre, pedido }) {
  if (!plantillasConfiguradas) return { ok: false, motivo: 'sin_config' };
  const to = soloDigitos(telefono);
  if (!to) return { ok: false, motivo: 'sin_telefono' };
  return enviar({
    to,
    type: 'template',
    template: {
      name: 'entrega_encuesta',
      language: { code: IDIOMA },
      components: [
        { type: 'body', parameters: [{ type: 'text', text: limpiarParam(nombre || 'cliente', 60) }, { type: 'text', text: limpiarParam(pedido, 30) }] },
      ],
    },
  });
}

export async function enviarConfirmacionCompra({ telefono, nombre, pedido, total, statusUrl }) {
  if (!plantillasConfiguradas) return { ok: false, motivo: 'sin_config' };
  const to = soloDigitos(telefono);
  if (!to) return { ok: false, motivo: 'sin_telefono' };

  const sufijo = String(statusUrl || '').replace(/^https?:\/\/[^/]+\//, '').trim();
  if (!sufijo) return { ok: false, motivo: 'sin_url' };

  return enviar({
    to,
    type: 'template',
    template: {
      name: 'confirmacion_compra',
      language: { code: IDIOMA },
      components: [
        { type: 'body', parameters: [
          { type: 'text', text: String(nombre || 'cliente') },
          { type: 'text', text: String(pedido || '') },
          { type: 'text', text: String(total || '') },
        ] },
        { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: sufijo }] },
      ],
    },
  });
}
