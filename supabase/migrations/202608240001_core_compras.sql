-- Plataforma Mizar: núcleo y compras. Diseñada para Supabase/PostgreSQL 15+.
-- Esta migración no aprovisiona ningún proyecto ni contiene secretos.

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

do $$ begin
  create type public.rol_usuario as enum ('solicitante', 'revisor', 'aprobador', 'contabilidad', 'admin_mizar', 'admin_sixteam');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.estado_usuario as enum ('activo', 'inactivo');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.estado_obra as enum ('activa', 'cerrada');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.estado_item as enum ('activo', 'pendiente_normalizacion', 'inactivo', 'fusionado');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.tipo_requisicion as enum ('compra', 'pago');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.canal_requisicion as enum ('web', 'publico', 'whatsapp');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.estado_requisicion as enum ('enviada', 'en_revision', 'en_aprobacion', 'aprobada', 'devuelta', 'declinada');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.tipo_documento as enum ('REQ', 'OC', 'OP');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.estado_orden as enum ('generada', 'cumplida', 'no_cumplida', 'no_necesario');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.origen_gasto as enum ('requisicion', 'caja_menor');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.canal_notificacion as enum ('whatsapp', 'email', 'interno');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.estado_envio as enum ('pendiente', 'enviado', 'entregado', 'fallido');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.direccion_whatsapp as enum ('entrada', 'salida');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.tipo_whatsapp as enum ('flow', 'plantilla', 'mensaje');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.origen_auditoria as enum ('web', 'mcp', 'kapso', 'importacion', 'sistema');
exception when duplicate_object then null; end $$;

create table if not exists public.sociedades (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  nit text,
  nit_normalizado text generated always as (nullif(regexp_replace(coalesce(nit, ''), '[^0-9A-Za-z]', '', 'g'), '')) stored,
  activa boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sociedades_nombre_no_vacio check (nullif(btrim(nombre), '') is not null),
  constraint sociedades_nombre_unico unique (nombre),
  constraint sociedades_nit_unico unique (nit_normalizado)
);

