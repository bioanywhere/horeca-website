import crypto from 'node:crypto';
import { marcarCompradoPorTelefono } from '../lib/recuperacion.js';
import { cumplirReferido } from '../lib/referidos.js';
import { notificarCompra } from '../lib/notificaciones.js';
import { asegurarFiscalDelPedido, anotarFiscalEnPedido } from '../lib/fiscales-cliente.js';
import { procesarOrdenParaEntrega } from '../lib/entregas.js';
import { marcarCompradas } from '../lib/cotizaciones.js';
import { hayBaseDeDatos } from '../lib/bd.js';
import { enviarPedidoAMayasis } from '../lib/pedidos-mayasis.js';

function formatearTotal(orden) {
  const n = Number(orden.total_price ?? orden.current_total_price);
  const cur = orden.currency || 'COP';
  if (!Number.isFinite(n)) return '';
  try {
    return new Intl.NumberFormat('es-CO', { style: 'currency', currency: cur, maximumFractionDigits: 0 }).format(n);
  } catch {
    return `$${Math.round(n).toLocaleString('es-CO')}`;
  }
}

export const config = { api: { bodyParser: false } };

function leerCuerpo(req) {
  return new Promise((resolver, rechazar) => {
    const trozos = [];
    let bytes = 0;
    req.on('data', (t) => {
      bytes += t.length;
      if (bytes > 2_000_000) { rechazar(new Error('cuerpo demasiado grande')); req.destroy(); return; }
      trozos.push(t);
    });
    req.on('end', () => resolver(Buffer.concat(trozos)));
    req.on('error', rechazar);
  });
}

function hmacValido(crudo, header, secreto) {
  if (!secreto || !header) return false;
  const calc = crypto.createHmac('sha256', secreto).update(crudo).digest('base64');
  const a = Buffer.from(calc);
  const b = Buffer.from(String(header));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'metodo_no_permitido' });
  }
  const secreto = (process.env.SHOPIFY_CLIENT_SECRET || '').trim();
  if (!secreto) return res.status(503).json({ error: 'sin_secreto' });

  let crudo;
  try { crudo = await leerCuerpo(req); } catch { return res.status(400).json({ error: 'cuerpo_ilegible' }); }

  if (!hmacValido(crudo, req.headers['x-shopify-hmac-sha256'], secreto)) {
    return res.status(401).json({ error: 'hmac_invalido' });
  }

  let orden;
  try { orden = JSON.parse(crudo.toString('utf8')); } catch { return res.status(400).json({ error: 'json_invalido' }); }

  const tel =
    orden.customer?.phone || orden.phone ||
    orden.shipping_address?.phone || orden.billing_address?.phone || '';

  try {
    if (tel && hayBaseDeDatos) {
      const n = await marcarCompradoPorTelefono(tel);
      if (n) console.log(`[shopify-orden] ${orden.name || ''} · ${n} carrito(s) marcado(s) comprado`);

      const r = await cumplirReferido(tel);
      if (r) {
        console.log(
          `[shopify-orden] referido cumplido #${r.id}` +
            (r.manual ? ` (a mano: ${r.motivo})` : ` · códigos ${r.codigoReferidor}/${r.codigoReferido}`)
        );
      }

      const nombre =
        orden.customer?.first_name || orden.billing_address?.first_name ||
        orden.shipping_address?.first_name || '';
      const aviso = await notificarCompra({
        telefono: tel,
        nombre,
        pedido: orden.name || '',
        total: formatearTotal(orden),
        statusUrl: orden.order_status_url || '',
      });
      console.log(
        `[shopify-orden] WhatsApp compra ${orden.name || ''}: ${aviso.ok ? 'enviado (' + aviso.via + ')' : 'no (' + aviso.motivo + ')'}`
      );
    }

    if (tel && orden.customer?.id) {
      const copiado = await asegurarFiscalDelPedido({ customerId: orden.customer.id, telefono: tel });
      if (copiado) console.log(`[shopify-orden] datos fiscales copiados a la ficha del pedido ${orden.name || ''}`);
    }

    const anotado = await anotarFiscalEnPedido({ orderId: orden.id, customerId: orden.customer?.id, telefono: tel, atributosActuales: orden.note_attributes || [] });
    if (anotado) console.log(`[shopify-orden] atributos fiscales escritos en el pedido ${orden.name || ''}`);

    if (hayBaseDeDatos) {

      const nc = await marcarCompradas(orden);
      if (nc) console.log(`[shopify-orden] ${orden.name || ''} · ${nc} cotización(es) marcada(s) comprada`);

      const ent = await procesarOrdenParaEntrega(orden, { evento: 'create' });
      console.log(`[shopify-orden] entrega ${orden.name || ''}: ${JSON.stringify(ent)}`);

      const my = await enviarPedidoAMayasis(orden);
      console.log(`[shopify-orden] MAYASIS ${orden.name || ''}: ${JSON.stringify(my).slice(0, 300)}`);
    }
  } catch (e) {
    console.error('[shopify-orden]', e.message);
  }

  return res.status(200).json({ ok: true });
}
