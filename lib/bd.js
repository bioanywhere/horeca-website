import { neon } from '@neondatabase/serverless';

const CADENA = process.env.DATABASE_URL || process.env.POSTGRES_URL || null;

export const hayBaseDeDatos = Boolean(CADENA);

let _sql = null;

function conexion() {
  if (!CADENA) {
    throw new Error('Falta DATABASE_URL: la base de WhatsApp no esta configurada.');
  }
  if (!_sql) _sql = neon(CADENA);
  return _sql;
}

export async function consultar(texto, params = []) {
  return conexion().query(texto, params);
}

export async function unaFila(texto, params = []) {
  const filas = await consultar(texto, params);
  return filas[0] || null;
}
