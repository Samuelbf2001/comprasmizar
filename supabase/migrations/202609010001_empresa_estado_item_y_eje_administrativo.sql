-- Fase 1 de la reunión 2026-08-31: empresa (sociedad) vs obra en requisiciones,
-- estado por ítem, eje administrativo de órdenes, tasas de IVA/descuento,
-- antifraude de doble orden y lista blanca global de solicitantes.
-- Todo aditivo: ningún DROP de columna/tabla, ningún ALTER TYPE ... ADD VALUE.
-- No se toca 202608240001_core_compras.sql ni las otras dos migraciones existentes.

-- ---------------------------------------------------------------------------
-- 1) Enums nuevos
-- ---------------------------------------------------------------------------
do $$ begin
  create type public.estado_item_requisicion as enum ('pendiente', 'aprobado', 'declinado');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.estado_administrativo_orden as enum ('pendiente', 'contabilizada', 'pagada');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- 2) requisiciones: sociedad (empresa) vs obra
-- ---------------------------------------------------------------------------
-- La reunión pide que una requisición pertenezca a una sociedad (empresa) y no
-- solo a una obra: hoy `obra_id` es NOT NULL y la sociedad se infiere siempre a
-- través de la obra. Se añade `sociedad_id` explícita y se vuelve `obra_id`
-- opcional (una requisición "corporativa" sin obra concreta).
alter table public.requisiciones
  add column if not exists sociedad_id uuid references public.sociedades(id) on delete restrict;

-- Backfill: en este punto obra_id sigue siendo NOT NULL (el DROP NOT NULL va
-- después), así que esta actualización cubre el 100% de las filas existentes.
update public.requisiciones r
   set sociedad_id = o.sociedad_id
  from public.obras o
 where o.id = r.obra_id
   and r.sociedad_id is null;

alter table public.requisiciones alter column sociedad_id set not null;
alter table public.requisiciones alter column obra_id drop not null;

-- Forma de pago: la captura el revisor en review() (junto con la obra) y debe viajar a cada orden que
-- se genere después — `ordenes.forma_pago` ya existe más abajo en esta misma migración, esta es su
-- equivalente en la cabecera. Sin columna propia aquí, el dato se perdía entre revisar() y
-- generateOrders() y el servicio lo reconstruía leyendo el evento "revisada" de auditoría, que es solo
-- una traza append-only para trazabilidad y nunca debe ser la fuente de verdad de un dato de negocio.
alter table public.requisiciones add column if not exists forma_pago text;

-- Trampa evitada: schema_verification.sql, generic_attachments_verification.sql y
-- supplier_documents_verification.sql tienen más de una decena de
-- `insert into requisiciones(...)` que solo pasan obra_id (nunca sociedad_id) y
-- que tenemos prohibido reescribir. Con sociedad_id NOT NULL sin más, todas esas
-- inserciones romperían con 23502. La solución es este trigger BEFORE INSERT:
-- si llega sociedad_id NULL con obra_id presente, la deriva de obras.sociedad_id.
-- No es solo un parche de test: es el mecanismo permanente que necesitan el
-- portal público (`crear_requisicion_publica`) y cualquier alta legacy, que
-- siguen ancladas a la obra y nunca capturan sociedad explícita.
--
-- Nombre `requisiciones_0_derivar_sociedad`: Postgres dispara los triggers
-- BEFORE del mismo evento en orden alfabético por nombre, no por orden de
-- creación. Este trigger debe ejecutarse antes que
-- `requisiciones_catalogos_activos` (que valida sociedad/obra activas y su
-- coherencia) para que NEW.sociedad_id ya esté poblado cuando esa validación
-- corra. El prefijo "0" ordena antes que la "c" de "catalogos_activos": no
-- renombrar sin conservar ese orden.
create or replace function public.derivar_sociedad_requisicion()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.sociedad_id is null and new.obra_id is not null then
    select o.sociedad_id into new.sociedad_id from public.obras o where o.id = new.obra_id;
  end if;
  return new;
end; $$;

drop trigger if exists requisiciones_0_derivar_sociedad on public.requisiciones;
create trigger requisiciones_0_derivar_sociedad
  before insert on public.requisiciones
  for each row execute function public.derivar_sociedad_requisicion();

-- Reescritura completa (no merge) de la validación de catálogos activos de
-- requisiciones: ahora tolera obra_id NULL, valida que la sociedad esté activa
-- (antes se validaba únicamente vía obra) y, cuando ambas están presentes,
-- exige que la obra pertenezca exactamente a la sociedad de la requisición.
create or replace function public.validar_catalogos_activos_requisicion()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_sociedad_activa boolean;
  v_obra_activa boolean;
  v_obra_sociedad_id uuid;
  v_etiqueta_activa boolean;
  v_solicitante_activo boolean;
