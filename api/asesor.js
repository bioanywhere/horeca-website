import { firmaValida, selloReciente } from '../lib/firma.js';
import { consumir, purgar, hayAlmacenCompartido } from '../lib/limite.js';
import { validarAdjunto } from '../lib/imagenes.js';
import {
  buscarProductos,
  familiasDeLaConsulta,
  clienteDeLaConsulta,
  totalProductos,
} from '../lib/catalogo.js';


export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'metodo_no_permitido' });
  }

  const secreto = process.env.SHOPIFY_APP_SECRET;
  if (!secreto) {
    console.error('SHOPIFY_APP_SECRET sin configurar');
    return res.status(503).json({ error: 'servicio_no_configurado' });
  }

  const query = req.query || {};
  if (!firmaValida(query, secreto)) return res.status(403).json({ error: 'firma_invalida' });
  if (!selloReciente(query)) return res.status(403).json({ error: 'peticion_caducada' });

  const cuerpo = typeof req.body === 'string' ? seguroJson(req.body) : req.body || {};
  const consulta = String(cuerpo.consulta || query.consulta || '').slice(0, 2000).trim();
  const modo = String(cuerpo.modo || query.modo || 'buscar').toLowerCase();

  const adjuntos = [];
  let imagenRechazada = false;
  for (const entrada of [cuerpo.imagen, cuerpo.archivo]) {
    if (!entrada) continue;
    const a = await validarAdjunto(entrada);
    if (a) adjuntos.push(a);
    else imagenRechazada = true;
  }
  const imagen = adjuntos[0] || null;

  const clienteId = query.logged_in_customer_id || cuerpo.cliente || null;
  const empresaId = cuerpo.empresa || null;

  purgar();
  const identidad = clienteId
    ? `cliente:${clienteId}`
    : `ip:${(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'desconocida'}`;

  if (!consulta && !imagen) {
    if (imagenRechazada) {
      return res.status(400).json({ error: 'imagen_invalida', mensaje: 'El archivo no es válido o pesa demasiado. Usa JPG, PNG, WEBP, PDF, Excel, CSV o Word de menos de 3 MB.' });
    }
    return res.status(200).json({
      ok: true,
      catalogo: { productos: totalProductos },
      modos: ['buscar', 'ia'],
      mensaje: 'Envie {"consulta": "...", "modo": "buscar"|"ia", "imagen"?: {"tipo","datos"}}.',
    });
  }


  if (modo !== 'ia') {

    if (imagen) return res.status(400).json({ error: 'imagen_requiere_modo_ia' });
    const cupo = await consumir(identidad, Number(process.env.LIMITE_PETICIONES_HORA || 30));
    res.setHeader('X-Cupo-Restante', String(cupo.restantes));
    if (!cupo.permitido) {
      res.setHeader('Retry-After', String(Math.ceil(cupo.reinicioEn / 1000)));
      return res.status(429).json({ error: 'limite_alcanzado' });
    }
    return res.status(200).json({
      ok: true,
      modo: 'buscar',
      consulta,
      interpretacion: { familias: familiasDeLaConsulta(consulta), cliente: clienteDeLaConsulta(consulta) },
      candidatos: buscarProductos({ consulta, cliente: clienteDeLaConsulta(consulta), limite: 12 }),
    });
  }





  if (process.env.ASESOR_PAUSADO === '1') {
    return res.status(200).json({
      ok: true,
      modo: 'ia',
      pausado: true,
      texto:
        'Nuestro asistente con inteligencia artificial está en pausa en este momento. '
        + 'Puedes usar la búsqueda normal del catálogo o escribirnos por WhatsApp al '
        + '+57 311 352 1593 y con gusto te ayudamos.',
      opciones: null,
      propuesta: null,
      cotizacion: null,
      busquedas: [],
    });
  }


  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'ia_no_configurada' });
  }


  const modoAcceso = (process.env.IA_MODO_ACCESO || 'sesion').toLowerCase();

  if (modoAcceso === 'empresa' && !empresaId) {
    return res.status(401).json({
      error: 'empresa_requerida',
      mensaje: clienteId
        ? 'Tu cuenta no esta asociada a una empresa. Escribenos y la configuramos.'
        : 'Inicia sesion con la cuenta de tu empresa para usar el asesor.',
    });
  }

  if (modoAcceso === 'sesion' && !clienteId) {
    return res.status(401).json({
      error: 'sesion_requerida',
      mensaje: 'Inicia sesion con tu cuenta para usar el asesor. La busqueda normal no lo requiere.',
    });
  }

  if (modoAcceso === 'abierto' && !hayAlmacenCompartido) {


    console.warn('IA_MODO_ACCESO=abierto sin almacen compartido: el limite no es global');
  }

  const cupoIA = await consumir(`ia:${identidad}`, Number(process.env.LIMITE_IA_HORA || 8));
  res.setHeader('X-Cupo-Restante', String(cupoIA.restantes));
  if (!cupoIA.permitido) {
    res.setHeader('Retry-After', String(Math.ceil(cupoIA.reinicioEn / 1000)));
    return res.status(429).json({ error: 'limite_alcanzado', mensaje: 'Has alcanzado el limite por hora del asesor.' });
  }

  try {

    const { armarPedido } = await import('../lib/asesor-ia.js');
    const historial = Array.isArray(cuerpo.historial) ? cuerpo.historial.slice(-8) : [];


    const carrito = sanearCarrito(cuerpo.carrito);

    let listaTexto = '';
    if (adjuntos.length) {
      const { leerLista, listaComoTexto } = await import('../lib/lectura-adjuntos.js');
      const lista = await leerLista(adjuntos);
      listaTexto = lista ? listaComoTexto(lista) : '';
    }
    if (!listaTexto) {
      const { listaEscrita } = await import('../lib/lectura-adjuntos.js');
      listaTexto = listaEscrita(consulta);
    }
    const r = await armarPedido({ consulta, historial, adjuntos, clienteId, carrito, listaLeida: listaTexto || null });

    const { registrarUso } = await import('../lib/uso-ia.js');
    await registrarUso({ canal: 'web', clienteId: clienteId || null, modelo: r.uso?.modelo, uso: r.uso });


    if (r.cotizacion && clienteId) {
      const [{ registrarCotizacion }, { datosDeCliente }] = await Promise.all([import('../lib/cotizaciones.js'), import('../lib/fiscales-cliente.js')]);
      const ficha = await datosDeCliente(clienteId).catch(() => null);
      await registrarCotizacion({
        numero: r.cotizacion.numero,
        telefono: ficha?.telefono || null,
        clienteId,
        nombre: ficha?.nombre || null,
        canal: 'web',
        lineas: r.cotizacion.lineas,
        total: r.cotizacion.total,
        enlaceCarrito: r.cotizacion.enlaceCarrito,
      });
    }

    return res.status(200).json({
      ok: true,
      modo: 'ia',
      consulta,
      conImagen: Boolean(imagen),
      imagenRechazada: imagenRechazada || undefined,
      propuesta: r.propuesta,

      cotizacion: r.cotizacion
        ? { numero: r.cotizacion.numero, nombre: r.cotizacion.nombre, datos: r.cotizacion.buffer.toString('base64') }
        : null,
      texto: r.texto,
      listaLeida: listaTexto || null,

      opciones: r.opciones || null,
      busquedas: r.busquedas,
      uso: r.uso,
      acceso: { modo: modoAcceso, empresa: empresaId || null },
      limiteGlobal: cupoIA.global,
      cupoRestante: cupoIA.restantes,
    });
  } catch (e) {



    const detalle = String(e?.message || '');
    console.error('fallo del asesor:', detalle);

    const esSobrecarga = /(429|529|overloaded|rate.?limit)/i.test(detalle);
    const esTransitorio = /(500|502|503|api_error|timeout|ETIMEDOUT|ECONNRESET)/i.test(detalle);

    return res.status(502).json({
      error: esSobrecarga ? 'servicio_saturado' : 'asesor_no_disponible',
      transitorio: esSobrecarga || esTransitorio,
    });
  }
}

function sanearCarrito(c) {
  if (!c || typeof c !== 'object' || !Array.isArray(c.lineas)) return null;
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const lineas = c.lineas.slice(0, 50).map((l) => ({
    titulo: String(l?.titulo || '').slice(0, 160),
    variante: l?.variante != null ? String(l.variante).replace(/\D/g, '').slice(0, 20) : null,
    cantidad: Math.max(0, Math.round(num(l?.cantidad))),
    precio: num(l?.precio),
    subtotal: num(l?.subtotal),
  })).filter((l) => l.titulo && l.cantidad > 0);
  return { lineas, total: num(c.total), unidades: Math.max(0, Math.round(num(c.unidades))) };
}

function seguroJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}
