import Anthropic from '@anthropic-ai/sdk';
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { buscarProductos, FAMILIAS, CLIENTES, porVariante, asegurarCatalogoFresco, expandirConsulta } from './catalogo.js';
import { registrarBusquedaFallida } from './busquedas-fallidas.js';
import { textoParaPrompt } from './equivalencias.js';
import { codigoDe, mensajeParaCompartir, leerConfig } from './referidos.js';
import { describirRecompensa } from './descuentos.js';
import { admin, configurado as adminConfigurado } from './admin.js';
import { fetchConUso, conMedicion, costoUSD } from './uso-ia.js';
import { leerFiscalesDe, guardarFiscalesDe, leerFiscalesDeCliente, guardarFiscalesDeCliente, datosDeCliente, parametrosCheckoutPorTelefono, calcularDv } from './fiscales-cliente.js';
import { direccionesDe, guardarDireccionDe } from './direcciones-cliente.js';
import { acortar } from './enlaces.js';
import { crearCotizacionPDF, numeroCotizacion } from './cotizacion-pdf.js';
import { entregasDeTelefono, ETIQUETAS as ETIQUETAS_ENTREGA } from './entregas.js';
import { bloquesDeAdjuntos } from './imagenes.js';

async function stockDeVariantes(ids = []) {
  const uniq = [...new Set((ids || []).map(String).filter(Boolean))];
  const estado = new Map();
  if (!uniq.length || !adminConfigurado()) return estado;
  try {
    const data = await admin(
      `query($ids:[ID!]!){ nodes(ids:$ids){ ... on ProductVariant { id availableForSale price } } }`,
      { ids: uniq.map((id) => `gid://shopify/ProductVariant/${id}`) }
    );
    for (const n of data?.nodes || []) {
      if (n?.id) {
        estado.set(n.id.split('/').pop(), {
          disponible: n.availableForSale === true,
          precio: n.price != null ? Math.round(Number(n.price)) : null,
        });
      }
    }
  } catch {

  }
  return estado;
}

const disponibilidadReal = (lineas = []) => stockDeVariantes((lineas || []).map((l) => l.variante));

async function ultimoPedidoDe(telefono) {
  const tel10 = String(telefono || '').replace(/\D/g, '').slice(-10);
  if (!tel10 || !adminConfigurado()) return null;

  const tel = tel10.startsWith('3') ? '+57' + tel10 : '+' + tel10;
  try {
    const d = await admin(
      `query($q:String!){ customers(first:5, query:$q){ nodes{
         orders(first:5, sortKey:CREATED_AT, reverse:true){
           nodes{ name createdAt lineItems(first:40){ nodes{ quantity title variant{ id } } } } } } } }`,
      { q: `phone:${tel}` }
    );
    const nodos = d?.customers?.nodes || [];

    const porPedido = new Map();
    for (const c of nodos)
      for (const o of c.orders?.nodes || []) if (!porPedido.has(o.name)) porPedido.set(o.name, o);
    const o = [...porPedido.values()].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
    if (!o) return null;
    const items = (o.lineItems?.nodes || [])
      .filter((l) => l.variant?.id)
      .map((l) => ({ variante: l.variant.id.split('/').pop(), cantidad: l.quantity, titulo: l.title }));
    return items.length ? { nombre: o.name, fecha: o.createdAt, items } : null;
  } catch {
    return null;
  }
}

const MODELO = (process.env.ASESOR_MODELO || 'claude-haiku-4-5-20251001').trim();
const ES_HAIKU = /haiku/i.test(MODELO);

const cliente = new Anthropic({
  fetch: fetchConUso,
  ...(process.env.ANTHROPIC_WORKSPACE_ID ? { defaultHeaders: { 'anthropic-workspace-id': process.env.ANTHROPIC_WORKSPACE_ID } } : {}),
});

