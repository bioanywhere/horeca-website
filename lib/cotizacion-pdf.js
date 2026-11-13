import { readFileSync } from 'node:fs';

let CARRITO_BLANCO = null;
const CARRITO_PROPORCION = 268 / 209;
try {
  CARRITO_BLANCO = readFileSync(new URL('../datos/carrito-blanco.png', import.meta.url));
} catch {

}

const LOGO_URL = 'https://cdn.shopify.com/s/files/1/0689/7244/5811/files/horeca-logo-sin-bajada.png?v=1788194429';
let logoCache = null;

async function logo() {
  if (logoCache) return logoCache;
  try {
    const r = await fetch(LOGO_URL);
    if (r.ok) logoCache = Buffer.from(await r.arrayBuffer());
  } catch {

  }
  return logoCache;
}

const EMISOR = {
  razonSocial: 'DISNAR S.A.S. — CALLE 92',
  nombreComercial: 'HORECA CENTER CALLE 92',
  nit: '802003599-2',
  direccion: 'Calle 92 # 46 - 09, Barranquilla',
  telefono: '311 352 1593',
  correo: 'horecacenter@disnarsas.com',
};

const WA_CAMILA = (process.env.WA_NUMERO_TIENDA || '573113521593').replace(/\D/g, '');
const VERDE_WA = '#128C7E';
const VERDE_ECO = '#15803d';

const TRAZOS = {
  hoja: 'M17 8C8 10 5.9 16.17 3.82 21.34l1.89.66.95-2.3c.48.17.98.3 1.34.3C19 20 22 3 22 3c-1 2-8 2.25-13 3.25S2 11.5 2 13.5s1.75 3.75 1.75 3.75C7 8 17 8 17 8z',
  gota: 'M12 2c-5.33 4.55-8 8.48-8 11.8 0 4.98 3.8 8.2 8 8.2s8-3.22 8-8.2C20 10.48 17.33 6.55 12 2z',
  arbol: 'M12 2 5 11h3l-4 6h6v5h4v-5h6l-4-6h3z',
  planeta: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm6.93 6h-2.95a15.65 15.65 0 0 0-1.38-3.56A8.03 8.03 0 0 1 18.93 8zM12 4.04c.83 1.2 1.48 2.53 1.91 3.96h-3.82c.43-1.43 1.08-2.76 1.91-3.96zM4.26 14A7.9 7.9 0 0 1 4 12c0-.69.1-1.36.26-2h3.38c-.08.66-.14 1.32-.14 2s.06 1.34.14 2H4.26zm.82 2h2.95c.32 1.25.78 2.45 1.38 3.56A7.99 7.99 0 0 1 5.08 16zm2.95-8H5.08a7.99 7.99 0 0 1 4.33-3.56A15.65 15.65 0 0 0 8.03 8zM12 19.96c-.83-1.2-1.48-2.53-1.91-3.96h3.82c-.43 1.43-1.08 2.76-1.91 3.96zM14.34 14H9.66c-.09-.66-.16-1.32-.16-2s.07-1.35.16-2h4.68c.09.65.16 1.32.16 2s-.07 1.34-.16 2zm.25 5.56c.6-1.11 1.06-2.31 1.38-3.56h2.95a8.03 8.03 0 0 1-4.33 3.56zM16.36 14c.08-.66.14-1.32.14-2s-.06-1.34-.14-2h3.38c.16.64.26 1.31.26 2s-.1 1.36-.26 2h-3.38z',
};

function formatoTel(d) {
  const m = String(d).match(/^57(\d{3})(\d{3})(\d{4})$/);
  return m ? `+57 ${m[1]} ${m[2]} ${m[3]}` : '+' + d;
}

const TRAZO_WA =
  'M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.885-9.885 9.885m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z';

