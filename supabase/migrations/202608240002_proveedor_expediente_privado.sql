-- RF-601/RF-602/RF-604. El expediente reutiliza `adjuntos`; no se crean
-- tablas por módulo. El servidor verifica el objeto Storage antes de persistir
-- su metadata (entidad='proveedor').

alter table public.adjuntos
  add column if not exists storage_bucket text,
  add column if not exists mime_type text,
  add column if not exists checksum_sha256 text;

-- url_storage es una clave privada, nunca una URL/capacidad. Los documentos de
-- proveedor sólo admiten el expediente proveedores/<proveedor>/<documento>/<nombre>.
alter table public.adjuntos
  add constraint adjuntos_proveedor_documento_valido check (
    entidad <> 'proveedor' or (
      tipo in ('rut', 'camara_comercio', 'certificacion_bancaria', 'certificado_calidad')
      and storage_bucket is not null and storage_bucket = 'proveedor-documentos-privados'
      and url_storage is not null and nombre_original is not null
      and nombre_original ~ '^[a-z0-9][a-z0-9._-]{0,127}$'
      and position('..' in nombre_original) = 0
      and url_storage = 'proveedores/' || entidad_id::text || '/' || id::text || '/' || nombre_original
      and mime_type is not null and mime_type in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')
      and tamano_bytes is not null and tamano_bytes > 0 and tamano_bytes <= 20971520
      and (checksum_sha256 is null or checksum_sha256 ~ '^[a-f0-9]{64}$')
    )
  );

comment on table public.adjuntos is
  'Adjuntos polimórficos. entidad=proveedor es el expediente privado RF-602, registrado sólo tras verificación server-side.';
comment on column public.adjuntos.url_storage is
  'Clave Storage, nunca URL pública/firmada. Proveedor: proveedores/<proveedor_uuid>/<documento_uuid>/<nombre_seguro>.';

-- Un FK no puede apuntar a una sola tabla en una relación polimórfica. Para el
-- expediente sensible sí se comprueba el proveedor real, y la evidencia queda
-- inmutable incluso para service_role una vez registrada.
create or replace function public.validar_adjunto_proveedor()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.entidad = 'proveedor' and not exists (
    select 1 from public.proveedores p where p.id = new.entidad_id
  ) then
    raise exception 'El documento debe pertenecer a un proveedor existente' using errcode = '23503';
  end if;
  if tg_op = 'UPDATE' and old.entidad = 'proveedor' then
    raise exception 'Los documentos de proveedor son evidencia y no se modifican' using errcode = '55000';
  end if;
  return new;
end; $$;

create or replace function public.bloquear_borrado_adjunto_proveedor()
returns trigger language plpgsql set search_path = public as $$
begin
  if old.entidad = 'proveedor' then
    raise exception 'Los documentos de proveedor son evidencia y no se eliminan' using errcode = '55000';
  end if;
  return old;
end; $$;

create trigger adjuntos_proveedor_integridad
  before insert or update on public.adjuntos
  for each row execute function public.validar_adjunto_proveedor();
create trigger adjuntos_proveedor_sin_borrado_fisico
  before delete on public.adjuntos
  for each row execute function public.bloquear_borrado_adjunto_proveedor();

-- Conserva sólo entidad/tipo/tamaño útiles. Nunca registra path, nombre,
-- checksum/MIME o datos bancarios junto a una certificación.
create or replace function public.auditoria_campo_sensible(p_tabla text, p_clave text)
returns boolean language sql immutable set search_path = public as $$
  select p_clave = any(array[
    'password', 'key_hash', 'token_hash', 'public_code_hash', 'payload', 'payload_json',
    'datos_bancarios', 'contacto', 'telefono', 'telefono_destino', 'email', 'observaciones'
  ])
  or (p_tabla = 'requisiciones' and p_clave = any(array['solicitante_nombre_externo', 'solicitante_telefono_externo']))
  or (p_tabla = 'obra_solicitantes_autorizados' and p_clave = any(array['nombre', 'telefono_normalizado']))
  or (p_tabla = 'usuarios' and p_clave = 'nombre')
  or (p_tabla = 'whatsapp_eventos' and p_clave = any(array['telefono', 'kapso_message_id']))
  or (p_tabla = 'adjuntos' and p_clave = any(array['url_storage', 'nombre_original', 'checksum_sha256', 'mime_type']));