const SISTEMA = `Eres Camila, la asesora de compra de HORECA Center, distribuidor
institucional en Barranquilla, Colombia. Atiendes a negocios: hoteles,
restaurantes, cafeterias, clinicas, oficinas, bares, minimercados y empresas de aseo.

Tu trabajo es convertir lo que el cliente pide en lenguaje natural en un pedido
concreto de productos que EXISTEN y estan DISPONIBLES en el catalogo.

SALUDO Y PRESENTACION
- Preséntate siempre como Camila, con un tono cálido, cercano, profesional y respetuoso.
- Al iniciar una conversación nueva, saluda según la franja horaria del cliente
  (te la indico en el CONTEXTO DE AHORA): «Buenos días», «Buenas tardes» o «Buenas noches».
- Si NO conoces el nombre del cliente, pídelo de forma natural. Ejemplo:
  «¡Buenas tardes! Soy Camila 😊. Qué gusto atenderte. ¿Me regalas tu nombre para poder ayudarte mejor?»
- Si YA conoces su nombre, NO lo vuelvas a preguntar: úsalo en el saludo y ponte a su
  disposición. Ejemplo: «¡Buenas tardes, Carlos! Soy Camila 😊. Qué gusto saludarte
  nuevamente. Cuéntame, ¿en qué te puedo ayudar hoy?»
- Evita saludos excesivamente largos, repetitivos o artificiales. Si ya vienes a mitad
  de la conversación, no vuelvas a saludar.

DISPONIBILIDAD DE INVENTARIO (regla que no puedes romper)
- Cada producto que devuelve buscar_productos trae un campo "disponible". Antes de
  recomendar, ofrecer o meter cualquier producto al pedido, comprueba que "disponible"
  sea verdadero.
- El pedido (carrito) se arma EXCLUSIVAMENTE con productos disponibles. Nunca metas al
  pedido un producto agotado, sin existencias o cuya disponibilidad no puedas confirmar.
- Cuando presentes alternativas, prioriza las que: (1) estén disponibles, (2) cumplan
  la necesidad del cliente, (3) tengan buena relación entre precio, rendimiento y
  calidad, y (4) puedan sustituir fácilmente lo que buscaba el cliente.

PRODUCTO AGOTADO Y SUSTITUCIONES
- Si el cliente pide algo que no tiene inventario, no te limites a decir que está
  agotado. Responde de forma comercial, positiva y orientada a resolver su necesidad.
- Recomienda de inmediato una alternativa que SÍ esté disponible y explica en una frase
  por qué le sirve. Ejemplo: «Justo en este momento se nos agotó ese producto, pero
  tengo este otro disponible que te sirve para lo mismo. ¿Quieres que te lo agregue?»
- Al armar el pedido, marca cada linea que NO sea lo que el cliente pidio tal cual con el
  campo «cambio» (sustituto / agregado / ajustado) y una «cambioNota» corta. Asi el cliente
  ve claramente que fue un cambio. Lo que pidio exacto NO lleva marca.
  Un tamaño, formato o presentación distinta a la pedida TAMBIÉN es cambio (oficio en vez de carta,
  legajador en vez de carpeta, cuñete en vez de galón): márcalo «sustituto» con una nota como
  «oficio; carta agotada», y en tu texto NUNCA lo describas como si fuera lo que pidió.
- BAJO PEDIDO: si el producto está agotado (o no existe en el catálogo) y NO tienes un sustituto
  disponible que de verdad le sirva, di que en este momento no lo tienes y cierra SIEMPRE con esta
  frase (tal cual o casi): «Si lo quieres bajo pedido, indícame y te comunico con un asesor». Si el
  cliente responde que sí lo quiere bajo pedido, sigue la instrucción de la sección BAJO PEDIDO de
  este contexto (varía según el canal).

CÓMO BUSCAR SIN PERDER LO YA OFRECIDO
- Si el cliente ELIGE una opción que tú ya le ofreciste (un aroma, una talla, un color, una presentación),
  no vuelvas a buscar con la frase completa («jabón neutro caja x24 x500ml»): busca de nuevo el producto
  BASE («jabón de manos») y toma la variante que coincide con lo elegido. Nunca digas que no existe algo
  que acabas de ofrecer en el turno anterior.
- Si una búsqueda literal no devuelve nada, antes de concluir que no lo tenemos prueba 2 o 3 consultas más
  simples en el mismo uso de buscar_productos: el nombre genérico sin presentación, un sinónimo, la familia.
- Cuando escribas nombres de productos que traen asteriscos o símbolos raros del ERP (p. ej. «PX10*200»),
  escríbelos sin esos símbolos («PX10 x 200»): un asterisco suelto rompe el formato en WhatsApp.

HONESTIDAD (regla que no puedes romper)
- Nunca inventes disponibilidad, características, precios, rendimientos ni sustitutos.
  Todo sale del catálogo real.
- NO afirmes que una alternativa «rinde más», «es más económica», «dura más» o
  ventajas parecidas a menos que los datos del catálogo lo permitan comprobar. Si no
  puedes comprobarlo con los datos, ofrécela por lo que SÍ sabes —que está disponible y
  cumple la misma función— sin prometer ventajas que no constan.

El objetivo no es solo encontrar el producto exacto solicitado, sino resolver la
necesidad de compra usando productos realmente disponibles:
necesidad del cliente → verificar inventario → recomendar la mejor alternativa
disponible → ofrecer agregarla al carrito.

ENVÍOS (regla simple; NO calcules ni clasifiques tarifas)
- NO ofrecemos envío gratis en ningún caso ni a partir de ningún monto. Nunca lo prometas ni lo
  sugieras, ni propongas agregar productos para «alcanzar» un envío gratis.
- Si preguntan cuánto cuesta el envío, responde sencillo: «El costo del envío se calcula
  automáticamente en el checkout según tu ubicación y los productos del pedido». En Barranquilla y su
  área metropolitana el domicilio depende de la distancia a la sede. No intentes calcularlo, no des
  cifras ni rangos, y NO pases a un asesor humano por eso.
- Clientes fuera de Barranquilla y su área metropolitana: di que hacemos envíos nacionales y que el valor
  se muestra automáticamente durante el checkout. También existe retiro en tienda sin costo en nuestras dos sedes.

CONTINUIDAD (no repitas ni te contradigas)
- Antes de preguntar un dato o de volver a buscar, revisa la conversación: si ya lo ofreciste, el cliente ya lo
  respondió o está en su lista, úsalo. No vuelvas a preguntar lo que ya tiene respuesta.
- No contradigas lo que ya ofreciste en esta conversación: si mostraste un producto como disponible, no digas luego
  que no existe; búscalo otra vez con el nombre EXACTO con que lo ofreciste.
- Si el cliente pidió una cotización y ya tienes productos, cantidades y sus datos de facturación, genera la
  cotización en ese mismo turno, sin volver a preguntar.
- Nunca vuelvas a preguntar una cantidad, marca, color o tamaño que el cliente ya dijo: si dijo «35 de café»,
  son 35; si dijo «azul», es azul.

PRODUCTOS QUE SE CONFUNDEN
- Una TAPA de vaso no es un vaso: si piden vasos, ofrece vasos. El PORTA TRAPERO es el palo o soporte, no la mecha:
  si piden «trapero con rosca» o «mecha», son los repuestos «TRAPERO … COPA / C/ACOP»; el porta trapero solo si lo piden.

ORDEN DE LA RESPUESTA CUANDO ARMAS UN PEDIDO O COTIZACIÓN
- Empieza por lo que SÍ tienes (el pedido o la cotización con lo que está claro). Lo agotado o no disponible va al
  final, en una línea, con su alternativa o la opción bajo pedido. Nunca abras tu respuesta con «está agotado».
- Si la lista es larga, no la conviertas en un cuestionario: arma lo claro, supón lo razonable (y dilo) y pregunta
  como máximo 3 cosas realmente ambiguas.

COTIZACIONES A NOMBRE DE OTRA EMPRESA
- Si el cliente pide una cotización «a nombre de» otra empresa o con otro NIT (p. ej. «a nombre del parque, NIT …»),
  es una cotización APARTE: arma su pedido por separado (no la mezcles con la anterior) y llama a generar_cotizacion
  con «a_nombre_de» (tipo de persona, tipo y número de documento, razón social). Esos datos NO reemplazan los
  datos de facturación guardados del cliente. Si falta la razón social de una empresa, pídela en una sola pregunta.
- Los mensajes que empiezan con «[Asesor humano…]» los escribió una persona del equipo, no tú. Continúa desde lo que
  ese asesor acordó con el cliente. Si el asesor ya cerró la venta o ya envió cotización o pedido, no propongas otro
  ni repitas sus preguntas: ayuda solo con lo nuevo que pida el cliente. Nunca empieces tu respuesta con esa marca.

NO INVENTES LO QUE NO VES
- Nunca menciones productos, cantidades, marcas ni datos que no estén escritos en la conversación o en un adjunto que
  estés viendo en este turno. Si el cliente se refiere a una foto o archivo que no tienes delante, dilo con honestidad
  («no tengo la imagen a la vista en este momento, ¿me la reenvías?»); nunca digas que «no llega con claridad» si no
  la estás viendo, y nunca completes la lista con productos supuestos.

DATOS OFICIALES DE LA EMPRESA (usa únicamente esta información; NUNCA inventes ni tomes la dirección de un cliente)
- HORECA CENTER es una marca de DISNAR S.A.S. NIT 802003599-2.
- Sede principal: Calle 92 # 46 - 09, Barranquilla, Atlántico. Permite retiro de pedidos en tienda. HORECA CENTER no
  está dentro de ningún centro comercial.
- Sede Villa Campestre: Calle 3A # 24 - 71, Barranquilla, Atlántico. También permite retiro de pedidos en tienda.
- Retiro en tienda (sin costo): el cliente elige la sede en el checkout; allí solo aparecen las sedes que tienen
  existencias de todo el pedido. El pedido suele estar listo en 24 horas y le avisamos por WhatsApp cuando puede pasar.
- Si el cliente pregunta «¿dónde están?», «¿tienen local en X?» o por otras sedes, informa estas ubicaciones según corresponda.
- Clientes en otras ciudades de Colombia: hacemos envíos por transportadora; pueden aplicar términos, condiciones,
  tiempos y costos especiales de envío.
- Contacto: WhatsApp y teléfono +57 311 352 1593 · correo horecacenter@disnarsas.com.
- Horario de atención comercial: lunes a viernes de 9:00 a. m. a 6:00 p. m. y sábados de 9:00 a. m. a 4:00 p. m., en jornada continua; domingos y festivos no laboramos.
- TÚ (Camila) atiendes las 24 horas, los 7 días: buscas productos, armas carritos, generas cotizaciones en PDF
  y respondes a cualquier hora, de inmediato. NUNCA digas que enviarás algo «mañana» o «después de las 9»:
  todo lo que puedes hacer, lo haces en el momento.
- La tienda online recibe pedidos las 24 horas; el horario de atención aplica solo a la bodega y al equipo
  humano: el procesamiento, el despacho y el retiro en tienda ocurren dentro de ese horario. Si un cliente
  PAGA fuera del horario, dile que su pedido quedó recibido y que se procesa/despacha en el siguiente horario
  operativo (sin dejar de atenderlo tú ahora).

PAGO
- El pago se concluye en el LINK del carrito (checkout de Shopify). Cuando el
  cliente esté listo para pagar, indícale con naturalidad que pague en el link.
- NO preguntes cómo prefiere pagar ni ofrezcas botones de «Pagar en línea /
  Contra entrega»: el enlace ya trae todos los medios (tarjeta, PSE,
  transferencia, Efecty y contra entrega) y el cliente elige allí. Solo explica
  un medio de pago si el cliente lo pregunta o lo menciona.
- Si dice que quiere PAGO CONTRA ENTREGA o pagar EN EFECTIVO al recibir: responde
  que no hay problema; que entre al enlace del carrito, complete sus datos, elija
  «Pago contra entrega» en el paso de pago y pulse «Finalizar pedido» para que se
  despache; paga al recibirlo. Vuelve a poner el enlace del carrito.
- Si dice que quiere pagar por un MEDIO ELECTRÓNICO (Nequi, Daviplata, PSE,
  transferencia, Bancolombia, tarjeta, Mercado Pago…): dile que el pago se hace
  A TRAVÉS DEL ENLACE del carrito, donde están disponibles: tarjeta de crédito o
  débito, transferencia con Bancolombia, PSE y Efecty. Aclara que pagar por el
  enlace hace que el pago se acredite AL INSTANTE y no se retrase la entrega del
  pedido (un pago hecho por fuera hay que verificarlo a mano y demora el despacho).
  Vuelve a poner el enlace. Si pide Nequi o Daviplata, indícale que en el enlace
  puede pagar con PSE o con su tarjeta. No des números de cuenta ni pidas
  comprobantes por el chat.
- El ENLACE del carrito lo agrega el SISTEMA debajo del total de la lista cada vez
  que llamas a proponer_pedido. Si en tu respuesta mencionas el enlace (pago, contra
  entrega, «para pagar»), SIEMPRE llama a proponer_pedido en ese mismo turno; si no
  hay carrito que armar, no digas «aquí va el enlace». NUNCA escribas tú una URL del carrito ni la copies del
  historial (las viejas caducan y no llevan el formulario). Para «volver a poner el
  enlace» —«dame el carrito», «ver carrito», «mándame el link», al hablar de pago—
  llama de nuevo a proponer_pedido con las líneas vigentes y, en tu texto, di solo
  «aquí va tu carrito» sin pegar ningún enlace.
- NO pases a un asesor por pagar. Solo se traspasa si el cliente menciona
  CRÉDITO o CARTERA (pago a plazos para empresas), no por un pago normal.

COMPLEMENTOS COMPATIBLES
- Muchos productos necesitan otra pieza para funcionar, o se usan junto con un
  complemento. Cuando el cliente pida uno de esos, OFRÉCELE el complemento
  compatible y disponible —pero PREGÚNTALE antes de agregarlo; NO lo metas al
  carrito hasta que diga que sí—. Ej: «¿Te sumo un mango compatible para ese
  repuesto?».
- Es un PATRÓN general (no una lista cerrada); estúdialo caso a caso en el
  catálogo. Familias de complemento en la tienda:
    · repuesto/mecha, escoba o cepillo «S/M» (sin mango), o base de cepillo → su
      mango/cabo/acople (ojo al montaje: copa, acople o rosca);
    · vaso, contenedor, molde o bowl → su TAPA del MISMO tamaño (misma onza/medida);
    · bolsa de basura → la caneca/papelera del MISMO tamaño (litros), y al revés;
    · papel higiénico, toalla o servilleta → su dispensador del formato correcto
      (Z, en rollo, jumbo, interfoliado);
    · dispensador → su recarga del formato/marca correcto (manual→jabón líquido;
      Tork→cartucho/recarga Tork; toalla Z→toalla Z; jumbo→papel higiénico jumbo);
    · trapero → balde con exprimidor.
- COMPATIBILIDAD HONESTA: la SEÑAL de que encajan es que coincida el atributo
  clave en el nombre —tamaño/onza, litros, rosca/montaje, formato o marca—. Solo
  AFIRMA que es compatible cuando esa señal coincide. Si no lo puedes confirmar,
  ofrécelo diciendo «confírmame la medida/tamaño/tipo para asegurar que encaje»,
  sin prometer compatibilidad que no consta.
- El complemento debe estar DISPONIBLE. Ofrece máximo 1 o 2 complementos, sin
  abrumar. Cuando el cliente acepte, agrégalo marcándolo como «agregado».

CONOCIMIENTO DEL NEGOCIO (contexto complementario)
Esto te ayuda a entender mejor a los clientes y el catálogo. Úsalo con naturalidad,
pero NO te limites a esto: sigue razonando con tu conocimiento general, consulta el
catálogo real y decide según cada conversación.
- Cómo nombran las cosas en Colombia / costa Caribe (tradúcelo al buscar; la misma
  tabla la aplica el buscador, ver lib/equivalencias.js): ${textoParaPrompt()}.
- NOTACIÓN DEL ERP en los títulos (léela bien y tradúcela al cliente): en bolsas
  «9L x 5A» = 9 cm de largo por 5 cm de ancho (NO litros, NO años); «PX100» o «x100» =
  paquete de 100; «CX12» / «*12» = caja del proveedor de 12 (NO es la unidad de venta);
  «1A» en escobas, traperos, rastrillos = primera calidad (NO un año); «S/M» = sin mango;
  «C/M» = con mango; «DH» = doble hoja; «BCO» = blanco; «NAT» = natural; «PQ» = paquete.
  Presenta medidas siempre en unidades claras («9 x 5 cm», «paquete de 100»).
- Antes de ofrecer, aclara lo que cambia QUÉ producto (1 o 2 preguntas): servilleta →
  ¿mesa o toalla de mano?; escoba/cepillo → ¿piso o pared?; limpiavidrios → ¿el químico
  o la herramienta?; toalla en rollo → ¿center pull o rollo continuo?; trapero/mecha →
  ¿rosca o portatrapero?; vasos → ¿cartón o plástico? ¿frío o caliente?; bolsa de papel
  → ¿con o sin manija?; guantes → ¿alimentos, aseo o médico?; resma → ¿carta u oficio?;
  rollos/limpión/paño → ¿qué uso? (cambia la resistencia).
- Bolsas de basura por residuo (color): verde = orgánico; blanco = plástico/aprovechable;
  negro = no aprovechables; rojo = biológicos/peligrosos.
- Dispensadores de higiene, dos sistemas: «cartucho sellado» (repuesto preenvasado,
  bag-in-box / pods-refills: más higiénico, recarga en segundos, insumo más caro) y
  «a granel» (depósito rellenable con galón/bidón: más económico, requiere limpieza).
  Recomienda según lo que priorice el cliente (higiene vs. costo).
- Si el cliente pide VER un producto, una foto, imagen o referencia, mándasela con la
  herramienta enviar_imagen (es la primera foto del catálogo) y dile en una frase qué
  le envías.
- Si el cliente quiere repetir su compra, o es un cliente que vuelve, usa ultimo_pedido
  para traer su pedido anterior y ofrécele repetirlo; si acepta, ármalo con
  proponer_pedido (algún producto pudo agotarse o cambiar de precio: se ajusta solo).
- REFERIDOS: cuando un pedido quede listo (tras armar el carrito y pasar el enlace), y
  también si el cliente pregunta por descuentos, promociones o por traer/recomendar a otro
  negocio, usa mi_codigo_referido y comparte el «mensaje» que devuelve TAL CUAL (trae el
  enlace y la recompensa reales). Nunca inventes la recompensa ni el código: usa solo lo que
  devuelva la herramienta. Si devuelve activo:false, NO menciones referidos. No insistas: se
  ofrece una vez, con naturalidad, no en cada mensaje.

REGLAS DE PEDIDO QUE NO PUEDES ROMPER:
0. TODO pedido, carrito o resumen con productos y precios se entrega ÚNICAMENTE con la
   herramienta proponer_pedido (el sistema pinta la lista, el total y el botón/enlace del
   carrito). NUNCA escribas tú en el texto una lista de productos con precios ni un
   «Total:»; si el cliente pide el carrito o cambias una cantidad, vuelve a llamar a
   proponer_pedido con las líneas vigentes. Tu texto solo acompaña (una frase de
   contexto, la pregunta que falte).
1. Solo puedes incluir en el pedido productos devueltos por la herramienta
   buscar_productos. Nunca inventes un producto, ni un precio, ni una referencia.
   Si no encuentras algo, dilo en las notas; no lo sustituyas por algo inventado.
2. Llama a buscar_productos UNA SOLA VEZ, metiendo en el array todas las cosas
   distintas que pida el cliente. Si pide "desengrasante, guantes y bolsas",
   es una llamada con tres entradas, no tres llamadas. Solo vuelve a llamarla
   si alguna busqueda salio vacia y quieres reintentar con otras palabras.
3. Cuando tengas el pedido armado, llama a proponer_pedido UNA sola vez. Esa
   llamada cierra tu turno.
4. Las cantidades son ESTIMACIONES tuyas y el cliente las va a revisar. En el
   campo motivo de cada linea explica en una frase por que esa cantidad, citando
   el dato que te dio el cliente (habitaciones, comensales, dias). Si no te dio
   ningun dato de tamano, pon cantidad 1 y dilo en el motivo.
5. Antes de armar el carrito, resuelve las decisiones que cambian QUÉ producto
   (tipo, línea, marca, presentación, tamaño). Si alguna de esas está abierta,
   haz PRIMERO las preguntas clave —máximo 3, en UN solo mensaje— y NO armes el
   carrito todavía; así no tienes que rehacerlo varias veces. Ejemplo, ante
   «tienes dispensadores»: «¿Los quieres manual o línea Tork? ¿De espuma o de
   jabón líquido? ¿Para cuántos puntos?». Pregunta SOLO lo que cambia el
   producto; la CANTIDAD la estimas tú, no la exijas. Una sola ronda de
   preguntas: no interrogues de más. Si el pedido ya viene claro, arma directo
   sin preguntar —es mejor proponer algo revisable que no proponer nada—.

Familias del catalogo: ${FAMILIAS.join(' | ')}
Tipos de negocio: ${CLIENTES.join(' | ')}

Responde siempre en español de Colombia, con un tono cálido pero profesional.`;

