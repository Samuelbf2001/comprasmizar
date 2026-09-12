-- CENTROS DE COSTO (decisión del dueño, Ernesto, 2026-09-12): «obra y centro de costo están
-- correlacionados, pero varias obras pueden ir a un centro de costo; en la requisición debe salir
-- predeterminado el centro asociado a esa obra y poder cambiarse». Aditiva e idempotente: ningún DROP
-- de columna/tabla, ningún ALTER TYPE ... ADD VALUE. No se toca ninguna migración existente.
--
-- Diseño en tres capas, cada una con su propio dueño de dato:
--   1) `centros_costo`: catálogo nuevo. `sociedad_id` NULL = centro COMPARTIDO entre empresas (p. ej.
--      "Administración" o "Gastos generales"); si viene informado, ata el centro a una sola sociedad.
--   2) `obras.centro_costo_id`: el DEFAULT de la obra — de dónde sale el centro sugerido al elegir esa
--      obra en una requisición.
--   3) `requisiciones.centro_costo_id`: el valor EFECTIVO de la requisición, editable. Nace heredado de
--      la obra (ver `resolveCostCenter` en lib/domain/rules.ts) y el revisor puede cambiarlo.
--   4) `gastos.centro_costo_id`: INSTANTÁNEA copiada al crear el gasto (generateOrders/registerPettyCash
--      vía el trigger de caja menor de abajo), NUNCA derivada en lectura — si más tarde alguien cambia
--      el centro de una requisición ya facturada, el gasto histórico no debe moverse solo. Es la misma
--      razón por la que `gastos.etiqueta_id`/`gastos.proveedor_id` ya se copian en vez de recalcularse.

-- ---------------------------------------------------------------------------
-- 1) Catálogo `centros_costo`
-- ---------------------------------------------------------------------------
create table if not exists public.centros_costo (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  codigo text,
  -- Mismo patrón que `sociedades.nit_normalizado`/`proveedores.nit_normalizado`: columna generada que
  -- ignora separadores y mayúsculas/minúsculas de verdad solo en el sentido de que compara por forma,
  -- no por texto exacto. NULL cuando no hay código (la mayoría de los centros nacidos del backfill de
  -- abajo, que nunca inventa uno) — varios NULL conviven bajo el unique index sin chocar entre sí,
  -- como ya pasa con el NIT opcional de sociedades/proveedores.
  codigo_normalizado text generated always as (nullif(regexp_replace(coalesce(codigo, ''), '[^0-9A-Za-z]', '', 'g'), '')) stored,
  -- NULL = centro COMPARTIDO entre empresas (p. ej. "Administración"). Si viene informado, debe
  -- coincidir con `requisiciones.sociedad_id` de cualquier requisición que lo use — lo exige el
  -- trigger `validar_centro_costo_requisicion` de más abajo, no una FK (una FK no puede comparar
  -- contra una columna de OTRA fila de OTRA tabla).
  sociedad_id uuid references public.sociedades(id) on delete restrict,
  activo boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint centros_costo_nombre_no_vacio check (nullif(btrim(nombre), '') is not null),
  constraint centros_costo_nombre_unico unique (nombre),
  constraint centros_costo_codigo_unico unique (codigo_normalizado)
);
comment on table public.centros_costo is
  'Centros de costo: varias obras pueden compartir uno. sociedad_id NULL = centro compartido entre empresas.';

alter table public.obras
  add column if not exists centro_costo_id uuid references public.centros_costo(id) on delete restrict;
comment on column public.obras.centro_costo_id is
  'Centro de costo DEFAULT de esta obra: de aquí sale el sugerido al elegirla en una requisición (ver resolveCostCenter).';

alter table public.requisiciones
  add column if not exists centro_costo_id uuid references public.centros_costo(id) on delete restrict;
comment on column public.requisiciones.centro_costo_id is
  'Centro de costo EFECTIVO de la requisición. Nace heredado de obras.centro_costo_id y el revisor puede cambiarlo (review()).';

