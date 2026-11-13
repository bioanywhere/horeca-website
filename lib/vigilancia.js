import { consultar, hayBaseDeDatos } from './bd.js';
import { saludWorker } from './worker-cliente.js';

const WEBHOOK = process.env.ALERTA_WEBHOOK || null;

const LATIDO_MAX_MIN = Number(process.env.VIGILANCIA_LATIDO_MIN || 3);

const ATASCO_MIN = Number(process.env.VIGILANCIA_ATASCO_MIN || 5);

const SILENCIO_MIN = Number(process.env.VIGILANCIA_SILENCIO_MIN || 30);

let tablaLista = false;
async function asegurarTabla() {
  if (tablaLista) return;
  await consultar(`create table if not exists latidos (
      componente text primary key,
      visto      timestamptz not null default now()
    )`);
  tablaLista = true;
}


export async function latir(componente = 'worker') {
  if (!hayBaseDeDatos) return;
  try {
    await asegurarTabla();
    await consultar(
      `insert into latidos (componente, visto) values ($1, now())
       on conflict (componente) do update set visto = now()`,
      [componente]
    );
  } catch {

  }
}


export async function revisar() {
  const detalle = { pausado: process.env.ASESOR_PAUSADO === '1' };
  const motivos = [];
  if (!hayBaseDeDatos) return { ok: true, motivos, detalle, sinBase: true };

  await asegurarTabla();


  const [lat] = await consultar(
    `select extract(epoch from (now() - visto))::int as seg from latidos where componente = 'worker'`
  );
  const latidoSeg = lat ? Number(lat.seg) : null;
  detalle.latido_worker_seg = latidoSeg;
  if (latidoSeg == null) {
    motivos.push('el worker nunca ha dejado latido (¿desplegado?)');
  } else if (latidoSeg > LATIDO_MAX_MIN * 60) {
    motivos.push(`el worker lleva ${Math.round(latidoSeg / 60)} min sin latido (posible caída)`);
  }


  const [c] = await consultar(`
    select
      count(*) filter (where estado in ('pendiente','en_curso'))::int as en_espera,
      count(*) filter (where estado = 'fallido'
                        and creado > now() - interval '24 hours')::int as fallidos_24h,
      coalesce(extract(epoch from (now() - min(creado) filter (
                 where estado in ('pendiente','en_curso'))))::int, 0)  as espera_seg
    from trabajos
    where estado in ('pendiente','en_curso') or creado > now() - interval '24 hours'
  `);
  const espera = Number(c?.espera_seg || 0);
  detalle.en_espera = Number(c?.en_espera || 0);
  detalle.fallidos_24h = Number(c?.fallidos_24h || 0);
  detalle.espera_mas_antigua_seg = espera;
  if (detalle.en_espera > 0 && espera > ATASCO_MIN * 60) {
    motivos.push(`cola atascada: trabajo sin atender hace ${Math.round(espera / 60)} min`);
  }
  if (detalle.fallidos_24h >= 5) {
    motivos.push(`${detalle.fallidos_24h} turnos fallidos en 24 h`);
  }


  return { ok: motivos.length === 0, motivos, detalle };
}


async function puedeAvisar() {
  const [f] = await consultar(
    `select extract(epoch from (now() - visto))::int as seg from latidos where componente = 'ultimo_aviso'`
  );
  return !f || Number(f.seg) > SILENCIO_MIN * 60;
}


export async function revisarSinBase() {
  const detalle = { pausado: process.env.ASESOR_PAUSADO === '1' };
  const motivos = [];
  const s = await saludWorker();
  detalle.worker = s;
  if (!s.ok) {
    motivos.push(`el worker no responde (${s.error}); posible caída en Fly`);
  } else {
    const vuelta = s.ultimaVuelta ? (Date.now() - new Date(s.ultimaVuelta).getTime()) / 60000 : null;

    if (vuelta == null || vuelta > 25) motivos.push(`el bucle del worker lleva ${vuelta == null ? '?' : Math.round(vuelta)} min sin dar vuelta (¿colgado?)`);
    if (Number(s.erroresBdSeguidos) >= 3) motivos.push(`la base de datos falla (${s.erroresBdSeguidos} intentos seguidos): ${s.ultimoErrorBd?.mensaje || ''}`.slice(0, 300));
  }
  return { ok: motivos.length === 0, motivos, detalle };
}


export async function vigilar() {
  const estado = await revisarSinBase();
  if (estado.ok) return { ...estado, aviso: false };

  let aviso = false;
  if (new Date().getUTCMinutes() >= 10) return { ...estado, aviso, silenciado: true };

  const texto = `⚠️ Asesor de WhatsApp con problemas:\n· ${estado.motivos.join('\n· ')}`;
  console.error('[vigilancia] ' + texto.replace(/\n/g, ' '));

  if (WEBHOOK) {
    try {
      await fetch(WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: texto, content: texto, motivos: estado.motivos, detalle: estado.detalle }),
      });
      aviso = true;
    } catch (e) {
      console.error('[vigilancia] no se pudo avisar:', e?.message);
    }
  }
  return { ...estado, aviso };
}
