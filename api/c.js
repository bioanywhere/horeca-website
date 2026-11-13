import { firmaValida, selloReciente } from '../lib/firma.js';
import { resolver } from '../lib/enlaces.js';

const TIENDA = ('https://' + (process.env.TIENDA_PUBLICA || 'horecacenter.co').replace(/^https?:\/\//i, '')).replace(/\/+$/, '');

function pagina(destino) {
  const seguro = destino.replace(/["<>\\]/g, '');
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>HORECA CENTER</title>
<meta name="robots" content="noindex"><meta http-equiv="refresh" content="0;url=${seguro}">
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;color:#1b2430}p{color:#6b7280}</style>
</head><body><div><p>Abriendo tu carrito…</p><a href="${seguro}">Si no abre, toca aquí</a></div>
<script>location.replace(${JSON.stringify(destino)});</script></body></html>`;
}

export default async function handler(req, res) {
  const secreto = process.env.SHOPIFY_APP_SECRET;

  const { codigo: codigoRewrite, ...query } = req.query || {};
  if (!secreto || !firmaValida(query, secreto) || !selloReciente(query)) {
    return res.status(403).send('Enlace no válido.');
  }
  const ruta = String(req.url || '').split('?')[0];
  const codigo = codigoRewrite || ruta.split('/c/')[1] || '';
  const destino = await resolver(codigo).catch(() => null);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (!destino) return res.status(404).send(pagina(TIENDA + '/cart'));
  const absoluto = /^https?:\/\//i.test(destino) ? destino : TIENDA + (destino.startsWith('/') ? '' : '/') + destino;
  return res.status(200).send(pagina(absoluto));
}