create table if not exists public.usuarios (
  id uuid primary key references auth.users(id) on delete cascade,
  nombre text not null check (char_length(btrim(nombre)) >= 2),
  email text not null,
  telefono text,
  estado public.estado_usuario not null default 'activo',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint usuarios_nombre_no_vacio check (nullif(btrim(nombre), '') is not null),
  constraint usuarios_email_formato check (btrim(email) ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  constraint usuarios_email_unico unique (email)
);

create table if not exists public.usuario_roles (
  usuario_id uuid not null references public.usuarios(id) on delete cascade,
  rol public.rol_usuario not null,
  created_at timestamptz not null default now(),
  primary key (usuario_id, rol)
);

create table if not exists public.modulos (
  nombre text primary key,
  activo boolean not null default false,
  roles_acceso public.rol_usuario[] not null default '{}'::public.rol_usuario[],
  descripcion text,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.usuarios(id) on delete set null,
  constraint modulos_nombre_formato check (nombre ~ '^[a-z0-9_]+$')
);

insert into public.modulos (nombre, activo, roles_acceso, descripcion) values
  ('compras', true, array['solicitante','revisor','aprobador','contabilidad','admin_mizar','admin_sixteam']::public.rol_usuario[], 'Núcleo de requisiciones y compras'),
  ('caja_menor', true, array['revisor','contabilidad','admin_mizar','admin_sixteam']::public.rol_usuario[], 'Registro liviano de caja menor'),
  ('ordenes_multi_proveedor', false, array['revisor','aprobador','contabilidad','admin_mizar','admin_sixteam']::public.rol_usuario[], 'Habilita división de OC por proveedor en alcance Completo'),
  ('catalogos_admin_mizar', false, array['admin_mizar']::public.rol_usuario[], 'Habilita autoservicio de catálogos en alcance Completo')
on conflict (nombre) do nothing;

create table if not exists public.obras (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  sociedad_id uuid not null references public.sociedades(id) on delete restrict,
  estado public.estado_obra not null default 'activa',
  public_submission_enabled boolean not null default false,
  require_authorized_requester boolean not null default false,
  public_code_hash text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint obras_nombre_no_vacio check (nullif(btrim(nombre), '') is not null),
  constraint obras_nombre_sociedad_unico unique (nombre, sociedad_id),
  constraint obras_codigo_publico_check check (
    (public_submission_enabled = false and public_code_hash is null)
    or (public_submission_enabled = true and public_code_hash is not null)
  )
);

create table if not exists public.obra_solicitantes_autorizados (
  id uuid primary key default gen_random_uuid(),
  obra_id uuid not null references public.obras(id) on delete cascade,
  nombre text not null,
  telefono text not null,
  telefono_normalizado text generated always as (regexp_replace(telefono, '[^0-9]', '', 'g')) stored,
  activo boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint obra_solicitantes_telefono_no_vacio check (telefono_normalizado <> ''),
  constraint obra_solicitantes_unico unique (obra_id, telefono_normalizado)
);

create table if not exists public.etiquetas (
  id uuid primary key default gen_random_uuid(),
  nombre text not null unique,
  aprobador_id uuid references public.usuarios(id) on delete restrict,
  activa boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint etiquetas_nombre_no_vacio check (nullif(btrim(nombre), '') is not null)
);

create table if not exists public.proveedores (
  id uuid primary key default gen_random_uuid(),
  razon_social text not null,
  nit text,
  nit_normalizado text generated always as (nullif(regexp_replace(coalesce(nit, ''), '[^0-9A-Za-z]', '', 'g'), '')) stored,
  contacto jsonb not null default '{}'::jsonb,
  datos_bancarios jsonb not null default '{}'::jsonb,
  activo boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint proveedores_razon_social_no_vacia check (nullif(btrim(razon_social), '') is not null),
  constraint proveedores_nit_unico unique (nit_normalizado),
  constraint proveedores_contacto_objeto check (jsonb_typeof(contacto) = 'object'),
  constraint proveedores_banco_objeto check (jsonb_typeof(datos_bancarios) = 'object')
);

create table if not exists public.items (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  nombre_normalizado text not null,
  especificacion text,
  unidad_defecto text not null,
  categoria text,
  estado public.estado_item not null default 'activo',
  item_canonico_id uuid references public.items(id) on delete restrict,
  creado_por uuid references public.usuarios(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint items_nombre_normalizado_unico unique (nombre_normalizado),
  constraint items_fusion_check check ((estado = 'fusionado') = (item_canonico_id is not null)),
  constraint items_no_autofusion check (item_canonico_id is null or item_canonico_id <> id)
);

create table if not exists public.consecutivos (
  tipo_documento public.tipo_documento not null,
  anio integer not null check (anio between 2000 and 9999),
  siguiente bigint not null check (siguiente > 0),
  updated_at timestamptz not null default now(),
  primary key (tipo_documento, anio)
);

create table if not exists public.requisiciones (
  id uuid primary key default gen_random_uuid(),
  consecutivo text not null unique,
  tipo public.tipo_requisicion not null,
  obra_id uuid not null references public.obras(id) on delete restrict,
  solicitante_id uuid references public.usuarios(id) on delete restrict,
  solicitante_nombre_externo text,
  solicitante_telefono_externo text,
  canal public.canal_requisicion not null,
  fecha_requerida date,
  destino text,
  observaciones text,
  etiqueta_id uuid references public.etiquetas(id) on delete restrict,
  estado public.estado_requisicion not null default 'enviada',
  motivo_declinacion text,
  motivo_devolucion text,
  kapso_event_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint requisiciones_solicitante_check check (
    solicitante_id is not null or (solicitante_nombre_externo is not null and solicitante_telefono_externo is not null)
  ),
  constraint requisiciones_publica_check check (
    (canal <> 'publico') or solicitante_id is null
  ),
  constraint requisiciones_motivo_declinacion_check check (
    (estado <> 'declinada') or nullif(btrim(motivo_declinacion), '') is not null
  ),
  constraint requisiciones_motivo_devolucion_check check (
    (estado <> 'devuelta') or nullif(btrim(motivo_devolucion), '') is not null
  ),
  constraint requisiciones_kapso_event_id_no_vacio check (
    kapso_event_id is null or nullif(btrim(kapso_event_id), '') is not null
  )
);

create table if not exists public.requisicion_items (
  id uuid primary key default gen_random_uuid(),
  requisicion_id uuid not null references public.requisiciones(id) on delete restrict,
  item_id uuid references public.items(id) on delete restrict,
  descripcion_libre text,
  cantidad numeric(14,3) not null check (cantidad > 0),
  unidad text not null,
  posible_proveedor_texto text,
  proveedor_final_id uuid references public.proveedores(id) on delete restrict,
  link_producto text,
  valor_base numeric(16,2) not null default 0 check (valor_base >= 0 and valor_base = trunc(valor_base)),
  iva numeric(16,2) not null default 0 check (iva >= 0 and iva = trunc(iva)),
  valor_total numeric(16,2) generated always as (round(valor_base + iva, 2)) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint requisicion_items_item_check check (item_id is not null or nullif(btrim(descripcion_libre), '') is not null)
);

create table if not exists public.ordenes (
  id uuid primary key default gen_random_uuid(),
  consecutivo text not null unique,
  tipo public.tipo_documento not null check (tipo in ('OC', 'OP')),
  requisicion_id uuid not null references public.requisiciones(id) on delete restrict,
  proveedor_id uuid references public.proveedores(id) on delete restrict,
  estado_cumplimiento public.estado_orden not null default 'generada',
  pdf_url text,
  fecha_generacion timestamptz not null default now(),
  creada_por uuid references public.usuarios(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.orden_items (
  orden_id uuid not null references public.ordenes(id) on delete restrict,
  requisicion_item_id uuid not null references public.requisicion_items(id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (orden_id, requisicion_item_id)
);

create table if not exists public.gastos (
  id uuid primary key default gen_random_uuid(),
  obra_id uuid not null references public.obras(id) on delete restrict,
  origen public.origen_gasto not null,
  referencia_id uuid not null,
  etiqueta_id uuid references public.etiquetas(id) on delete restrict,
  proveedor_id uuid references public.proveedores(id) on delete restrict,
  fecha date not null,
  valor_base numeric(16,2) not null default 0 check (valor_base >= 0 and valor_base = trunc(valor_base)),
  iva numeric(16,2) not null default 0 check (iva >= 0 and iva = trunc(iva)),
  valor_total numeric(16,2) generated always as (round(valor_base + iva, 2)) stored,
  -- El cast a timestamp NO es opcional: para un argumento date, Postgres resuelve
  -- date_trunc hacia la sobrecarga timestamptz (tipo preferido de la categoria),
  -- que es STABLE y una columna generada exige IMMUTABLE.
  periodo date generated always as (date_trunc('month', fecha::timestamp)::date) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint gastos_origen_referencia_unico unique (origen, referencia_id)
);

create table if not exists public.gastos_reparto (
  gasto_id uuid not null references public.gastos(id) on delete restrict,
  obra_id uuid not null references public.obras(id) on delete restrict,
  valor numeric(16,2) not null check (valor > 0 and valor = trunc(valor)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (gasto_id, obra_id)
);

create table if not exists public.caja_menor (
  id uuid primary key default gen_random_uuid(),
  obra_id uuid not null references public.obras(id) on delete restrict,
  fecha date not null,
  concepto text not null check (nullif(btrim(concepto), '') is not null),
  etiqueta_id uuid references public.etiquetas(id) on delete restrict,
  proveedor_id uuid references public.proveedores(id) on delete restrict,
  valor numeric(16,2) not null check (valor > 0 and valor = trunc(valor)),
  registrado_por uuid not null references public.usuarios(id) on delete restrict,
  gasto_id uuid unique references public.gastos(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.adjuntos (
  id uuid primary key default gen_random_uuid(),
  entidad text not null check (entidad in ('requisicion', 'requisicion_item', 'orden', 'proveedor', 'gasto', 'caja_menor')),
  entidad_id uuid not null,
  url_storage text not null unique,
  tipo text not null,
  nombre_original text not null,
  tamano_bytes bigint check (tamano_bytes is null or tamano_bytes >= 0),
  subido_por uuid references public.usuarios(id) on delete set null,
  fecha timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists public.notificaciones (
  id uuid primary key default gen_random_uuid(),
  usuario_id uuid references public.usuarios(id) on delete cascade,
  telefono_destino text,
  canal public.canal_notificacion not null,
  plantilla text,
  payload jsonb not null default '{}'::jsonb,
  estado_envio public.estado_envio not null default 'pendiente',
  intentos smallint not null default 0 check (intentos >= 0),
  ultimo_error text,
  bloqueada_hasta timestamptz,
  fecha timestamptz not null default now(),
  enviado_at timestamptz,
  created_at timestamptz not null default now(),
  constraint notificaciones_payload_objeto check (jsonb_typeof(payload) = 'object'),
  constraint notificaciones_destino_check check ((usuario_id is not null) <> (nullif(btrim(telefono_destino), '') is not null)),
  constraint notificaciones_envio_fecha_check check (estado_envio not in ('enviado', 'entregado') or enviado_at is not null)
);

create table if not exists public.whatsapp_eventos (
  id uuid primary key default gen_random_uuid(),
  direccion public.direccion_whatsapp not null,
  telefono text not null,
  requisicion_id uuid references public.requisiciones(id) on delete set null,
  tipo public.tipo_whatsapp not null,
  payload_json jsonb not null default '{}'::jsonb,
  estado_entrega public.estado_envio,
  kapso_message_id text,
  fecha timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint whatsapp_eventos_payload_objeto check (jsonb_typeof(payload_json) = 'object')
);

-- Ledger técnico de idempotencia para webhooks Kapso. Nunca se expone el payload
-- por auditoría ni a perfiles operativos: el eventId es la clave de reintento.
create table if not exists public.kapso_procesamiento (
  event_id text primary key check (nullif(btrim(event_id), '') is not null),
  tipo_evento text not null check (tipo_evento in ('flow_submission', 'message_status')),
  estado text not null check (estado in ('processing', 'retryable', 'completed')),
  requisicion_id uuid references public.requisiciones(id) on delete restrict,
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint kapso_flow_completed_requiere_requisicion check (
    estado <> 'completed' or tipo_evento <> 'flow_submission' or requisicion_id is not null
  )
);

create table if not exists public.mcp_api_keys (
  id uuid primary key default gen_random_uuid(),
  usuario_id uuid not null references public.usuarios(id) on delete cascade,
  nombre text not null,
  key_hash text not null unique,
  activa boolean not null default true,
  ultima_vez_usada timestamptz,
  fecha_creacion timestamptz not null default now(),
  revocada_at timestamptz,
  created_at timestamptz not null default now(),
  constraint mcp_api_keys_nombre_por_usuario unique (usuario_id, nombre),
  -- HMAC-SHA256(raw API key, MCP_KEY_PEPPER), never la clave mizar_ en claro.
  constraint mcp_api_keys_hash_hmac_sha256 check (key_hash ~ '^[0-9a-f]{64}$')
);

create table if not exists public.sesiones_pantalla (
  id uuid primary key default gen_random_uuid(),
  nombre text not null unique,
  token_hash text not null unique,
  activa boolean not null default true,
  creada_por uuid not null references public.usuarios(id) on delete restrict,
  ultima_vez_usada timestamptz,
  fecha_creacion timestamptz not null default now(),
  expira_at timestamptz
);

create table if not exists public.auditoria (
  id bigint generated always as identity primary key,
  entidad text not null,
  entidad_id uuid,
  evento text not null check (evento ~ '^[A-Z][A-Z0-9_]{0,79}$'),
  origen public.origen_auditoria not null,
  usuario_id uuid,
  fecha timestamptz not null default now(),
  datos_json jsonb not null default '{}'::jsonb,
  constraint auditoria_datos_objeto check (jsonb_typeof(datos_json) = 'object')
);

create table if not exists public.requisicion_historial (
  id bigint generated always as identity primary key,
  requisicion_id uuid not null references public.requisiciones(id) on delete restrict,
  estado_anterior public.estado_requisicion,
  estado_nuevo public.estado_requisicion not null,
  comentario text,
  usuario_id uuid,
  fecha timestamptz not null default now()
);

create table if not exists public.configuracion (
  clave text primary key,
  valor jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.usuarios(id) on delete set null,
  constraint configuracion_objeto check (jsonb_typeof(valor) = 'object')
);

insert into public.configuracion (clave, valor)
values ('impuestos_v1', '{"solo_iva": true, "tasa_iva_predeterminada": 0.19, "nota": "Provisional hasta cierre P1"}'::jsonb)
on conflict (clave) do nothing;

-- Helper functions avoid circular RLS evaluation. Ownership must remain migration owner.
create or replace function public.is_active_user(p_user_id uuid default auth.uid())
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.usuarios u where u.id = p_user_id and u.estado = 'activo');
$$;

create or replace function public.has_role(p_role public.rol_usuario, p_user_id uuid default auth.uid())
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.usuario_roles ur
    join public.usuarios u on u.id = ur.usuario_id
    where ur.usuario_id = p_user_id and ur.rol = p_role and u.estado = 'activo'
  );
$$;

-- Contrato RF-003/RF-401 compartido con el backend: una etiqueta activa se
-- enruta exclusivamente a un aprobador activo con alguno de estos tres roles.
create or replace function public.es_aprobador_elegible(p_user_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select p_user_id is not null and exists (
    select 1 from public.usuarios u
    join public.usuario_roles ur on ur.usuario_id = u.id
    where u.id = p_user_id and u.estado = 'activo'
      and ur.rol in ('aprobador', 'revisor', 'admin_sixteam')
  );
$$;

create or replace function public.is_admin(p_user_id uuid default auth.uid())
returns boolean language sql stable security definer set search_path = public as $$
  select public.has_role('admin_mizar', p_user_id) or public.has_role('admin_sixteam', p_user_id);
$$;

create or replace function public.is_reviewer_or_admin(p_user_id uuid default auth.uid())
returns boolean language sql stable security definer set search_path = public as $$
  select public.has_role('revisor', p_user_id) or public.is_admin(p_user_id);
$$;

create or replace function public.can_manage_items(p_user_id uuid default auth.uid())
returns boolean language sql stable security definer set search_path = public as $$
  select public.has_role('revisor', p_user_id) or public.has_role('admin_sixteam', p_user_id);
$$;

create or replace function public.can_manage_catalogos(p_user_id uuid default auth.uid())
returns boolean language sql stable security definer set search_path = public as $$
  select public.has_role('admin_sixteam', p_user_id) or (
    public.has_role('admin_mizar', p_user_id) and exists (
      select 1 from public.modulos m
      where m.nombre = 'catalogos_admin_mizar' and m.activo and 'admin_mizar' = any(m.roles_acceso)
    )
  );
$$;

create or replace function public.can_operate_compras(p_user_id uuid default auth.uid())
returns boolean language sql stable security definer set search_path = public as $$
  select public.has_role('revisor', p_user_id) or public.has_role('admin_sixteam', p_user_id);
$$;

create or replace function public.origen_auditoria_contexto()
returns public.origen_auditoria language sql stable set search_path = public as $$
  select case coalesce(nullif(current_setting('app.audit_origin', true), ''), case when auth.role() = 'service_role' then 'sistema' else 'web' end)
    when 'mcp' then 'mcp'::public.origen_auditoria
    when 'kapso' then 'kapso'::public.origen_auditoria
    when 'importacion' then 'importacion'::public.origen_auditoria
    when 'sistema' then 'sistema'::public.origen_auditoria
    else 'web'::public.origen_auditoria end;
$$;

create or replace function public.registrar_evento_auditoria(
  p_entidad text, p_entidad_id uuid, p_evento text, p_origen public.origen_auditoria, p_datos_json jsonb default '{}'::jsonb
) returns bigint language plpgsql security definer set search_path = public as $$
declare v_id bigint; begin
  if auth.role() <> 'service_role' then raise exception 'Solo service_role puede registrar eventos técnicos' using errcode = '42501'; end if;
  if jsonb_typeof(p_datos_json) <> 'object' then raise exception 'datos_json debe ser un objeto' using errcode = '23514'; end if;
  insert into public.auditoria(entidad, entidad_id, evento, origen, usuario_id, datos_json)
  values (p_entidad, p_entidad_id, p_evento, p_origen, auth.uid(), p_datos_json) returning id into v_id;
  return v_id;
end; $$;

create or replace function public.next_consecutivo(p_tipo public.tipo_documento, p_anio integer default extract(year from current_date)::integer)
returns text language plpgsql security definer set search_path = public as $$
declare v_num bigint; begin
  insert into public.consecutivos (tipo_documento, anio, siguiente)
  values (p_tipo, p_anio, 2)
  on conflict (tipo_documento, anio) do update
    set siguiente = public.consecutivos.siguiente + 1, updated_at = now()
  returning siguiente - 1 into v_num;
  return p_tipo::text || '-' || p_anio::text || '-' || lpad(v_num::text, 4, '0');
end;
$$;

create or replace function public.asignar_consecutivo_requisicion()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.consecutivo is null or btrim(new.consecutivo) = '' then new.consecutivo := public.next_consecutivo('REQ'); end if;
  return new;
end; $$;

create or replace function public.asignar_consecutivo_orden()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.consecutivo is null or btrim(new.consecutivo) = '' then new.consecutivo := public.next_consecutivo(new.tipo); end if;
  return new;
end; $$;

create or replace function public.set_updated_at()
returns trigger language plpgsql set search_path = public as $$ begin new.updated_at := now(); return new; end; $$;

create or replace function public.validar_transicion_requisicion()
returns trigger language plpgsql as $$ begin
  if new.estado = old.estado then return new; end if;
  if not ((old.estado = 'enviada' and new.estado = 'en_revision')
    or (old.estado = 'en_revision' and new.estado in ('en_aprobacion', 'declinada'))
    or (old.estado = 'en_aprobacion' and new.estado in ('aprobada', 'devuelta'))
    or (old.estado = 'devuelta' and new.estado = 'en_revision')) then
    raise exception 'Transición de requisición no permitida: % -> %', old.estado, new.estado using errcode = '23514';
  end if;
  return new;
end; $$;

create or replace function public.registrar_historial_requisicion()
returns trigger language plpgsql security definer set search_path = public as $$ begin
  if tg_op = 'INSERT' then
    insert into public.requisicion_historial(requisicion_id, estado_nuevo, comentario, usuario_id)
    values (new.id, new.estado, 'Requisición creada', auth.uid());
  elsif new.estado is distinct from old.estado then
    insert into public.requisicion_historial(requisicion_id, estado_anterior, estado_nuevo, comentario, usuario_id)
    values (new.id, old.estado, new.estado,
      case new.estado when 'declinada' then new.motivo_declinacion when 'devuelta' then new.motivo_devolucion else null end,
      auth.uid());
  end if;
  return new;
end; $$;

create or replace function public.bloquear_historial_mutacion()
returns trigger language plpgsql as $$ begin
  raise exception '% es inmutable', tg_table_name using errcode = '55000';
end; $$;

-- Los maestros se retiran mediante sus banderas de estado, no con DELETE. Así se
-- conserva la trazabilidad y una reactivación no exige recrear las referencias.
create or replace function public.bloquear_eliminacion_catalogo()
returns trigger language plpgsql as $$ begin
  raise exception '% usa desactivación reversible; DELETE no permitido', tg_table_name using errcode = '55000';
end; $$;

-- El lock FOR UPDATE sobre usuarios es el mutex de la relación etiqueta/rol:
-- tanto activar/reasignar la etiqueta como retirar al aprobador se serializan
-- sobre la misma fila y no pueden dejar una etiqueta activa sin responsable.
create or replace function public.validar_aprobador_etiqueta_activa()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_estado public.estado_usuario; begin
  if not new.activa then return new; end if;
  if new.aprobador_id is null then
    raise exception 'Una etiqueta activa requiere aprobador elegible' using errcode = '23514';
  end if;
  select u.estado into v_estado from public.usuarios u where u.id = new.aprobador_id for update;
  if not found or v_estado <> 'activo' or not public.es_aprobador_elegible(new.aprobador_id) then
    raise exception 'El aprobador de una etiqueta activa debe estar activo y ser elegible' using errcode = '23514';
  end if;
  return new;
end; $$;

create or replace function public.validar_baja_usuario_con_etiquetas_activas()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- El UPDATE ya bloquea la fila de usuario; la activación/reasignación de una
  -- etiqueta toma FOR UPDATE sobre esa misma fila antes de comprobar sus roles.
  if old.estado = 'activo' and new.estado = 'inactivo' and exists (
    select 1 from public.etiquetas e where e.aprobador_id = old.id and e.activa
  ) then
    raise exception 'No se puede desactivar un aprobador con etiquetas activas; desactive o reasigne las etiquetas primero' using errcode = '23514';
  end if;
  return new;
end; $$;

create or replace function public.validar_retiro_ultimo_rol_aprobador()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_usuario_id uuid; begin
  if old.rol not in ('aprobador', 'revisor', 'admin_sixteam') then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  if tg_op = 'UPDATE' and new.usuario_id = old.usuario_id
    and new.rol in ('aprobador', 'revisor', 'admin_sixteam') then return new; end if;
  v_usuario_id := old.usuario_id;
  perform 1 from public.usuarios u where u.id = v_usuario_id for update;
  if exists (select 1 from public.etiquetas e where e.aprobador_id = v_usuario_id and e.activa)
    and not exists (
      select 1 from public.usuario_roles ur
      where ur.usuario_id = v_usuario_id and ur.rol in ('aprobador', 'revisor', 'admin_sixteam')
        and not (ur.usuario_id = old.usuario_id and ur.rol = old.rol)
    ) then
    raise exception 'No se puede retirar el último rol elegible de un aprobador con etiquetas activas' using errcode = '23514';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end; $$;

-- RLS controla quién escribe; estos triggers también impiden que una integración
-- con privilegios de servicio cree referencias nuevas a catálogos retirados.
-- No se ejecutan cuando solo cambia el estado de una requisición ya histórica.
create or replace function public.validar_catalogos_activos_requisicion()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_obra_activa boolean; v_etiqueta_activa boolean; v_solicitante_activo boolean; begin
  select o.estado = 'activa' and s.activa into v_obra_activa
    from public.obras o join public.sociedades s on s.id = o.sociedad_id where o.id = new.obra_id;
  if coalesce(v_obra_activa, false) = false then
    raise exception 'La obra de una requisición nueva o reasignada debe estar activa' using errcode = '23514';
  end if;
  if new.etiqueta_id is not null then
    select e.activa and public.es_aprobador_elegible(e.aprobador_id) into v_etiqueta_activa
      from public.etiquetas e where e.id = new.etiqueta_id;
    if coalesce(v_etiqueta_activa, false) = false then
      raise exception 'La etiqueta de una requisición nueva o reasignada debe estar activa' using errcode = '23514';
    end if;
  end if;
  if new.solicitante_id is not null then
    select estado = 'activo' into v_solicitante_activo from public.usuarios where id = new.solicitante_id;
    if coalesce(v_solicitante_activo, false) = false then
      raise exception 'El solicitante de una requisición nueva o reasignada debe estar activo' using errcode = '23514';
    end if;
  end if;
  return new;
end; $$;

create or replace function public.validar_catalogos_activos_requisicion_item()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_item_estado public.estado_item; v_proveedor_activo boolean; begin
  if new.item_id is not null then
    select estado into v_item_estado from public.items where id = new.item_id;
    if coalesce(v_item_estado::text, '') in ('inactivo', 'fusionado') or v_item_estado is null then
      raise exception 'El ítem seleccionado no está disponible' using errcode = '23514';
    end if;
  end if;
  if new.proveedor_final_id is not null then
    select activo into v_proveedor_activo from public.proveedores where id = new.proveedor_final_id;
    if coalesce(v_proveedor_activo, false) = false then
      raise exception 'El proveedor seleccionado debe estar activo' using errcode = '23514';
    end if;
  end if;
  return new;
end; $$;

create or replace function public.validar_catalogos_activos_orden()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_proveedor_activo boolean; begin
  if new.proveedor_id is not null then
    select activo into v_proveedor_activo from public.proveedores where id = new.proveedor_id;
    if coalesce(v_proveedor_activo, false) = false then
      raise exception 'El proveedor de una orden nueva o reasignada debe estar activo' using errcode = '23514';
    end if;
  end if;
  return new;
end; $$;

create or replace function public.validar_catalogos_activos_caja_menor()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_obra_activa boolean; v_etiqueta_activa boolean; v_proveedor_activo boolean; v_usuario_activo boolean; begin
  select o.estado = 'activa' and s.activa into v_obra_activa
    from public.obras o join public.sociedades s on s.id = o.sociedad_id where o.id = new.obra_id;
  if coalesce(v_obra_activa, false) = false then
    raise exception 'La obra de caja menor debe estar activa' using errcode = '23514';
  end if;
  if new.etiqueta_id is not null then
    select e.activa and public.es_aprobador_elegible(e.aprobador_id) into v_etiqueta_activa
      from public.etiquetas e where e.id = new.etiqueta_id;
    if coalesce(v_etiqueta_activa, false) = false then
      raise exception 'La etiqueta de caja menor debe estar activa' using errcode = '23514';
    end if;
  end if;
  if new.proveedor_id is not null then
    select activo into v_proveedor_activo from public.proveedores where id = new.proveedor_id;
    if coalesce(v_proveedor_activo, false) = false then
      raise exception 'El proveedor de caja menor debe estar activo' using errcode = '23514';
    end if;
  end if;
  select estado = 'activo' into v_usuario_activo from public.usuarios where id = new.registrado_por;
  if coalesce(v_usuario_activo, false) = false then
    raise exception 'El responsable de caja menor debe estar activo' using errcode = '23514';
  end if;
  return new;
end; $$;

-- La auditoría conserva valores de negocio útiles, pero nunca secretos, payloads ni PII.
create or replace function public.auditoria_campo_sensible(p_tabla text, p_clave text)
returns boolean language sql immutable set search_path = public as $$
  select p_clave = any(array[
    'password', 'key_hash', 'token_hash', 'public_code_hash', 'payload', 'payload_json',
    'datos_bancarios', 'contacto', 'telefono', 'telefono_destino', 'email', 'observaciones'
  ])
  or (p_tabla = 'requisiciones' and p_clave = any(array['solicitante_nombre_externo', 'solicitante_telefono_externo']))
  or (p_tabla = 'obra_solicitantes_autorizados' and p_clave = any(array['nombre', 'telefono_normalizado']))
  or (p_tabla = 'usuarios' and p_clave = 'nombre')
  or (p_tabla = 'whatsapp_eventos' and p_clave = any(array['telefono', 'kapso_message_id']));
$$;

create or replace function public.auditoria_fila_visible(p_tabla text, p_fila jsonb)
returns jsonb language sql immutable set search_path = public as $$
  select coalesce(jsonb_object_agg(e.clave,
    case when public.auditoria_campo_sensible(p_tabla, e.clave) then jsonb_build_object('redactado', true) else e.valor end), '{}'::jsonb)
  from jsonb_each(coalesce(p_fila, '{}'::jsonb)) e(clave, valor);
$$;

create or replace function public.auditoria_cambios_visibles(p_tabla text, p_anterior jsonb, p_nuevo jsonb)
returns jsonb language sql immutable set search_path = public as $$
  select coalesce(jsonb_object_agg(n.clave,
    case when public.auditoria_campo_sensible(p_tabla, n.clave) then jsonb_build_object('redactado', true)
    else jsonb_build_object('antes', a.valor, 'despues', n.valor) end), '{}'::jsonb)
  from jsonb_each(coalesce(p_nuevo, '{}'::jsonb)) n(clave, valor)
  left join jsonb_each(coalesce(p_anterior, '{}'::jsonb)) a(clave, valor) using (clave)
  where n.clave <> 'updated_at' and a.valor is distinct from n.valor;
$$;

create or replace function public.escribir_auditoria()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_data jsonb; v_row jsonb; v_event text; begin
  v_row := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  v_id := nullif(v_row ->> 'id', '')::uuid;
  v_data := jsonb_build_object('operacion', tg_op);
  if tg_op = 'UPDATE' then
    v_data := v_data || jsonb_build_object('datos_cambio', public.auditoria_cambios_visibles(tg_table_name, to_jsonb(old), to_jsonb(new)));
  elsif tg_op = 'INSERT' then
    v_data := v_data || jsonb_build_object('datos_nuevos', public.auditoria_fila_visible(tg_table_name, to_jsonb(new)));
  else
    v_data := v_data || jsonb_build_object('datos_anteriores', public.auditoria_fila_visible(tg_table_name, to_jsonb(old)));
  end if;
  v_event := case when tg_table_name = 'requisiciones' and tg_op = 'UPDATE'
    and (to_jsonb(new) ->> 'estado') is distinct from (to_jsonb(old) ->> 'estado') then 'STATE_CHANGE' else tg_op end;
  insert into public.auditoria(entidad, entidad_id, evento, origen, usuario_id, datos_json)
  values (tg_table_name, v_id, v_event, public.origen_auditoria_contexto(), auth.uid(), v_data);
  if tg_op = 'DELETE' then return old; end if;
  return new;
end; $$;

create or replace function public.escribir_auditoria_kapso_procesamiento()
returns trigger language plpgsql security definer set search_path = public, extensions as $$
declare v_row jsonb; v_event_id text; v_data jsonb; begin
  v_row := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  v_event_id := v_row ->> 'event_id';
  -- Deliberadamente no se copia `payload`: puede contener teléfono, texto u otro PII.
  v_data := jsonb_build_object(
    'operacion', tg_op,
    'event_id_sha256', encode(extensions.digest(v_event_id, 'sha256'), 'hex'),
    'tipo_evento', v_row ->> 'tipo_evento',
    'estado', v_row ->> 'estado'
  );
  insert into public.auditoria(entidad, entidad_id, evento, origen, usuario_id, datos_json)
  values ('kapso_procesamiento', null, 'KAPSO_PROCESSING_' || tg_op, 'kapso', auth.uid(), v_data);
  if tg_op = 'DELETE' then return old; end if;
  return new;
end; $$;

create or replace function public.limitar_actualizacion_aprobador()
returns trigger language plpgsql security definer set search_path = public as $$ begin
  -- Un aprobador que no sea revisor ni admin solo puede decidir su bandeja personal.
  if public.has_role('aprobador') and not public.can_operate_compras() then
    if old.estado <> 'en_aprobacion' or new.estado not in ('aprobada', 'devuelta')
      or (to_jsonb(new) - array['estado', 'motivo_devolucion', 'updated_at'])
         is distinct from (to_jsonb(old) - array['estado', 'motivo_devolucion', 'updated_at']) then
      raise exception 'Un aprobador solo puede aprobar o devolver su requisición sin modificar otros campos' using errcode = '42501';
    end if;
  end if;
  return new;
end; $$;

create or replace function public.validar_reparto_gasto()
returns trigger language plpgsql as $$
declare v_gasto uuid := coalesce(new.gasto_id, old.gasto_id); v_total numeric(16,0); v_repartido numeric(16,0); begin
  select valor_total into v_total from public.gastos where id = v_gasto;
  if not found then return null; end if;
  select coalesce(sum(valor), 0) into v_repartido from public.gastos_reparto where gasto_id = v_gasto;
  if v_repartido <> 0 and v_repartido <> v_total then
    raise exception 'El reparto del gasto % debe sumar %, suma %', v_gasto, v_total, v_repartido using errcode = '23514';
  end if;
  return null;
end; $$;

create or replace function public.validar_reparto_gasto_padre()
returns trigger language plpgsql as $$
declare v_repartido numeric(16,0); begin
  select coalesce(sum(valor), 0) into v_repartido from public.gastos_reparto where gasto_id = new.id;
  if v_repartido <> 0 and v_repartido <> new.valor_total then
    raise exception 'El reparto del gasto % debe sumar %, suma %', new.id, new.valor_total, v_repartido using errcode = '23514';
  end if;
  return null;
end; $$;

create or replace function public.sincronizar_gasto_caja_menor()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_gasto uuid; begin
  if tg_op = 'INSERT' then
    insert into public.gastos(obra_id, origen, referencia_id, etiqueta_id, proveedor_id, fecha, valor_base, iva)
    values (new.obra_id, 'caja_menor', new.id, new.etiqueta_id, new.proveedor_id, new.fecha, new.valor, 0)
    returning id into v_gasto;
    new.gasto_id := v_gasto;
  elsif new.gasto_id is not null then
    update public.gastos set obra_id = new.obra_id, etiqueta_id = new.etiqueta_id, proveedor_id = new.proveedor_id,
      fecha = new.fecha, valor_base = new.valor, iva = 0 where id = new.gasto_id;
  end if;
  return new;
end; $$;

create or replace function public.crear_requisicion_publica(
  p_obra_id uuid, p_codigo text, p_nombre text, p_telefono text, p_tipo public.tipo_requisicion,
  p_fecha_requerida date, p_destino text, p_observaciones text, p_items jsonb
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_req uuid; v_item jsonb; v_codigo_valido boolean; v_requiere_lista boolean; begin
  select public_submission_enabled and public_code_hash = extensions.crypt(p_codigo, public_code_hash), require_authorized_requester
    into v_codigo_valido, v_requiere_lista
    from public.obras where id = p_obra_id and estado = 'activa';
  if coalesce(v_codigo_valido, false) = false then raise exception 'Código de obra inválido' using errcode = '28000'; end if;
  if v_requiere_lista and not exists (
    select 1 from public.obra_solicitantes_autorizados osa
    where osa.obra_id = p_obra_id and osa.activo and osa.telefono_normalizado = regexp_replace(p_telefono, '[^0-9]', '', 'g')
  ) then raise exception 'Solicitante no autorizado para esta obra' using errcode = '28000'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'Se requiere al menos un ítem' using errcode = '23514'; end if;
  insert into public.requisiciones(consecutivo, tipo, obra_id, solicitante_nombre_externo, solicitante_telefono_externo, canal, fecha_requerida, destino, observaciones, estado)
  values ('', p_tipo, p_obra_id, nullif(btrim(p_nombre), ''), nullif(btrim(p_telefono), ''), 'publico', p_fecha_requerida, p_destino, p_observaciones, 'enviada') returning id into v_req;
  for v_item in select value from jsonb_array_elements(p_items) loop
    insert into public.requisicion_items(requisicion_id, item_id, descripcion_libre, cantidad, unidad, posible_proveedor_texto, link_producto)
    values (v_req, nullif(v_item->>'item_id', '')::uuid, nullif(btrim(v_item->>'descripcion_libre'), ''),
      coalesce((v_item->>'cantidad')::numeric, 0), nullif(btrim(v_item->>'unidad'), ''),
      nullif(btrim(v_item->>'posible_proveedor_texto'), ''), nullif(btrim(v_item->>'link_producto'), ''));
  end loop;
  return v_req;
end; $$;

create or replace function public.consultar_estado_requisicion_publica(p_requisicion_id uuid, p_codigo text)
returns table(consecutivo text, estado public.estado_requisicion, updated_at timestamptz)
language sql stable security definer set search_path = public as $$
  select r.consecutivo, r.estado, r.updated_at from public.requisiciones r
  join public.obras o on o.id = r.obra_id
  where r.id = p_requisicion_id and r.canal = 'publico'
    and o.public_submission_enabled and o.public_code_hash = extensions.crypt(p_codigo, o.public_code_hash);
$$;

create or replace view public.gasto_distribucion with (security_invoker = true) as
  select g.id as gasto_id, g.obra_id, g.fecha, g.periodo, g.etiqueta_id, g.proveedor_id, g.origen, g.valor_total as valor
  from public.gastos g where not exists (select 1 from public.gastos_reparto gr where gr.gasto_id = g.id)
  union all
  select g.id, gr.obra_id, g.fecha, g.periodo, g.etiqueta_id, g.proveedor_id, g.origen, gr.valor
  from public.gastos g join public.gastos_reparto gr on gr.gasto_id = g.id;

create index if not exists obras_sociedad_estado_idx on public.obras(sociedad_id, estado);
create index if not exists etiquetas_aprobador_activa_idx on public.etiquetas(aprobador_id, activa);
create index if not exists obras_activas_busqueda_idx on public.obras(sociedad_id, nombre) where estado = 'activa';
create index if not exists etiquetas_activas_busqueda_idx on public.etiquetas(nombre) where activa;
create index if not exists proveedores_activos_busqueda_idx on public.proveedores(razon_social) where activo;
-- La validación de importación no es una garantía de concurrencia: esta llave
-- funcional cierra find-then-insert para razones sociales equivalentes.
create unique index if not exists proveedores_razon_social_normalizada_unico_idx on public.proveedores(lower(btrim(razon_social)));
create index if not exists items_disponibles_busqueda_idx on public.items(nombre_normalizado) where estado in ('activo', 'pendiente_normalizacion');
create index if not exists obra_solicitantes_activos_idx on public.obra_solicitantes_autorizados(obra_id, telefono_normalizado) where activo;
create index if not exists items_busqueda_idx on public.items using gin (to_tsvector('spanish', nombre || ' ' || coalesce(especificacion, '')));
create index if not exists requisiciones_revision_idx on public.requisiciones(estado, created_at desc);
create index if not exists requisiciones_obra_estado_idx on public.requisiciones(obra_id, estado, created_at desc);
create index if not exists requisiciones_etiqueta_estado_idx on public.requisiciones(etiqueta_id, estado, created_at desc);
create index if not exists requisiciones_solicitante_idx on public.requisiciones(solicitante_id, created_at desc) where solicitante_id is not null;
create unique index if not exists requisiciones_kapso_event_id_unico_idx on public.requisiciones(kapso_event_id) where kapso_event_id is not null;
create index if not exists requisicion_items_requisicion_idx on public.requisicion_items(requisicion_id);
create index if not exists ordenes_requisicion_idx on public.ordenes(requisicion_id, fecha_generacion desc);
create index if not exists ordenes_estado_idx on public.ordenes(estado_cumplimiento, fecha_generacion desc);
create index if not exists gastos_obra_periodo_idx on public.gastos(obra_id, periodo, fecha);
create index if not exists gastos_etiqueta_periodo_idx on public.gastos(etiqueta_id, periodo);
create index if not exists gastos_reparto_obra_idx on public.gastos_reparto(obra_id, gasto_id);
create index if not exists caja_menor_obra_fecha_idx on public.caja_menor(obra_id, fecha desc);
create index if not exists adjuntos_entidad_idx on public.adjuntos(entidad, entidad_id, fecha desc);
create index if not exists notificaciones_usuario_idx on public.notificaciones(usuario_id, estado_envio, fecha desc);
create index if not exists notificaciones_pendientes_idx on public.notificaciones(estado_envio, fecha) where estado_envio in ('pendiente', 'fallido');
create index if not exists whatsapp_eventos_requisicion_idx on public.whatsapp_eventos(requisicion_id, fecha desc);
create index if not exists whatsapp_eventos_telefono_idx on public.whatsapp_eventos(telefono, fecha desc);
create unique index if not exists whatsapp_eventos_kapso_unico_idx on public.whatsapp_eventos(kapso_message_id) where kapso_message_id is not null;
create index if not exists kapso_procesamiento_estado_updated_idx on public.kapso_procesamiento(estado, updated_at);
create index if not exists kapso_procesamiento_requisicion_idx on public.kapso_procesamiento(requisicion_id) where requisicion_id is not null;
create index if not exists auditoria_entidad_idx on public.auditoria(entidad, entidad_id, fecha desc);
create index if not exists historial_requisicion_idx on public.requisicion_historial(requisicion_id, fecha);

create trigger requisiciones_consecutivo before insert on public.requisiciones for each row execute function public.asignar_consecutivo_requisicion();
create trigger ordenes_consecutivo before insert on public.ordenes for each row execute function public.asignar_consecutivo_orden();
create trigger etiquetas_aprobador_elegible before insert or update of activa, aprobador_id on public.etiquetas for each row execute function public.validar_aprobador_etiqueta_activa();
create trigger usuarios_baja_etiquetas_activas before update of estado on public.usuarios for each row execute function public.validar_baja_usuario_con_etiquetas_activas();
create trigger usuario_roles_ultimo_aprobador before delete or update of usuario_id, rol on public.usuario_roles for each row execute function public.validar_retiro_ultimo_rol_aprobador();
create trigger requisiciones_catalogos_activos before insert or update of obra_id, etiqueta_id, solicitante_id on public.requisiciones for each row execute function public.validar_catalogos_activos_requisicion();
create trigger requisicion_items_catalogos_activos before insert or update of item_id, proveedor_final_id on public.requisicion_items for each row execute function public.validar_catalogos_activos_requisicion_item();
create trigger ordenes_catalogos_activos before insert or update of proveedor_id on public.ordenes for each row execute function public.validar_catalogos_activos_orden();
create trigger caja_menor_catalogos_activos before insert or update of obra_id, etiqueta_id, proveedor_id, registrado_por on public.caja_menor for each row execute function public.validar_catalogos_activos_caja_menor();
create trigger requisiciones_transicion before update of estado on public.requisiciones for each row execute function public.validar_transicion_requisicion();
create trigger requisiciones_aprobador_limite before update on public.requisiciones for each row execute function public.limitar_actualizacion_aprobador();
create trigger requisiciones_historial after insert or update of estado on public.requisiciones for each row execute function public.registrar_historial_requisicion();
create trigger caja_menor_gasto before insert or update on public.caja_menor for each row execute function public.sincronizar_gasto_caja_menor();
create constraint trigger gastos_reparto_cuadra after insert or update or delete on public.gastos_reparto deferrable initially deferred for each row execute function public.validar_reparto_gasto();
create constraint trigger gastos_reparto_cuadra_padre after update of valor_base, iva on public.gastos deferrable initially deferred for each row execute function public.validar_reparto_gasto_padre();

do $$ declare t text; begin
  foreach t in array array['sociedades','usuarios','modulos','obras','obra_solicitantes_autorizados','etiquetas','proveedores','items','requisiciones','requisicion_items','ordenes','gastos','gastos_reparto','caja_menor','notificaciones','kapso_procesamiento','configuracion'] loop
    execute format('create trigger %I before update on public.%I for each row execute function public.set_updated_at()', t || '_updated_at', t);
  end loop;
  foreach t in array array['sociedades','usuarios','usuario_roles','modulos','obras','obra_solicitantes_autorizados','etiquetas','proveedores','items','requisiciones','requisicion_items','ordenes','orden_items','gastos','gastos_reparto','caja_menor','adjuntos','notificaciones','whatsapp_eventos','mcp_api_keys','sesiones_pantalla','configuracion'] loop
    execute format('create trigger %I after insert or update or delete on public.%I for each row execute function public.escribir_auditoria()', t || '_auditoria', t);
  end loop;
end $$;
do $$ declare t text; begin
  foreach t in array array['sociedades','usuarios','obras','obra_solicitantes_autorizados','etiquetas','proveedores','items'] loop
    execute format('create trigger %I before delete on public.%I for each row execute function public.bloquear_eliminacion_catalogo()', t || '_sin_borrado_fisico', t);
  end loop;
end $$;
create trigger kapso_procesamiento_auditoria after insert or update or delete on public.kapso_procesamiento for each row execute function public.escribir_auditoria_kapso_procesamiento();
create trigger auditoria_inmutable before update or delete on public.auditoria for each row execute function public.bloquear_historial_mutacion();
create trigger historial_inmutable before update or delete on public.requisicion_historial for each row execute function public.bloquear_historial_mutacion();

alter table public.sociedades enable row level security;
alter table public.usuarios enable row level security;
alter table public.usuario_roles enable row level security;
alter table public.modulos enable row level security;
alter table public.obras enable row level security;
alter table public.obra_solicitantes_autorizados enable row level security;
alter table public.etiquetas enable row level security;
alter table public.proveedores enable row level security;
alter table public.items enable row level security;
alter table public.consecutivos enable row level security;
alter table public.requisiciones enable row level security;
alter table public.requisicion_items enable row level security;
alter table public.ordenes enable row level security;
alter table public.orden_items enable row level security;
alter table public.gastos enable row level security;
alter table public.gastos_reparto enable row level security;
alter table public.caja_menor enable row level security;
alter table public.adjuntos enable row level security;
alter table public.notificaciones enable row level security;
alter table public.whatsapp_eventos enable row level security;
alter table public.kapso_procesamiento enable row level security;
alter table public.mcp_api_keys enable row level security;
alter table public.sesiones_pantalla enable row level security;
alter table public.auditoria enable row level security;
alter table public.requisicion_historial enable row level security;
alter table public.configuracion enable row level security;

-- Catalogues: all active authenticated users can read; writing remains restricted.
create policy "catalogos_lectura" on public.sociedades for select to authenticated using (public.is_active_user());
create policy "catalogos_admin" on public.sociedades for all to authenticated using (public.can_manage_catalogos()) with check (public.can_manage_catalogos());
create policy "usuarios_propios_o_admin" on public.usuarios for select to authenticated using (public.is_active_user() and (id = auth.uid() or public.is_admin()));
create policy "usuarios_admin" on public.usuarios for all to authenticated using (public.can_manage_catalogos()) with check (public.can_manage_catalogos());
create policy "roles_propios_o_admin" on public.usuario_roles for select to authenticated using (public.is_active_user() and (usuario_id = auth.uid() or public.is_admin()));
create policy "roles_admin" on public.usuario_roles for all to authenticated using (public.can_manage_catalogos()) with check (public.can_manage_catalogos());
create policy "modulos_lectura" on public.modulos for select to authenticated using (public.is_active_user());
create policy "modulos_admin_sixteam" on public.modulos for all to authenticated using (public.has_role('admin_sixteam')) with check (public.has_role('admin_sixteam'));
create policy "obras_lectura" on public.obras for select to authenticated using (public.is_active_user());
create policy "obras_admin" on public.obras for all to authenticated using (public.can_manage_catalogos()) with check (public.can_manage_catalogos());
create policy "solicitantes_autorizados_operacion" on public.obra_solicitantes_autorizados for select to authenticated using (public.can_operate_compras() or public.can_manage_catalogos());
create policy "solicitantes_autorizados_catalogos" on public.obra_solicitantes_autorizados for all to authenticated using (public.can_manage_catalogos()) with check (public.can_manage_catalogos());
create policy "etiquetas_lectura" on public.etiquetas for select to authenticated using (public.is_active_user());
create policy "etiquetas_admin" on public.etiquetas for all to authenticated using (public.can_manage_catalogos()) with check (public.can_manage_catalogos());
create policy "proveedores_lectura_operativa" on public.proveedores for select to authenticated using (public.can_operate_compras() or public.can_manage_catalogos() or public.has_role('contabilidad'));
create policy "proveedores_revisor_admin" on public.proveedores for all to authenticated using (public.has_role('revisor') or public.can_manage_catalogos()) with check (public.has_role('revisor') or public.can_manage_catalogos());
create policy "items_lectura" on public.items for select to authenticated using (public.is_active_user());
create policy "items_solo_revisor_o_sixteam" on public.items for all to authenticated using (public.can_manage_items()) with check (public.can_manage_items());
create policy "configuracion_sixteam" on public.configuracion for all to authenticated using (public.has_role('admin_sixteam')) with check (public.has_role('admin_sixteam'));

-- Requisitions: requester only theirs; approver only those routed by their label; accounting read-only.
create policy "requisiciones_select" on public.requisiciones for select to authenticated using (
  public.is_active_user() and (public.can_operate_compras() or public.has_role('contabilidad') or solicitante_id = auth.uid()
  or exists (select 1 from public.etiquetas e where e.id = etiqueta_id and e.aprobador_id = auth.uid())
  )
);
create policy "requisiciones_solicitante_insert" on public.requisiciones for insert to authenticated with check (
  public.is_active_user() and solicitante_id = auth.uid() and canal = 'web' and estado = 'enviada'
);
create policy "requisiciones_operador_update" on public.requisiciones for update to authenticated using (public.can_operate_compras()) with check (public.can_operate_compras());
create policy "requisiciones_aprobador_update" on public.requisiciones for update to authenticated using (
  public.is_active_user() and estado = 'en_aprobacion' and exists (select 1 from public.etiquetas e where e.id = etiqueta_id and e.aprobador_id = auth.uid())
) with check (
  public.is_active_user() and exists (select 1 from public.etiquetas e where e.id = etiqueta_id and e.aprobador_id = auth.uid())
  and estado in ('aprobada', 'devuelta')
);
create policy "requisicion_items_select" on public.requisicion_items for select to authenticated using (
  public.is_active_user() and exists (select 1 from public.requisiciones r where r.id = requisicion_id and (
    public.can_operate_compras() or public.has_role('contabilidad') or r.solicitante_id = auth.uid()
    or exists (select 1 from public.etiquetas e where e.id = r.etiqueta_id and e.aprobador_id = auth.uid())
  ))
);
create policy "requisicion_items_solicitante_insert" on public.requisicion_items for insert to authenticated with check (
  public.is_active_user() and exists (select 1 from public.requisiciones r where r.id = requisicion_id and r.solicitante_id = auth.uid() and r.estado = 'enviada')
);
create policy "requisicion_items_operador_write" on public.requisicion_items for all to authenticated using (public.can_operate_compras()) with check (public.can_operate_compras());

create policy "ordenes_lectura_operativa" on public.ordenes for select to authenticated using (public.is_active_user() and (public.can_operate_compras() or public.has_role('contabilidad') or exists (
  select 1 from public.requisiciones r join public.etiquetas e on e.id = r.etiqueta_id where r.id = requisicion_id and e.aprobador_id = auth.uid()
)));
create policy "orden_items_lectura_operativa" on public.orden_items for select to authenticated using (exists (
  select 1 from public.ordenes o where o.id = orden_id and (public.can_operate_compras() or public.has_role('contabilidad'))
));
create policy "gastos_lectura_operativa" on public.gastos for select to authenticated using (public.is_reviewer_or_admin() or public.has_role('contabilidad'));
create policy "gastos_reparto_lectura_operativa" on public.gastos_reparto for select to authenticated using (public.is_reviewer_or_admin() or public.has_role('contabilidad'));
create policy "caja_menor_lectura_operativa" on public.caja_menor for select to authenticated using (public.can_operate_compras() or public.has_role('contabilidad'));
create policy "caja_menor_operador" on public.caja_menor for insert to authenticated with check (public.can_operate_compras() and registrado_por = auth.uid());
create policy "caja_menor_operador_update" on public.caja_menor for update to authenticated using (public.can_operate_compras()) with check (public.can_operate_compras());
create policy "adjuntos_lectura_operativa" on public.adjuntos for select to authenticated using (public.is_active_user() and (public.can_operate_compras() or public.has_role('contabilidad') or subido_por = auth.uid()));
create policy "adjuntos_subir" on public.adjuntos for insert to authenticated with check (public.is_active_user() and (subido_por = auth.uid() or public.can_operate_compras()));
create policy "notificaciones_propias" on public.notificaciones for select to authenticated using (public.is_active_user() and (usuario_id = auth.uid() or public.has_role('admin_sixteam')));
create policy "notificaciones_sixteam" on public.notificaciones for all to authenticated using (public.has_role('admin_sixteam')) with check (public.has_role('admin_sixteam'));
create policy "whatsapp_revisor_sixteam" on public.whatsapp_eventos for select to authenticated using (public.can_operate_compras());
create policy "kapso_procesamiento_sixteam_tecnico" on public.kapso_procesamiento for all to authenticated using (public.has_role('admin_sixteam')) with check (public.has_role('admin_sixteam'));
create policy "mcp_keys_propias" on public.mcp_api_keys for select to authenticated using (public.is_active_user() and (usuario_id = auth.uid() or public.has_role('admin_sixteam')));
create policy "mcp_keys_sixteam" on public.mcp_api_keys for all to authenticated using (public.has_role('admin_sixteam')) with check (public.has_role('admin_sixteam'));
create policy "sesiones_pantalla_admin" on public.sesiones_pantalla for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "auditoria_lectura" on public.auditoria for select to authenticated using (public.can_operate_compras() or public.has_role('contabilidad'));
create policy "historial_lectura" on public.requisicion_historial for select to authenticated using (
  public.is_active_user() and exists (select 1 from public.requisiciones r where r.id = requisicion_id and (
    public.can_operate_compras() or public.has_role('contabilidad') or r.solicitante_id = auth.uid()
    or exists (select 1 from public.etiquetas e where e.id = r.etiqueta_id and e.aprobador_id = auth.uid())
  ))
);

-- Service role is intentionally not represented by a client-side RLS policy: its Supabase key bypasses RLS
-- and must be used only by server-side service code. Explicitly deny anonymous direct table access.
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke all on function public.next_consecutivo(public.tipo_documento, integer) from public, anon, authenticated;
revoke all on function public.crear_requisicion_publica(uuid, text, text, text, public.tipo_requisicion, date, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.consultar_estado_requisicion_publica(uuid, text) from public, anon, authenticated;
grant execute on function public.crear_requisicion_publica(uuid, text, text, text, public.tipo_requisicion, date, text, text, jsonb) to service_role;
grant execute on function public.consultar_estado_requisicion_publica(uuid, text) to service_role;
revoke all on function public.registrar_evento_auditoria(text, uuid, text, public.origen_auditoria, jsonb) from public, anon, authenticated;
grant execute on function public.registrar_evento_auditoria(text, uuid, text, public.origen_auditoria, jsonb) to service_role;
revoke all on table public.kapso_procesamiento from public, anon, authenticated;
grant select, insert, update, delete on table public.kapso_procesamiento to authenticated;
grant all on table public.kapso_procesamiento to service_role;

-- Private storage for supports. Public forms obtain a server-created signed upload URL only after code validation.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('requisicion-adjuntos', 'requisicion-adjuntos', false, 20971520,
  array['application/pdf', 'image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create policy "mizar_storage_read" on storage.objects for select to authenticated using (
  bucket_id = 'requisicion-adjuntos' and public.is_active_user() and (public.can_operate_compras() or public.has_role('contabilidad') or owner_id = (select auth.uid()::text))
);
create policy "mizar_storage_upload" on storage.objects for insert to authenticated with check (
  bucket_id = 'requisicion-adjuntos' and public.is_active_user() and (public.can_operate_compras() or owner_id = (select auth.uid()::text))
);
create policy "mizar_storage_update" on storage.objects for update to authenticated using (
  bucket_id = 'requisicion-adjuntos' and public.is_active_user() and (public.can_operate_compras() or owner_id = (select auth.uid()::text))
) with check (
  bucket_id = 'requisicion-adjuntos' and public.is_active_user() and (public.can_operate_compras() or owner_id = (select auth.uid()::text))
);

comment on function public.crear_requisicion_publica is 'P2 provisional: enlace de obra + codigo almacenado con crypt; no expone tablas a anon.';
comment on table public.gastos_reparto is 'P3 provisional: reparto manual por montos; el trigger diferido exige suma exacta del gasto.';
comment on table public.configuracion is 'P1 provisional: solo IVA configurable hasta definir retenciones/export Helisa.';
