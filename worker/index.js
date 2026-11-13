import { unaFila, hayBaseDeDatos } from '../lib/bd.js';
import { reclamarAgrupado } from '../lib/agrupar.js';
import { atender, cerrar } from '../lib/wa-turno.js';
import { hayChatwoot } from '../lib/chatwoot.js';
import { purgarCupos } from '../lib/conversacion.js';
import { rescatar, contarFallo, todoBien, avisar } from '../lib/alerta.js';
import { pasarRecuperacion } from '../lib/recuperacion.js';
import http from 'node:http';
import { refrescarDesdePersistencia } from '../lib/catalogo.js';
import { reconstruirCatalogo } from '../lib/indexador.js';
import { pasarSeguimientos } from '../lib/cotizaciones.js';
import { pasarEncuestas } from '../lib/entregas.js';
import { pasarComparaciones } from '../lib/precios.js';
import { sincronizarInventario } from '../lib/inventario-mayasis.js';
import { agotadosAlFinal } from '../lib/orden-colecciones.js';
import { sincronizarOfertas } from '../lib/ofertas-shopify.js';
import { sincronizarPausaMetafield } from '../lib/pausa-metafield.js';


const PRECIOS_HORA_COL = Number(process.env.PRECIOS_HORA_REFRESCO || 5);
let ultimoRefrescoPrecios = 0;




const RECUP_MS = Number(process.env.WA_RECUP_INTERVALO_MS || 30 * 60 * 1000);
const HORA_INICIO_COL = Number(process.env.WA_HORA_INICIO || 7);
const HORA_FIN_COL = Number(process.env.WA_HORA_FIN || 20);
let ultimaRecup = 0;
const horaColombia = () => (new Date().getUTCHours() + 19) % 24;
const deDia = () => { const h = horaColombia(); return h >= HORA_INICIO_COL && h < HORA_FIN_COL; };


const CATALOGO_MS = Number(process.env.CATALOGO_REFRESCO_MS || 24 * 3600 * 1000);

const INV_MS = Number(process.env.MAYASIS_INV_MS || 5 * 60 * 1000);
const INV_NOCHE_MS = Number(process.env.MAYASIS_INV_NOCHE_MS || 60 * 60 * 1000);
let ultimoInventario = 0;

const OFERTAS_MS = Number(process.env.OFERTAS_INTERVALO_MS || 30 * 60 * 1000);
let ultimaOfertas = 0;

const ORDEN_MS = Number(process.env.ORDEN_COLECCIONES_MS || 60 * 60 * 1000);
let ultimoOrden = Date.now() - ORDEN_MS + 10 * 60 * 1000;
let ordenando = false;
let ultimoCatalogo = 0;

const PAUSA_MS = Number(process.env.PAUSA_SYNC_MS || 5 * 60 * 1000);
let ultimaPausa = 0;

async function refrescarCatalogo() {
  try {
    const r = await reconstruirCatalogo();
    console.log('[wa-worker] catálogo reconstruido', r);
  } catch (e) {
    console.error('[wa-worker] no se pudo reconstruir el catálogo:', e?.message);
  }
}

const SONDEO_MS = Number(process.env.WA_SONDEO_MS || 1500);

const ACTIVO_MS = Number(process.env.WA_ACTIVO_MS || 3 * 60 * 1000);

const REPOSO_MS = Number(process.env.WA_REPOSO_MS || 15 * 60 * 1000);
const MAX_INTENTOS = 3;

let parando = false;
let enVuelo = null;
let ultimaActividad = Date.now();
let despertador = null;


const salud = {
  arranque: new Date().toISOString(),
  ultimaVuelta: null,
  ultimoOkBd: null,
  erroresBdSeguidos: 0,
  ultimoErrorBd: null,
  atendidos: 0,
};
let ultimoAvisoBd = 0;

function dormir(ms) {
  return new Promise((resolver) => {
    const t = setTimeout(() => { despertador = null; resolver(); }, ms);
    despertador = () => { clearTimeout(t); despertador = null; resolver(); };
  });
}


function despertar() {
  ultimaActividad = Date.now();
  if (despertador) despertador();
}


