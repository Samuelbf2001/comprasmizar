-- Adenda de pagos · soporte del portal público con más formatos (2026-09-17).
--
-- Decisión de Ernesto, literal: «si puede ser muchos tipos de archivos, CSV, Excel, etc., PDF,
-- imágenes, lo que sea». Hasta hoy el adjunto que sube quien radica por el portal solo podía ser una
-- foto (JPG/PNG/WebP), y la base lo imponía por partida triple: la lista blanca de `mime_type`, la
-- correspondencia nombre↔MIME, y la regla de que un `requisicion_item` solo admite `tipo = 'foto'`.
--
-- Esta migración amplía las tres, SIN aflojar ninguna defensa:
--   1) `nombre_mime_adjunto_valido` aprende las extensiones de los formatos nuevos. Sigue siendo una
--      correspondencia EXACTA: un .exe con mime_type 'application/pdf' se rechaza igual que ayer.
--   2) La lista blanca de MIME crece con OOXML (.xlsx/.docx/.pptx), XLS legado y `text/plain` (el
--      MIME con el que el servidor guarda un CSV: ver lib/infrastructure/attachment-mime.ts, donde se
--      explica por qué de un CSV no se puede demostrar nada más que "es texto").
--   3) Un `requisicion_item` pasa a admitir `tipo in ('foto', 'soporte')`: la factura de un artículo
--      es un soporte, no una foto. A cambio se AÑADE una regla que antes no existía y que ahora hace
--      falta: lo que se llame `foto` tiene que ser una imagen de verdad. Antes se cumplía por
--      accidente (todos los MIME permitidos menos el PDF eran imágenes); a partir de hoy hay ocho
--      MIME no-imagen, así que la invariante se escribe.
--
-- Lo que NO cambia, a propósito:
--   - El tope de `tamano_bytes` sigue en 20 MiB aunque la aplicación baje a 10 MB. El CHECK es la
--     barrera EXTERIOR, y es `not valid`: apretarlo a 10 MB rompería cualquier UPDATE sobre filas
--     radicadas con el tope viejo. El límite del producto vive en `MAX_PRIVATE_ATTACHMENT_BYTES`.
--   - El expediente de proveedor (`adjuntos_proveedor_documento_valido`, 202608240002) se queda con
--     PDF/JPG/PNG/WebP: el RUT y la cámara de comercio son documentos firmados, no hojas de cálculo.
--   - Ninguna política de lectura/escritura se toca; solo se recrean las funciones que enumeran MIME.

-- ---------------------------------------------------------------------------
-- 1) Correspondencia nombre ↔ MIME
-- ---------------------------------------------------------------------------
create or replace function public.nombre_mime_adjunto_valido(p_nombre text, p_mime text)
returns boolean language sql immutable set search_path = public as $$
  select case lower(coalesce(p_mime, ''))
    when 'application/pdf' then lower(coalesce(p_nombre, '')) ~ '\.pdf$'
    when 'image/jpeg' then lower(coalesce(p_nombre, '')) ~ '\.(jpg|jpeg)$'
    when 'image/png' then lower(coalesce(p_nombre, '')) ~ '\.png$'
    when 'image/webp' then lower(coalesce(p_nombre, '')) ~ '\.webp$'
    when 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' then lower(coalesce(p_nombre, '')) ~ '\.xlsx$'
    when 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' then lower(coalesce(p_nombre, '')) ~ '\.docx$'
    when 'application/vnd.openxmlformats-officedocument.presentationml.presentation' then lower(coalesce(p_nombre, '')) ~ '\.pptx$'
    when 'application/vnd.ms-excel' then lower(coalesce(p_nombre, '')) ~ '\.xls$'
    -- Un .csv y un .txt son el mismo hallazgo para el servidor: comparten MIME a propósito.
    when 'text/plain' then lower(coalesce(p_nombre, '')) ~ '\.(csv|txt)$'
    else false
  end;
$$;

-- Lista blanca de MIME de los adjuntos genéricos, en UNA sola función para que la constraint, el
-- helper de lectura y cualquier arnés miren exactamente la misma lista (antes estaba escrita a pelo
-- en los dos sitios, y por eso 202609150001 tuvo que copiarla).
create or replace function public.mime_adjunto_generico_permitido(p_mime text)
returns boolean language sql immutable set search_path = public as $$
  select lower(coalesce(p_mime, '')) in (
    'application/pdf',
    'image/jpeg',
    'image/png',
    'image/webp',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.ms-excel',
    'text/plain'
  );
$$;

/* Una foto tiene que ser una imagen: la invariante que hasta hoy sostenía la lista blanca entera. */
create or replace function public.tipo_mime_adjunto_coherente(p_tipo text, p_mime text)
returns boolean language sql immutable set search_path = public as $$
  select p_tipo <> 'foto' or lower(coalesce(p_mime, '')) like 'image/%';
$$;