function normalizarTrazo(d) {
  const cola = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e-?\d+)?/g) || [];
  const out = [];
  let cmd = '';
  let pos = 0;
  while (cola.length) {
    const t = cola.shift();
    if (/[a-zA-Z]/.test(t)) { cmd = t; pos = 0; out.push(t); continue; }

    if (/a/i.test(cmd) && (pos % 7 === 3 || pos % 7 === 4) && t.length > 1) {
      out.push(t[0]); pos++;
      cola.unshift(t.slice(1));
      continue;
    }
    out.push(t); pos++;
  }
  return out.join(' ');
}
const TRAZO_WA_OK = normalizarTrazo(TRAZO_WA);
const TRAZOS_OK = Object.fromEntries(Object.entries(TRAZOS).map(([k, v]) => [k, normalizarTrazo(v)]));

function icono(doc, nombre, x, y, tam, color) {
  const d = TRAZOS_OK[nombre];
  if (!d) return;
  doc.save();
  doc.translate(x, y).scale(tam / 24);
  doc.path(d).fill(color);
  doc.restore();
}

function iconoWhatsApp(doc, x, y, tam, color = '#25D366') {
  doc.save();
  doc.translate(x, y).scale(tam / 24);
  doc.path(TRAZO_WA_OK).fill(color);
  doc.restore();
}

async function dibujarQR(doc, texto, x, y, tam, color) {
  const { create } = await import('qrcode');
  const qr = create(texto, { errorCorrectionLevel: 'M' });
  const n = qr.modules.size;
  const m = tam / n;
  doc.save();
  doc.rect(x, y, tam, tam).fill('#ffffff');
  doc.fillColor(color);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.modules.get(r, c)) doc.rect(x + c * m, y + r * m, m + 0.2, m + 0.2).fill(color);
    }
  }
  doc.restore();
}

const pesos = (n) => '$' + Math.round(Number(n) || 0).toLocaleString('es-CO');

const etiquetaDoc = (t) => String(t || '').replace(/^\d+\s*-\s*/, '').trim();

