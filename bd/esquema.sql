-- Esquema del asesor en WhatsApp.
--
-- Base propia de Horeca. NO comparte nada con Synergy: otro cliente, otros
-- datos, otra factura. Lo unico que se reutiliza de alli es la forma de la
-- cola, que ya esta probada en produccion.
--
-- Se aplica una sola vez:  node bd/aplicar.js

-- ── Conversaciones ────────────────────────────────────────────────────────
-- La clave es el numero tal y como lo manda Meta (`wa_id`): digitos, sin '+'
-- ni espacios. No se normaliza a E.164 a proposito: lo que llega del webhook
-- es lo que hay que usar para responder, y cualquier reescritura nuestra
-- seria una fuente de errores silenciosos.
create table if not exists conversaciones (
  telefono     text primary key,
  nombre       text,
  cliente_id   text,
  creada       timestamptz not null default now(),
  actualizada  timestamptz not null default now()
);

-- ── Memoria del cliente ───────────────────────────────────────────────────
-- Lo que el asesor debe seguir sabiendo cuando el mensaje donde se dijo ya se
-- salio de la ventana de contexto.
--
-- Paso de verdad: un cliente escribio "me llamo Andres, saludame por el
-- nombre", el asesor lo anoto, y ocho turnos despues respondio "no tengo su
-- nombre confirmado en esta conversacion". Contradecirse delante del cliente
-- es peor que no haberlo sabido nunca.
--
-- El historial es una ventana movil y tiene que serlo —cada turno son tokens
-- en cada llamada—, asi que lo que debe durar no puede vivir ahi. Vive aqui.
alter table conversaciones add column if not exists memoria jsonb not null default '{}'::jsonb;

-- ── Mensajes ──────────────────────────────────────────────────────────────
-- El registro permanente de lo que se dijo. En la web una sugerencia es una
-- sugerencia; por WhatsApp un precio se lee como una cotizacion y el cliente
-- guarda el chat. Poder responder "esto fue lo que se le contesto, y cuando"
-- es la razon de que esto sea Postgres y no una cache con caducidad.
create table if not exists mensajes (
  id        bigserial primary key,
  telefono  text not null references conversaciones(telefono) on delete cascade,
  rol       text not null check (rol in ('cliente', 'asesor')),
  texto     text not null,
  wa_id     text,
  creado    timestamptz not null default now()
);

create index if not exists mensajes_hilo_idx on mensajes (telefono, creado);

-- Un mensaje de WhatsApp se guarda una sola vez. Sin esto, un trabajo que
-- falla al enviar y se reintenta a los cinco minutos volveria a insertar el
-- mensaje del cliente, y el modelo lo veria repetido en el historial.
create unique index if not exists mensajes_wa_idx on mensajes (wa_id) where wa_id is not null;

-- ── Cola de trabajos ──────────────────────────────────────────────────────
-- Meta reenvia los webhooks que no se acusan rapido. `wa_id` es unico: el
-- reintento choca contra la restriccion y no crea trabajo, asi que el cliente
-- no recibe la misma respuesta dos veces. Desde el 1 de octubre de 2026 esa
-- respuesta duplicada ademas se cobraria dos veces.
create table if not exists trabajos (
  id         bigserial primary key,
  wa_id      text not null unique,
  telefono   text not null,
  nombre     text,
  texto      text not null,
  estado     text not null default 'pendiente'
             check (estado in ('pendiente', 'en_curso', 'hecho', 'fallido')),
  intentos   int not null default 0,
  error      text,
  creado     timestamptz not null default now(),
  reclamado  timestamptz,
  terminado  timestamptz
);

create index if not exists trabajos_cola_idx on trabajos (estado, creado);

-- Fotos que el cliente adjunta al mensaje (búsqueda por imagen). Solo la
-- referencia [{tipo:'image', url, id}]: el worker la baja a memoria para el
-- turno y no la persiste. `texto` puede quedar vacío si el mensaje era solo
-- la foto.
alter table trabajos add column if not exists adjuntos jsonb;

-- ── Reintentos de entrega de mensajes ──────────────────────────────────────
-- Cuando Meta marca un mensaje saliente como `failed` (Chatwoot lo reporta con
-- `message_updated`), se reenvía UNA vez con el texto saneado. Aquí queda el
-- rastro: el id original, el id del reenvío y el error. Si el reenvío también
-- falla, se avisa por la alerta y no se insiste (evita bucles).
create table if not exists reintentos_entrega (
  mensaje_id      text primary key,
  reenviado_id    text,
  conversacion_id text,
  error           text,
  creado          timestamptz not null default now()
);

