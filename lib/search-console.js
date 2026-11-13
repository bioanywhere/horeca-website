import crypto from 'node:crypto';

const PROPIEDAD = (process.env.GSC_PROPIEDAD || 'sc-domain:horecacenter.co').trim();
let cache = { token: null, hasta: 0 };

function credenciales() {
  const raw = process.env.GSC_CREDENCIALES;
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
export const configurado = () => Boolean(credenciales());

const b64url = (s) => Buffer.from(s).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

export async function token() {
  if (cache.token && Date.now() < cache.hasta) return cache.token;
  const c = credenciales();
  if (!c) throw new Error('GSC_CREDENCIALES no configurado');
  const ahora = Math.floor(Date.now() / 1000);
  const cabecera = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const cuerpo = b64url(JSON.stringify({
    iss: c.client_email, scope: 'https://www.googleapis.com/auth/webmasters',
    aud: 'https://oauth2.googleapis.com/token', iat: ahora, exp: ahora + 3600,
  }));
  const firma = crypto.createSign('RSA-SHA256').update(`${cabecera}.${cuerpo}`).sign(c.private_key);
  const jwt = `${cabecera}.${cuerpo}.${b64url(firma)}`;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('token GSC: ' + JSON.stringify(j).slice(0, 200));
  cache = { token: j.access_token, hasta: Date.now() + (j.expires_in - 60) * 1000 };
  return cache.token;
}

async function api(ruta, cuerpo) {
  const t = await token();
  const r = await fetch(`https://www.googleapis.com/webmasters/v3/${ruta}`, {
    method: cuerpo ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`GSC ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
  return j;
}

export const sitios = () => api('sites');

export async function rendimiento({ desde, hasta, dimensiones = ['query'], filas = 100, filtros = [] } = {}) {
  const fmt = (d) => new Date(d).toISOString().slice(0, 10);
  const fin = hasta ? new Date(hasta) : new Date(Date.now() - 2 * 864e5);
  const inicio = desde ? new Date(desde) : new Date(fin.getTime() - 27 * 864e5);
  const cuerpo = { startDate: fmt(inicio), endDate: fmt(fin), dimensions: dimensiones, rowLimit: filas };
  if (filtros.length) cuerpo.dimensionFilterGroups = [{ filters: filtros }];
  const j = await api(`sites/${encodeURIComponent(PROPIEDAD)}/searchAnalytics/query`, cuerpo);
  return (j.rows || []).map((r) => ({ claves: r.keys, clics: r.clicks, impresiones: r.impressions, ctr: r.ctr, posicion: r.position }));
}

export const sitemaps = () => api(`sites/${encodeURIComponent(PROPIEDAD)}/sitemaps`);

export async function enviarSitemap(url = 'https://horecacenter.co/sitemap.xml') {
  const t = await token();
  const r = await fetch(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(PROPIEDAD)}/sitemaps/${encodeURIComponent(url)}`, {
    method: 'PUT', headers: { Authorization: `Bearer ${t}` },
  });
  return r.status;
}