function nombreLegible(t) {
  const s = String(t || '').trim();
  if (!s) return '';
  if (s !== s.toUpperCase()) return s;
  return s.toLowerCase().replace(/(^|[\s(/-])([a-záéíóúñ])/g, (m, a, b) => a + b.toUpperCase());
}

const fechaLarga = (d) =>
  d.toLocaleDateString('es-CO', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/Bogota' });

export async function crearCotizacionPDF({ numero, cliente = {}, lineas = [], total = 0, enlaceCarrito, diasValidez = 5 }) {
  const { default: PDFDocument } = await import('pdfkit');
  const img = await logo();

  const AZUL = '#146FE0';
  const TINTA = '#1f2937';
  const GRIS = '#6b7280';
  const LINEA = '#e5e7eb';
  const ZEBRA = '#f8fafc';

  const doc = new PDFDocument({ size: 'LETTER', margin: 48, info: { Title: `Cotización ${numero}`, Author: 'HORECA CENTER' } });
  const trozos = [];
  doc.on('data', (c) => trozos.push(c));
  const listo = new Promise((res) => doc.on('end', () => res(Buffer.concat(trozos))));

  const X = doc.page.margins.left;
  const ANCHO = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const hoy = new Date();
  const vence = new Date(hoy.getTime() + diasValidez * 86400000);

  function cabecera() {
    const top = doc.page.margins.top;
    if (img) {
      try { doc.image(img, X, top, { width: 170 }); } catch {  }
    } else {
      doc.font('Helvetica-Bold').fontSize(20).fillColor(AZUL).text('HORECA CENTER', X, top);
    }
    doc.font('Helvetica-Bold').fontSize(22).fillColor(TINTA).text('COTIZACIÓN', X, top, { width: ANCHO, align: 'right' });
    doc.font('Helvetica').fontSize(10).fillColor(GRIS)
      .text(`No. ${numero}`, X, top + 28, { width: ANCHO, align: 'right' })
      .text(`Fecha: ${fechaLarga(hoy)}`, { width: ANCHO, align: 'right' })
      .text(`Válida hasta: ${fechaLarga(vence)}`, { width: ANCHO, align: 'right' });
    doc.moveTo(X, top + 78).lineTo(X + ANCHO, top + 78).lineWidth(1).strokeColor(LINEA).stroke();
    doc.y = top + 92;
  }
  cabecera();

  const colW = ANCHO / 2 - 10;
  const yBloques = doc.y;
  doc.font('Helvetica-Bold').fontSize(9).fillColor(GRIS).text('DE', X, yBloques);
  doc.font('Helvetica-Bold').fontSize(11).fillColor(TINTA).text(EMISOR.razonSocial, X, yBloques + 13, { width: colW });
  doc.font('Helvetica').fontSize(9.5).fillColor(TINTA)
    .text(EMISOR.nombreComercial, { width: colW })
    .text(`NIT: ${EMISOR.nit}`, { width: colW })
    .text(EMISOR.direccion, { width: colW })
    .text(`Tel: ${EMISOR.telefono}`, { width: colW })
    .fillColor(AZUL).text(EMISOR.correo, { width: colW, link: `mailto:${EMISOR.correo}` })
    .text('horecacenter.co', { width: colW, link: 'https://horecacenter.co' });

  const yFinDe = doc.y;

  const xC = X + ANCHO / 2 + 10;
  doc.font('Helvetica-Bold').fontSize(9).fillColor(GRIS).text('PARA', xC, yBloques);
  const nombreCliente = cliente.razonSocial || cliente.nombre || 'Cliente';
  doc.font('Helvetica-Bold').fontSize(11).fillColor(TINTA).text(nombreCliente, xC, yBloques + 13, { width: colW });
  doc.font('Helvetica').fontSize(9.5).fillColor(TINTA);
  if (cliente.tipoPersona) doc.text(`Persona ${String(cliente.tipoPersona).toLowerCase()}`, { width: colW });
  if (cliente.numeroDocumento) {
    const dv = cliente.dv ? `-${cliente.dv}` : '';
    doc.text(`${etiquetaDoc(cliente.tipoDocumento) || 'Documento'}: ${cliente.numeroDocumento}${dv}`, { width: colW });
  }
  if (cliente.razonSocial && cliente.nombre && cliente.nombre !== cliente.razonSocial) {
    doc.text(`Atención: ${cliente.nombre}`, { width: colW });
  }
  if (cliente.correo) doc.text(cliente.correo, { width: colW });
  if (cliente.telefono) doc.text(`WhatsApp: ${cliente.telefono}`, { width: colW });
  doc.y = Math.max(yFinDe, doc.y) + 18;

  const cols = { n: 26, prod: ANCHO - 26 - 52 - 92 - 96, cant: 52, precio: 92, sub: 96 };
  const xN = X, xP = xN + cols.n, xQ = xP + cols.prod, xU = xQ + cols.cant, xS = xU + cols.precio;

  function encabezadoTabla() {
    const y = doc.y;
    doc.rect(X, y, ANCHO, 22).fill(AZUL);
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#ffffff');
    doc.text('#', xN + 4, y + 7, { width: cols.n - 8 });
    doc.text('Producto', xP + 4, y + 7, { width: cols.prod - 8 });
    doc.text('Cant.', xQ, y + 7, { width: cols.cant - 6, align: 'right' });
    doc.text('Precio unit.', xU, y + 7, { width: cols.precio - 6, align: 'right' });
    doc.text('Subtotal', xS, y + 7, { width: cols.sub - 6, align: 'right' });
    doc.y = y + 22;
  }
  encabezadoTabla();

  const limiteY = doc.page.height - doc.page.margins.bottom - 150;
  doc.font('Helvetica').fontSize(9.5).fillColor(TINTA);
  lineas.forEach((l, i) => {
    const titulo = nombreLegible(l.titulo);
    const alto = Math.max(20, doc.heightOfString(titulo, { width: cols.prod - 8 }) + 8);
    if (doc.y + alto > limiteY) {
      doc.addPage();
      cabecera();
      encabezadoTabla();
      doc.font('Helvetica').fontSize(9.5).fillColor(TINTA);
    }
    const y = doc.y;
    if (i % 2 === 1) doc.rect(X, y, ANCHO, alto).fill(ZEBRA);
    doc.fillColor(TINTA);
    doc.text(String(i + 1), xN + 4, y + 5, { width: cols.n - 8 });
    doc.text(titulo, xP + 4, y + 5, { width: cols.prod - 8 });
    doc.text(String(l.cantidad), xQ, y + 5, { width: cols.cant - 6, align: 'right' });
    doc.text(pesos(l.precio), xU, y + 5, { width: cols.precio - 6, align: 'right' });
    doc.text(pesos(l.subtotal ?? l.precio * l.cantidad), xS, y + 5, { width: cols.sub - 6, align: 'right' });
    doc.moveTo(X, y + alto).lineTo(X + ANCHO, y + alto).lineWidth(0.5).strokeColor(LINEA).stroke();
    doc.y = y + alto;
  });

  doc.y += 10;
  const yT = doc.y;
  doc.rect(xU - 6, yT, cols.precio + cols.sub + 6, 26).fill('#eef4fc');
  doc.font('Helvetica-Bold').fontSize(11).fillColor(TINTA)
    .text('TOTAL', xU, yT + 8, { width: cols.precio - 6, align: 'right' })
    .text(pesos(total), xS, yT + 8, { width: cols.sub - 6, align: 'right' });
  doc.y = yT + 34;
  doc.font('Helvetica').fontSize(8.5).fillColor(GRIS)
    .text('Precios en pesos colombianos (COP). Sujetos a disponibilidad de inventario al momento de la compra.', X, doc.y, { width: ANCHO });

  {
    const nombreCli = String(cliente.nombre || cliente.razonSocial || '').trim();
    const textoWa = `Hola, soy ${nombreCli || 'cliente de HORECA'}. Tengo dudas sobre la cotización ${numero}.`;
    const enlaceWa = `https://wa.me/${WA_CAMILA}?text=${encodeURIComponent(textoWa)}`;

    const acciones = [
      enlaceCarrito && { enlace: enlaceCarrito, color: AZUL, etiqueta: 'Comprar', icono: 'carrito' },
      { enlace: enlaceWa, color: VERDE_WA, etiqueta: 'Asesor', icono: 'whatsapp' },
    ].filter(Boolean);

    const PAD = 14, QR = 84, BW = QR, BH = 24, GAP_QR = 14, GAP_BTN = 8, SEP_COL = 18;
    const altoFranja = PAD + QR + GAP_BTN + BH + PAD;
    const anchoQRs = acciones.length * BW + (acciones.length - 1) * GAP_QR;
    if (doc.y + 18 + altoFranja > doc.page.height - doc.page.margins.bottom - 24) doc.addPage();

    doc.y += 18;
    const yF = doc.y;

    doc.save();
    doc.roundedRect(X, yF, ANCHO, altoFranja, 10).fill('#f8fafc');
    doc.dash(3, { space: 3 }).lineWidth(1).strokeColor(LINEA).roundedRect(X + 0.5, yF + 0.5, ANCHO - 1, altoFranja - 1, 10).stroke();
    doc.undash();
    doc.restore();

    const xT = X + PAD;
    const anchoT = ANCHO - PAD * 2 - anchoQRs - SEP_COL;
    const lineas = [
      { ico: 'hoja', texto: 'Continúa tu compra sin imprimir', fuente: 'Helvetica-Bold', tam: 11.5, color: VERDE_ECO, alto: 14 },
      { texto: 'Al mantener esta cotización en formato digital, ayudas a ahorrar aproximadamente:', fuente: 'Helvetica', tam: 9.5, color: GRIS, alto: 24 },
    ];
    const altoMetricas = 12;
    const altoTexto = lineas.reduce((n, l) => n + l.alto, 0) + 4 + altoMetricas;
    let yT = yF + (altoFranja - altoTexto) / 2;
    for (const l of lineas) {
      let x = xT;
      if (l.ico) { icono(doc, l.ico, x, yT + 0.5, 12, l.color); x += 17; }
      doc.font(l.fuente).fontSize(l.tam).fillColor(l.color).text(l.texto, x, yT, { width: anchoT - (x - xT), lineGap: 1.5 });
      yT += l.alto;
    }

    yT += 4;
    const metricas = [
      { ico: 'gota', cifra: '0,45 L', resto: ' de agua' },
      { ico: 'arbol', cifra: '18 g', resto: ' de madera' },
      { ico: 'planeta', cifra: '43 g', resto: ' de CO', sub: '2', fin: 'e' },
    ];
    let xM = xT;
    metricas.forEach((m, i) => {
      if (i) { doc.font('Helvetica').fontSize(9.5).fillColor(GRIS).text('·', xM, yT, { lineBreak: false }); xM += doc.widthOfString('·') + 7; }
      icono(doc, m.ico, xM, yT + 0.5, 10, VERDE_ECO); xM += 13;
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor(TINTA).text(m.cifra, xM, yT, { lineBreak: false, continued: true })
        .font('Helvetica').text(m.resto, { lineBreak: false });
      xM = doc.x;
      if (m.sub) {

        doc.fontSize(6.5).text(m.sub, xM, yT + 3, { lineBreak: false }); xM += doc.widthOfString(m.sub);
        doc.fontSize(9.5).text(m.fin, xM, yT, { lineBreak: false }); xM = doc.x;
      }
      xM += 7;
    });

    let xCol = X + ANCHO - PAD - anchoQRs;
    const yQ = yF + PAD;
    for (const a of acciones) {
      const xq = xCol + (BW - QR) / 2;
      await dibujarQR(doc, a.enlace, xq, yQ, QR, TINTA);
      doc.link(xq, yQ, QR, QR, a.enlace);

      const bx = xCol, by = yQ + QR + GAP_BTN;
      doc.roundedRect(bx, by, BW, BH, 6).fill(a.color);
      const tam = 10;
      doc.font('Helvetica-Bold').fontSize(tam).fillColor('#ffffff');
      const tw = doc.widthOfString(a.etiqueta);
      const alturaIco = 11;
      const anchoIco = a.icono === 'carrito' ? Math.round(alturaIco * CARRITO_PROPORCION) : alturaIco;
      const sep = 5;
      const x0 = bx + (BW - (anchoIco + sep + tw)) / 2;
      const yIco = by + (BH - alturaIco) / 2;
      if (a.icono === 'whatsapp') iconoWhatsApp(doc, x0, yIco, alturaIco, '#ffffff');
      else if (a.icono === 'carrito' && CARRITO_BLANCO) {
        try { doc.image(CARRITO_BLANCO, x0, yIco, { height: alturaIco }); } catch {  }
      }

      const alturaCaps = 0.718 * tam;
      doc.text(a.etiqueta, x0 + anchoIco + sep, by + (BH - alturaCaps) / 2 - 0.5, { lineBreak: false });
      doc.link(bx, by, BW, BH, a.enlace);
      xCol += BW + GAP_QR;
    }
    doc.y = yF + altoFranja;
  }

  const yPie = doc.page.height - doc.page.margins.bottom - 12;
  doc.font('Helvetica').fontSize(8).fillColor(GRIS)
    .text('Cotización generada por Camila, asesora virtual de HORECA CENTER · horecacenter.co', X, yPie, { width: ANCHO, align: 'center', lineBreak: false });

  doc.end();
  const buffer = await listo;
  return { buffer, nombre: `Cotizacion-HORECA-${numero}.pdf`, numero };
}

export function numeroCotizacion(telefono = '') {
  const d = new Date(Date.now() - 5 * 3600000);
  const p = (n) => String(n).padStart(2, '0');
  const fecha = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
  const hora = `${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
  const suf = String(telefono || '').replace(/\D/g, '').slice(-4);
  return `COT-${fecha}-${hora}${suf ? '-' + suf : ''}`;
}
