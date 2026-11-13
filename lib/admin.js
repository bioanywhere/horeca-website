const TIENDA = (process.env.TIENDA_MYSHOPIFY || '').trim();
const CLIENTE = (process.env.SHOPIFY_CLIENT_ID || '').trim();
const SECRETO = (process.env.SHOPIFY_CLIENT_SECRET || '').trim();
const VERSION = '2024-10';

let cache = { token: null, expira: 0 };

async function token() {

  if (cache.token && Date.now() < cache.expira - 60_000) return cache.token;

  const r = await fetch(`https://${TIENDA}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: CLIENTE,
      client_secret: SECRETO,
      grant_type: 'client_credentials',
    }),
  });
  if (!r.ok) {

    const detalle = (await r.text()).slice(0, 200);
    throw new Error(
      `no pude obtener token admin: HTTP ${r.status} ${detalle} ` +
        `(client_id de ${CLIENTE.length} caracteres, secreto de ${SECRETO.length}, tienda "${TIENDA}")`
    );
  }

  const j = await r.json();
  cache = { token: j.access_token, expira: Date.now() + (j.expires_in ?? 86_000) * 1000 };
  return cache.token;
}

export function configurado() {
  return Boolean(TIENDA && CLIENTE && SECRETO);
}

export async function admin(query, variables) {
  const r = await fetch(`https://${TIENDA}/admin/api/${VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': await token(),
    },
    body: JSON.stringify({ query, variables }),
  });

  const j = await r.json();
  if (j.errors?.length) throw new Error(j.errors.map((e) => e.message).join(' | '));
  return j.data;
}

export async function rest(path, { method = 'GET', body = null, intento = 0 } = {}) {
  const r = await fetch(`https://${TIENDA}/admin/api/${VERSION}/${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': await token() },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  if (r.status === 429 && intento < 6) {
    const espera = Number(r.headers.get('retry-after') || 2) * 1000;
    await new Promise((s) => setTimeout(s, espera));
    return rest(path, { method, body, intento: intento + 1 });
  }
  const txt = await r.text();
  let j = null;
  try { j = txt ? JSON.parse(txt) : null; } catch {  }
  if (!r.ok) throw new Error(`REST ${method} ${path} -> HTTP ${r.status} ${txt.slice(0, 200)}`);
  return j;
}