begin
  select s.activa into v_sociedad_activa from public.sociedades s where s.id = new.sociedad_id;
  if coalesce(v_sociedad_activa, false) = false then
    raise exception 'La sociedad de una requisición nueva o reasignada debe estar activa' using errcode = '23514';
  end if;

  if new.obra_id is not null then
    select o.estado = 'activa', o.sociedad_id into v_obra_activa, v_obra_sociedad_id
      from public.obras o where o.id = new.obra_id;
    if coalesce(v_obra_activa, false) = false then
      raise exception 'La obra de una requisición nueva o reasignada debe estar activa' using errcode = '23514';
    end if;
    if v_obra_sociedad_id is distinct from new.sociedad_id then
      raise exception 'La obra asignada no pertenece a la sociedad de la requisición' using errcode = '23514';
    end if;
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

-- Se recrea el trigger para que también dispare al cambiar sociedad_id (antes
-- solo escuchaba obra_id/etiqueta_id/solicitante_id).
drop trigger if exists requisiciones_catalogos_activos on public.requisiciones;
create trigger requisiciones_catalogos_activos
  before insert or update of obra_id, sociedad_id, etiqueta_id, solicitante_id
  on public.requisiciones for each row execute function public.validar_catalogos_activos_requisicion();

-- Nota: la regla de negocio "gastos.obra_id obligatoria al enviar a aprobación"
-- no se toca aquí; vive en el servicio de dominio (fuera de esta migración).

-- ---------------------------------------------------------------------------
-- 3) Estado por ítem de requisición
-- ---------------------------------------------------------------------------
alter table public.requisicion_items
  add column if not exists estado public.estado_item_requisicion not null default 'pendiente',
  add column if not exists motivo_declinacion text;

-- add column if not exists ... check(...) es atómico: si la columna ya existe,
-- toda la cláusula (incluido el nombre de constraint) se omite sin duplicar.
do $$ begin
  alter table public.requisicion_items
    add constraint requisicion_items_motivo_declinacion_check check (
      estado <> 'declinado' or nullif(btrim(motivo_declinacion), '') is not null
    );
exception when duplicate_object then null; end $$;

-- Sin decidido_por/decidido_at: el trigger escribir_auditoria (ya extendido a
-- requisicion_items desde la migración base) cubre la trazabilidad de quién y
-- cuándo cambió el estado.

-- ---------------------------------------------------------------------------
-- 4) Eje administrativo de órdenes (contable/pago), independiente del
--    cumplimiento operativo (estado_cumplimiento no se toca)
-- ---------------------------------------------------------------------------
alter table public.ordenes
  add column if not exists estado_administrativo public.estado_administrativo_orden not null default 'pendiente',
  add column if not exists contabilizada_at timestamptz,
  add column if not exists pagada_at timestamptz,
  add column if not exists forma_pago text;

-- Deliberadamente no se añade aquí un check que ate estado_administrativo a
-- contabilizada_at/pagada_at (p.ej. "contabilizada => contabilizada_at not
-- null"): la invariante de orden entre transiciones administrativas vive en el
-- dominio (assertAdminTransition), igual que se decidió para iva/iva_tasa.

-- ---------------------------------------------------------------------------
-- 5) IVA y descuento como tasa (fracción 0..1, no puntos porcentuales)
-- ---------------------------------------------------------------------------
-- Bloqueante QA (Postgres real): iva_tasa se deja NULLABLE, SIN default, a propósito.
-- "0" y "sin capturar" son estados distintos: una línea legacy cuya razón iva/valor_base no
-- coincide con ninguna tasa colombiana conocida NO tiene una tasa de 0%, tiene una tasa
-- DESCONOCIDA. Con `not null default 0` (como se declaró originalmente) esa distinción se pierde
-- en el propio esquema: el mapeador Postgres (lib/infrastructure/postgres-repositories.ts) nunca
-- podía leer NULL y la defensa IVA legacy de ProcurementService.review() (que solo actúa cuando
-- la línea entrante no trae ivaRate) terminaba restaurando una tasa 0 "real" -> calculateLineAmounts
-- toma la vía de tasa con esa tasa y el IVA se evapora en silencio. Nullable + sin default resuelve
-- esto de raíz: NULL siempre significa "tasa no capturada", nunca "tasa 0%".
-- descuento_tasa NO cambia: el mismo bug no aplica ahí (no hay defensa "legacy" análoga para
-- descuento en el dominio), así que se mantiene su default 0 original.
alter table public.requisicion_items
  add column if not exists iva_tasa numeric(5,4)
    constraint requisicion_items_iva_tasa_rango check (iva_tasa is null or (iva_tasa >= 0 and iva_tasa <= 1)),
  add column if not exists descuento_tasa numeric(5,4) not null default 0
    constraint requisicion_items_descuento_tasa_rango check (descuento_tasa >= 0 and descuento_tasa <= 1);

