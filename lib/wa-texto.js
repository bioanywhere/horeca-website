const LIMITE_TEXTO = 4096;


export function desescapar(texto) {
  return String(texto || '')
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\r/g, '');
}

export function recortar(texto) {
  const t = desescapar(texto).trim();
  if (t.length <= LIMITE_TEXTO) return t;
  return t.slice(0, LIMITE_TEXTO - 1) + '…';
}


const pesos = (n) => '$' + Math.round(Number(n) || 0).toLocaleString('es-CO');


function aWhatsApp(texto) {
  return String(texto || '')
    .replace(/\*\*(.+?)\*\*/gs, '*$1*')
    .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
    .replace(/^(\s*)[-+*]\s+/gm, '$1• ')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '$1: $2');
}


const UNID = new Set(['ml','cc','lt','lts','gr','grs','kg','cm','mt','mts','oz','onz','und','un','cx','bx','px','dx','hjs','hojas','pulg']);
const CONECT = new Set(['de','del','la','las','el','los','con','sin','y','o','para','por','a','en']);
export function limpiarNombre(t) {
  let s = String(t || '').replace(/\*/g, ' x').replace(/_/g, ' ');
  s = s.replace(/\bR\/?\s?\d[\d.]*/gi, ' ');
  s = s.replace(/\b[A-Z]{2,3}\d{3,}\b/g, ' ');
  s = s.replace(/#?\b\d{5,}\b/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  const out = s.split(' ').map((w, i) => {
    const low = w.toLowerCase();
    if (low === 'x') return '';
    if (/^x\d+$/i.test(w)) return 'x' + w.slice(1);
    if (UNID.has(low.replace(/[.,]/g, ''))) return low;
    if (/\d/.test(w)) return low;
    if (i > 0 && CONECT.has(low)) return low;
    return low ? low.charAt(0).toUpperCase() + low.slice(1) : low;
  });
  return out.join(' ').replace(/\s+/g, ' ').trim();
}



export function redactarPartes(resultado, tienda, nombre = '') {
  const propuesta = resultado?.propuesta;
  const suelto = (resultado?.texto || '').trim();

  if (!propuesta || !propuesta.lineas?.length) {
    return suelto ? [aWhatsApp(suelto)] : [];
  }

  const partes = [];








  const NOTA_DEF = { sustituto: 'en vez del agotado', agregado: 'te sugiero', ajustado: 'ajusté la cantidad' };
  const cant = (l) => (l.cantidad > 1 ? ` — ${l.cantidad} und · ${pesos(l.subtotal)}` : ` — ${pesos(l.subtotal)}`);
  const nota = (l) => (l.cambio && l.cambio !== 'agregado' ? ` _(${l.cambioNota || NOTA_DEF[l.cambio] || 'cambio'})_` : '');
  const linea = (l) => {
    const marca = l.cambio === 'sustituto' || l.cambio === 'ajustado' ? '👉' : '•';
    return `${marca} ${limpiarNombre(l.titulo)}${cant(l)}${nota(l)}`;
  };

  const pedido = propuesta.lineas.filter((l) => l.cambio !== 'agregado');
  const sugeridos = propuesta.lineas.filter((l) => l.cambio === 'agregado');
  const n = propuesta.lineas.length;
  const encabezado = `🛒 *Tu pedido*${n >= 3 ? ` · ${n} productos` : ''}`;
  const bloque = [encabezado];
  if (sugeridos.length && pedido.length) {
    bloque.push('*Lo que pediste*\n' + pedido.map(linea).join('\n'));
    bloque.push('*Te sugiero*\n' + sugeridos.map(linea).join('\n'));
  } else {
    bloque.push(propuesta.lineas.map(linea).join('\n'));
  }
  if (propuesta.total) bloque.push(`*Total: ${pesos(propuesta.total)}*`);

  if (propuesta.enlaceCarrito) {
    const base = String(tienda || '').replace(/\/+$/, '');
    bloque.push(`🔗 *Revisa y paga aquí:*\n${base}${propuesta.enlaceCarrito}`);
  }
  partes.push(bloque.join('\n\n'));


  if (propuesta.preguntas?.length) {
    partes.push(propuesta.preguntas.map((p) => `• ${p}`).join('\n'));
  }



  return partes.filter((p) => p && p.trim()).map(desescapar);
}


export function redactar(resultado, tienda, nombre = '') {
  const partes = redactarPartes(resultado, tienda, nombre);
  return partes.length ? partes.join('\n\n') : null;
}
