-- RF-1005/RF-101/RF-102/RF-801. Los soportes de requisición, ítem y caja
-- menor comparten `adjuntos`. El path es una clave privada de Storage, nunca
-- una URL firmada ni una capacidad de acceso.

-- Un adjunto genérico siempre está bajo una de estas rutas:
-- requisiciones/<requisicion_uuid>/<adjunto_uuid>/<nombre_seguro>
-- requisicion-items/<item_uuid>/<adjunto_uuid>/<nombre_seguro>
-- caja-menor/<caja_uuid>/<adjunto_uuid>/<nombre_seguro>
create or replace function public.path_adjunto_generico_valido(p_path text)
returns boolean language sql immutable set search_path = public as $$
  select coalesce(p_path ~
    '^(requisiciones|requisicion-items|caja-menor)/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[a-z0-9][a-z0-9._-]{0,127}$', false);
$$;

create or replace function public.entidad_adjunto_desde_path(p_path text)
returns text language sql immutable set search_path = public as $$
  select case split_part(p_path, '/', 1)
    when 'requisiciones' then 'requisicion'
    when 'requisicion-items' then 'requisicion_item'
    when 'caja-menor' then 'caja_menor'
    else null
  end;
$$;

create or replace function public.entidad_id_adjunto_desde_path(p_path text)
returns uuid language plpgsql immutable set search_path = public as $$
begin
  if not public.path_adjunto_generico_valido(p_path) then return null; end if;
  return split_part(p_path, '/', 2)::uuid;
end;
$$;

create or replace function public.nombre_mime_adjunto_valido(p_nombre text, p_mime text)
returns boolean language sql immutable set search_path = public as $$
  select case lower(coalesce(p_mime, ''))
    when 'application/pdf' then lower(coalesce(p_nombre, '')) ~ '\.pdf$'
    when 'image/jpeg' then lower(coalesce(p_nombre, '')) ~ '\.(jpg|jpeg)$'
    when 'image/png' then lower(coalesce(p_nombre, '')) ~ '\.png$'
    when 'image/webp' then lower(coalesce(p_nombre, '')) ~ '\.webp$'
    else false
  end;
$$;