-- Backfill obligatorio pero conservador: solo se completa iva_tasa cuando la
-- razón iva/valor_base coincide exactamente con una tasa colombiana conocida
-- (5% o 19%). Filas con otra proporción (redondeos históricos, datos sucios) se
-- quedan en NULL (nunca en 0: eso inventaría una tasa 0% que no consta en el
-- dato original) — la columna ya nace en NULL para toda fila que este UPDATE no toque, al no
-- tener default. No hay check que ate iva a iva_tasa precisamente porque el histórico no
-- siempre cuadra.
update public.requisicion_items
   set iva_tasa = round(iva / valor_base, 4)
 where valor_base > 0 and round(iva / valor_base, 4) in (0.0500, 0.1900);

-- ---------------------------------------------------------------------------
-- 6) Antifraude: una sola orden por requisición+proveedor
-- ---------------------------------------------------------------------------
create unique index if not exists ordenes_una_por_requisicion_proveedor
  on public.ordenes (requisicion_id, coalesce(proveedor_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- ---------------------------------------------------------------------------
-- 7) Lista blanca global de solicitantes autorizados
-- ---------------------------------------------------------------------------
-- GRAVE 2 (QA Postgres real): la normalización original solo quitaba los no-dígitos, así que
-- "3001112233" (10 dígitos, sin indicativo) y "+57 300 111 2233"/"573001112233" (con indicativo)
-- producían DOS filas distintas ("3001112233" vs "573001112233"). WhatsApp siempre entrega el
-- remitente en E.164 (con indicativo), así que todo número cargado sin "+57" quedaba fuera del
-- canal en silencio (unauthorized_requester). `normalizar_telefono_co` homologa las tres formas al
-- mismo E.164 sin "+": un número local de 10 dígitos (móvil colombiano) se le antepone "57";
-- cualquier otro largo (ya con indicativo, o un formato ajeno que esta plataforma no intenta
-- adivinar) se deja tal cual, solo sin los no-dígitos. `lib/infrastructure/public-access.ts` debe
-- aplicar EXACTAMENTE el mismo criterio al comparar el remitente entrante contra esta columna.
create or replace function public.normalizar_telefono_co(p_telefono text)
returns text language sql immutable as $$
  select case
    when length(regexp_replace(p_telefono, '[^0-9]', '', 'g')) = 10
      then '57' || regexp_replace(p_telefono, '[^0-9]', '', 'g')
    else regexp_replace(p_telefono, '[^0-9]', '', 'g')
  end;
$$;

-- Mismo patrón que obra_solicitantes_autorizados (normalización de teléfono,
-- unique, auditoría, baja reversible, RLS), pero sin obra_id: es la lista
-- blanca a nivel de toda la plataforma. obra_solicitantes_autorizados se
-- conserva intacta porque el portal público (anclado a la obra) sigue
-- usándola, y NO se toca aquí: es una tabla de una migración ya aplicada, y su
-- corrección (si alguna vez hace falta) requeriría su propia migración nueva.
create table if not exists public.solicitantes_autorizados (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  telefono text not null,
  telefono_normalizado text generated always as (public.normalizar_telefono_co(telefono)) stored,
  activo boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint solicitantes_autorizados_telefono_no_vacio check (telefono_normalizado <> ''),
  constraint solicitantes_autorizados_telefono_unico unique (telefono_normalizado)
);

-- Migra deduplicando por teléfono normalizado: si el mismo teléfono estaba
-- autorizado en varias obras, sobrevive activo=true si lo era en alguna.
-- Deliberadamente se agrupa con `normalizar_telefono_co(telefono)` (la normalización NUEVA), no con
-- la columna `telefono_normalizado` de la tabla vieja (que solo quita no-dígitos): si ese mismo
-- teléfono estaba cargado en dos obras distintas con y sin indicativo, la columna vieja los vería
-- como dos grupos distintos y el `on conflict do nothing` de abajo dejaría sobrevivir uno al azar
-- (posiblemente el inactivo) en vez de fusionarlos de verdad — justo la deduplicación que este
-- backfill dice preservar.
insert into public.solicitantes_autorizados (nombre, telefono, activo)
select nombre, telefono, activo
from (
  select
    nombre, telefono, public.normalizar_telefono_co(telefono) as telefono_normalizado,
    bool_or(activo) over (partition by public.normalizar_telefono_co(telefono)) as activo,
    row_number() over (
      partition by public.normalizar_telefono_co(telefono) order by activo desc, created_at desc, id
    ) as rn
  from public.obra_solicitantes_autorizados
) dedup
where rn = 1
on conflict (telefono_normalizado) do nothing;

alter table public.solicitantes_autorizados enable row level security;

-- Mismo trato de acceso que la tabla vieja: lectura para quien opera compras o
-- administra catálogos, escritura solo para quien administra catálogos.
-- MENOR (QA Postgres real): "create policy" no es idempotente por sí solo (una segunda pasada de
-- esta migración fallaba con "policy already exists"); se envuelve en el mismo patrón
-- do $$ ... exception when duplicate_object then null; end $$ que ya usa el resto del archivo
-- para los tipos enum.
do $$ begin
  create policy "solicitantes_autorizados_lectura_operativa" on public.solicitantes_autorizados
    for select to authenticated using (public.can_operate_compras() or public.can_manage_catalogos());
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "solicitantes_autorizados_admin_catalogos" on public.solicitantes_autorizados
    for all to authenticated using (public.can_manage_catalogos()) with check (public.can_manage_catalogos());
exception when duplicate_object then null; end $$;

revoke all on public.solicitantes_autorizados from anon;

create index if not exists solicitantes_autorizados_activos_idx
  on public.solicitantes_autorizados(telefono_normalizado) where activo;

-- MENOR (QA Postgres real): mismo problema de idempotencia que las policies de arriba —
-- "create trigger" sin guarda falla en una segunda pasada ("trigger already exists").
do $$ begin
  create trigger solicitantes_autorizados_updated_at before update on public.solicitantes_autorizados
    for each row execute function public.set_updated_at();
exception when duplicate_object then null; end $$;
do $$ begin
  create trigger solicitantes_autorizados_auditoria after insert or update or delete on public.solicitantes_autorizados
    for each row execute function public.escribir_auditoria();
exception when duplicate_object then null; end $$;
do $$ begin
  create trigger solicitantes_autorizados_sin_borrado_fisico before delete on public.solicitantes_autorizados
    for each row execute function public.bloquear_eliminacion_catalogo();
exception when duplicate_object then null; end $$;

-- auditoria_campo_sensible se reemplaza completa (create or replace no hace
-- merge): se reproduce el cuerpo vigente tras la migración 002 (incluye el
-- caso `adjuntos`) y se añade el caso nuevo para la tabla de lista blanca
-- global, con el mismo criterio que su equivalente por obra.
create or replace function public.auditoria_campo_sensible(p_tabla text, p_clave text)
returns boolean language sql immutable set search_path = public as $$
  select p_clave = any(array[
    'password', 'key_hash', 'token_hash', 'public_code_hash', 'payload', 'payload_json',
    'datos_bancarios', 'contacto', 'telefono', 'telefono_destino', 'email', 'observaciones'
  ])
  or (p_tabla = 'requisiciones' and p_clave = any(array['solicitante_nombre_externo', 'solicitante_telefono_externo']))
  or (p_tabla = 'obra_solicitantes_autorizados' and p_clave = any(array['nombre', 'telefono_normalizado']))
  or (p_tabla = 'solicitantes_autorizados' and p_clave = any(array['nombre', 'telefono_normalizado']))
  or (p_tabla = 'usuarios' and p_clave = 'nombre')
  or (p_tabla = 'whatsapp_eventos' and p_clave = any(array['telefono', 'kapso_message_id']))
  or (p_tabla = 'adjuntos' and p_clave = any(array['url_storage', 'nombre_original', 'checksum_sha256', 'mime_type']));
$$;

-- ---------------------------------------------------------------------------
-- 8) Podas sin DROP
-- ---------------------------------------------------------------------------
-- `destino` queda obsoleto y se fusiona en `observaciones` antes de dejar de
-- usarse; no se elimina la columna para no romper filas históricas ni el
-- contrato de crear_requisicion_publica, que sigue escribiéndola.
-- MENOR (QA Postgres real): sin la segunda condición, una segunda pasada de esta migración
-- volvería a anteponer `destino` a `observaciones` (que ya lo tiene desde la primera pasada),
-- duplicando el texto. Como `destino` nunca se limpia (columna conservada a propósito, ver
-- comentario debajo), no hay forma de detectar "ya migrado" salvo mirar si `observaciones` YA
-- empieza por ese mismo valor — si es así, se salta la fila.
update public.requisiciones
   set observaciones = concat_ws(' · ', nullif(btrim(destino), ''), observaciones)
 where nullif(btrim(destino), '') is not null
   and coalesce(observaciones, '') not like (btrim(destino) || '%');
comment on column public.requisiciones.destino is 'Obsoleto desde 2026-09: fusionado en observaciones. No escribir ni leer.';

-- La generación de órdenes agrupa siempre por proveedor: el módulo
-- ordenes_multi_proveedor queda obsoleto, pero conserva su fila en `modulos`
-- (no se borra) para no romper cualquier lectura defensiva existente.
update public.modulos
   set descripcion = '(obsoleto) La generación de órdenes agrupa siempre por proveedor'
 where nombre = 'ordenes_multi_proveedor';