-- ── Entregas a domicilio ───────────────────────────────────────────────────
-- Una fila por pedido que va a domicilio. El estado avanza:
--   pendiente_pago → confirmada → asignada → notificada → aceptada → recogida
--   → en_camino → entregada (o cancelada). El domiciliario avanza estados
--   respondiendo por WhatsApp; el panel /entregas también. `historial` guarda
--   cada transición [{estado, en, nota}]. lat/lng vienen de Shopify (geocodifica
--   la dirección); si faltan, el aviso sale sin mapa (plantilla de texto).
create table if not exists entregas (
  id                  bigserial primary key,
  pedido_id           text not null unique,
  pedido_nombre       text,
  cliente             text,
  telefono            text,
  direccion           text,
  ciudad              text,
  lat                 double precision,
  lng                 double precision,
  notas               text,
  resumen             text,
  total               numeric,
  cobrar              numeric not null default 0,
  pagada              boolean not null default false,
  status_url          text,
  estado              text not null default 'confirmada'
                      check (estado in ('pendiente_pago','confirmada','asignada','notificada','aceptada','recogida','en_camino','entregada','cancelada')),
  domiciliario        text,
  domiciliario_nombre text,
  mensaje_id          text,
  copia_id            text,
  plantilla           text,
  error               text,
  historial           jsonb not null default '[]'::jsonb,
  creado              timestamptz not null default now(),
  actualizado         timestamptz not null default now()
);
create index if not exists entregas_estado_idx on entregas (estado, creado);

-- Encuesta post-entrega: 2 h después de `entregada` se manda la plantilla
-- `entrega_encuesta` (👍 / 👎). La respuesta llega como texto del botón y la
-- atiende lib/entregas.js sin pasar por Camila; un 👎 pasa a un humano.
alter table entregas add column if not exists encuesta_en         timestamptz;
alter table entregas add column if not exists encuesta_enviada    timestamptz;
alter table entregas add column if not exists encuesta_id         text;
alter table entregas add column if not exists encuesta_respuesta  text;
alter table entregas add column if not exists encuesta_respondida timestamptz;
alter table entregas add column if not exists encuesta_error      text;

-- ── Cotizaciones ──────────────────────────────────────────────────────────
-- Cada PDF que Camila entrega (WhatsApp o web) queda aquí con sus líneas y el
-- enlace del carrito. Si en `seguimiento_en` sigue `abierta`, se manda la
-- plantilla `cotizacion_seguimiento` (fuera de la ventana de 24 h hace falta
-- plantilla). Un pedido del mismo cliente la pasa a `comprada`.
create table if not exists cotizaciones (
  numero                text primary key,
  telefono              text,
  cliente_id            text,
  nombre                text,
  canal                 text not null default 'whatsapp',
  cuenta_id             text,
  conversacion_id       text,
  lineas                jsonb not null default '[]'::jsonb,
  total                 numeric,
  enlace_carrito        text,
  estado                text not null default 'abierta' check (estado in ('abierta','comprada','cerrada')),
  pedido_id             text,
  pedido_nombre         text,
  seguimiento_en        timestamptz,
  seguimiento_enviado   timestamptz,
  seguimiento_id        text,
  seguimiento_error     text,
  seguimiento_respuesta text,
  creada                timestamptz not null default now(),
  actualizada           timestamptz not null default now()
);
create index if not exists cotizaciones_seg_idx on cotizaciones (estado, seguimiento_en);

-- ── Por donde se responde ─────────────────────────────────────────────────
-- El mismo asesor atiende dos caminos y el trabajo lleva cual le toca, en vez
-- de que el worker lo adivine:
--
--   meta      el webhook de Meta llega directo aqui; se responde por Cloud API
--             al numero de `telefono`.
--   chatwoot  Chatwoot es el dueno del canal; se responde dentro de la
--             conversacion, y el traspaso a un humano es de verdad — la
--             conversacion pasa a 'open' y la toma un vendedor.
--
-- Conviven a proposito: se puede tener Chatwoot montado y seguir con el camino
-- directo hasta que se reapunte el webhook en Meta, sin un corte.
--
-- `wa_id` sigue siendo la llave de idempotencia; para Chatwoot guarda
-- 'chatwoot:<id del mensaje>'.
alter table trabajos add column if not exists origen text not null default 'meta';
alter table trabajos add column if not exists cuenta_id text;
alter table trabajos add column if not exists conversacion_id text;

