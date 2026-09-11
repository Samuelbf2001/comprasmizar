-- Decisión del cliente (reunión, literal): "yo digo que sea solamente una contraseña para todo el
-- mundo". El enlace del portal público SIGUE siendo por obra (obra + token HMAC en el fragmento `#`,
-- ver PUBLIC_FORM_CODE_PEPPER); lo que cambia es contra qué se compara el código que el solicitante
-- escribe: ya no es un hash por obra (`obras.public_code_hash`), sino un hash GLOBAL.
-- `public_submission_enabled` se conserva intacta: sigue decidiendo qué obras aceptan el portal —
-- solo cambia contra qué se valida el código, no quién puede usarlo.
-- Todo aditivo: no se dropea `public_code_hash` (queda obsoleta, comentada) ni ninguna tabla existente,
-- ningún ALTER TYPE ... ADD VALUE. No se toca 202608240001_core_compras.sql ni las demás migraciones.
--
-- QA Postgres real (GRAVE, bloqueante 4 del informe): la primera versión de esta migración guardaba el
-- hash dentro de `configuracion.acceso_publico_v1` (columna `valor`, jsonb). `auditoria_campo_sensible`
-- (202608240001 ~línea 708) redacta por NOMBRE DE COLUMNA, y `valor` no está en esa lista — así que
-- cada vez que `escribir_auditoria` copiaba `configuracion` antes/después de un UPDATE, el bcrypt
-- completo del PATCH de administración quedaba en texto plano dentro de `auditoria`, legible por
-- cualquier revisor/contabilidad (policy `auditoria_lectura`). Se evaluaron dos arreglos:
--   (a) añadir `(p_tabla = 'configuracion' and p_clave = 'valor')` a `auditoria_campo_sensible`: el
--       problema es que esa columna es compartida por TODAS las claves de `configuracion` — también
--       redactaría `impuestos_v1` (tasa de IVA, nada secreto) de la auditoría, perdiendo trazabilidad
--       legítima de un cambio de negocio real para tapar un secreto que ni siquiera necesita vivir ahí.
--   (b) mover el hash a su PROPIA tabla, con su PROPIA columna — la elegida. `public_code_hash` ya
--       está en la lista de campos sensibles de `auditoria_campo_sensible` desde la migración base
--       (coincide por nombre de columna, sin importar la tabla), así que nombrando la columna nueva
--       IGUAL se hereda la redacción automáticamente, sin tocar esa función ni arriesgar colateral
--       sobre `impuestos_v1` u otras claves de `configuracion` presentes o futuras.
-- Se elige (b): tabla singleton `public.acceso_publico`, columna `public_code_hash`.

-- ---------------------------------------------------------------------------
-- 1) Tabla singleton `acceso_publico`
-- ---------------------------------------------------------------------------
-- Patrón singleton: `id uuid` fijo a una constante conocida ('00000000-...-000000000001', nunca
-- otra — el `check` de abajo lo hace cumplir) en vez de `id boolean default true`. QA Postgres real:
-- la primera versión de esta migración usaba `id boolean` — y el trigger genérico `escribir_auditoria`
-- (202608240001_core_compras.sql) hace `nullif(to_jsonb(new)->>'id','')::uuid` para toda tabla
-- auditada, asumiendo que `id` siempre castea a uuid; con `id boolean` esa conversión revienta
-- (`invalid input syntax for type uuid: "true"`) en el primer INSERT/UPDATE de esta tabla. Mantener
-- `id uuid` conserva esa función compartida intacta sin necesitar un caso especial para esta tabla.
-- `public_code_hash` arranca en null: sin contraseña fijada, verificar_codigo_publico (más abajo)
-- rechaza todo por diseño en vez de "abrir" el portal por config vacía. Se fija desde la plataforma
-- (PATCH /api/public-access, lib/services/public-access-admin-service.ts vía
-- lib/infrastructure/public-access.ts), nunca por SQL manual.
create table if not exists public.acceso_publico (
  id uuid primary key default '00000000-0000-0000-0000-000000000001',
  public_code_hash text,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.usuarios(id) on delete set null,
  constraint acceso_publico_singleton check (id = '00000000-0000-0000-0000-000000000001')
);

insert into public.acceso_publico (id, public_code_hash) values ('00000000-0000-0000-0000-000000000001', null)
  on conflict (id) do nothing;

alter table public.acceso_publico enable row level security;

-- Mismo criterio de acceso que el servicio (PublicAccessAdminService.canManagePublicAccess):
-- admin_mizar o admin_sixteam. Nota honesta, igual que en el resto de este archivo: la app se conecta
-- con el service role (evade RLS); esta policy protege cualquier acceso futuro que sí use un JWT de
-- usuario final.
do $$ begin
  create policy "acceso_publico_admin" on public.acceso_publico for all to authenticated
    using (public.has_role('admin_sixteam') or public.has_role('admin_mizar'))
    with check (public.has_role('admin_sixteam') or public.has_role('admin_mizar'));