alter table public.gastos
  add column if not exists centro_costo_id uuid references public.centros_costo(id) on delete restrict;
comment on column public.gastos.centro_costo_id is
  'INSTANTÁNEA copiada al crear el gasto (nunca derivada en lectura): un cambio posterior en la requisición no debe mover el histórico.';

-- ---------------------------------------------------------------------------
-- 2) Backfill: cero filas con obra o gasto sin centro al terminar
-- ---------------------------------------------------------------------------
-- Un centro por cada obra EXISTENTE, reutilizando el nombre de la obra (y su sociedad). Truco
-- deliberado: el centro nace con EL MISMO id que su obra de origen — así el UPDATE de más abajo
-- (`obras.centro_costo_id = id`) no necesita ningún join, y una segunda pasada de esta migración es
-- inerte por construcción (`on conflict (id) do nothing`). Esto es solo un atajo del backfill: un
-- centro creado después desde el catálogo nace con un uuid propio, sin relación con ninguna obra.
--
-- Disambiguación de nombre: `centros_costo.nombre` es único GLOBALMENTE, a diferencia de
-- `obras.nombre` (único solo por sociedad) — dos obras de EMPRESAS distintas con el mismo nombre
-- literal (legado real, no hipotético) chocarían contra ese unique si se insertaran tal cual. Se les
-- añade un sufijo con los ÚLTIMOS 8 caracteres de su id (no los primeros) para que el backfill nunca
-- falle por esto en vez de fusionar en silencio dos obras de dueños distintos bajo un solo centro.
-- ÚLTIMOS, no primeros, adrede: todo id de prueba de este repo (seed.sql, supabase/tests/legacy/*)
-- comparte a propósito el mismo PRIMER bloque de 8 caracteres dentro de cada namespace (p. ej.
-- "90000000-...") para agruparlos visualmente — tomar los primeros 8 habría reproducido, en el propio
-- backfill, el mismo choque de nombre que esta disambiguación existe para evitar. Se descubrió así,
-- corriendo esta migración contra Postgres real con dos obras legado homónimas (ver
-- supabase/tests/legacy/202609120001_centros_costo.pre.sql): "centros_costo_nombre_unico" saltó con
-- los dos sufijos idénticos.
insert into public.centros_costo (id, nombre, sociedad_id)
select
  o.id,
  case when count(*) over (partition by o.nombre) > 1
    then o.nombre || ' (' || right(o.id::text, 8) || ')'
    else o.nombre
  end,
  o.sociedad_id
from public.obras o
on conflict (id) do nothing;

update public.obras set centro_costo_id = id where centro_costo_id is null;

-- Requisiciones: heredan el centro de SU obra. Las que no tienen obra (corporativas, o el tramo
-- público antes de que el revisor asigne obra) quedan sin centro a propósito — no hay de dónde
-- derivarlo, y no es la obligación que pide el negocio ("ninguna requisición CON OBRA" queda sin centro).
update public.requisiciones r
   set centro_costo_id = o.centro_costo_id
  from public.obras o
 where o.id = r.obra_id
   and r.obra_id is not null
   and r.centro_costo_id is null;

-- Gastos: derivan del centro de SU obra (`gastos.obra_id` es NOT NULL desde la migración base, tanto
-- para origen 'requisicion' como 'caja_menor') — cubre ambos orígenes con un único UPDATE, sin
-- necesitar un camino aparte por caja menor.
update public.gastos g
   set centro_costo_id = o.centro_costo_id
  from public.obras o
 where o.id = g.obra_id
   and g.centro_costo_id is null;

-- Guardián del propio backfill: si algo de lo de arriba se queda corto, la migración falla aquí y
-- ahora, en vez de dejar una base a medias que solo se descubre semanas después mirando un reporte.
do $$
declare v_requisiciones_sin_centro integer; v_gastos_sin_centro integer;
begin
  select count(*) into v_requisiciones_sin_centro from public.requisiciones where obra_id is not null and centro_costo_id is null;
  select count(*) into v_gastos_sin_centro from public.gastos where centro_costo_id is null;
  if v_requisiciones_sin_centro > 0 or v_gastos_sin_centro > 0 then
    raise exception 'Backfill de centros de costo incompleto: % requisición(es) con obra y % gasto(s) siguen sin centro',
      v_requisiciones_sin_centro, v_gastos_sin_centro;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3) Validación: centro activo y coherente con la sociedad de la requisición
-- ---------------------------------------------------------------------------
-- Hermano de `validar_catalogos_activos_requisicion` (mismo criterio de "activo" que obra/etiqueta/
-- solicitante), pero AISLADO en su propio trigger en vez de crecer aquella función: esta migración no
-- reescribe una función de otra ya aplicada — la extiende con una nueva, más fácil de auditar sola.
create or replace function public.validar_centro_costo_requisicion()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_activo boolean; v_sociedad_id uuid; begin
  if new.centro_costo_id is null then return new; end if;
  select activo, sociedad_id into v_activo, v_sociedad_id from public.centros_costo where id = new.centro_costo_id;
  if not found or not v_activo then
    raise exception 'El centro de costo de una requisición nueva o reasignada debe existir y estar activo' using errcode = '23514';
  end if;
  -- sociedad_id NULL en el centro = compartido entre empresas: no hay nada que comparar.
  if v_sociedad_id is not null and v_sociedad_id is distinct from new.sociedad_id then
    raise exception 'El centro de costo no pertenece a la sociedad de la requisición' using errcode = '23514';
  end if;
  return new;
end; $$;

-- Nombre SIN el prefijo "0_": a diferencia de `requisiciones_0_derivar_sociedad`, este trigger no
-- necesita correr antes que nadie — solo necesita que `new.sociedad_id` ya esté resuelto, y ese
-- trigger (que sí lleva el prefijo "0_" para ir primero) se dispara antes por orden alfabético
-- ("0" < cualquier letra) dentro del mismo evento BEFORE INSERT.
drop trigger if exists requisiciones_centro_costo_activo on public.requisiciones;
create trigger requisiciones_centro_costo_activo
  before insert or update of centro_costo_id, sociedad_id on public.requisiciones
  for each row execute function public.validar_centro_costo_requisicion();

-- ---------------------------------------------------------------------------
-- 4) Caja menor: el gasto que genera hereda el centro de SU obra, igual que en el backfill
-- ---------------------------------------------------------------------------
-- Reescritura completa (no merge) de `sincronizar_gasto_caja_menor`. OJO al reescribirla de nuevo en el
-- futuro: la versión vigente de esta función NO es la de 202608240001_core_compras.sql (esa es la
-- ORIGINAL, sin `fecha_orden`) sino la que dejó 202609070003_gasto_fecha_pago.sql, que ya añadió
-- `fecha_orden` (nace con el registro) separada de `fecha` (fecha de PAGO; la caja menor se paga en el
-- acto, así que ambas siempre coinciden). Este archivo reproduce ESA versión completa y le suma
-- `centro_costo_id`: caja menor no tiene noción propia de centro de costo (no hay requisición de la que
-- heredar un valor EFECTIVO editable, ver el punto 1 de este archivo) — su gasto simplemente copia el
-- centro configurado en la obra, tanto al nacer como en cada edición posterior del movimiento.
create or replace function public.sincronizar_gasto_caja_menor()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_gasto uuid; v_centro_costo_id uuid; begin
  select centro_costo_id into v_centro_costo_id from public.obras where id = new.obra_id;
  if tg_op = 'INSERT' then
    insert into public.gastos(obra_id, origen, referencia_id, etiqueta_id, proveedor_id, fecha_orden, fecha, valor_base, iva, centro_costo_id)
    values (new.obra_id, 'caja_menor', new.id, new.etiqueta_id, new.proveedor_id, new.fecha, new.fecha, new.valor, 0, v_centro_costo_id)
    returning id into v_gasto;
    new.gasto_id := v_gasto;
  elsif new.gasto_id is not null then
    update public.gastos set obra_id = new.obra_id, etiqueta_id = new.etiqueta_id, proveedor_id = new.proveedor_id,
      fecha_orden = new.fecha, fecha = new.fecha, valor_base = new.valor, iva = 0, centro_costo_id = v_centro_costo_id where id = new.gasto_id;
  end if;
  return new;
end; $$;

-- ---------------------------------------------------------------------------
-- 5) Vista `gasto_distribucion`: se extiende con `centro_costo_id`
-- ---------------------------------------------------------------------------
-- El centro es un atributo del GASTO, no de cada obra repartida: en la rama de `gastos_reparto` se
-- sigue leyendo `g.centro_costo_id` (del gasto padre), no uno por obra repartida — no existe tal
-- cosa. CREATE OR REPLACE VIEW admite añadir columnas al final sin romper lo existente.
create or replace view public.gasto_distribucion with (security_invoker = true) as
  select g.id as gasto_id, g.obra_id, g.fecha, g.periodo, g.etiqueta_id, g.proveedor_id, g.origen, g.valor_total as valor, g.centro_costo_id
  from public.gastos g where not exists (select 1 from public.gastos_reparto gr where gr.gasto_id = g.id)
  union all
  select g.id, gr.obra_id, g.fecha, g.periodo, g.etiqueta_id, g.proveedor_id, g.origen, gr.valor, g.centro_costo_id
  from public.gastos g join public.gastos_reparto gr on gr.gasto_id = g.id;

-- ---------------------------------------------------------------------------
-- 6) Índices
-- ---------------------------------------------------------------------------
create index if not exists gastos_centro_costo_periodo_idx on public.gastos(centro_costo_id, periodo);
create index if not exists gastos_centro_costo_fecha_idx on public.gastos(centro_costo_id, fecha);
create index if not exists centros_costo_activos_busqueda_idx on public.centros_costo(nombre) where activo;
create index if not exists obras_centro_costo_idx on public.obras(centro_costo_id);
create index if not exists requisiciones_centro_costo_idx on public.requisiciones(centro_costo_id) where centro_costo_id is not null;

-- ---------------------------------------------------------------------------
-- 7) Triggers estándar (set_updated_at / escribir_auditoria / bloquear_eliminacion_catalogo):
--    reutilizan las funciones ya existentes (definidas en 202608240001_core_compras.sql). El loop que
--    las aplica a la lista de catálogos YA CORRIÓ en esa migración aplicada; aquí se añaden a mano con
--    el mismo patrón idempotente que usó 202609010001 para `solicitantes_autorizados`.
-- ---------------------------------------------------------------------------
do $$ begin
  create trigger centros_costo_updated_at before update on public.centros_costo
    for each row execute function public.set_updated_at();
exception when duplicate_object then null; end $$;
do $$ begin
  create trigger centros_costo_auditoria after insert or update or delete on public.centros_costo
    for each row execute function public.escribir_auditoria();
exception when duplicate_object then null; end $$;
do $$ begin
  create trigger centros_costo_sin_borrado_fisico before delete on public.centros_costo
    for each row execute function public.bloquear_eliminacion_catalogo();
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- 8) RLS: copia exacta del criterio de `obras` (lectura para cualquier usuario activo, escritura solo
--    para quien administra catálogos) — mismo nivel de exposición que el resto de catálogos maestros.
-- ---------------------------------------------------------------------------
alter table public.centros_costo enable row level security;
do $$ begin
  create policy "centros_costo_lectura" on public.centros_costo for select to authenticated using (public.is_active_user());
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "centros_costo_admin" on public.centros_costo for all to authenticated using (public.can_manage_catalogos()) with check (public.can_manage_catalogos());
exception when duplicate_object then null; end $$;
revoke all on public.centros_costo from anon;