$$;

-- RF-604: una fila por OC/OP. El agregado lateral queda aislado por orden, de
-- modo que cada ítem aporta una sola vez a los totales de la ficha.
create or replace view public.proveedor_historial_ordenes
with (security_invoker = true) as
select
  o.proveedor_id, o.id as orden_id, o.consecutivo, o.tipo,
  o.estado_cumplimiento, o.fecha_generacion, o.requisicion_id, r.obra_id,
  coalesce(lineas.cantidad_items, 0)::integer as cantidad_items,
  coalesce(lineas.valor_base, 0)::numeric(16,2) as valor_base,
  coalesce(lineas.iva, 0)::numeric(16,2) as iva,
  coalesce(lineas.valor_total, 0)::numeric(16,2) as valor_total
from public.ordenes o
join public.requisiciones r on r.id = o.requisicion_id
left join lateral (
  select count(*) as cantidad_items,
    sum(ri.valor_base * ri.cantidad) as valor_base,
    sum(ri.iva * ri.cantidad) as iva,
    sum(ri.valor_total * ri.cantidad) as valor_total
  from public.orden_items oi
  join public.requisicion_items ri on ri.id = oi.requisicion_item_id
  where oi.orden_id = o.id
) lineas on true
where o.proveedor_id is not null;

comment on view public.proveedor_historial_ordenes is
  'RF-604. Vista SECURITY INVOKER de órdenes y totales; no expone contacto, datos bancarios ni adjuntos.';

create index if not exists adjuntos_proveedor_historial_idx
  on public.adjuntos(entidad_id, fecha desc) where entidad = 'proveedor';
create index if not exists ordenes_proveedor_historial_idx
  on public.ordenes(proveedor_id, fecha_generacion desc) where proveedor_id is not null;

-- La política genérica de adjuntos propios no puede heredarse al expediente:
-- mantiene los demás adjuntos, pero cierra la lectura/escritura JWT de proveedor.
drop policy if exists "adjuntos_lectura_operativa" on public.adjuntos;
create policy "adjuntos_lectura_operativa" on public.adjuntos for select to authenticated using (
  public.is_active_user() and (
    (entidad <> 'proveedor' and (public.can_operate_compras() or public.has_role('contabilidad') or subido_por = auth.uid()))
    or
    (entidad = 'proveedor' and (public.can_operate_compras() or public.can_manage_catalogos() or public.has_role('contabilidad')))
  )
);
drop policy if exists "adjuntos_subir" on public.adjuntos;
create policy "adjuntos_subir" on public.adjuntos for insert to authenticated with check (
  entidad <> 'proveedor' and public.is_active_user()
  and (subido_por = auth.uid() or public.can_operate_compras())
);
-- No existían policies de UPDATE/DELETE para adjuntos; retirar además estos
-- privilegios evita que un cliente pueda convertir un rechazo RLS en una ruta
-- de mutación futura si alguien añade una policy amplia por error.
revoke update, delete on public.adjuntos from authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('proveedor-documentos-privados', 'proveedor-documentos-privados', false, 20971520,
  array['application/pdf', 'image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- No hay policies de INSERT/UPDATE/DELETE sobre este bucket: el único upload es
-- URL firmada desde servidor. Un objeto sólo es legible si ya tiene metadata
-- canónica de proveedor; no existe acceso por owner_id.
create policy "expediente_proveedor_storage_lectura_privada"
  on storage.objects for select to authenticated using (
    bucket_id = 'proveedor-documentos-privados' and public.is_active_user()
    and (public.can_operate_compras() or public.can_manage_catalogos() or public.has_role('contabilidad'))
    and exists (
      select 1 from public.adjuntos a
      where a.entidad = 'proveedor' and a.storage_bucket = storage.objects.bucket_id
        and a.url_storage = storage.objects.name
    )
  );

grant select on public.proveedor_historial_ordenes to authenticated;
