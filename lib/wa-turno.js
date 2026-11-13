import { consultar } from './bd.js';
import { armarPedido } from './asesor-ia.js';
import { redactarPartes, recortar, limpiarNombre } from './wa-texto.js';
import { guardarCarrito, cerrarCarritos, descartarCarritos, ultimoCarritoDe } from './recuperacion.js';
import { acortar } from './enlaces.js';
import {
  detectarCodigo,
  registrarReferido,
  leerConfig as leerConfigReferidos,
  recompensasPorEntregar,
  marcarEntregada,
  mensajeDeRecompensa,
} from './referidos.js';
import { describirRecompensa } from './descuentos.js';
import { detectarOrigen, registrarOrigen } from './origenes.js';
import { registrarResolucion } from './resoluciones.js';
import { enviarCarritoListo } from './wa-plantilla.js';
import { registrarUso } from './uso-ia.js';
import { responder, responderOpciones, enviarPlantilla, notaPrivada, pasarAHumano, escribiendo, etiquetar, anotarContacto, enviarImagen, enviarAdjunto, resolver, hayChatwoot } from './chatwoot.js';



const PLANTILLA_CARRITO = (process.env.WA_PLANTILLA_CARRITO ?? '0') === '1';

const ANUNCIA_ENLACE = /(aqu[ií] (va|tienes|est[aá]|te dejo)|te (dejo|env[ií]o|comparto|mando))[^\n]{0,40}(enlace|link|carrito|bot[oó]n)[^\n]{0,15}👇|(el|tu) (enlace|link) es este|(aqu[ií] (va|tienes|te dejo)|te (dejo|env[ií]o|comparto|mando)) (el|tu|de nuevo el|nuevamente el) (enlace|link|carrito)( de nuevo| nuevamente)?\s*[:.👇]?/i;

const PLANTILLA_CARRITO_ENV = process.env.WA_PLANTILLA_CARRITO_NOMBRE || '';
const WABA_ID = process.env.WHATSAPP_WABA_ID || '1945259146244050';

const PLANTILLA_CANDIDATA = process.env.WA_PLANTILLA_CARRITO_CANDIDATA || 'pago_pedido';
let plantillaCache = { nombre: 'ver_carrito', hasta: 0 };

async function nombrePlantillaCarrito() {
  if (PLANTILLA_CARRITO_ENV) return PLANTILLA_CARRITO_ENV;
  if (Date.now() < plantillaCache.hasta) return plantillaCache.nombre;
  plantillaCache.hasta = Date.now() + 5 * 60 * 1000;
  try {
    const token = process.env.WHATSAPP_TOKEN;
    if (!token) return plantillaCache.nombre;

    const r = await fetch(`https://graph.facebook.com/v21.0/${WABA_ID}/message_templates?name=${PLANTILLA_CANDIDATA}&fields=name,status,category`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    });
    const d = await r.json().catch(() => null);
    const ok = (d?.data || []).some((t) => t.name === PLANTILLA_CANDIDATA && t.status === 'APPROVED' && t.category === 'UTILITY');
    plantillaCache.nombre = ok ? PLANTILLA_CANDIDATA : 'ver_carrito';
    console.log('[wa-turno] plantilla del carrito:', plantillaCache.nombre);
  } catch (e) {
    console.warn('[wa-turno] no se pudo consultar estado de carrito_listo:', e?.message);
  }
  return plantillaCache.nombre;
}
const pesosWa = (n) => '$' + Math.round(Number(n) || 0).toLocaleString('es-CO');
import { descargarAdjunto, describirAdjunto, MAX_ADJUNTOS } from './imagenes.js';
import { leerLista, listaComoTexto, listaEscrita } from './lectura-adjuntos.js';
import { reclamarNuevosDe } from './agrupar.js';
import { atenderDomiciliario, atenderEncuesta } from './entregas.js';
import { registrarCotizacion } from './cotizaciones.js';
import {
  asegurarConversacion,
  guardarMensaje,
  historial,
  consumirCupo,
  leerMemoria,
  guardarMemoria,
  inicioDeSesion,
} from './conversacion.js';

const TOPE_HORA = Number(process.env.WA_TOPE_HORA || 20);
const SIN_TOPE = String(process.env.WA_SIN_TOPE || '').split(',').map((t) => t.replace(/\D/g, '').slice(-10)).filter(Boolean);
const TIENDA = process.env.TIENDA_PUBLICA || 'https://horecacenter.co';