exception when duplicate_object then null; end $$;

do $$ begin
  create trigger acceso_publico_updated_at before update on public.acceso_publico
    for each row execute function public.set_updated_at();
exception when duplicate_object then null; end $$;

do $$ begin
  create trigger acceso_publico_auditoria after insert or update or delete on public.acceso_publico
    for each row execute function public.escribir_auditoria();
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- 2) obras: se relaja la constraint que exigía hash POR OBRA
-- ---------------------------------------------------------------------------
-- La constraint original ataba public_submission_enabled a un public_code_hash propio de la obra; con
-- el código global esa exigencia ya no tiene sentido — una obra puede aceptar el portal sin tener (ni
-- necesitar) su propio hash. No se dropea la columna: es una operación no aditiva que este repo evita
-- por norma, y borrar datos históricos de golpe no aporta nada frente a solo dejar de usarla.
alter table public.obras drop constraint if exists obras_codigo_publico_check;

comment on column public.obras.public_code_hash is 'OBSOLETA (202609070002): el código público pasó a ser GLOBAL. Ver public.acceso_publico y public.verificar_codigo_publico. Esta columna ya no se lee ni se escribe; se conserva solo por compatibilidad histórica con datos previos a esta migración.';

-- ---------------------------------------------------------------------------
-- 3) Verificador global
-- ---------------------------------------------------------------------------
-- security definer + search_path fijo, mismo criterio que el resto de funciones de este módulo. Sin
-- hash configurado (public_code_hash null) devuelve false SIEMPRE: una tabla vacía nunca debe
-- traducirse en "cualquier código vale". stable (no muta nada) para que el planner pueda cachearla en
-- la sentencia.
create or replace function public.verificar_codigo_publico(p_codigo text)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(
    (
      select a.public_code_hash is not null and a.public_code_hash = extensions.crypt(p_codigo, a.public_code_hash)
      from public.acceso_publico a
      where a.id = '00000000-0000-0000-0000-000000000001'
    ),
    false
  );
$$;

-- Mismo criterio que next_consecutivo: la app llama a esta función con la conexión propietaria
-- (DATABASE_URL), que conserva privilegios de dueño pese al revoke. Lo que este revoke cierra es la
-- exposición automática de PostgREST hacia anon/authenticated (como ya se hace con
-- crear_requisicion_publica/consultar_estado_requisicion_publica).
revoke all on function public.verificar_codigo_publico(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4) `crear_requisicion_publica` / `consultar_estado_requisicion_publica`: dejan de comparar contra
--    `obras.public_code_hash` (obsoleta desde el punto 2 de arriba)
-- ---------------------------------------------------------------------------
-- MENOR del informe: ninguna de las dos se invoca hoy desde ningún sitio (verificado por grep sobre
-- app/, lib/, tests/) — están revocadas de anon/authenticated desde la migración base y concedidas
-- solo a service_role, que tampoco las usa. Aun así se recrean para usar el código GLOBAL en vez de
-- dejarlas leyendo una columna ya obsoleta: una función revocada-pero-viva que sigue comparando contra
-- un hash por obra es una mina para quien la reviva más adelante sin notar que el modelo cambió — con
-- el código global, una obra sin `public_code_hash` propio (el caso normal desde esta migración)
-- rechazaría SIEMPRE, y una obra con un hash histórico residual aceptaría un código que ya no debería
-- validar nada. Reescribirlas para que usen `verificar_codigo_publico` es el mismo costo que comentar
-- "obsoleta" y evita dejar ese lodo. `create or replace` completo (no hace merge).
create or replace function public.crear_requisicion_publica(
  p_obra_id uuid, p_codigo text, p_nombre text, p_telefono text, p_tipo public.tipo_requisicion,
  p_fecha_requerida date, p_destino text, p_observaciones text, p_items jsonb
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_req uuid; v_item jsonb; v_obra_habilitada boolean; v_requiere_lista boolean; begin
  select public_submission_enabled, require_authorized_requester
    into v_obra_habilitada, v_requiere_lista
    from public.obras where id = p_obra_id and estado = 'activa';
  if coalesce(v_obra_habilitada, false) = false or not public.verificar_codigo_publico(p_codigo) then
    raise exception 'Código de obra inválido' using errcode = '28000';
  end if;
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
    and o.public_submission_enabled and public.verificar_codigo_publico(p_codigo);
$$;

comment on function public.crear_requisicion_publica is 'P2 provisional: enlace de obra + código GLOBAL (public.verificar_codigo_publico, desde 202609070002); no expone tablas a anon. No invocada actualmente (ver comentario de 202609070002_acceso_publico_global.sql).';