export function saludoDelDia() {
  const ahora = new Date();
  const hora = Number(
    new Intl.DateTimeFormat('en-US', { timeZone: 'America/Bogota', hour: '2-digit', hourCycle: 'h23' }).format(ahora)
  );

  const redondeada = new Date(Math.floor(ahora.getTime() / 600000) * 600000);
  const hhmm = new Intl.DateTimeFormat('es-CO', {
    timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(redondeada);
  if (hora >= 5 && hora < 12) return { saludo: 'Buenos días', franja: 'mañana', hhmm };
  if (hora >= 12 && hora < 19) return { saludo: 'Buenas tardes', franja: 'tarde', hhmm };
  return { saludo: 'Buenas noches', franja: 'noche', hhmm };
}

function contextoDeAhora() {
  const { saludo, franja, hhmm } = saludoDelDia();
  return `CONTEXTO DE AHORA
Hora local del cliente (Colombia): ${hhmm} (franja de la ${franja}). Si es el inicio de la conversación, saluda con «${saludo}».`;
}

function haceCuanto(iso) {
  const dias = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (dias <= 0) return 'hoy mismo';
  if (dias === 1) return 'ayer';
  if (dias < 7) return `hace ${dias} días`;
  if (dias < 14) return 'la semana pasada';
  if (dias < 45) return `hace ${Math.round(dias / 7)} semanas`;
  return `hace ${Math.round(dias / 30)} meses`;
}

const ESTADO_PAGO = { PAID: 'pagado', PENDING: 'pendiente de pago', AUTHORIZED: 'pago autorizado', PARTIALLY_PAID: 'pago parcial', REFUNDED: 'reembolsado', PARTIALLY_REFUNDED: 'reembolso parcial', VOIDED: 'anulado' };
const ESTADO_DESPACHO = { FULFILLED: 'despachado', UNFULFILLED: 'aún sin despachar', PARTIALLY_FULFILLED: 'despacho parcial', IN_PROGRESS: 'preparando el despacho', ON_HOLD: 'en espera', SCHEDULED: 'programado' };
export async function pedidosRecientes({ telefono, clienteId }) {
  if (!adminConfigurado()) return [];
  const campos = `orders(first: 3, sortKey: CREATED_AT, reverse: true) { nodes { name createdAt displayFinancialStatus displayFulfillmentStatus statusPageUrl totalPriceSet { shopMoney { amount } } shippingLine { title } } }`;
  let nodos = [];
  if (telefono) {
    const tel10 = String(telefono).replace(/\D/g, '').slice(-10);
    const tel = tel10.startsWith('3') ? '+57' + tel10 : '+' + tel10;
    const d = await admin(`query($q:String!){ customers(first:5, query:$q){ nodes{ ${campos} } } }`, { q: `phone:${tel}` });
    nodos = (d.customers?.nodes ?? []).flatMap((c) => c.orders?.nodes ?? []);
  } else if (clienteId) {
    const gid = String(clienteId).startsWith('gid://') ? String(clienteId) : `gid://shopify/Customer/${String(clienteId).replace(/\D/g, '')}`;
    const d = await admin(`query($id:ID!){ customer(id:$id){ ${campos} } }`, { id: gid });
    nodos = d.customer?.orders?.nodes ?? [];
  }
  nodos.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  nodos = nodos.slice(0, 3);
  const entregas = telefono ? await entregasDeTelefono(telefono, 10).catch(() => []) : [];
  const fecha = (iso) => new Date(iso).toLocaleString('es-CO', { timeZone: 'America/Bogota', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  return nodos.map((o) => {
    const e = entregas.find((x) => x.pedido_nombre === o.name);
    return {
      pedido: o.name,
      fecha: fecha(o.createdAt),
      total: '$' + Math.round(Number(o.totalPriceSet?.shopMoney?.amount) || 0).toLocaleString('es-CO'),
      pago: ESTADO_PAGO[o.displayFinancialStatus] || String(o.displayFinancialStatus || '').toLowerCase(),
      despacho: ESTADO_DESPACHO[o.displayFulfillmentStatus] || String(o.displayFulfillmentStatus || '').toLowerCase(),
      envio: o.shippingLine?.title || null,
      entrega: e ? { estado: ETIQUETAS_ENTREGA[e.estado] || e.estado, actualizado: fecha(e.actualizado), domiciliario: e.domiciliario_nombre || null } : null,
      enlace: o.statusPageUrl || null,
    };
  });
}

async function contextoDeReconocimiento(telefono) {
  const ult = await ultimoPedidoDe(telefono);
  if (!ult) return null;
  const cuando = haceCuanto(ult.fecha);
  const cuantos = ult.items.length;
  const muestra = ult.items.slice(0, 3).map((i) => i.titulo).join(', ');
  return `CLIENTE QUE VUELVE
Este contacto YA te compró antes: su último pedido fue ${cuando} (${cuantos} producto${cuantos === 1 ? '' : 's'}${muestra ? `, p.ej. ${muestra}` : ''}).
Como es el inicio de una nueva conversación, salúdalo con calidez reconociendo que vuelve (por su nombre si lo sabes). Si su mensaje sugiere que quiere reponer lo de siempre, ofrécele retomar su último pedido —tienes la herramienta ultimo_pedido para traerlo— pero NO lo armes hasta que lo confirme. Si viene por algo puntual, atiende eso sin forzar la repetición.`;
}

const EsquemaLinea = z.object({
  variante: z.string().describe('El id de variante exacto devuelto por buscar_productos'),
  cantidad: z.number().int().min(1).max(999),
  motivo: z.string().describe('Por que este producto y esta cantidad, en una frase'),
  cambio: z.enum(['sustituto', 'agregado', 'ajustado']).optional().describe(
    'Marca SOLO si la linea NO es lo que el cliente pidio tal cual: «sustituto» (reemplaza algo agotado o que no existe), «agregado» (lo sugieres tu, el cliente no lo pidio), «ajustado» (cambiaste la cantidad que implico). Si el cliente lo pidio asi, dejalo VACIO.'
  ),
  cambioNota: z.string().max(60).optional().describe(
    'Nota muy corta para el cliente sobre ese cambio. Ej: «en vez del limpiavidrios agotado». Opcional; si la dejas vacia se usa un texto por defecto.'
  ),
});

const abreviarDireccion = (d) => {
  const base = String(d.empresa || d.direccion || d.etiqueta || '').replace(/\s+/g, ' ').trim();
  return base.length > 20 ? base.slice(0, 19).trim() + '…' : base;
};
const PREGUNTAS_CERRADAS = [
  {
    clave: 'direccion',
    cuando: 'Dirección, si ya hay UNA guardada',
    ejemplo: '«¿Te lo enviamos a <dirección corta>?»',
    detectar: /te lo (enviamos|mandamos|llevamos)|direcci[oó]n (habitual|guardada|de entrega|de siempre)|a (cu[aá]l|qu[eé]) direcci[oó]n/i,
    opciones: (ctx) => {
      const ds = ctx.direcciones || [];
      if (!ds.length) return null;
      if (ds.length === 1) return ['Sí, a esa', 'Otra dirección', 'Retiro en tienda'];
      const vistas = new Set();
      const abrev = ds.map(abreviarDireccion).filter((a) => a && !vistas.has(a) && vistas.add(a)).slice(0, 8);
      return [...abrev, 'Otra dirección', 'Retiro en tienda'];
    },
    extra: 'Direcciones, si hay VARIAS guardadas: NO las enumeres en el texto. Di solo «Tengo estas direcciones guardadas, ¿a cuál te lo enviamos?» y pasa a ofrecer_opciones cada dirección abreviada (≤20 caracteres: calle y número, o el nombre de la sede/empresa si lo tiene, p. ej. «Calle 83 #9-22», «Km 2.8 el Caimo», «Sede Norte») más «Otra dirección» y «Retiro en tienda». Con 4 o más opciones se ve como lista, que es lo correcto. Sin cursivas ni negritas en las direcciones. Si hay UNA, escríbela dentro de la pregunta («¿Te lo enviamos a Calle 83 #9-22?»); nunca dejes «Tengo esta dirección:» vacío.',
  },
  {
    clave: 'cotizacion',
    cuando: 'Cotización',
    ejemplo: '«¿Quieres la cotización en PDF?»',
    detectar: /cotizaci[oó]n (formal )?en pdf|(quieres|necesitas|te env[ií]o) (la |una )?cotizaci[oó]n/i,
    opciones: () => ['Sí, en PDF', 'No, así está bien'],
    extra: 'Esa pregunta es solo cuando TÚ ofreces la cotización. Si el cliente ya la pidió («dame la cotización», «necesito cotización formal»), NO preguntes: genérala directamente con la herramienta (pidiendo antes los datos de facturación que falten).',
  },
  {
    clave: 'sustituto',
    cuando: 'Producto agotado con sustituto',
    ejemplo: '«¿Qué hacemos con <producto>?»',
    detectar: /qu[eé] hacemos con|(agotad[oa]|sin inventario)[^\n]*\?\s*$/i,
    opciones: () => ['Agregar sustituto', 'Prefiero otro', 'Bajo pedido'],
  },
  {
    clave: 'vuelve_carrito',
    cuando: 'Cliente que vuelve con un carrito sin pagar (inicio de sesión)',
    ejemplo: '«¿Qué quieres hacer con ese pedido?»',
    detectar: /qu[eé] (quieres|deseas|prefieres) hacer con (ese|tu|el) (pedido|carrito)|(pagar(lo)?|modificar(lo)?)[^\n]*(pedido|carrito)[^\n]*nuevo/i,
    opciones: () => ['Pagar ese pedido', 'Modificarlo', 'Pedido nuevo'],
  },
  {
    clave: 'vuelve_carrito_web',
    cuando: 'Cliente web que abre el chat con productos en el carrito (primer mensaje)',
    ejemplo: '«¿Seguimos con lo que tienes en el carrito o armamos uno nuevo?»',
    detectar: /seguimos con[^\n]*carrito|(continuar|seguir) con (tu|el|lo que tienes en el) carrito/i,
    opciones: () => ['Seguir con mi carrito', 'Pedido nuevo'],
  },
  {
    clave: 'vuelve_repetir',
    cuando: 'Cliente que vuelve y ya compró antes (inicio de sesión, sin carrito pendiente)',
    ejemplo: '«¿Repetimos tu último pedido o armamos uno nuevo?»',
    detectar: /repet(imos|ir)[^\n]*(pedido|compra)|(mismo|último) pedido[^\n]*nuevo/i,
    opciones: () => ['Repetir mi pedido', 'Pedido nuevo'],
  },
  {
    clave: 'cantidad',
    cuando: 'Cantidades típicas o presentaciones',
    ejemplo: '«¿Cuántas cajas?» → [1 caja] [2 cajas] [3 cajas]; «¿Qué presentación?» → [3.785 ml] [20 L]',
    detectar: null,
    opciones: () => null,
  },
];

function instruccionesBotones() {
  const casos = PREGUNTAS_CERRADAS.map((p) => {
    const ops = p.opciones({ direcciones: [{ direccion: 'Calle 83 #9-22' }] });
    return `- ${p.cuando}: ${p.ejemplo}${ops ? ' → ' + ops.map((o) => `[${o}]`).join(' ') : ''}.${p.extra ? '\n- ' + p.extra : ''}`;
  });
  return `BOTONES DE RESPUESTA (WhatsApp y web: mismo mecanismo)
Cuando la respuesta del cliente sea una elección corta, usa ofrecer_opciones en vez de pedir que escriba. Casos:
${casos.join('\n')}
Reglas: una sola pregunta con botones por turno; opciones de máximo 20 caracteres, sin emojis; el texto del mensaje no repite las opciones. La respuesta del cliente llega como el texto del botón: trátala como su elección. Las preguntas abiertas (qué necesita, cuántas mesas) siguen siendo texto normal.
IMPORTANTE: los corchetes de arriba son solo notación de estas instrucciones. NUNCA escribas «[Sí, en PDF] [No, así está bien]» ni «[Botones: …]» ni opciones entre corchetes en el texto al cliente: las opciones van ÚNICAMENTE por la herramienta ofrecer_opciones (salen como botones reales). En el historial, una línea «[Botones: A / B]» solo indica que ese turno llevó botones; no la copies. Tu texto termina en la pregunta, sin listar las opciones.`;
}

function botonesParaPregunta(texto, ctx) {
  const lineas = String(texto || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const ultima = lineas[lineas.length - 1] || '';
  if (!/\?/.test(ultima)) return null;
  for (const p of PREGUNTAS_CERRADAS) {
    if (p.detectar && p.detectar.test(ultima)) {
      const ops = p.opciones(ctx);
      return ops && ops.length >= 2 ? { clave: p.clave, pregunta: ultima, opciones: ops } : null;
    }
  }
  return null;
}

export function sinPromesaDeArmar(texto) {
  if (!texto) return texto;
  let quitado = false;
  const ARMAR = /\b(armo|armamos|armar|armaré|armare|arme|cierro|cerramos|dejo listo)\b/i;
  const CONDICION = /(confirm\w*|una vez|cuando|en cuanto|apenas|mientras|antes de|con eso|con esos|con esa|con esto|si me)/i;
  const OBJETO = /\b(carrito|pedido)\b/i;
  let t = texto.replace(/[^.!?\n]*[.!?]?[ \t]*(?:[😊👍🙌✅💪]\s*)*/gu, (oracion) => {
    if (ARMAR.test(oracion) && CONDICION.test(oracion) && OBJETO.test(oracion)) { quitado = true; return ''; }
    return oracion;
  });
  t = t.replace(/\b(antes de|para) armar (tu|el) (pedido|carrito)( exacto| exactito)?/gi, () => { quitado = true; return 'para ajustar tu pedido'; });
  t = t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (quitado) t = `${t}\n\nTe dejé el carrito armado con lo que ya está claro 👇; si me confirmas esos detalles, lo ajusto.`.trim();
  return t;
}

export async function armarPedido(parametros) {
  const { resultado, uso } = await conMedicion(() => armarPedidoInterno(parametros));
  return { ...resultado, uso: { ...uso, modelo: MODELO, costo_usd: costoUSD(MODELO, uso) } };
}

async function armarPedidoInterno({
  consulta,
  historial = [],
  traspaso = false,
  memoria = null,
  telefono = null,

  clienteId = null,

  carrito = null,

  carritoWhatsApp = null,
  reconocer = false,
  bienvenidaReferido = null,
  origenAnuncio = null,

  imagenes = [],
  adjuntos = [],

  adjuntosPrevios = [],

  listaLeida = null,
}) {

  await asegurarCatalogoFresco();

  const soloNumero = String(consulta || '').match(/^\s*(\d{1,2})\s*[.)]?\s*$/);
  if (soloNumero) {
    const ultimoAsesor = [...historial].reverse().find((m) => m.rol === 'asesor')?.texto || '';
    const item = ultimoAsesor.split('\n').map((l) => l.match(/^\s*(\d{1,2})[.)]\s+(.+?)\s*$/)).find((m) => m && m[1] === soloNumero[1]);
    if (item) {
      consulta = `${soloNumero[1]} (el cliente eligió la opción ${soloNumero[1]} de tu lista anterior: ${item[2].replace(/[*_]/g, '')})`;
    }
  }

  let propuesta = null;
  let cotizacionPedida = null;

  const hayIdentidad = Boolean(telefono || clienteId);
  const leerFiscal = async () =>
    telefono ? leerFiscalesDe(telefono) : clienteId ? leerFiscalesDeCliente(clienteId) : null;
  const guardarFiscal = async (campos) =>
    telefono
      ? guardarFiscalesDe({ telefono, ...campos })
      : clienteId
        ? guardarFiscalesDeCliente({ clienteId, ...campos })
        : { ok: false, motivo: 'sin_identidad' };
  let peticionDeHumano = null;
  let debeResolver = false;
  const nuevaMemoria = {};
  const busquedas = [];
  const imagenesPedidas = [];

  const herramientaBuscar = betaZodTool({
    name: 'buscar_productos',
    description:
      'Busca en el catalogo real de HORECA Center. Acepta VARIAS busquedas de una vez: mandalas TODAS juntas en un solo uso de la herramienta en vez de una por una. Devuelve productos existentes con su id de variante, titulo, precio y familia. Es la UNICA fuente valida de productos.',
    inputSchema: z.object({
      consultas: z
        .array(
          z.object({
            consulta: z.string().describe('Que se busca, en palabras del cliente. Ej: "desengrasante de cocina"'),
            familia: z.enum(FAMILIAS).optional().describe('Acota a una familia si estas seguro'),
            cliente: z.enum(CLIENTES).optional().describe('Acota al surtido de un tipo de negocio'),
          })
        )
        .min(1)
        .max(10)
        .describe('Todas las cosas distintas que pide el cliente, juntas'),
    }),
    run: async (entrada) => {

      const CANDIDATOS = 20, MOSTRAR = 8;
      const grupos = [];
      for (const c of entrada.consultas) {
        let r = buscarProductos({ ...c, limite: CANDIDATOS, sinPenalizarAgotados: true });
        let relajado = false;

        if (!r.length && (c.familia || c.cliente)) {
          r = buscarProductos({ consulta: c.consulta, limite: CANDIDATOS, sinPenalizarAgotados: true });
          relajado = r.length > 0;
        }

        busquedas.push({
          consulta: c.consulta, familia: c.familia || null, cliente: c.cliente || null,
          encontrados: r.length, relajado,
        });
        grupos.push({
          consulta: c.consulta, relajado,
          items: r.map((x) => ({ variante: x.v, titulo: x.t, precio: x.p, familia: x.f, disponible: x.d })),
        });
      }

      const vivo = await stockDeVariantes(grupos.flatMap((g) => g.items.map((i) => i.variante)).slice(0, 250));
      const salida = {};
      for (const g of grupos) {
        for (const it of g.items) {
          const v = vivo.get(String(it.variante));
          if (v) {
            it.disponible = v.disponible;
            if (v.precio != null) it.precio = v.precio;
          }
        }

        const disponibles = g.items.filter((it) => it.disponible).slice(0, MOSTRAR);

        {
          const norm = (x) => String(x || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

          const VACIAS_BF = new Set(['para', 'unos', 'unas', 'necesito', 'quiero', 'tienes', 'tienen', 'favor', 'cotizar', 'unidades', 'unidad', 'paquetes', 'paquete', 'cajas', 'caja', 'como', 'algo', 'otro', 'otra']);
          const palabrasCliente = norm(g.consulta).split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !/^\d+$/.test(w) && !VACIAS_BF.has(w));
          const alternativas = palabrasCliente.map((w) => [w, ...norm(expandirConsulta(w)).split(/[^a-z0-9]+/).filter((x) => x.length >= 3)]);
          const necesarias = alternativas.length <= 2 ? alternativas.length : Math.ceil((alternativas.length * 2) / 3);

          const propias = new Set(norm(g.consulta).split(/[^a-z0-9]+/));
          const anadidas = [...new Set(norm(expandirConsulta(g.consulta)).split(/[^a-z0-9]+/))]
            .filter((x) => x.length >= 2 && !propias.has(x) && !/^\d+$/.test(x) && !/^(oz|x)\d+$/.test(x));
          const casa = (it) => {
            if (!alternativas.length) return true;
            const t = norm(it.titulo);
            const porPalabra = alternativas.filter((alts) => alts.some((x) => t.includes(x.slice(0, 5)))).length;
            if (porPalabra >= necesarias) return true;
            const porFrase = anadidas.filter((x) => new RegExp(`(^|[^a-z0-9])${x.slice(0, 6)}`).test(t)).length;
            return porFrase >= 1 && (anadidas.length === 1 || porFrase >= 2 || porPalabra >= 1);
          };
          const primeros = g.items.slice(0, MOSTRAR);
          const resultado = !g.items.length ? 'sin_resultados'
            : !g.items.some(casa) ? 'sin_coincidencia'
            : !g.items.some((it) => it.disponible && casa(it)) ? 'todos_agotados' : null;
          if (resultado) {
            const original = entrada.consultas.find((c) => c.consulta === g.consulta) || {};
            registrarBusquedaFallida({
              canal: telefono ? 'whatsapp' : 'web',
              persona: telefono || (clienteId ? `web:${clienteId}` : null),
              consulta: g.consulta,
              familia: original.familia || null,
              cliente: original.cliente || null,
              resultado,
              ejemplos: primeros.slice(0, 3).map((it) => `${it.titulo}${it.disponible ? '' : ' (agotado)'}`),
            }).catch(() => {});
          }
        }
        g.items = g.items.slice(0, MOSTRAR);
        if (!g.items.length) {
          salida[g.consulta] = 'sin resultados ni siquiera sin filtros; el catalogo no lo tiene';
        } else if (!disponibles.length) {

          salida[g.consulta] = {
            aviso: 'todos los resultados de esta busqueda estan AGOTADOS; no los ofrezcas: propone una alternativa disponible o vuelve a buscar con otras palabras',
            productos: g.items,
          };
        } else if (g.relajado) {
          salida[g.consulta] = {
            aviso: 'los filtros de familia o negocio dejaban esto vacio, asi que se buscó en todo el catalogo',
            productos: disponibles,
          };
        } else {
          salida[g.consulta] = disponibles;
        }
      }
      return JSON.stringify(salida);
    },
  });

  const herramientaProponer = betaZodTool({
    name: 'proponer_pedido',
    description:
      'Entrega el pedido propuesto. Llamala una sola vez, cuando ya hayas buscado todo lo que necesitas.',
    inputSchema: z.object({
      lineas: z.array(EsquemaLinea).min(1).max(40),
      resumen: z.string().describe('Una o dos frases explicando que armaste'),
      preguntas: z.array(z.string()).max(3).optional()
        .describe('Solo datos imprescindibles que falten. Vacio si no falta nada.'),
    }),
    run: async (entrada) => {

      const malas = [];
      const vistas = new Set();
      const lineas = [];
      for (const l of entrada.lineas || []) {
        const id = String(l.variante || '').trim();
        if (!porVariante(id)) { malas.push(id); continue; }
        if (vistas.has(id)) continue;
        vistas.add(id);
        lineas.push({ ...l, variante: id });
      }
      if (!lineas.length || malas.length) {
        return `ERROR: estas variantes no existen en el catálogo: ${malas.join(', ') || '(ninguna válida)'}. Vuelve a llamar proponer_pedido usando SOLO los ids de variante que devolvió buscar_productos en esta conversación o los del CARRITO VIGENTE del sistema (búscalos si no los tienes). No inventes ids.`;
      }
      propuesta = { ...entrada, lineas, resumen: String(entrada.resumen || '').replace(/^["'\s]+|["'\s]+$/g, '') };
      return 'Pedido recibido. No hagas nada mas.';
    },
  });

  const herramientaHumano = betaZodTool({
    name: 'pasar_a_humano',
    description:
      'Pasa la conversacion a un vendedor de carne y hueso. Usala cuando el cliente PIDA hablar con una persona, o cuando mencione CREDITO o CARTERA (pago aplazado / a plazos para empresas); por el estado de un despacho o una entrega; por un reclamo, devolucion o garantia; o por descuentos y negociacion de precios. NO la uses por el pago normal: pagar el pedido se hace en el LINK del carrito (checkout de Shopify) —cuando el cliente este listo, dile que pague en el link, no lo traspases—. TAMPOCO la uses porque el cliente pregunte cuanto cuesta el envio: eso se responde con «el costo del envio se calcula automaticamente en el checkout segun tu ubicacion y los productos». En los temas de arriba no tienes los datos y una respuesta segura pero inventada hace dano. No la uses para armar pedidos: para eso estas tu.',
    inputSchema: z.object({
      categoria: z.enum(['cartera', 'entrega', 'reclamo', 'precio', 'otro'])
        .describe('El tema, para etiquetar la conversacion: cartera/credito, entrega/despacho, reclamo/garantia, precio/descuento, u otro'),
      motivo: z.string().describe('Una frase para el vendedor: que necesita el cliente'),
      mensaje: z.string().describe('Lo que se le dice al cliente mientras espera'),
    }),
    run: async (entrada) => {
      peticionDeHumano = entrada;
      return 'Conversacion pasada a un vendedor. No hagas nada mas.';
    },
  });

  const herramientaRecordar = betaZodTool({
    name: 'recordar',
    description:
      'Guarda un dato del cliente que debe sobrevivir a esta conversacion: su nombre, el tipo de negocio, cuantas sedes o empleados tiene, marcas o presentaciones que prefiere, o algo que pidio expresamente que recordaras. NO la uses para el pedido en curso ni para cosas de un solo momento. Si el cliente te corrige un dato, vuelve a llamarla con el valor nuevo.',
    inputSchema: z.object({
      clave: z.string().describe('Etiqueta corta y estable: nombre, negocio, sedes, preferencia…'),
      valor: z.string().describe('El dato, en pocas palabras'),
    }),
    run: async ({ clave, valor }) => {
      nuevaMemoria[String(clave).trim().slice(0, 40)] = String(valor).trim().slice(0, 200);
      return 'Anotado.';
    },
  });

  const herramientaImagen = betaZodTool({
    name: 'enviar_imagen',
    description:
      'Envía al cliente la imagen de referencia de un producto (la primera foto del catálogo). Úsala cuando el cliente pida ver el producto, una foto, imagen o referencia. Pasa la(s) variante(s) devueltas por buscar_productos (máximo 3).',
    inputSchema: z.object({
      variantes: z.array(z.string()).min(1).max(3)
        .describe('Ids de variante cuyas imágenes de referencia enviar'),
    }),
    run: async ({ variantes }) => {
      let hubo = false;
      for (const v of variantes || []) {
        const prod = porVariante(String(v));
        if (prod?.i && !imagenesPedidas.some((x) => x.variante === prod.v)) {
          imagenesPedidas.push({ variante: prod.v, url: prod.i, titulo: prod.t });
          hubo = true;
        }
      }
      return hubo ? 'Imagen(es) en camino; cuéntale brevemente qué le mandas.' : 'Ese producto no tiene imagen en el catálogo.';
    },
  });

  const herramientaResolver = betaZodTool({
    name: 'resolver_conversacion',
    description:
      'Marca la conversación como RESUELTA (cerrada). Úsala SOLO cuando el cliente ya terminó: pagó, se despidió, dijo que es todo, o agradeció y no necesita nada más. NO la uses si sigue comprando, preguntando o dudando. Primero despídete con amabilidad y LUEGO resuelve.',
    inputSchema: z.object({}),
    run: async () => {
      debeResolver = true;
      return 'Conversación marcada para cerrar.';
    },
  });

  const herramientaUltimoPedido = betaZodTool({
    name: 'ultimo_pedido',
    description:
      'Trae el ÚLTIMO pedido que hizo este cliente, para ofrecerle repetirlo. Úsala cuando el cliente pida repetir su compra anterior, o cuando vuelve y quieras ofrecerle su pedido habitual. Devuelve productos y cantidades; si acepta, ármalos con proponer_pedido (respetando disponibilidad y precio actuales).',
    inputSchema: z.object({}),
    run: async () => {
      const p = await ultimoPedidoDe(telefono);
      return p ? JSON.stringify(p) : 'Este cliente no tiene pedidos anteriores registrados.';
    },
  });

  const herramientaReferido = betaZodTool({
    name: 'mi_codigo_referido',
    description:
      'Obtiene el código y el enlace de referido de ESTE cliente, para que invite a otro negocio. Úsala cuando un pedido queda listo, o si el cliente pregunta por descuentos, promociones o por traer/recomendar a otro negocio. Devuelve un mensaje ya redactado: compártelo TAL CUAL (trae el enlace y la recompensa reales). Si devuelve activo:false, el programa no está disponible y NO debes ofrecer referidos.',
    inputSchema: z.object({}),
    run: async () => {
      if (!telefono) return JSON.stringify({ activo: false });
      const cfg = await leerConfig();
      if (!cfg.activo) return JSON.stringify({ activo: false });
      const nombre = memoria ? (Object.entries(memoria).find(([k]) => /nombre/i.test(k)) || [])[1] : null;
      const codigo = await codigoDe(telefono, nombre || null);
      if (!codigo) return JSON.stringify({ activo: false });
      return JSON.stringify({
        activo: true,
        codigo,
        recompensa: describirRecompensa(cfg),
        mensaje: mensajeParaCompartir(codigo, describirRecompensa(cfg)),
      });
    },
  });

  const herramientaVerFiscal = betaZodTool({
    name: 'ver_datos_fiscales',
    description:
      'Consulta los datos fiscales (facturación DIAN) YA guardados de este cliente. Úsala ANTES de pedirlos: si existen, confírmalos en vez de volver a preguntar. Devuelve {hay:true,datos} o {hay:false}.',
    inputSchema: z.object({}),
    run: async () => {
      if (!hayIdentidad) return JSON.stringify({ hay: false });
      const f = await leerFiscal();
      return f ? JSON.stringify({ hay: true, datos: f }) : JSON.stringify({ hay: false });
    },
  });

  const herramientaGuardarFiscal = betaZodTool({
    name: 'guardar_datos_fiscales',
    description:
      'Guarda o actualiza los datos fiscales del cliente para la factura electrónica (DIAN). Úsala cuando el cliente te los dé o los corrija. El DV del NIT se calcula solo (no lo pidas). Devuelve {ok:true,datos} si quedó guardado.',
    inputSchema: z.object({
      tipo_persona: z.enum(['Natural', 'Jurídica']).describe('Natural (persona) o Jurídica (empresa)'),
      tipo_documento: z
        .string()
        .describe('Uno de: Cédula de ciudadanía, NIT, Cédula de extranjería, Tarjeta de identidad, Pasaporte, PEP, NIT de otro país'),
      numero_documento: z.string().describe('Número del documento, sin el dígito de verificación'),
      razon_social: z.string().optional().describe('Solo si es Jurídica: nombre/razón social de la empresa'),
      responsabilidad_fiscal: z
        .string()
        .optional()
        .describe('Solo Jurídica y si la sabe: «No aplica / Otros» (R-99-PN; también si dice «no responsable de IVA»), «Gran contribuyente», «Autorretenedor», «Agente de retención de IVA» o «Régimen simple de tributación»'),
      correo_fe: z.string().optional().describe('Correo para enviar la factura electrónica'),
    }),
    run: async (a) => {
      if (!hayIdentidad) return JSON.stringify({ ok: false, motivo: 'sin_identidad' });
      const nom = memoria ? (Object.entries(memoria).find(([k]) => /nombre/i.test(k)) || [])[1] : null;
      const r = await guardarFiscal({
        tipoPersona: a.tipo_persona,
        tipoDocumento: a.tipo_documento,
        numeroDocumento: a.numero_documento,
        razonSocial: a.razon_social,
        responsabilidadFiscal: a.responsabilidad_fiscal,
        correoFe: a.correo_fe,
        nombre: nom || '',
      });
      return JSON.stringify(r);
    },
  });

  const herramientaCotizar = betaZodTool({
    name: 'generar_cotizacion',
    description:
      'Genera y adjunta una COTIZACIÓN formal en PDF (con logo de HORECA, datos de facturación del cliente, productos, cantidades, precios y total) junto con el enlace al carrito con exactamente lo cotizado. Úsala cuando el cliente pida cotización, proforma o presupuesto formal. ORDEN OBLIGATORIO: (1) ten claros los productos, cantidades y presentaciones; (2) verifica los datos de facturación con ver_datos_fiscales y, si faltan, pídelos y guárdalos con guardar_datos_fiscales; (3) llama a proponer_pedido con las líneas; (4) llama a generar_cotizacion. Si falta algo, devuelve qué pedir en vez de generar.',
    inputSchema: z.object({
      a_nombre_de: z
        .object({
          tipo_persona: z.enum(['Natural', 'Jurídica']),
          tipo_documento: z.string().describe('NIT, Cédula de ciudadanía, etc.'),
          numero_documento: z.string().describe('Sin dígito de verificación'),
          razon_social: z.string().optional().describe('Obligatoria si es Jurídica'),
          correo_fe: z.string().optional(),
        })
        .optional()
        .describe('SOLO si el cliente pide la cotización a nombre de OTRA empresa o persona distinta a sus datos guardados. Se usa solo en este PDF; no se guarda.'),
    }),
    run: async (entrada = {}) => {
      if (!hayIdentidad) return JSON.stringify({ ok: false, motivo: 'La cotización en PDF requiere sesión iniciada en la tienda o WhatsApp.' });
      if (!propuesta || !propuesta.lineas?.length) {
        return JSON.stringify({ ok: false, motivo: 'Primero arma el pedido con proponer_pedido (productos y cantidades). Luego vuelve a llamar a generar_cotizacion.' });
      }

      const ultimoAsesor = [...historial].reverse().find((m) => m.rol === 'asesor')?.texto || '';
      const pideCotizacion = /cotiz|proforma|presupuesto|pdf|actualiz|reenv|m[aá]nda|env[ií]a/i.test(consulta || '');
      if (/\[Cotización [^\]]*enviada en PDF\]/.test(ultimoAsesor) && !pideCotizacion) {
        return JSON.stringify({
          ok: false,
          motivo: 'Ya se le envió la cotización en PDF en el turno anterior y el cliente NO pidió actualizarla. NO generes otro PDF: muestra el pedido actualizado con el enlace del carrito y, si el cambio es relevante, ofrece «¿quieres que te actualice la cotización en PDF?».',
        });
      }

      const otro = entrada?.a_nombre_de;
      const fiscal = otro?.numero_documento
        ? { tipo_persona: otro.tipo_persona, tipo_documento: otro.tipo_documento, numero_documento: String(otro.numero_documento).replace(/[^\dA-Za-z]/g, ''), dv: /nit/i.test(otro.tipo_documento || '') ? calcularDv(String(otro.numero_documento).replace(/\D/g, '')) : '', razon_social: otro.razon_social || '', correo_fe: otro.correo_fe || '' }
        : await leerFiscal();
      const faltan = [];
      if (!fiscal?.numero_documento) faltan.push('tipo y número de documento (cédula o NIT)');
      if (!fiscal?.tipo_persona) faltan.push('si es persona natural o jurídica');
      if (fiscal?.tipo_persona === 'Jurídica' && !fiscal?.razon_social) faltan.push('la razón social');
      if (faltan.length) {
        return JSON.stringify({
          ok: false,
          motivo: 'Faltan datos de facturación para la cotización. Pídeselos al cliente con naturalidad y guárdalos con guardar_datos_fiscales; luego vuelve a llamar a generar_cotizacion.',
          faltan,
        });
      }
      cotizacionPedida = { fiscal };
      return JSON.stringify({
        ok: true,
        nota: 'La cotización en PDF y el enlace del carrito se adjuntan automáticamente al final de tu respuesta. En tu texto dile al cliente que le envías la cotización en PDF y que con el enlace del carrito puede comprar directamente; no repitas la lista completa de productos.',
      });
    },
  });

  let opcionesPedidas = null;
  let direccionesVistas = null;
  const herramientaOpciones = betaZodTool({
    name: 'ofrecer_opciones',
    description:
      'Muestra al cliente BOTONES para responder (WhatsApp interactivo) en vez de que escriba. Úsala cuando la respuesta sea una elección corta y cerrada: cómo pagar, confirmar dirección, si quiere la cotización en PDF, qué hacer con un producto agotado, cantidades típicas. Da la pregunta y de 2 a 10 opciones (hasta 3 se ven como botones; más, como lista). Cada opción máximo 20 caracteres, sin emojis. Los botones se envían automáticamente al final de tu mensaje: en tu texto NO repitas las opciones ni digas «responde 1 o 2». Máximo una pregunta con botones por turno.',
    inputSchema: z.object({
      pregunta: z.string().describe('La pregunta corta que encabeza los botones. Ej: «¿Quieres la cotización en PDF?»'),
      opciones: z.array(z.string()).min(2).max(10).describe('Textos de los botones, cortos (≤20 caracteres). Ej: ["Sí, en PDF","No, así está bien"]'),
    }),
    run: async (a) => {
      opcionesPedidas = { pregunta: String(a.pregunta || '').trim().slice(0, 1000), opciones: a.opciones.map((o) => String(o).trim().slice(0, 24)).filter(Boolean).slice(0, 10) };
      return JSON.stringify({ ok: true, nota: 'Los botones se enviarán al final de tu respuesta. No repitas las opciones en el texto.' });
    },
  });

  const herramientaVerDirecciones = betaZodTool({
    name: 'ver_direcciones',
    description:
      'Consulta las direcciones de entrega YA guardadas de este cliente (la predeterminada primero). Úsala antes de pedir la dirección: si existe, confírmala en vez de volver a preguntar. Devuelve {direcciones:[{etiqueta, direccion, ciudad, departamento, empresa, predeterminada}]}.',
    inputSchema: z.object({}),
    run: async () => {
      direccionesVistas = telefono ? await direccionesDe(telefono) : [];
      return JSON.stringify({ direcciones: direccionesVistas });
    },
  });
  const herramientaGuardarDireccion = betaZodTool({
    name: 'guardar_direccion',
    description:
      'Guarda una dirección de entrega en la ficha del cliente y la deja como predeterminada (así el checkout sale relleno). Úsala cuando el cliente te dé o corrija su dirección. Necesita al menos dirección y ciudad; el departamento se deduce de la ciudad si es conocida, si no, pídelo. Devuelve {ok:true, direccion} o {ok:false, motivo}.',
    inputSchema: z.object({
      direccion: z.string().describe('Calle/carrera y número, tal como la dice el cliente. Ej: «Cra 53 # 75-20»'),
      ciudad: z.string().describe('Ciudad o municipio'),
      departamento: z.string().optional().describe('Departamento (Atlántico, Bolívar…). Opcional si la ciudad es conocida'),
      complemento: z.string().optional().describe('Local, oficina, bodega, piso, barrio…'),
      empresa: z.string().optional().describe('Nombre del negocio/sede, si aplica'),
      indicaciones: z.string().optional().describe('Referencias para el domiciliario (timbre, horario, portería…)'),
      nombre: z.string().optional().describe('Quién recibe, si lo dijo'),
    }),
    run: async (a) => {
      if (!telefono) return JSON.stringify({ ok: false, motivo: 'sin_telefono' });
      const nom = a.nombre || (memoria ? (Object.entries(memoria).find(([k]) => /nombre/i.test(k)) || [])[1] : '') || '';
      return JSON.stringify(await guardarDireccionDe({ telefono, nombre: nom, direccion: a.direccion, complemento: a.complemento, ciudad: a.ciudad, departamento: a.departamento, empresa: a.empresa, indicaciones: a.indicaciones }));
    },
  });

  const herramientaEstadoPedido = betaZodTool({
    name: 'estado_pedido',
    description:
      'Consulta el ESTADO de los pedidos recientes de este cliente (pago, despacho y, si va a domicilio, en qué punto está la entrega: asignada, en camino, entregada…). Úsala cuando pregunte dónde va su pedido, si ya salió, cuándo llega o si ya fue entregado. Devuelve una lista con nombre del pedido, fecha, estado en palabras y enlace de seguimiento. NO inventes horas de llegada: si no hay dato, dilo.',
    inputSchema: z.object({}),
    run: async () => {
      if (!hayIdentidad) return JSON.stringify({ pedidos: [] });
      try {
        const p = await pedidosRecientes({ telefono, clienteId });
        return JSON.stringify({ pedidos: p });
      } catch (e) {
        return JSON.stringify({ pedidos: [], error: 'No pude consultar ahora mismo.' });
      }
    },
  });

  const todosAdjuntos = [...(adjuntos || []), ...(imagenes || []).map((im) => ({ ...im, clase: 'imagen' }))];
  const bloquesImg = bloquesDeAdjuntos(todosAdjuntos);
  const hayDocumento = todosAdjuntos.some((a) => a && a.clase && a.clase !== 'imagen');

  const bloquesPrevios = (adjuntosPrevios || []).filter(Boolean).flatMap((a) => {
    const b = bloquesDeAdjuntos([a]);
    return b.length ? [{ type: 'text', text: `ADJUNTO ANTERIOR de esta conversación (el cliente lo envió hace ${a.haceMin ?? '?'} min; ya lo analizaste en un turno anterior):` }, ...b] : [];
  });
  const hayPrevios = bloquesPrevios.length > 0;
  const contenidoUsuario = bloquesImg.length || hayPrevios
    ? [...bloquesPrevios, ...(bloquesImg.length && hayPrevios ? [{ type: 'text', text: 'ADJUNTO NUEVO de este mensaje:' }] : []), ...bloquesImg,
       { type: 'text', text: consulta || (bloquesImg.length ? '(El cliente envió este adjunto sin texto: interpreta qué busca o qué pide y prepara el pedido.)' : '(sin texto)') }]
    : consulta;

  const bloquesUsuario = (Array.isArray(contenidoUsuario) ? contenidoUsuario : [{ type: 'text', text: String(contenidoUsuario || '').trim() || '(sin texto)' }]).map((b) => ({ ...b }));
  bloquesUsuario[bloquesUsuario.length - 1].cache_control = { type: 'ephemeral' };

  const previosModelo = historial.map((m) => ({ role: m.rol === 'asesor' ? 'assistant' : 'user', content: m.texto }));
  while (previosModelo.length && previosModelo[0].role === 'assistant') previosModelo.shift();
  const mensajes = [
    ...previosModelo,
    { role: 'user', content: bloquesUsuario },
  ];

  const pesosCtx = (n) => '$' + Math.round(Number(n) || 0).toLocaleString('es-CO');
  const contextoCliente =
    reconocer && telefono ? await contextoDeReconocimiento(telefono) : null;

  const esSaludo = /^[\s¡!¿?.,😊👋🙂]*(hola|holi|buen[oa]s?(\s+(d[ií]as|tardes|noches))?|hey|qu[eé]\s+tal|saludos|hi|hello|camila)[\s¡!¿?.,😊👋🙂]*(camila|buen[oa]s?(\s+(d[ií]as|tardes|noches))?)?[\s¡!¿?.,😊👋🙂]*$/i.test(String(consulta || ''));
  const carritoPendiente = traspaso && carritoWhatsApp?.resumen ? carritoWhatsApp : null;
  const carritoWeb = !traspaso && carrito?.lineas?.length && !historial.length ? carrito : null;
  const vuelveCon = traspaso && reconocer && esSaludo
    ? (carritoPendiente ? 'carrito' : contextoCliente ? 'compra' : null)
    : carritoWeb && esSaludo ? 'carrito_web' : null;
  const contextoVuelve = vuelveCon === 'carrito'
    ? `CLIENTE QUE VUELVE CON CARRITO SIN PAGAR (inicio de sesión)
Tiene un carrito armado en este chat y sin pagar (ver ÚLTIMO CARRITO ARMADO). En tu saludo, dile en UNA frase que tiene un pedido pendiente de pago (${carritoPendiente.lineas?.length || ''} productos${carritoPendiente.total ? `, ${pesosCtx(carritoPendiente.total)}` : ''}) y pregunta con ofrecer_opciones: «¿Qué quieres hacer con ese pedido?» → [Pagar ese pedido] [Modificarlo] [Pedido nuevo]. No listes las líneas todavía.
Cuando responda: «Pagar ese pedido» → llama proponer_pedido con las líneas del carrito vigente tal cual (le llega el botón de pago); «Modificarlo» → pregúntale qué cambia y luego proponer_pedido con el carrito completo ajustado; «Pedido nuevo» → ignora ese carrito y pregúntale qué necesita.`
    : vuelveCon === 'carrito_web'
      ? `CLIENTE QUE VUELVE CON PRODUCTOS EN EL CARRITO (web, primer mensaje)
Abre el chat saludando y ya tiene ${carritoWeb.lineas.length} producto${carritoWeb.lineas.length === 1 ? '' : 's'} en el carrito (${pesosCtx(carritoWeb.total)}). En tu saludo dilo en UNA frase y pregunta con ofrecer_opciones: «¿Seguimos con lo que tienes en el carrito o armamos uno nuevo?» → [Seguir con mi carrito] [Pedido nuevo]. No listes las líneas todavía.
Cuando responda: «Seguir con mi carrito» → pregúntale qué más necesita o indícale «Ver carrito» para pagar; «Pedido nuevo» → el carrito ya quedó vacío (lo vació el sistema al tocar el botón): pregúntale qué necesita.`
    : vuelveCon === 'compra'
      ? `CLIENTE QUE VUELVE (inicio de sesión, ya compró antes)
En tu saludo pregunta con ofrecer_opciones: «¿Repetimos tu último pedido o armamos uno nuevo?» → [Repetir mi pedido] [Pedido nuevo].
Cuando responda: «Repetir mi pedido» → usa ultimo_pedido y llama proponer_pedido con esas mismas líneas y cantidades (con el botón ya confirmó, no vuelvas a preguntar); «Pedido nuevo» → pregúntale qué necesita.`
      : null;

  const [fichaCuenta, fiscalGuardado] = adminConfigurado() && hayIdentidad
    ? await Promise.all([
        clienteId && !telefono ? datosDeCliente(clienteId).catch(() => null) : null,
        (telefono ? leerFiscalesDe(telefono) : leerFiscalesDeCliente(clienteId)).catch(() => null),
      ])
    : [null, null];
  const nombreMemoria = String((Object.entries(memoria || {}).find(([k]) => /nombre/i.test(k)) || [])[1] || '').trim();
  const conocido = [
    fichaCuenta?.nombre || nombreMemoria ? `- Nombre: ${fichaCuenta?.nombre || nombreMemoria}` : null,
    fichaCuenta?.correo ? `- Correo: ${fichaCuenta.correo}` : null,
    fichaCuenta?.telefono || telefono ? `- Teléfono: ${fichaCuenta?.telefono || telefono}` : null,
    fiscalGuardado?.tipo_persona ? `- Tipo de persona: ${fiscalGuardado.tipo_persona}` : null,
    fiscalGuardado?.tipo_documento || fiscalGuardado?.numero_documento ? `- Documento: ${[fiscalGuardado.tipo_documento, fiscalGuardado.numero_documento].filter(Boolean).join(' ')}` : null,
    fiscalGuardado?.razon_social ? `- Razón social: ${fiscalGuardado.razon_social}` : null,
    fiscalGuardado?.correo_fe ? `- Correo para factura: ${fiscalGuardado.correo_fe}` : null,
  ].filter(Boolean);
  const contextoConocido = conocido.length
    ? `DATOS DEL CLIENTE YA CONOCIDOS (${clienteId && !telefono ? 'de su cuenta en la tienda' : 'de su ficha'})
${conocido.join('\n')}
NUNCA vuelvas a pedir estos datos (ni el nombre, ni el correo, ni el teléfono). Para factura o cotización pide SOLO lo que falte de: tipo de persona, tipo y número de documento, razón social si es jurídica. Si ya está todo, no preguntes nada: confirma en una frase y sigue.`
    : null;
  const recordatorioFiscal =
    reconocer && telefono && adminConfigurado() && !(fiscalGuardado && fiscalGuardado.numero_documento)
      ? `RECORDATORIO DE FACTURACIÓN (para el saludo)
Este cliente aún no tiene datos de facturación guardados para su WhatsApp. En tu saludo de bienvenida agrega UNA frase corta y natural, del tipo: «Y recuerda darme tus datos de facturación si quieres factura o cotización». Solo una línea, sin insistir ni pedir todavía el detalle completo (eso lo harás al cerrar el pedido).`
      : null;

  const contextoReferido = bienvenidaReferido
    ? `NEGOCIO REFERIDO
Este negocio llega recomendado por otro cliente. Dale una bienvenida cálida y, con naturalidad, menciónale que por venir referido, al hacer su primer pedido recibirá ${bienvenidaReferido} (el código de descuento se le entrega automáticamente cuando complete esa primera compra). Luego atiende su necesidad normal.`
    : null;

  const contextoAnuncio = origenAnuncio
    ? `LLEGA DESDE UN ANUNCIO
Este cliente escribió tras tocar un anuncio de HORECA en redes (es tráfico nuevo, probablemente no te conoce). Dale una bienvenida cálida y directa, preséntate como Camila, y ayúdale a cotizar rápido lo que busca para su negocio. Haz como mucho una o dos preguntas clave para entender qué necesita y avanza a proponerle productos disponibles. No lo abrumes ni lo interrogues: la meta es que se lleve una cotización útil en pocos mensajes.`
    : null;

  const contextoFiscal = hayIdentidad
    ? `DATOS FISCALES PARA LA FACTURA (facturación electrónica DIAN)
HORECA factura ante la DIAN; para poder emitir la factura necesitas los datos fiscales del cliente. ${traspaso ? 'Por WhatsApp los recoges tú (no hay formulario), así:' : 'En la tienda web el cliente puede llenarlos en el formulario del carrito, y tú también puedes recogerlos en el chat (quedan en el mismo registro), así:'}
- Pídelos cuando el cliente esté CERRANDO el pedido (o si pide factura o pregunta por facturación), no antes de tiempo.
- PRIMERO usa ver_datos_fiscales: si ya están, confírmalos («¿Te facturo a nombre de … con NIT …?») en vez de volver a preguntar. Si el cliente los corrige, actualízalos.
- Lo que necesitas: (1) si es persona Natural o Jurídica; (2) tipo de documento (Cédula de ciudadanía, NIT, Cédula de extranjería, Tarjeta de identidad, Pasaporte, PEP o NIT de otro país); (3) número de documento; (4) si es Jurídica, la razón social (y su responsabilidad fiscal si la sabe); (5) el correo para la factura (si no lo da, se usa el del pedido). El dígito de verificación del NIT se calcula solo: NO lo pidas.
- Guárdalos con guardar_datos_fiscales en cuanto los tengas. Pide lo mínimo y con calidez; no interrogues.
- NO bloquees la compra por esto: si el cliente no quiere darlos ahora, déjalo pagar igual; quedan pendientes para después.

COTIZACIONES FORMALES (PDF)
- El PDF se envía SOLO cuando el cliente lo PIDE de forma explícita (una cotización, proforma o presupuesto formal, o que se la actualices/reenvíes). Nunca lo mandes por iniciativa propia.
- Una cotización en PDF va UNA sola vez por pedido. Si después el cliente ajusta una cantidad, cambia un producto o simplemente confirma, NO generes otro PDF: muestra el pedido actualizado con su enlace del carrito y, si el cambio es de fondo, pregunta «¿quieres que te actualice la cotización en PDF?». Solo regeneras si dice que sí o lo pide («me actualizas la cotización»).
- Si el cliente pide cotización, se le entrega un PDF profesional (logo HORECA, sus datos de facturación, productos, cantidades, precios y total) MÁS el enlace al carrito con exactamente lo cotizado, para que pueda comprar de una.
- Antes de generarla verifica que tienes TODO: productos, cantidades y presentación de cada uno (busca en el catálogo y confirma disponibilidad), y los datos de facturación (ver_datos_fiscales; si faltan, pídelos con claridad y guárdalos). Si falta algo indispensable, pídelo de forma natural antes de cotizar.
- Con todo listo: proponer_pedido con las líneas y luego generar_cotizacion. El PDF y el carrito se adjuntan solos al final; en tu mensaje anuncia que va la cotización en PDF y que con el enlace del carrito puede comprar directamente.${traspaso ? '' : ' (En la web el PDF aparece como botón de descarga debajo de tu respuesta y el pedido ya trae el botón «Agregar al carrito».)'}
- Cotiza SOLO productos disponibles; si algo está agotado, ofrece la alternativa disponible antes de cotizar.`
    : null;

  const waTienda = (process.env.WA_NUMERO_TIENDA || '573113521593').replace(/\D/g, '');
  const contextoBajoPedido = traspaso
    ? `BAJO PEDIDO (canal WhatsApp)
Si el cliente dice que sí quiere el producto agotado bajo pedido, usa pasar_a_humano con categoria «otro» y motivo «Producto bajo pedido: <producto y cantidad>», y en el mensaje al cliente dile que un asesor le confirma disponibilidad, tiempo de entrega y precio.`
    : `BAJO PEDIDO (canal web)
En el primer turno solo cierra con la frase «Si lo quieres bajo pedido, indícame y te comunico con un asesor»; NO des el enlace todavía. SOLO cuando el cliente responda que sí lo quiere bajo pedido (no puedes traspasarlo desde aquí), dale este enlace para escribirle al asesor por WhatsApp, con el producto ya en el mensaje:
https://wa.me/${waTienda}?text=${encodeURIComponent('Hola, quiero pedir bajo pedido: ')}PRODUCTO
(reemplaza PRODUCTO por el producto y la cantidad, con los espacios como %20). Preséntalo como enlace en Markdown con el texto «Escríbele al asesor por WhatsApp» y dile que allí le confirman disponibilidad, tiempo de entrega y precio.`;

  const contextoCarrito = traspaso
    ? (carritoWhatsApp?.resumen
      ? `ÚLTIMO CARRITO ARMADO EN ESTE CHAT (vigente, aún sin pagar; armado ${(() => { const h = Math.round((Date.now() - new Date(carritoWhatsApp.creado).getTime()) / 36e5); return h < 1 ? 'hace menos de una hora' : `hace ${h} h`; })()})
${Array.isArray(carritoWhatsApp.lineas) && carritoWhatsApp.lineas.length
  ? carritoWhatsApp.lineas.map((l) => `- variante ${l.variante}: ${l.cantidad} × ${l.titulo}${l.precio ? ` (${pesosCtx(l.precio)} c/u)` : ''}`).join('\n')
  : carritoWhatsApp.resumen}${carritoWhatsApp.total ? `\nTotal: ${pesosCtx(carritoWhatsApp.total)}` : ''}
Reglas:
- Si pregunta qué tiene en su pedido/carrito, si tienes algún pedido suyo o algo «en lista», responde con ESTOS datos (nunca digas que no hay pedido) y ofrécele el enlace: vuelve a armarlo con proponer_pedido.
- Si quiere verlo, pagarlo, o agregar/quitar algo, llama proponer_pedido con el pedido COMPLETO: estas mismas líneas (usa EXACTAMENTE los ids de variante de arriba) aplicando el cambio que pida (cantidades nuevas, línea quitada, línea nueva). Para una línea nueva busca primero con buscar_productos. Nunca inventes ids ni repitas una línea.
- Si dice que quiere empezar de cero, ignora este carrito y arma uno nuevo.`
      : null)
    : carrito && carrito.lineas?.length
      ? `CARRITO ACTUAL DEL CLIENTE EN LA TIENDA (leído ahora mismo; es la verdad, no lo contradigas)
${carrito.lineas.map((l) => `- ${l.cantidad} × ${l.titulo} — ${pesosCtx(l.precio)} c/u = ${pesosCtx(l.subtotal)}`).join('\n')}
Total del carrito: ${pesosCtx(carrito.total)} (${carrito.unidades} unidades).
Reglas:
- Si pregunta qué tiene en el carrito o cuánto lleva, responde con ESTOS datos (puede haberlos agregado navegando, no solo por este chat).
- Lo que ya está en el carrito NO lo vuelvas a incluir en proponer_pedido: el botón «Agregar al carrito» SUMA a lo existente y quedaría duplicado. Propón solo lo NUEVO. Si quiere cambiar cantidades de algo que ya tiene, dile que puede ajustarlas en el carrito (ícono arriba a la derecha).
- Para pagar, indícale «Ver carrito» / el carrito de la tienda; no necesitas generar otro enlace.`
      : carrito
        ? `CARRITO ACTUAL DEL CLIENTE EN LA TIENDA: está VACÍO (leído ahora mismo). Si pregunta por su carrito, dile que está vacío y ofrécele armar el pedido.`
        : `CARRITO DE LA TIENDA: no pudiste leerlo en este turno. Si el cliente pregunta qué tiene en el carrito, NO digas que está vacío: dile que desde el chat no lo alcanzas a ver ahora y que lo revise con el ícono del carrito arriba a la derecha; ofrécete a armar o completar el pedido.`;

  const nitOtro = /\ba nombre de(l)?\b/i.test(consulta || '') ? (String(consulta).match(/\bnit\.?\s*:?\s*(\d[\d.\-\s]{5,}\d)/i) || [])[1] : null;
  const contextoANombre = nitOtro
    ? `COTIZACIÓN A NOMBRE DE OTRA EMPRESA\nEl cliente pide esta cotización a nombre de otra entidad con NIT ${nitOtro.replace(/[^\d-]/g, '')}. Es una cotización APARTE de lo anterior: arma solo estos productos y usa generar_cotizacion con «a_nombre_de» (tipo_persona «Jurídica», tipo_documento «NIT», numero_documento sin DV). Si no sabes la razón social, pídela en UNA pregunta corta junto con cualquier otra duda; no uses los datos de facturación guardados del cliente para esta cotización.`
    : null;
  const contextoAudio = /🎤 \(nota de voz\)/.test(consulta || '')
    ? `NOTA DE VOZ
El texto marcado con «🎤 (nota de voz)» es la transcripción automática de un audio del cliente. Trátalo como si lo hubiera escrito, pero tolera errores de transcripción: nombres de marcas o productos mal oídos, cifras y unidades dudosas. Si una parte clave (producto, cantidad) es ambigua o no cuadra con el catálogo, confirma con UNA pregunta corta en lugar de adivinar. No menciones que fue un audio salvo que haga falta para aclarar algo.`
    : null;

  const contextoImagen = bloquesImg.length || hayPrevios
    ? `ADJUNTOS DEL CLIENTE (imágenes y/o documentos)
El cliente adjuntó ${bloquesImg.length + (hayPrevios ? adjuntosPrevios.length : 0) > 1 ? 'varios archivos' : 'un archivo'}${hayDocumento ? ' (incluye documento: PDF, Excel, CSV, Word o texto; su contenido va arriba tal cual)' : ''}. Identifica automáticamente QUÉ es cada uno y actúa según el caso:

A) FOTO DE UN PRODUCTO (o de un empaque): interprétala VISUALMENTE, no solo el texto: producto, marca, empaque y presentación (litros, gramos, unidades), categoría, color, forma, uso probable y texto legible. Busca con buscar_productos mandando VARIAS consultas a la vez (marca+producto, genérico, categoría/uso). Primero coincidencias EXACTAS; si no, equivalentes DISPONIBLES explicando en una frase por qué sirven.

B) LISTA O PEDIDO (foto de una hoja escrita a mano, captura de pantalla, orden de compra, cotización propia o de la competencia, PDF/Excel/CSV/Word con referencias o tablas): es una SOLICITUD DE COMPRA. Extrae TODAS las líneas con producto, cantidad, unidad/presentación (cajas, rollos, galones, unidades…) y cualquier referencia o marca. OBLIGATORIO: tu respuesta al cliente empieza con la lista COMPLETA que leíste, una línea por renglón y en el mismo orden («Leí esto en tu lista: • Carpeta AZ carta — 5 unidades • Resma carta — 4 paquetes …»), ANTES de cualquier pregunta; así el cliente puede corregir y la lista queda escrita en la conversación. Nunca digas «encontré la mayoría» sin enumerar. Luego busca cada línea en el catálogo (varias consultas en un solo uso de buscar_productos) y arma el pedido con proponer_pedido respetando cantidades y presentaciones; convierte unidades con sentido común (p. ej. «3 galones» → la presentación más cercana disponible) y usa el campo «cambio»/«cambioNota» cuando no sea exacto. Lo que no encuentres o sea ambiguo, dilo claramente en el resumen y pregúntalo (máximo 3 preguntas). Si es una cotización ajena, cotiza los equivalentes que sí tenemos.

C) FOTO DE UN ESPACIO O NECESIDAD (cocina, baño, habitación de hotel, área de producción, derrame…): reconoce la necesidad y recomienda el conjunto completo de productos para esa área, agrupado por uso y con cantidades sugeridas.

Reglas: prioriza siempre lo DISPONIBLE; si mandó solo el archivo sin texto, abre con una frase natural («Veo que me envías una lista de pedido; déjame revisarla y armarlo con lo que tenemos disponible»); si no logras leer o identificar suficiente (borroso, ambiguo, tabla sin cantidades), NO inventes: haz UNA pregunta corta y concreta; nunca afirmes que tenemos una marca o referencia salvo que aparezca en buscar_productos.

${listaLeida ? `LISTA DE PEDIDO DEL CLIENTE (la escribió él o ya se le envió la transcripción de su adjunto):\n${listaLeida}\nNO la repitas. Busca TODAS esas líneas (un solo uso de buscar_productos con varias consultas), arma el pedido con proponer_pedido EN ESTE MISMO TURNO respetando cantidades y unidades de la lista —no esperes respuestas para armarlo—, y pregunta solo lo que sea ambiguo o no esté disponible (máximo 3 preguntas, en «preguntas»). Si solo falta un detalle menor (color, tamaño entre dos casi iguales), elige la opción disponible más común, métela al pedido y dilo en una frase para que el cliente la cambie si quiere. Toda línea que no sea exactamente lo de la lista (otro tamaño, formato o presentación) va con cambio=«sustituto» y una cambioNota corta.` : ''}${hayPrevios ? `

ADJUNTOS ANTERIORES: los marcados «ADJUNTO ANTERIOR» los envió el cliente en mensajes previos de esta conversación. Úsalos como la fuente de verdad de lo que pidió (productos, cantidades, unidades) cuando el cliente se refiera a ellos («en la imagen aparece la cantidad», «lo de la lista»). No te vuelvas a presentar ni reinicies el pedido: continúa donde iba la conversación. Si el cliente ya cambió o descartó algo de esa lista, manda lo que dijo el cliente.` : ''}`
    : null;

  const contextoCanal = [
      instruccionesBotones(),
      contextoFiscal,
      contextoBajoPedido,
      traspaso
        ? `DIRECCIÓN DE ENTREGA (WhatsApp)
- Cuando el pedido esté listo para pagar (o si pide envío a domicilio, o pregunta qué direcciones tiene), PRIMERO usa ver_direcciones: si hay una guardada, confírmala con botones («¿Te lo enviamos a Cra 53 # 75-20?» → Sí, a esa / Otra dirección / Retiro en tienda); si hay varias, ofrécelas como botones/lista (ver BOTONES), nunca como lista numerada en texto; si no hay ninguna, pídele la dirección de entrega con ciudad y una referencia (local, piso, timbre) en UNA pregunta.
- En cuanto la tenga, guárdala con guardar_direccion (queda en su cuenta y el enlace del carrito ya llega con ella puesta al checkout). Si la corrige, guarda la nueva.
- Retiro en tienda (sede Calle 92 o Villa Campestre, se elige en el checkout): no hace falta dirección. No bloquees la compra por esto: si no quiere darla ahora, puede escribirla en el checkout.`
        : null,
      hayIdentidad
        ? `ESTADO DEL PEDIDO
Si el cliente pregunta dónde va su pedido, si ya salió, cuándo llega o si ya lo entregaron, usa estado_pedido y responde con lo que devuelva: nombre del pedido, estado en palabras (p. ej. «pagado y en camino con el domiciliario», «entregado hoy a las 3 pm», «pendiente de pago») y el enlace de seguimiento si lo hay. Si no hay pedidos, dilo con naturalidad y ofrece ayudarle a armar uno. NUNCA inventes horas estimadas de llegada ni nombres de transportadora que no vengan en los datos. Si el cliente reporta un problema con una entrega ya hecha (no llegó, llegó incompleto, dañado), usa pasar_a_humano.`
        : null,
    ].filter(Boolean).join('\n\n');

  const contextoTurno = [
      contextoDeAhora(),
      contextoCliente,
      recordatorioFiscal,
      contextoReferido,
      contextoAnuncio,
      contextoConocido,
      contextoVuelve,
      contextoCarrito,
      contextoANombre,
      contextoAudio,
      contextoImagen,
      memoria && Object.keys(memoria).length
        ? `LO QUE YA SABES DE ESTE CLIENTE (de conversaciones anteriores; usalo con naturalidad y no lo recites):
${Object.entries(memoria)
            .map(([k, v]) => `- ${k}: ${v}`)
            .join('\n')}`
        : null,
    ].filter(Boolean).join('\n\n');

  const runner = cliente.beta.messages.toolRunner({
    model: MODELO,
    max_tokens: 8000,

    ...(ES_HAIKU ? {} : { thinking: { type: 'adaptive' }, output_config: { effort: 'medium' } }),

    max_iterations: 7,

    system: [
      { type: 'text', text: SISTEMA, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: contextoCanal, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: contextoTurno },
    ],
    tools: [
      herramientaBuscar,
      herramientaProponer,

      ...(traspaso ? [herramientaHumano, herramientaImagen, herramientaResolver, herramientaUltimoPedido, herramientaReferido, herramientaVerFiscal, herramientaGuardarFiscal, herramientaCotizar, herramientaVerDirecciones, herramientaGuardarDireccion, herramientaOpciones] : []),

      ...(!traspaso && clienteId ? [herramientaVerFiscal, herramientaGuardarFiscal, herramientaCotizar] : []),

      ...(!traspaso ? [herramientaOpciones] : []),

      ...(hayIdentidad ? [herramientaEstadoPedido] : []),
      ...(memoria ? [herramientaRecordar] : []),
    ],
    messages: mensajes,
  });

  let final;
  try {
    final = await runner;
  } catch (e) {

    const msg = String(e?.message || '');
    if (e?.status === 401 || /credit balance|invalid x-api-key|authentication/i.test(msg)) {
      e.permanente = true;
    }
    throw e;
  }

  const textoCrudo = (final.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');

  const pareceListaDePedido = /\btotal\b[^\n]*\$\s?\d/i.test(textoCrudo);

  const anunciaCarrito = /\b(carrito|pedido)\b[^\n]{0,40}\b(listo|armad[oa]|hecho|actualizad[oa]|va abajo|aquí va)\b|\b(aquí va|aqu[ií] tienes|te dejo|te env[ií]o|te comparto)\b[^\n]{0,20}\b(carrito|pedido|enlace|link)\b|\b(el|tu) (enlace|link) es este\b/i.test(textoCrudo);
  const clientePideCarrito = /\b(carrito|link|enlace)\b/i.test(consulta || '') && !/cotiz|pdf/i.test(consulta || '');
  const busco = busquedas.length > 0 || Boolean(carritoWhatsApp?.resumen) || historial.some((m) => m.rol === 'asesor' && /\$\s?\d/.test(m.texto || ''));

  const cortado = final?.stop_reason === 'tool_use' || (final?.content || []).some((b) => b.type === 'tool_use');
  if (cortado) console.warn('[asesor] turno cortado por max_iterations; se remata aparte');

  const mensajesBase = () => {
    const ms = [...(runner.params.messages || [])];
    while (ms.length && ms[ms.length - 1].role === 'assistant' && Array.isArray(ms[ms.length - 1].content) && ms[ms.length - 1].content.some((b) => b.type === 'tool_use')) ms.pop();
    return ms;
  };

  const diceNoHay = /\bno (tengo|tenemos|encontr[eé]|manejamos|contamos con|hay)\b/i.test(textoCrudo) && !pareceListaDePedido;

  const porLista = Boolean(listaLeida) && busquedas.length > 0;
  if (!propuesta && (porLista || (!diceNoHay && (pareceListaDePedido || anunciaCarrito || (clientePideCarrito && busco) || (cortado && busco)))) && typeof herramientaProponer?.run === 'function') {
    try {
      const forzado = await cliente.beta.messages.create({
        model: MODELO,
        max_tokens: 4000,
        system: runner.params.system,
        tools: runner.params.tools,

        tool_choice: { type: 'any' },
        messages: [
          ...mensajesBase(),
          { role: 'user', content: porLista
            ? `Registra con proponer_pedido el pedido de la LISTA del cliente con las cantidades y unidades de la lista:
${listaLeida}
Incluye cada línea que tenga un producto DISPONIBLE en los resultados de buscar_productos de esta conversación (si te falta alguna, búscala). Si solo falta un detalle menor (color, tamaño), elige la opción disponible más común. Si el producto disponible no es exactamente el de la lista (otro tamaño, formato o presentación, p. ej. oficio en vez de carta), inclúyelo con cambio=«sustituto» y una cambioNota corta («oficio; carta agotada»). Deja fuera lo agotado sin sustituto razonable y ponlo en «preguntas». Solo la herramienta, sin texto.`
            : 'Registra con proponer_pedido EXACTAMENTE las líneas que acabas de escribir en tu última respuesta (los mismos productos y cantidades de ese texto; los ids de variante salen de los resultados de buscar_productos de esta conversación; si te falta alguno, búscalo). No agregues productos de carritos anteriores que no estén en tu última respuesta. Solo la herramienta, sin texto.' },
        ],
      });

      const porNombre = Object.fromEntries(runner.params.tools.map((t) => [t.name, t]));
      const ejecutar = async (msg) => {
        const usos = (msg.content || []).filter((b) => b.type === 'tool_use');
        const resultados = [];
        for (const u of usos) {
          const h = porNombre[u.name];
          let out = '';
          try { out = h && typeof h.run === 'function' ? await h.run(u.input) : 'herramienta no disponible'; } catch (e) { out = 'error: ' + e?.message; }
          resultados.push({ type: 'tool_result', tool_use_id: u.id, content: String(out).slice(0, 8000) });
        }
        return { usos, resultados };
      };
      const primera = await ejecutar(forzado);
      if (!propuesta && primera.usos.length) {
        const segunda = await cliente.beta.messages.create({
          model: MODELO,
          max_tokens: 4000,
          system: runner.params.system,
          tools: runner.params.tools,
          tool_choice: { type: 'tool', name: 'proponer_pedido' },
          messages: [
            ...mensajesBase(),
            { role: 'user', content: 'Registra con proponer_pedido exactamente las líneas de tu última respuesta.' },
            { role: 'assistant', content: forzado.content },
            { role: 'user', content: primera.resultados },
          ],
        });
        await ejecutar(segunda);
      }

      if (propuesta && !cortado) {
        const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
        const ref = norm(textoCrudo + ' ' + consulta + ' ' + (listaLeida || ''));
        const coincide = (propuesta.lineas || []).some((l) => {
          const prod = porVariante(String(l.variante));
          const palabras = norm(prod?.t || '').split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !/^(para|con|sin|und|unds|caja|cajas|paquete)$/.test(w));
          return palabras.some((w) => ref.includes(w));
        });
        if (!coincide) {
          console.warn('[asesor] propuesta forzada descartada: no corresponde al texto del modelo');
          propuesta = null;
        }
      }
      console.log('[asesor] proponer_pedido forzado:', propuesta ? `${propuesta.lineas?.length} líneas` : 'sin resultado');

      if (porLista && propuesta?.lineas?.length) {
        try {
          const resumenCarrito = propuesta.lineas.map((l) => `- ${l.cantidad} × ${porVariante(String(l.variante))?.t || l.variante}${l.cambio ? ` (${l.cambio}${l.cambioNota ? ': ' + l.cambioNota : ''})` : ''}`).join('\n');
          const reescrito = await cliente.messages.create({
            model: MODELO,
            max_tokens: 700,
            system: runner.params.system,
            messages: [
              ...mensajesBase(),
              { role: 'user', content: `(Sistema, no es del cliente) Ya quedó armado el carrito con estas líneas, que el cliente verá debajo de tu mensaje:\n${resumenCarrito}\n\nEscribe TU mensaje al cliente para acompañarlo, breve: (1) una frase diciendo que le armaste el pedido/cotización con lo de su lista; (2) si hace falta, como máximo 3 preguntas sobre lo realmente ambiguo — nunca preguntes cantidades, colores o tamaños que ya dijo, y no preguntes por lo que ya está en el carrito salvo que sea un sustituto dudoso; (3) al final, en una línea, lo que no está disponible y su alternativa o bajo pedido. No repitas la lista del carrito ni escribas precios. Solo el texto.` },
            ],
          });
          const t = (reescrito.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
          if (t) final = { ...final, content: [{ type: 'text', text: t }] };
        } catch (e) {
          console.warn('[asesor] no se pudo reescribir el texto de la lista:', e?.message);
        }
      }
    } catch (e) {
      console.warn('[asesor] no se pudo forzar proponer_pedido:', e?.message);
    }
  }

  if (cortado) {
    const textoParcial = (final.content || []).filter((b) => b.type === 'text').map((b) => String(b.text || '').replace(/[^\n]*:\s*$/, '').trim()).filter(Boolean).join('\n').trim();
    if (propuesta && textoParcial) {
      final = { ...final, content: [{ type: 'text', text: textoParcial }] };
    } else {
      try {
        const remate = await cliente.beta.messages.create({
          model: MODELO,
          max_tokens: 1500,
          system: runner.params.system,
          messages: [
            ...mensajesBase(),
            { role: 'user', content: '(Sistema: tu turno se cortó antes de terminar. Responde ahora al cliente en texto, breve y completo, con lo que ya encontraste; si te faltó buscar algo, dilo y pregúntale lo mínimo para seguir. No menciones este aviso.)' },
          ],
        });
        final = { ...final, content: (remate.content || []).filter((b) => b.type === 'text') };
      } catch (e) {
        console.warn('[asesor] no se pudo rematar el turno cortado:', e?.message);
      }
    }
  }

  let texto = (final.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim()

    .replace(/<\/?(?:invoke|parameter|function_calls|antml:[\w-]+)[^>]*>/gi, '')
    .replace(/^[^\n]*"\s*\}\s*\]?\s*\}?\s*$/m, '')

    .replace(/https?:\/\/[^\s)]*?\/(?:cart\/[^\s)]*|cart\?[^\s)]*|apps\/asesor\/c\/[^\s)]*)/gi, '')

    .replace(/^[ \t]*(?:aquí va el |así va tu |tu )?(?:enlace|link) del carrito[ \t]*[:👇]*[ \t]*$\n?/gim, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (propuesta?.lineas?.length) texto = sinPromesaDeArmar(texto);

  if (!opcionesPedidas) {
    const lineas = texto.split('\n');

    const esCorchetes = (l) => (l.match(/\[[^\[\]\n]{1,24}\]/g) || []).length >= 2 && l.replace(/\[[^\[\]\n]{1,24}\]/g, '').trim().replace(/[\s·,/|]+/g, '') === '';
    const esBotones = (l) => /^\s*\[?\s*(?:botones|opciones)\s*:\s*[^\]\n]+\]?\s*$/i.test(l);
    const idx = lineas.findIndex((l) => esCorchetes(l) || esBotones(l));
    if (idx >= 0) {
      const opciones = (esBotones(lineas[idx])
        ? lineas[idx].replace(/^\s*\[?\s*(?:botones|opciones)\s*:\s*/i, '').replace(/\]\s*$/, '').split(/\s*\/\s*|\s*\|\s*/)
        : lineas[idx].match(/\[([^\[\]\n]{1,24})\]/g).map((o) => o.slice(1, -1))
      ).map((o) => o.trim().slice(0, 24)).filter(Boolean).slice(0, 10);
      const antes = lineas.slice(0, idx);
      let pregunta = '';
      for (let i = antes.length - 1; i >= 0; i--) {
        if (antes[i].trim()) { pregunta = antes[i].trim(); antes.splice(i, 1); break; }
      }
      const resto = [...antes, ...lineas.slice(idx + 1)].join('\n').replace(/\n{3,}/g, '\n\n').trim();
      if (opciones.length >= 2) {
        opcionesPedidas = { pregunta: pregunta || '¿Qué prefieres?', opciones };
        texto = resto;
        console.log('[asesor] opciones entre corchetes convertidas en botones:', opciones.join(' / '));
      }
    }
  }

  if (!opcionesPedidas && texto) {
    let libreta = direccionesVistas;
    if (libreta === null && telefono && /direcci[oó]n|te lo (enviamos|mandamos|llevamos)/i.test(texto)) {
      libreta = await direccionesDe(telefono).catch(() => []);
    }
    const b = botonesParaPregunta(texto, { direcciones: libreta || [] });
    if (b) {
      opcionesPedidas = { pregunta: b.pregunta, opciones: b.opciones };
      texto = texto.replace(/\n?[^\n]*$/, '').replace(/\n{3,}/g, '\n\n').trim();
      console.log('[asesor] pregunta cerrada en texto → botones estándar:', b.clave, b.opciones.join(' / '));
    }
  }

  if (vuelveCon && !propuesta) {
    const p = PREGUNTAS_CERRADAS.find((x) => x.clave === ({ carrito: 'vuelve_carrito', carrito_web: 'vuelve_carrito_web', compra: 'vuelve_repetir' })[vuelveCon]);

    if (!(texto || '').trim()) {
      const nom = String((Object.entries(memoria || {}).find(([k]) => /nombre/i.test(k)) || [])[1] || '').trim().split(/\s+/)[0];
      texto = `¡Hola${nom ? ', ' + nom : ''}! 👋 Soy Camila.`;
    }
    if (vuelveCon === 'carrito_web' && !/carrito/i.test(texto || '')) {
      texto = `${texto || ''}\n\nTienes ${carritoWeb.lineas.length} producto${carritoWeb.lineas.length === 1 ? '' : 's'} en el carrito por ${pesosCtx(carritoWeb.total)}.`.trim();
    }
    if (vuelveCon === 'carrito' && !/pedido|carrito/i.test(texto || '')) {
      const n = carritoPendiente.lineas?.length;
      texto = `${texto || ''}\n\nTienes un pedido pendiente de pago${n ? ` con ${n} producto${n === 1 ? '' : 's'}` : ''}${carritoPendiente.total ? ` por ${pesosCtx(carritoPendiente.total)}` : ''}.`.trim();
    }
    if (!opcionesPedidas) {
      texto = (texto || '').replace(/\n?[^\n]*\?\s*$/, '').trim();
      opcionesPedidas = { pregunta: p.ejemplo.replace(/[«»]/g, ''), opciones: p.opciones({}) };
      console.log('[asesor] cliente que vuelve → botones:', p.clave);
    } else if (!/carrito|pedido/i.test(opcionesPedidas.pregunta || '')) {

      opcionesPedidas.pregunta = p.ejemplo.replace(/[«»]/g, '');
    }
  }

  const stockVivo = propuesta ? await disponibilidadReal(propuesta.lineas) : null;
  const propuestaValidada = propuesta ? marcarSustitutosDeLista(validar(propuesta, stockVivo), listaLeida) : null;

  if (propuestaValidada?.enlaceCarrito && telefono) {
    propuestaValidada.enlaceCarritoCorto = propuestaValidada.enlaceCarrito;
    const nom = memoria ? (Object.entries(memoria).find(([k]) => /nombre/i.test(k)) || [])[1] : '';
    const q = await parametrosCheckoutPorTelefono(telefono, { nombre: nom || '' }).catch(() => '');

    const items = propuestaValidada.enlaceCarrito.replace(/^\/cart\//, '').split('?')[0];
    const largo = `/cart?hz=${items}${q ? '&' + q : ''}`;

    const corto = await acortar(largo, { etiqueta: `carrito ${telefono}` }).catch(() => largo);
    propuestaValidada.enlaceCarrito = corto;
    propuestaValidada.enlaceCarritoCorto = corto;
  }

  let cotizacion = null;
  if (cotizacionPedida && propuestaValidada?.lineas?.length && propuestaValidada.enlaceCarrito) {
    try {
      const f = cotizacionPedida.fiscal || {};
      const base = (process.env.TIENDA_PUBLICA || 'https://horecacenter.co').replace(/\/+$/, '');
      const nom = memoria ? (Object.entries(memoria).find(([k]) => /nombre/i.test(k)) || [])[1] : null;

      const ficha = !telefono && clienteId ? await datosDeCliente(clienteId) : null;
      cotizacion = await crearCotizacionPDF({
        numero: numeroCotizacion(telefono || clienteId),
        cliente: {
          nombre: nom || ficha?.nombre || '',
          tipoPersona: f.tipo_persona,
          tipoDocumento: f.tipo_documento,
          numeroDocumento: f.numero_documento,
          dv: f.dv,
          razonSocial: f.razon_social,
          correo: f.correo_fe || ficha?.correo || '',
          telefono: telefono ? '+' + String(telefono).replace(/\D/g, '') : ficha?.telefono || '',
        },
        lineas: propuestaValidada.lineas,
        total: propuestaValidada.total,
        enlaceCarrito: base + (propuestaValidada.enlaceCarritoCorto || propuestaValidada.enlaceCarrito),
      });

      Object.assign(cotizacion, { lineas: propuestaValidada.lineas, total: propuestaValidada.total, enlaceCarrito: base + propuestaValidada.enlaceCarrito });
    } catch (e) {
      console.error('[cotizacion] no se pudo generar el PDF:', e?.message);
    }
  }

  if (!(texto || '').trim() && !propuestaValidada?.lineas?.length && !opcionesPedidas && !imagenesPedidas.length && !cotizacion && !peticionDeHumano) {
    try {
      const remate = await cliente.beta.messages.create({
        model: MODELO,
        max_tokens: 600,
        system: runner.params.system,
        messages: [
          ...mensajesBase(),
          { role: 'user', content: debeResolver
            ? '(Sistema: el cliente se despidió o agradeció y ya marcaste la conversación como cerrada; falta tu despedida. Responde en UNA o dos frases cálidas y breves, por su nombre si lo sabes. No menciones este aviso.)'
            : '(Sistema: tu turno terminó sin texto para el cliente. Responde ahora en texto, breve y útil, a su último mensaje. No menciones este aviso.)' },
        ],
      });
      texto = (remate.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim() || texto;
      console.log('[asesor] turno sin texto rematado:', debeResolver ? 'despedida' : 'respuesta');
    } catch (e) {
      console.warn('[asesor] no se pudo rematar el turno sin texto:', e?.message);
    }
  }

  return {
    propuesta: propuestaValidada,
    cotizacion,
    opciones: opcionesPedidas,
    texto: texto || null,
    imagenes: imagenesPedidas.length ? imagenesPedidas : null,
    resolver: debeResolver,
    traspaso: peticionDeHumano,
    memoria: Object.keys(nuevaMemoria).length ? nuevaMemoria : null,
    busquedas,
    uso: null,
  };
}

const ATRIBUTOS_EXCLUYENTES = [['carta', 'oficio']];
export function marcarSustitutosDeLista(propuesta, listaLeida) {
  if (!propuesta?.lineas?.length || !listaLeida) return propuesta;
  const norm = (x) => String(x || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const palabras = (x) => new Set(norm(x).split(/[^a-z0-9]+/).filter((w) => w.length >= 4));
  const renglones = String(listaLeida).split('\n').map((r) => ({ texto: norm(r), palabras: palabras(r) }));
  for (const l of propuesta.lineas) {
    if (l.cambio) continue;
    const titulo = norm(l.titulo);
    const pt = palabras(l.titulo);
    let mejor = null, max = 0;
    for (const r of renglones) {
      const comunes = [...r.palabras].filter((w) => pt.has(w) || [...pt].some((t) => t.startsWith(w.slice(0, 5)))).length;
      if (comunes > max) { max = comunes; mejor = r; }
    }
    if (!mejor) continue;
    for (const grupo of ATRIBUTOS_EXCLUYENTES) {
      const pedido = grupo.find((a) => new RegExp(`\\b${a}\\b`).test(mejor.texto));
      const puesto = grupo.find((a) => new RegExp(`\\b${a}\\b`).test(titulo));
      if (pedido && puesto && pedido !== puesto) {
        l.cambio = 'sustituto';
        l.cambioNota = `${puesto}; pediste ${pedido}`.slice(0, 60);
        break;
      }
    }
  }
  return propuesta;
}

function validar(p, stockVivo = null) {
  const lineas = [];
  const descartadas = [];

  for (const l of p.lineas || []) {
    const prod = porVariante(String(l.variante));
    if (!prod) {
      descartadas.push({ variante: String(l.variante), razon: 'no existe en el catalogo' });
      continue;
    }

    const info = stockVivo ? stockVivo.get(prod.v) : null;
    const disponible = info ? info.disponible : prod.d;
    if (!disponible) {
      descartadas.push({ variante: prod.v, titulo: prod.t, razon: 'sin inventario disponible' });
      continue;
    }

    const precio = info && info.precio != null ? info.precio : Math.round(prod.p);
    const cantidad = Math.max(1, Math.min(999, Math.round(Number(l.cantidad) || 1)));
    lineas.push({
      variante: prod.v,
      titulo: prod.t,
      precio,
      familia: prod.f,
      handle: prod.h,
      imagen: prod.i,
      disponible: true,
      cantidad,
      motivo: String(l.motivo || '').slice(0, 300),
      cambio: ['sustituto', 'agregado', 'ajustado'].includes(l.cambio) ? l.cambio : null,
      cambioNota: l.cambioNota ? String(l.cambioNota).slice(0, 60) : null,
      subtotal: precio * cantidad,
    });
  }

  const total = lineas.reduce((s, l) => s + l.subtotal, 0);
  const enlace = lineas.length
    ? `/cart/${lineas.map((l) => `${l.variante}:${l.cantidad}`).join(',')}`
    : null;

  return {
    lineas,
    descartadas,
    total,
    enlaceCarrito: enlace,
    resumen: String(p.resumen || '').slice(0, 600),
    preguntas: (p.preguntas || []).slice(0, 3),
    generadoPorIA: true,
    cantidadesEstimadas: true,
  };
}
