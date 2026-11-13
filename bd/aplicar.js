import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { neon } from '@neondatabase/serverless';

const CADENA = process.env.DATABASE_URL || process.env.POSTGRES_URL;
if (!CADENA) {
  console.error('Falta DATABASE_URL.');
  process.exit(1);
}

const aqui = dirname(fileURLToPath(import.meta.url));
const sql = neon(CADENA);

const bruto = readFileSync(join(aqui, 'esquema.sql'), 'utf8');
const corte = bruto.indexOf('create or replace function');
const tablas = bruto.slice(0, corte);
const funcion = bruto.slice(corte);

const sinComentarios = tablas
  .split('\n')
  .map((l) => (l.trim().startsWith('--') ? '' : l))
  .join('\n');

const sentencias = sinComentarios
  .split(';')
  .map((s) => s.trim())
  .filter(Boolean);

let hechas = 0;
for (const s of sentencias) {
  try {
    await sql.query(s);
    hechas++;
    const titulo = s.split('\n').find((l) => l.trim() && !l.trim().startsWith('--')) || s;
    console.log('ok   ' + titulo.trim().slice(0, 70));
  } catch (e) {
    console.error('FALLO ' + s.slice(0, 90) + '\n      ' + e.message);
    process.exit(1);
  }
}

try {
  await sql.query(funcion.trim().replace(/;\s*$/, ''));
  hechas++;
  console.log('ok   create or replace function reclamar_trabajo()');
} catch (e) {
  console.error('FALLO al crear reclamar_trabajo(): ' + e.message);
  process.exit(1);
}

const tablasCreadas = await sql.query(
  "select table_name from information_schema.tables where table_schema = 'public' order by 1"
);
console.log(`\n${hechas} sentencias aplicadas.`);
console.log('tablas: ' + tablasCreadas.map((t) => t.table_name).join(', '));