function registrarErrorBd(mensaje) {
  salud.erroresBdSeguidos += 1;
  salud.ultimoErrorBd = { cuando: new Date().toISOString(), mensaje: String(mensaje).slice(0, 300) };
  const grave = /quota|402|exceeded|suspend/i.test(String(mensaje));
  if ((grave || salud.erroresBdSeguidos >= 3) && Date.now() - ultimoAvisoBd > 30 * 60 * 1000) {
    ultimoAvisoBd = Date.now();
    avisar(`Asesor de WhatsApp SIN BASE DE DATOS: no puede leer la cola, Camila no responde. ${grave ? 'Parece cuota/plan de Neon agotado (revisar Billing en console.neon.tech). ' : ''}Error: ${String(mensaje).slice(0, 200)}`).catch(() => {});
  }
}

function servirHttp() {
  const clave = (process.env.WORKER_CLAVE || '').trim();
  const puerto = Number(process.env.PORT || 8080);
  http.createServer((req, res) => {
    const url = new URL(req.url, 'http://worker');
    const autorizado = clave && (req.headers['x-clave'] === clave || url.searchParams.get('clave') === clave);
    const json = (codigo, cuerpo) => { res.writeHead(codigo, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(cuerpo)); };
    if (!autorizado) return json(401, { error: 'no_autorizado' });
    if (url.pathname === '/despertar') { despertar(); return json(200, { ok: true }); }
    if (url.pathname === '/salud') {
      return json(200, { ...salud, ahora: new Date().toISOString(), activo: Date.now() - ultimaActividad < ACTIVO_MS, enVuelo: Boolean(enVuelo) });
    }
    return json(404, { error: 'no_encontrado' });
  }).listen(puerto, '0.0.0.0', () => console.log(`[wa-worker] HTTP en :${puerto} (despertar/salud)${clave ? '' : ' — SIN WORKER_CLAVE: todo responde 401'}`));
}

async function vuelta() {

  const trabajo = await reclamarAgrupado();
  salud.ultimoOkBd = new Date().toISOString();
  salud.erroresBdSeguidos = 0;
  if (!trabajo || trabajo.id === null) return false;
  ultimaActividad = Date.now();
  salud.atendidos += 1;

  try {
    enVuelo = atender(trabajo);
    const r = await enVuelo;
    todoBien();
    console.log('[wa-worker] atendido', {
      id: trabajo.id,
      telefono: trabajo.telefono,
      intentos: trabajo.intentos,
      ...(r.atendido ? { lineas: r.lineas, caracteres: r.respuesta.length } : { omitido: r.motivo }),
    });
  } catch (e) {

    const definitivo = e?.permanente === true || Number(trabajo.intentos) >= MAX_INTENTOS;
    console.error('[wa-worker] fallo', {
      id: trabajo.id,
      intentos: trabajo.intentos,
      definitivo,
      error: e?.message,
    });

    if (definitivo) {
      await cerrar(trabajo.id, 'fallido', e?.message);

      const rescatado = await rescatar(trabajo, e?.message);
      if (rescatado) console.log('[wa-worker] rescatado · conversación pasada a un humano', trabajo.id);
    }

    await contarFallo(e?.message, { permanente: e?.permanente === true });
  } finally {
    enVuelo = null;
  }
  return true;
}