create or replace function public.adjunto_generico_existe(p_entidad text, p_entidad_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select case p_entidad
    when 'requisicion' then exists (select 1 from public.requisiciones where id = p_entidad_id)
    when 'requisicion_item' then exists (select 1 from public.requisicion_items where id = p_entidad_id)
    when 'caja_menor' then exists (select 1 from public.caja_menor where id = p_entidad_id)
    else false
  end;
$$;

-- La lectura hereda exactamente la visibilidad de la entidad padre; saber el
-- UUID o el path no concede acceso. Proveedor conserva su política RF-602.
create or replace function public.puede_leer_adjunto(p_entidad text, p_entidad_id uuid, p_usuario_id uuid default auth.uid())
returns boolean language sql stable security definer set search_path = public as $$
  select p_usuario_id = auth.uid() and public.is_active_user(p_usuario_id) and case p_entidad
    when 'requisicion' then exists (
      select 1 from public.requisiciones r
      where r.id = p_entidad_id and (
        public.can_operate_compras(p_usuario_id) or public.has_role('contabilidad', p_usuario_id)
        or r.solicitante_id = p_usuario_id
        or exists (select 1 from public.etiquetas e where e.id = r.etiqueta_id and e.aprobador_id = p_usuario_id)
      )
    )
    when 'requisicion_item' then exists (
      select 1 from public.requisicion_items ri
      join public.requisiciones r on r.id = ri.requisicion_id
      where ri.id = p_entidad_id and (
        public.can_operate_compras(p_usuario_id) or public.has_role('contabilidad', p_usuario_id)
        or r.solicitante_id = p_usuario_id
        or exists (select 1 from public.etiquetas e where e.id = r.etiqueta_id and e.aprobador_id = p_usuario_id)
      )
    )
    when 'caja_menor' then public.can_operate_compras(p_usuario_id) or public.has_role('contabilidad', p_usuario_id)
    when 'proveedor' then public.can_operate_compras(p_usuario_id) or public.can_manage_catalogos(p_usuario_id) or public.has_role('contabilidad', p_usuario_id)
    when 'orden' then exists (
      select 1 from public.ordenes o join public.requisiciones r on r.id = o.requisicion_id
      where o.id = p_entidad_id and (
        public.can_operate_compras(p_usuario_id) or public.has_role('contabilidad', p_usuario_id)
        or exists (select 1 from public.etiquetas e where e.id = r.etiqueta_id and e.aprobador_id = p_usuario_id)
      )
    )
    when 'gasto' then public.is_reviewer_or_admin(p_usuario_id) or public.has_role('contabilidad', p_usuario_id)
    else false
  end;
$$;

alter table public.adjuntos
  add constraint adjuntos_genericos_documento_valido check (
    entidad not in ('requisicion', 'requisicion_item', 'caja_menor') or (
      storage_bucket is not null and storage_bucket = 'requisicion-adjuntos'
      and (
        (entidad = 'requisicion' and tipo in ('soporte', 'cotizacion', 'foto'))
        or (entidad = 'requisicion_item' and tipo = 'foto')
        or (entidad = 'caja_menor' and tipo = 'soporte')
      )
      and nombre_original ~ '^[a-z0-9][a-z0-9._-]{0,127}$'
      and position('..' in nombre_original) = 0
      and mime_type is not null and mime_type in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')
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

create or replace function public.validar_adjunto_generico()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.entidad in ('requisicion', 'requisicion_item', 'caja_menor')
    and not public.adjunto_generico_existe(new.entidad, new.entidad_id) then
    raise exception 'El soporte debe pertenecer a una entidad existente' using errcode = '23503';
  end if;
  return new;
end;
$$;

-- La constraint se instala NOT VALID para no bloquear historia antigua. Esta
-- barrera de lectura sí es estricta: un soporte genérico sólo se vuelve
-- visible después del HEAD/complete server-side, cuando existe el objeto
-- privado y todos sus metadatos/ruta corresponden a la entidad.
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
    and p_entidad in ('requisicion', 'requisicion_item', 'caja_menor')
    and p_storage_bucket = 'requisicion-adjuntos'
    and (
      (p_entidad = 'requisicion' and p_tipo in ('soporte', 'cotizacion', 'foto'))
      or (p_entidad = 'requisicion_item' and p_tipo = 'foto')
      or (p_entidad = 'caja_menor' and p_tipo = 'soporte')
    )
    and p_nombre ~ '^[a-z0-9][a-z0-9._-]{0,127}$'
    and position('..' in p_nombre) = 0
    and p_mime in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')
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

drop trigger if exists adjuntos_genericos_integridad on public.adjuntos;
create trigger adjuntos_genericos_integridad
  before insert or update on public.adjuntos
  for each row execute function public.validar_adjunto_generico();

-- Es un helper de integridad del trigger: exponerlo permitiría sondear UUIDs
-- que el usuario no puede leer mediante un SECURITY DEFINER.
revoke all on function public.adjunto_generico_existe(text, uuid) from public, anon, authenticated;
revoke all on function public.puede_leer_adjunto(text, uuid, uuid) from public, anon, authenticated;
revoke all on function public.puede_leer_adjunto_generico_finalizado(uuid, text, uuid, text, text, text, text, text, bigint, uuid) from public, anon, authenticated;
grant execute on function public.adjunto_generico_existe(text, uuid) to service_role;
grant execute on function public.puede_leer_adjunto(text, uuid, uuid) to authenticated, service_role;
grant execute on function public.puede_leer_adjunto_generico_finalizado(uuid, text, uuid, text, text, text, text, text, bigint, uuid) to authenticated, service_role;

create index if not exists adjuntos_genericos_requisicion_idx
  on public.adjuntos(entidad_id, fecha desc) where entidad = 'requisicion';
create index if not exists adjuntos_genericos_item_idx
  on public.adjuntos(entidad_id, fecha desc) where entidad = 'requisicion_item';
create index if not exists adjuntos_genericos_caja_menor_idx
  on public.adjuntos(entidad_id, fecha desc) where entidad = 'caja_menor';

-- Sustituye el acceso por propietario del objeto: sólo existe lectura cuando
-- hay metadata finalizada y el actor puede ver la entidad correspondiente.
drop policy if exists "adjuntos_lectura_operativa" on public.adjuntos;
create policy "adjuntos_lectura_operativa" on public.adjuntos for select to authenticated using (
  case when entidad in ('requisicion', 'requisicion_item', 'caja_menor') then
    public.puede_leer_adjunto_generico_finalizado(
      id, entidad, entidad_id, url_storage, storage_bucket, tipo, nombre_original, mime_type, tamano_bytes
    )
  else public.puede_leer_adjunto(entidad, entidad_id) end
);
drop policy if exists "adjuntos_subir" on public.adjuntos;
revoke insert, update, delete on table public.adjuntos from authenticated;
revoke insert, update, delete on table public.adjuntos from anon;
grant insert, update, delete on table public.adjuntos to service_role;

drop policy if exists "mizar_storage_read" on storage.objects;
create policy "mizar_storage_read" on storage.objects for select to authenticated using (
  bucket_id = 'requisicion-adjuntos' and public.is_active_user()
  and exists (
    select 1 from public.adjuntos a
    where a.storage_bucket = storage.objects.bucket_id and a.url_storage = storage.objects.name
      and case when a.entidad in ('requisicion', 'requisicion_item', 'caja_menor') then
        public.puede_leer_adjunto_generico_finalizado(
          a.id, a.entidad, a.entidad_id, a.url_storage, a.storage_bucket, a.tipo,
          a.nombre_original, a.mime_type, a.tamano_bytes
        )
      else public.puede_leer_adjunto(a.entidad, a.entidad_id) end
  )
);
drop policy if exists "mizar_storage_upload" on storage.objects;
drop policy if exists "mizar_storage_update" on storage.objects;
-- NOTA (verificado en producción): storage.objects es propiedad de
-- supabase_storage_admin, no de postgres. El rol postgres (con el que
-- corren las migraciones) no es superusuario ni miembro de
-- supabase_storage_admin, así que este REVOKE es un no-op silencioso:
-- authenticated y anon conservan INSERT/UPDATE/DELETE de fábrica sobre
-- storage.objects por diseño de la plataforma Supabase gestionada. Se deja
-- el REVOKE por si algún día corre con más autoridad, pero el control real
-- de seguridad es la ausencia de políticas RLS de escritura para esos
-- roles (verificado con intentos de ataque que fallan con 42501 en
-- supabase/tests/generic_attachments_verification.sql).
revoke insert, update, delete on table storage.objects from authenticated;
revoke insert, update, delete on table storage.objects from anon;
grant insert, update, delete on table storage.objects to service_role;

-- El prepare de URL firmada y el HEAD/complete corren exclusivamente en el
-- servidor con service_role: primero se prepara un path canónico, luego el
-- servidor verifica tamaño/MIME del objeto y sólo entonces inserta adjuntos.
-- No hay policy JWT de escritura sobre metadata ni sobre este bucket.

comment on table public.adjuntos is
  'Adjuntos polimórficos privados. Soportes genéricos usan ruta canónica y RLS por entidad; proveedor conserva expediente privado RF-602.';
comment on column public.adjuntos.url_storage is
  'Clave Storage privada, nunca URL pública/firmada. Genérico: requisiciones|requisicion-items|caja-menor/<entidad_uuid>/<adjunto_uuid>/<nombre_seguro>.';