const EN_PARTES = (process.env.WA_RESPUESTA_EN_PARTES ?? '1') !== '0';

const PAUSA_PARTES_MS = Number(process.env.WA_PAUSA_PARTES_MS || 900);
const espera = (ms) => new Promise((r) => setTimeout(r, ms));


function primerNombre(memoria, nombreContacto) {
  const m = memoria ? (Object.entries(memoria).find(([k]) => /nombre/i.test(k)) || [])[1] : null;
  const raw = String(m || nombreContacto || '').trim();
  const p = raw.split(/\s+/)[0] || '';
  return p ? p.charAt(0).toUpperCase() + p.slice(1).toLowerCase() : '';
}

const DISCULPA =
  'Perdona, no logré armar una respuesta. ¿Puedes contarme un poco más de lo que necesitas?';

export async function cerrar(id, estado, error = null) {
  await consultar(
    'update trabajos set estado = $2, error = $3, terminado = now() where id = $1',
    [id, estado, error ? String(error).slice(0, 500) : null]
  );
}


function canal(trabajo) {
  const { cuenta_id: cuenta, conversacion_id: conversacion } = trabajo;
  return {
    enviar: (texto) => responder(cuenta, conversacion, recortar(texto)),
    traspasar: (motivo) => pasarAHumano(cuenta, conversacion, motivo),
    escribiendo: (activo) => escribiendo(cuenta, conversacion, activo),
    etiquetar: (labels) => etiquetar(cuenta, conversacion, labels),
    anotarContacto: (attrs) => anotarContacto(cuenta, conversacion, attrs),
    opciones: (texto, lista) => responderOpciones(cuenta, conversacion, recortar(texto), lista),
    plantilla: (p) => enviarPlantilla(cuenta, conversacion, p),
    plantillaDirecta: (p) => enviarCarritoListo(p),
    nota: (texto) => notaPrivada(cuenta, conversacion, texto),
    imagen: (url, caption) => enviarImagen(cuenta, conversacion, url, caption),
    adjunto: (buf, nombre, tipo, caption) => enviarAdjunto(cuenta, conversacion, buf, nombre, tipo, caption),
    resolver: () => resolver(cuenta, conversacion),
    ofreceTraspaso: hayChatwoot,
  };
}