function tareasPeriodicas() {
  if (parando) return;
  const ahora = Date.now();


  if (ahora - ultimoCatalogo > CATALOGO_MS) {
    ultimoCatalogo = ahora;
    refrescarCatalogo();
  }


  if (ahora - ultimoInventario > (deDia() ? INV_MS : INV_NOCHE_MS)) {
    ultimoInventario = ahora;
    sincronizarInventario()
      .then((r) => { if (r.omitido) { if (r.omitido !== 'otra_instancia') console.log('[wa-worker] inventario MAYASIS omitido:', r.omitido); } else if (Object.values(r).some((b) => b.cambios || b.error)) console.log('[wa-worker] inventario MAYASIS', JSON.stringify(r).slice(0, 600)); })
      .catch((e) => console.error('[wa-worker] inventario MAYASIS falló', e?.message));
  }


  if (deDia() && ahora - ultimaOfertas > OFERTAS_MS) {
    ultimaOfertas = ahora;
    sincronizarOfertas()
      .then((r) => { if (r && r.omitido) { if (r.omitido !== 'sin_config') console.log('[wa-worker] ofertas omitidas:', r.omitido); } else if (r) console.log('[wa-worker] ofertas Shopify', JSON.stringify(r).slice(0, 600)); })
      .catch((e) => console.error('[wa-worker] ofertas Shopify falló', e?.message));
  }


  if (!ordenando && ahora - ultimoOrden > (deDia() ? ORDEN_MS : 6 * ORDEN_MS)) {
    ultimoOrden = ahora;
    ordenando = true;
    agotadosAlFinal()
      .then((r) => { if (r.movidos || r.errores.length) console.log('[wa-worker] agotados al final', JSON.stringify(r).slice(0, 600)); })
      .catch((e) => console.error('[wa-worker] agotados al final falló', e?.message))
      .finally(() => { ordenando = false; });
  }


  if (ahora - ultimaPausa > PAUSA_MS) {
    ultimaPausa = ahora;
    sincronizarPausaMetafield()
      .then((r) => { if (r && r.cambiado) console.log('[wa-worker] pausa Camila -> metacampo:', r.pausado); else if (r && r.error) console.error('[wa-worker] pausa metacampo error:', r.error); })
      .catch((e) => console.error('[wa-worker] pausa metacampo falló', e?.message));
  }


  if (deDia() && ahora - ultimaRecup > RECUP_MS) {
    ultimaRecup = ahora;
    pasarRecuperacion()
      .then((r) => { if (r.enviados) console.log('[wa-worker] recuperación', r); })
      .catch((e) => console.error('[wa-worker] recuperación falló', e?.message));
    pasarSeguimientos()
      .then((r) => { if (r.enviados) console.log('[wa-worker] seguimiento cotizaciones', r); })
      .catch((e) => console.error('[wa-worker] seguimiento cotizaciones falló', e?.message));
    pasarEncuestas()
      .then((r) => { if (r.enviadas) console.log('[wa-worker] encuestas', r); })
      .catch((e) => console.error('[wa-worker] encuestas fallaron', e?.message));
  }


  if (horaColombia() === PRECIOS_HORA_COL && ahora - ultimoRefrescoPrecios > 20 * 3600 * 1000) {
    ultimoRefrescoPrecios = ahora;
    pasarComparaciones()
      .then((r) => console.log('[wa-worker] comparador refrescado', r))
      .catch((e) => console.error('[wa-worker] comparador falló', e?.message));
  }
}

async function principal() {
  const falta = [];
  if (!hayBaseDeDatos) falta.push('DATABASE_URL');
  if (!hayChatwoot) falta.push('CHATWOOT_BOT_TOKEN o CHATWOOT_BOT_SECRET');
  if (!process.env.ANTHROPIC_API_KEY) falta.push('ANTHROPIC_API_KEY');
  if (falta.length) {
    console.error('[wa-worker] faltan ' + falta.join(', '));
    process.exit(1);
  }

  console.log(`[wa-worker] listo · sondeo ${SONDEO_MS} ms con actividad, ${Math.round(REPOSO_MS / 60000)} min en reposo`);


  await refrescarDesdePersistencia()
    .then((r) => {
      if (!r) return;
      console.log('[wa-worker] catálogo desde caché', { total: r.total, generado: r.generado });
      const edad = Date.now() - new Date(r.generado).getTime();
      if (edad < CATALOGO_MS) ultimoCatalogo = Date.now() - edad;
    })
    .catch(() => {});

  servirHttp();

  const reloj = setInterval(tareasPeriodicas, 60 * 1000);
  setTimeout(tareasPeriodicas, 20 * 1000);

  let desdeLaPurga = 0;
  while (!parando) {
    let hubo = false;
    salud.ultimaVuelta = new Date().toISOString();
    try {
      hubo = await vuelta();
    } catch (e) {
      console.error('[wa-worker] no se pudo reclamar', e?.message);
      registrarErrorBd(e?.message);
    }


    if (hubo && ++desdeLaPurga > 200) {
      desdeLaPurga = 0;
      await purgarCupos().catch(() => {});
    }


    if (!hubo && !parando) {
      const activo = Date.now() - ultimaActividad < ACTIVO_MS;
      await dormir(activo ? SONDEO_MS : REPOSO_MS);
    }
  }
  clearInterval(reloj);

  console.log('[wa-worker] parando…');
  if (enVuelo) await enVuelo.catch(() => {});
  process.exit(0);
}

for (const senal of ['SIGTERM', 'SIGINT']) {
  process.on(senal, () => {
    if (parando) process.exit(1);
    parando = true;
  });
}

principal().catch((e) => {
  console.error('[wa-worker] muerte inesperada', e);
  process.exit(1);
});