-- ── Cupos ─────────────────────────────────────────────────────────────────
-- Tope por numero y por ventana. Ya no es higiene: cada respuesta del bot es
-- un mensaje facturable, asi que esto es control de gasto.
create table if not exists cupos (
  clave    text not null,
  ventana  timestamptz not null,
  usos     int not null default 0,
  primary key (clave, ventana)
);

-- ── Reclamo de trabajo ────────────────────────────────────────────────────
-- Un trabajo a la vez por worker. `skip locked` deja que varios workers
-- convivan sin pisarse, aunque hoy solo haya uno.
--
-- La segunda condicion rescata los trabajos de un worker que murio a mitad:
-- sin ella, un despliegue en el momento justo dejaria al cliente sin
-- respuesta y el trabajo colgado en 'en_curso' para siempre.
create or replace function reclamar_trabajo()
returns trabajos
language sql
as $$
  update trabajos
     set estado = 'en_curso',
         reclamado = now(),
         intentos = intentos + 1
   where id = (
     select id from trabajos
      where estado = 'pendiente'
         or (estado = 'en_curso' and reclamado < now() - interval '5 minutes')
      order by creado
      limit 1
      for update skip locked
   )
  returning *;
$$;

-- ── Comparador de precios ─────────────────────────────────────────────────
-- Una fila por observación de precio de un vendedor externo para uno de
-- nuestros productos. `activo` marca la última pasada; las anteriores quedan
-- como histórico. La clase y la confianza las pone el juez (reglas + Claude):
-- 1 igual · 2 misma referencia otra presentación · 3 equivalente · 4 similar.
create table if not exists comparaciones (
  id                 bigserial primary key,
  producto_handle    text not null,
  variante_id        text,
  fuente             text not null,
  vendedor           text,
  titulo_vendedor    text,
  precio             numeric not null,
  url                text,
  imagen             text,
  cantidad           numeric,
  unidad             text,
  empaque            int default 1,
  precio_normalizado numeric,
  base               text,
  clase              int not null default 4,
  confianza          int not null default 0,
  motivo             text,
  verificado_en      timestamptz not null default now(),
  activo             boolean not null default true
);
create index if not exists comparaciones_prod_idx on comparaciones (producto_handle, activo, verificado_en desc);

-- Cabecera por producto: cuándo se verificó, cuántas veces se consultó
-- (prioridad del refresco nocturno) y el último error de fuentes.
create table if not exists comparaciones_productos (
  producto_handle text primary key,
  variante_id     text,
  titulo          text,
  precio          numeric,
  consultas       int not null default 0,
  verificado_en   timestamptz,
  error           text
);
-- Presentación de VENTA de nuestro producto según el juez (cantidad/unidad/empaque):
-- los títulos del ERP son ambiguos (DX100 puede ser caja mayorista o la caja que se vende).
alter table comparaciones_productos add column if not exists presentacion jsonb;

-- ── Enlaces cortos ────────────────────────────────────────────────────────
-- horecacenter.co/apps/asesor/c/<codigo> → destino. Para que el enlace del
-- carrito con formulario (largo) quepa en un QR y en el botón de una plantilla.
create table if not exists enlaces_cortos (
  codigo        text primary key,
  destino       text not null,
  etiqueta      text,
  visitas       int not null default 0,
  creado        timestamptz not null default now(),
  ultima_visita timestamptz
);


-- Integración MAYASIS (2026-09-24): inventario por bodega y pedidos
create table if not exists inventario_items (sku text primary key, inventory_item_id text not null, variant_id text, titulo text, actualizado timestamptz not null default now());
create table if not exists inventario_mayasis (sku text not null, bodega text not null, cantidad integer not null, actualizado timestamptz not null default now(), primary key (sku, bodega));
create table if not exists cerrojos (nombre text primary key, hasta timestamptz not null, dueno text);
create table if not exists pedidos_mayasis (orden_id text primary key, nombre text, bodega text, estado text not null, mayasis_id text, cuerpo jsonb, respuesta jsonb, error text, creado timestamptz not null default now(), actualizado timestamptz not null default now());