export async function atender(trabajo, opciones = {}) {
  const { id, wa_id: waId, telefono, nombre } = trabajo;
  const via = { ...canal(trabajo), ...opciones };


  let texto = trabajo.texto;
  let origenAnuncio = null;


  const dom = await atenderDomiciliario({ telefono, texto }).catch(() => null);
  if (dom) {
    await via.enviar(dom.respuesta);
    await cerrar(id, 'hecho', `domiciliario${dom.estado ? ': ' + dom.estado : ''}`);
    return { atendido: true, domiciliario: true, respuesta: dom.respuesta };
  }

  const enc = await atenderEncuesta({ telefono, texto }).catch(() => null);
  if (enc) {
    await asegurarConversacion(telefono, nombre);
    await guardarMensaje(telefono, 'cliente', texto, waId);
    await via.enviar(enc.respuesta);
    await guardarMensaje(telefono, 'asesor', enc.respuesta);
    if (enc.traspaso && via.traspasar) {
      if (via.etiquetar) await via.etiquetar(['entrega', 'problema-entrega']).catch(() => {});
      await via.traspasar(enc.traspaso);
    } else if (via.etiquetar) {
      await via.etiquetar(['entrega', 'entrega-ok']).catch(() => {});
    }
    await cerrar(id, 'hecho', `encuesta: ${enc.resultado}`);
    return { atendido: true, encuesta: enc.resultado, respuesta: enc.respuesta };
  }

  const org = detectarOrigen(texto);
  if (org) {
    texto = org.limpio || texto;
    origenAnuncio = org.campana;
    await registrarOrigen({ telefono, campana: org.campana, detalle: nombre || null });
    if (via.etiquetar) await via.etiquetar(['anuncio', `anuncio:${org.campana}`]).catch(() => {});
  }



  const fotosCliente = [];
  let fotosFallidas = 0;
  const adjuntos = Array.isArray(trabajo.adjuntos) ? trabajo.adjuntos : [];
  for (const a of adjuntos.slice(0, MAX_ADJUNTOS)) {
    if (!a?.url) continue;
    const { adjunto, motivo } = await descargarAdjunto(a.url, { token: process.env.CHATWOOT_BOT_TOKEN || null, nombre: a.nombre || '' });
    if (adjunto) fotosCliente.push(adjunto);
    else {
      fotosFallidas++;
      console.warn(`[wa-turno] adjunto no usable (${motivo}) · trabajo ${id}`);
    }
  }

  const adjuntosPrevios = [];
  const HORAS_PREVIOS = Number(process.env.ADJ_PREVIOS_HORAS || 3);
  const cupoPrevios = Math.max(0, Math.min(2, MAX_ADJUNTOS - fotosCliente.length));
  const empiezaDeCero = /\b(borr[oó]n y cuenta nueva|(empezar|empecemos|empieza|arranquemos|comenzar|comencemos) de cero|desde cero|pedido nuevo|nuevo pedido)\b/i.test(texto || '');
  if (cupoPrevios && HORAS_PREVIOS > 0 && !empiezaDeCero) {
    try {
      const filas = await consultar(
        `select adjuntos, extract(epoch from (now() - creado))::int as seg from trabajos
          where telefono = $1 and id <> $2 and adjuntos is not null and creado > now() - ($3 || ' hours')::interval
          order by creado desc limit 3`,
        [telefono, id, String(HORAS_PREVIOS)]
      );
      for (const f of filas) {
        for (const a of (Array.isArray(f.adjuntos) ? f.adjuntos : [])) {
          if (adjuntosPrevios.length >= cupoPrevios || !a?.url) continue;
          const { adjunto } = await descargarAdjunto(a.url, { token: process.env.CHATWOOT_BOT_TOKEN || null, nombre: a.nombre || '' });
          if (adjunto) adjuntosPrevios.push({ ...adjunto, haceMin: Math.round(Number(f.seg) / 60) });
        }
      }
    } catch (e) {
      console.warn('[wa-turno] no se pudieron recuperar adjuntos anteriores:', e?.message);
    }
  }


  const listaLeida = fotosCliente.length ? await leerLista(fotosCliente) : null;
  const listaTexto = listaLeida ? listaComoTexto(listaLeida) : '';

  const textoHistorial = adjuntos.length
    ? `[El cliente envió ${fotosCliente.length ? fotosCliente.map(describirAdjunto).join(', ') : adjuntos.length + ' archivo(s)'}${listaTexto ? ` con esta lista de pedido:\n${listaTexto}\n` : ''}]${texto ? '\n' + texto : ''}`
    : texto;

  await asegurarConversacion(telefono, nombre);
  await guardarMensaje(telefono, 'cliente', textoHistorial, waId);


  if (Number(trabajo.intentos) > 1) {
    const posterior = await consultar(
      `select 1 from mensajes where telefono = $1 and rol = 'asesor' and creado > $2 limit 1`,
      [telefono, trabajo.creado]
    );
    if (posterior.length) {
      await cerrar(id, 'hecho', 'obsoleto: la conversación ya siguió; no se respondió');
      return { atendido: false, motivo: 'obsoleto' };
    }
  }



  const tel10 = String(telefono).replace(/\D/g, '').slice(-10);
  const sinTope = SIN_TOPE.some((t) => t && tel10.endsWith(t));
  const cupo = sinTope ? { permitido: true } : await consumirCupo(`wa:${telefono}`, TOPE_HORA);
  if (!cupo.permitido) {
    await cerrar(id, 'hecho', 'tope por hora alcanzado; no se respondio');
    return { atendido: false, motivo: 'tope' };
  }


  if (/\b(borr[oó]n y cuenta nueva|(empezar|empecemos|empieza|arranquemos|comenzar|comencemos) de cero|desde cero|pedido nuevo|nuevo pedido|olvida (el|ese|mi) (pedido|carrito)|cancela (el|ese|mi) (pedido|carrito))\b/i.test(texto)) {
    const n = await descartarCarritos(telefono).catch(() => 0);
    if (n) console.log('[wa-turno] carritos descartados por petición del cliente:', n);
  }

  const [previos, memoria, nuevaSesion, carritoVigente] = await Promise.all([
    historial(telefono, waId),
    leerMemoria(telefono),
    inicioDeSesion(telefono, waId),

    ultimoCarritoDe(telefono, { horas: 24 }).catch(() => null),
  ]);


  let bienvenidaReferido = null;
  const codigoEntrante = detectarCodigo(texto);
  if (codigoEntrante) {
    try {
      const r = await registrarReferido({
        codigo: codigoEntrante,
        referidoTel: telefono,
        nombre,
        cuentaId: trabajo.cuenta_id,
        conversacionId: trabajo.conversacion_id,
      });
      if (r.ok) bienvenidaReferido = describirRecompensa(await leerConfigReferidos());
    } catch {

    }
  }





  if (listaTexto) {
    const acuse = `📋 *Leí esto en tu lista:*\n${listaTexto}\n\nYa lo estoy buscando en el catálogo 🔎`;
    try {
      await via.enviar(acuse);
      await guardarMensaje(telefono, 'asesor', acuse);
    } catch (e) {
      console.warn('[wa-turno] no se pudo enviar el acuse de la lista:', e?.message);
    }
  }
  via.escribiendo?.(true);
  try {

    let consultaTurno =
      !fotosCliente.length && fotosFallidas
        ? `${texto ? texto + '\n' : ''}(El cliente adjuntó un archivo pero no se pudo procesar: pídele con amabilidad que lo envíe de nuevo como foto JPG/PNG, PDF o Excel.)`
        : texto;

    const pedirRespuesta = () => armarPedido({
      consulta: consultaTurno,
      adjuntos: fotosCliente,
      adjuntosPrevios,
      listaLeida: listaTexto || listaEscrita(texto) || null,
      historial: previos,
      traspaso: Boolean(via.ofreceTraspaso && via.traspasar),
      memoria,
      telefono,
      carritoWhatsApp: carritoVigente?.resumen ? carritoVigente : null,
      reconocer: nuevaSesion,
      bienvenidaReferido,
      origenAnuncio,
    });
    let resultado = await pedirRespuesta();


    for (let vuelta = 0; vuelta < 2; vuelta++) {
      const nuevos = await reclamarNuevosDe(telefono, id).catch(() => []);
      if (!nuevos.length) break;
      for (const n of nuevos) await guardarMensaje(telefono, 'cliente', n.texto, n.wa_id);
      const extra = nuevos.map((n) => String(n.texto || '').trim()).filter(Boolean).join('\n');
      texto = [texto, extra].filter(Boolean).join('\n');
      consultaTurno = [consultaTurno, extra].filter(Boolean).join('\n');
      console.log(`[wa-turno] ${nuevos.length} mensaje(s) nuevo(s) de ${telefono} mientras respondía: se rehace la respuesta (trabajo ${id})`);
      resultado = await pedirRespuesta();
    }


    await guardarMemoria(telefono, resultado.memoria);


    if (resultado.memoria && via.anotarContacto) {
      await via.anotarContacto(resultado.memoria);
    }


    if (resultado.traspaso && via.traspasar) {
      const aviso = resultado.traspaso.mensaje || 'Te paso con un asesor, en un momento te escribe.';
      await via.enviar(aviso);
      await guardarMensaje(telefono, 'asesor', aviso);
      if (via.etiquetar) await via.etiquetar(['asesor-ia', 'traspaso', resultado.traspaso.categoria]);
      await via.traspasar(resultado.traspaso.motivo);
      await cerrar(id, 'hecho', `traspasado: ${resultado.traspaso.motivo}`);
      return { atendido: true, traspasado: true, respuesta: aviso };
    }


    let partes = redactarPartes(resultado, TIENDA, primerNombre(memoria, nombre));
    if (!EN_PARTES) partes = partes.length ? [partes.join('\n\n')] : [];
    const imagenes = (resultado.imagenes || []).slice(0, 3);

    if (!partes.length && !imagenes.length && !resultado.opciones?.opciones?.length) partes = [DISCULPA];


    let enlaceRel = resultado.propuesta?.enlaceCarrito || null;
    let parteEnlace = null;
    let carritoPrevio = null;
    if (PLANTILLA_CARRITO && enlaceRel && via.plantilla) {
      const i = partes.findIndex((p) => p.includes(enlaceRel));
      if (i >= 0) parteEnlace = partes.splice(i, 1)[0];
    }

    const anunciaSinEnlace = !enlaceRel && partes.some((p) => ANUNCIA_ENLACE.test(p) && !/https?:\/\//.test(p));
    if (!enlaceRel && (anunciaSinEnlace || /carrito|link|enlace|pagar|comprar|checkout/i.test(texto))) {
      carritoPrevio = await ultimoCarritoDe(telefono).catch(() => null);
      if (carritoPrevio?.enlace) {
        let enlace = carritoPrevio.enlace;

        const viejo = enlace.match(/\/cart\/([^?\s]+)(\?[^\s]*)?$/);
        if (viejo) {
          const largo = `/cart?hz=${viejo[1]}${viejo[2] ? '&' + viejo[2].slice(1) : ''}`;
          const corto = await acortar(largo, { etiqueta: `carrito ${telefono} (reenvío)` }).catch(() => largo);
          enlace = TIENDA.replace(/\/+$/, '') + corto;
        }
        enlaceRel = enlace.replace(/^https?:\/\/[^/]+/, '');
        parteEnlace = `Así va tu carrito 👇\n${enlace}\n\nToca el enlace para comprar, o dime qué más le agrego 😊`;
      }
    }

    if (anunciaSinEnlace && !parteEnlace) {
      partes = partes
        .map((p) => p.split('\n').filter((l) => !ANUNCIA_ENLACE.test(l)).join('\n').replace(/\n{3,}/g, '\n\n').trim())
        .filter(Boolean);
    }

    let idEnviado = null;
    for (let i = 0; i < partes.length; i++) {
      if (i > 0) await espera(PAUSA_PARTES_MS);
      idEnviado = await via.enviar(partes[i]);
    }

    let carritoPorPlantilla = false;
    if (parteEnlace) {
      await espera(PAUSA_PARTES_MS);
      if (PLANTILLA_CARRITO) try {
        const p = resultado.propuesta;
        const nom = primerNombre(memoria, nombre) || 'cliente';

        const nLineas = p ? p.lineas.length : (carritoPrevio?.resumen || '').split(',').filter(Boolean).length;
        const conteo = nLineas === 1 ? '1 producto' : `${nLineas || 'Varios'} productos`;
        const total = p ? p.total : carritoPrevio?.total;
        const sufijo = enlaceRel.replace(/^\/+/, '');
        const enlaceAbs = `${TIENDA.replace(/\/+$/, '')}/${sufijo}`;
        const cola = 'Toca el botón para revisarlo y pagar. Si pagas por este enlace, el pago se acredita al instante y tu pedido sale sin demoras.';

        const PLANTILLA_CARRITO_NOMBRE = await nombrePlantillaCarrito();
        const esNueva = PLANTILLA_CARRITO_NOMBRE !== 'ver_carrito';

        const codigo = (sufijo.match(/\/c\/([A-Za-z0-9]+)/) || [])[1]?.toUpperCase() || 'WEB';
        const texto = esNueva
          ? `Tu pedido ${codigo} está listo para pagar: ${conteo} · Total *${pesosWa(total)}*.\n\nCompleta el pago con el botón de abajo. Si pagas por este enlace, el pago se acredita al instante y tu pedido sale sin demoras.\n🔗 Pagar pedido: ${enlaceAbs}`
          : `Hola ${nom}, tu carrito está listo: ${conteo}. Total: *${pesosWa(total)}*.\n\n${cola}\n🔗 Ver carrito: ${enlaceAbs}`;
        let idPl = null;

        if (esNueva && via.plantillaDirecta) {
          const r = await via.plantillaDirecta({ telefono, codigo, conteo, total: pesosWa(total), sufijo, nombre: PLANTILLA_CARRITO_NOMBRE }).catch((e) => ({ ok: false, motivo: e?.message }));
          if (r?.ok) {
            idPl = r.id || 'directo';
            if (via.nota) await via.nota(`🛒 Enviado por Camila (plantilla ${PLANTILLA_CARRITO_NOMBRE}, botón «Ver carrito»):\n${texto}`).catch(() => {});
          } else {
            console.warn(`[wa-turno] ${PLANTILLA_CARRITO_NOMBRE} directo falló:`, r?.motivo, '· se usa ver_carrito por Chatwoot');
          }
        }
        if (!idPl) {
          idPl = await via.plantilla({
            nombre: 'ver_carrito',
            texto: `Hola ${nom}, tu carrito está listo: ${conteo}. Total: *${pesosWa(total)}*.\n\n${cola}\n🔗 Ver carrito: ${enlaceAbs}`,
            cuerpo: { 1: nom, 2: conteo, 3: pesosWa(total) },
            botones: [{ type: 'url', parameter: sufijo }],
          });
        }
        if (idPl) { idEnviado = idPl; carritoPorPlantilla = true; console.log('[wa-turno] carrito enviado como plantilla', /^wamid\./.test(String(idPl)) ? `${PLANTILLA_CARRITO_NOMBRE} (directo)` : 'ver_carrito', idPl); }
        else console.warn('[wa-turno] plantilla ver_carrito no aceptada por Chatwoot; va en texto');
      } catch (e) {
        console.warn('[wa-turno] plantilla ver_carrito falló, va en texto:', e?.message);
      }
      if (!carritoPorPlantilla) idEnviado = await via.enviar(parteEnlace);
      partes.push(parteEnlace);
    }


    if (resultado.opciones?.opciones?.length && via.opciones) {
      await espera(PAUSA_PARTES_MS);
      try {
        const idOp = await via.opciones(resultado.opciones.pregunta || '¿Qué prefieres?', resultado.opciones.opciones);
        if (idOp) idEnviado = idOp;
        partes.push(`${resultado.opciones.pregunta || ''}\n[Botones: ${resultado.opciones.opciones.join(' / ')}]`);
      } catch (e) {
        console.warn('[wa-turno] botones fallaron, va en texto:', e?.message);
        idEnviado = await via.enviar(`${resultado.opciones.pregunta}\n${resultado.opciones.opciones.map((o, i) => `${i + 1}. ${o}`).join('\n')}`);
      }
    }


    let cotizacionEnviada = false;
    if (resultado.cotizacion?.buffer && via.adjunto) {
      await espera(PAUSA_PARTES_MS);
      cotizacionEnviada = await via.adjunto(
        resultado.cotizacion.buffer,
        resultado.cotizacion.nombre,
        'application/pdf',
        `Cotización ${resultado.cotizacion.numero} · HORECA CENTER`
      );

      if (cotizacionEnviada) {
        await registrarCotizacion({
          numero: resultado.cotizacion.numero,
          telefono,
          nombre: primerNombre(memoria, nombre),
          canal: 'whatsapp',
          cuentaId: trabajo.cuenta_id,
          conversacionId: trabajo.conversacion_id,
          lineas: resultado.cotizacion.lineas,
          total: resultado.cotizacion.total,
          enlaceCarrito: resultado.cotizacion.enlaceCarrito,
        });
      }
    }


    for (const im of imagenes) {
      if (!via.imagen) break;
      await espera(PAUSA_PARTES_MS);
      await via.imagen(im.url, limpiarNombre(im.titulo));
    }


    try {
      const premios = await recompensasPorEntregar(telefono);
      for (const p of premios) {
        await espera(PAUSA_PARTES_MS);
        const idMsg = await via.enviar(mensajeDeRecompensa(p));
        if (idMsg) await marcarEntregada(p.id, p.rol);
      }
    } catch {

    }


    if (resultado.resolver && via.resolver) {
      await via.resolver();
      registrarResolucion(telefono).catch(() => {});
    }


    if (resultado.propuesta?.enlaceCarrito) {
      await guardarCarrito({
        telefono,
        cuentaId: trabajo.cuenta_id,
        conversacionId: trabajo.conversacion_id,
        nombre: primerNombre(memoria, nombre),
        enlace: TIENDA.replace(/\/+$/, '') + resultado.propuesta.enlaceCarrito,
        total: resultado.propuesta.total,
        resumen: resultado.propuesta.lineas.slice(0, 6).map((l) => `${l.cantidad} × ${limpiarNombre(l.titulo)}`).join(', ') + (resultado.propuesta.lineas.length > 6 ? ` y ${resultado.propuesta.lineas.length - 6} más` : ''),
        lineas: resultado.propuesta.lineas.map((l) => ({ variante: l.variante, cantidad: l.cantidad, titulo: limpiarNombre(l.titulo), precio: l.precio })),
      });
    }
    if (resultado.resolver) await cerrarCarritos(telefono);


    const final =
      (partes.join('\n\n') || (imagenes.length ? '[imágenes de referencia enviadas]' : '')) +
      (cotizacionEnviada ? `\n\n[Cotización ${resultado.cotizacion.numero} enviada en PDF]` : '');
    await guardarMensaje(telefono, 'asesor', final, idEnviado);
    await cerrar(id, 'hecho', partes.length === 1 && partes[0] === DISCULPA ? 'sin propuesta ni texto' : null);

    await registrarUso({ canal: 'whatsapp', telefono, trabajoId: id, modelo: resultado?.uso?.modelo, uso: resultado?.uso });

    return {
      atendido: true,
      respuesta: final,
      partes: partes.length,
      imagenes: imagenes.length,
      lineas: resultado?.propuesta?.lineas?.length || 0,
      uso: resultado?.uso || null,
    };
  } finally {
    via.escribiendo?.(false);
  }
}