revoke all on function public.mime_adjunto_generico_permitido(text) from public, anon;
revoke all on function public.tipo_mime_adjunto_coherente(text, text) from public, anon;
grant execute on function public.mime_adjunto_generico_permitido(text) to authenticated, service_role;
grant execute on function public.tipo_mime_adjunto_coherente(text, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2) Metadata canónica: se recrea la constraint (NOT VALID, como la instaló 202608240003)
-- ---------------------------------------------------------------------------
alter table public.adjuntos drop constraint if exists adjuntos_genericos_documento_valido;
alter table public.adjuntos
  add constraint adjuntos_genericos_documento_valido check (
    entidad not in ('requisicion', 'requisicion_item', 'caja_menor', 'pago_orden') or (
      storage_bucket is not null and storage_bucket = 'requisicion-adjuntos'
      and (
        (entidad = 'requisicion' and tipo in ('soporte', 'cotizacion', 'foto'))
        -- El portal público radica la factura/cotización del artículo como `soporte`; la foto de
        -- siempre (Flow de WhatsApp y portal) sigue entrando como `foto`.
        or (entidad = 'requisicion_item' and tipo in ('foto', 'soporte'))
        or (entidad = 'caja_menor' and tipo = 'soporte')
        or (entidad = 'pago_orden' and tipo = 'soporte')
      )
      and nombre_original ~ '^[a-z0-9][a-z0-9._-]{0,127}$'
      and position('..' in nombre_original) = 0
      and mime_type is not null and public.mime_adjunto_generico_permitido(mime_type)
      and public.tipo_mime_adjunto_coherente(tipo, mime_type)
      and public.nombre_mime_adjunto_valido(nombre_original, mime_type)
      and tamano_bytes is not null and tamano_bytes > 0 and tamano_bytes <= 20971520
      and public.path_adjunto_generico_valido(url_storage)
      and public.entidad_adjunto_desde_path(url_storage) = entidad
      and public.entidad_id_adjunto_desde_path(url_storage) = entidad_id
      and split_part(url_storage, '/', 3) = id::text
      and split_part(url_storage, '/', 4) = nombre_original
      and (checksum_sha256 is null or checksum_sha256 ~ '^[a-f0-9]{64}$')
    )
  ) not valid;

comment on constraint adjuntos_genericos_documento_valido on public.adjuntos is
  'Se aplica a toda alta o cambio nuevo. Las filas genéricas históricas, si existen, requieren remediación antes de VALIDATE CONSTRAINT.';

-- ---------------------------------------------------------------------------
-- 3) Lectura: la misma ampliación en el helper que respalda las policies
-- ---------------------------------------------------------------------------
-- Versión VIGENTE = la de 202609150001 (cuatro entidades genéricas), con la lista de MIME y de tipos
-- delegada a las funciones de arriba. `create or replace` no cambia firma ni privilegios, así que los
-- GRANT/REVOKE de 202608240003 se conservan (misma nota que 202609110005).
create or replace function public.puede_leer_adjunto_generico_finalizado(
  p_adjunto_id uuid,
  p_entidad text,
  p_entidad_id uuid,
  p_storage_path text,
  p_storage_bucket text,
  p_tipo text,
  p_nombre text,
  p_mime text,
  p_tamano bigint,
  p_usuario_id uuid default auth.uid()
) returns boolean language sql stable security definer set search_path = public, storage as $$
  select p_usuario_id = auth.uid()
    and public.puede_leer_adjunto(p_entidad, p_entidad_id, p_usuario_id)
    and p_entidad in ('requisicion', 'requisicion_item', 'caja_menor', 'pago_orden')
    and p_storage_bucket = 'requisicion-adjuntos'
    and (
      (p_entidad = 'requisicion' and p_tipo in ('soporte', 'cotizacion', 'foto'))
      or (p_entidad = 'requisicion_item' and p_tipo in ('foto', 'soporte'))
      or (p_entidad = 'caja_menor' and p_tipo = 'soporte')
      or (p_entidad = 'pago_orden' and p_tipo = 'soporte')
    )
    and p_nombre ~ '^[a-z0-9][a-z0-9._-]{0,127}$'
    and position('..' in p_nombre) = 0
    and public.mime_adjunto_generico_permitido(p_mime)
    and public.tipo_mime_adjunto_coherente(p_tipo, p_mime)
    and public.nombre_mime_adjunto_valido(p_nombre, p_mime)
    and p_tamano > 0 and p_tamano <= 20971520
    and public.path_adjunto_generico_valido(p_storage_path)
    and public.entidad_adjunto_desde_path(p_storage_path) = p_entidad
    and public.entidad_id_adjunto_desde_path(p_storage_path) = p_entidad_id
    and split_part(p_storage_path, '/', 3) = p_adjunto_id::text
    and split_part(p_storage_path, '/', 4) = p_nombre
    and exists (
      select 1 from storage.objects o
      where o.bucket_id = p_storage_bucket and o.name = p_storage_path
    );
$$;

-- ---------------------------------------------------------------------------
-- 4) El bucket declara los mismos formatos
-- ---------------------------------------------------------------------------
-- `storage.buckets` es inerte desde la migración a disco propio (ver supabase/bootstrap), pero sigue
-- siendo la declaración de qué admite el bucket privado y hay arneses que la leen: si dijera una cosa
-- y la constraint otra, el próximo lector creería la equivocada.
update storage.buckets
  set allowed_mime_types = array[
    'application/pdf',
    'image/jpeg',
    'image/png',
    'image/webp',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.ms-excel',
    'text/plain'
  ]
  where id = 'requisicion-adjuntos';
