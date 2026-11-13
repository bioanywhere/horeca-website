import { consultar, unaFila, hayBaseDeDatos } from './bd.js';

const ALFABETO = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
const RUTA = '/apps/asesor/c/';

function codigoAleatorio(n = 7) {
  let s = '';
  for (let i = 0; i < n; i++) s += ALFABETO[Math.floor(Math.random() * ALFABETO.length)];
  return s;
}

export async function acortar(destino, { etiqueta = null } = {}) {
  const d = String(destino || '').trim();
  if (!d || !hayBaseDeDatos) return d;
  try {
    for (let intento = 0; intento < 3; intento++) {
      const codigo = codigoAleatorio();
      const r = await consultar(
        `insert into enlaces_cortos (codigo, destino, etiqueta) values ($1, $2, $3) on conflict (codigo) do nothing returning codigo`,
        [codigo, d.slice(0, 4000), etiqueta]
      );
      if (r.length) return RUTA + codigo;
    }
  } catch (e) {
    console.error('[enlaces] no se pudo acortar:', e?.message);
  }
  return d;
}

export async function resolver(codigo) {
  if (!hayBaseDeDatos) return null;
  const c = String(codigo || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 12);
  if (!c) return null;
  const f = await unaFila(`update enlaces_cortos set visitas = visitas + 1, ultima_visita = now() where codigo = $1 returning destino`, [c]);
  return f?.destino || null;
}
