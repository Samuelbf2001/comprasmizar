-- La cola de notificaciones salientes nunca pudo funcionar: `notificaciones` NO tiene `updated_at`,
-- pero el bucle de 202608240001_core_compras.sql:918 le adjunta el disparador `set_updated_at`, que
-- hace `new.updated_at := now()`. Resultado: CUALQUIER update sobre la tabla aborta con
--
--   ERROR: record "new" has no field "updated_at"
--   CONTEXT: PL/pgSQL assignment "new.updated_at := now()" en set_updated_at()
--
-- y como el despachador empieza por tomar el lease (`update ... set bloqueada_hasta`), no había
-- forma de enviar, reintentar ni marcar una sola notificación. `POST /api/internal/
-- dispatch-notifications` respondía 500 `dispatch_failed` con la fila intacta en `intentos = 0`.
--
-- Por qué nadie lo vio: las pruebas de la cola usan un store en memoria (tests/unit/
-- notification-dispatcher.test.ts), y ningún arnés de esquema hacía un UPDATE sobre `notificaciones`
-- — se comprobaba la forma de la tabla, no que se pudiera escribir en ella. El defecto está desde la
-- primera migración; solo se manifestó al instalar el cron que la drena, porque hasta entonces nada
-- la actualizaba en un despliegue real.
--
-- Se añade la columna en vez de quitar el disparador: la tabla está en la lista del bucle a
-- propósito (sus filas mutan — `intentos`, `estado_envio`, `bloqueada_hasta`, `enviado_at`) y las
-- otras 18 tablas de esa lista sí tienen `updated_at`. Quitar el disparador dejaría a
-- `notificaciones` como la única excepción silenciosa de la convención.
alter table public.notificaciones
  add column if not exists updated_at timestamptz not null default now();

-- Las filas que ya existían nacen con `updated_at = now()` por el default, que miente sobre cuándo
-- se tocaron por última vez. Se alinea con lo que sí se sabe: si ya se envió, la fecha de envío; si
-- no, la de creación.
update public.notificaciones
   set updated_at = coalesce(enviado_at, created_at)
 where updated_at > coalesce(enviado_at, created_at);
