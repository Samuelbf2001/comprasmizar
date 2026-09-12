-- CAJAS, INGRESOS Y CIERRES MENSUALES (cliente, 11-sep-2026, reunión con Ernesto): «TODOS los gastos
-- (cajas, bancos, personales) quedan en el sistema por centro de costo; Daniel cierra la caja
-- administrativa a inicio de mes e ingresa esos gastos para el reporte; cruce de ingresos/salidas».
--
-- Aditiva e idempotente: ningún DROP de columna/tabla, ningún ALTER TYPE ... ADD VALUE (los dos enums
-- nuevos, `tipo_caja` y `estado_cierre`, nacen COMPLETOS con `create type ... as enum (...)`, igual que
-- `medio_pago` en 202609120002_pagos_orden.sql). No se toca ninguna migración existente: `caja_menor` y
-- `gastos` solo GANAN columnas nuevas (todas NULLABLE, sin backfill que las obligue), y
-- `sincronizar_gasto_caja_menor` se REESCRIBE completa (no merge) a partir de su versión VIGENTE — la
-- que dejó 202609120001_centros_costo.sql, no la original de 202608240001_core_compras.sql.
--
-- Diseño en cuatro piezas:
--   1) `cajas`: catálogo nuevo de "dónde vive la plata" — caja menor de obra, caja administrativa,
--      cuenta de banco o caja personal. Administrado como cualquier otro catálogo (CatalogService,
--      kind "cashBoxes"), RLS igual que `centros_costo`.
--   2) `caja_menor` (ya existía, RF-caja menor de obra) gana `caja_id` (a qué caja pertenece este
--      movimiento — todo movimiento HISTÓRICO se backfillea a una caja "Caja menor" nueva, para que
--      "todo gasto de caja" siga viviendo en la misma tabla que ya sincroniza su gasto), `medio_pago`
--      (reutiliza el enum de 202609120002), `iva` (hasta hoy el trigger forzaba 0: un gasto directo de
--      caja SÍ puede llevar IVA) y `cierre_id` (a qué cierre mensual quedó atado, si alguno).
--   3) `ingresos`: tabla NUEVA y APARTE — nunca un gasto en negativo. Mismas columnas de contexto que
--      `caja_menor`/`gastos` (caja, centro de costo, obra opcional, medio de pago, quién registra) más
--      `tercero` (de quién viene el ingreso) y el mismo `periodo` generado que ya usa `gastos`.
--   4) `cierres_caja`: un cierre por (caja, mes). El trigger `validar_periodo_caja_abierto` (aplicado a
--      `caja_menor` e `ingresos`) rechaza cualquier alta o edición de un movimiento cuya fecha caiga en
--      un periodo YA cerrado para esa caja — así el cierre es de verdad un corte, no una etiqueta que
--      cualquiera puede seguir moviendo por debajo.
--   5) Vista `movimientos_centro_costo`: el cruce de ingresos (+) y gastos (−) por centro de costo que
--      pide el reporte, sin que cada consulta tenga que rearmar el `union all` a mano.
--
-- DECISIÓN DE ALCANCE (no tocar `obra_id`): `caja_menor.obra_id` y `gastos.obra_id` siguen NOT NULL,
-- sin relajar — aunque el enunciado describe un formulario de "gasto directo" con centro de costo
-- "predeterminado el de la obra SI SE ELIGE obra" (dando a entender que la obra sería opcional).
-- Relajar esa restricción exige propagar `workId?: string | undefined` (en vez de `string`) por
-- `Expense`/`PettyCash` y TODO lo que ya asume que un gasto siempre tiene obra (reports.tsx, orders.tsx,
-- detail.tsx, el propio `order(row)` de postgres-repositories.ts) — exactamente los archivos que este
-- encargo prohíbe tocar salvo la pestaña «Cajas» de catalog-admin.tsx. La obra sigue siendo obligatoria
-- para CUALQUIER movimiento de caja (menor, administrativa, banco o personal): el centro de costo
-- efectivo sigue derivándose de esa obra, exactamente como ya lo hacía `sincronizar_gasto_caja_menor`
-- desde 202609120001. Un "gasto directo" sin obra queda fuera de esta v1 (ver informe de la tarea).

-- ---------------------------------------------------------------------------
-- 1) Enums nuevos
-- ---------------------------------------------------------------------------
do $$ begin
  create type public.tipo_caja as enum ('caja_menor', 'administrativa', 'banco', 'personal');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.estado_cierre as enum ('abierto', 'cerrado');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- 2) Catálogo `cajas`
-- ---------------------------------------------------------------------------
-- `centro_costo_id`: centro DEFAULT de esta caja (mismo patrón que `obras.centro_costo_id` en
-- 202609120001) — únicamente informativo hoy, para cuando el formulario de "Cajas" quiera sugerir uno;
-- ningún movimiento lo hereda todavía porque el centro efectivo de caja_menor sigue viniendo de la obra
-- (ver el aviso de alcance arriba). `sociedad_id` NULL = caja compartida entre empresas (p. ej. una
-- cuenta de banco corporativa), mismo criterio que `centros_costo.sociedad_id`.
create table if not exists public.cajas (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  tipo public.tipo_caja not null,
  sociedad_id uuid references public.sociedades(id) on delete restrict,
  centro_costo_id uuid references public.centros_costo(id) on delete restrict,
  activo boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint cajas_nombre_no_vacio check (nullif(btrim(nombre), '') is not null),
  constraint cajas_nombre_unico unique (nombre)
);
comment on table public.cajas is
  'Catálogo de cajas: dónde vive la plata (caja menor de obra, administrativa, banco o personal). '
  'Todo movimiento de caja_menor/ingresos apunta a una fila de aquí.';

-- Backfill: una caja "Caja menor" por defecto para las filas de `caja_menor` que ya existían antes de
-- esta migración (idempotente por `on conflict (nombre)`, igual que el centro por obra de
-- 202609120001: una segunda corrida no duplica la caja ni reasigna nada).
insert into public.cajas (nombre, tipo)
values ('Caja menor', 'caja_menor')
on conflict (nombre) do nothing;

-- ---------------------------------------------------------------------------
-- 3) `caja_menor` gana caja_id, medio_pago, iva, cierre_id (cierre_id con su FK más abajo, después de
--    crear `cierres_caja` — no se puede referenciar una tabla que todavía no existe).
-- ---------------------------------------------------------------------------
alter table public.caja_menor add column if not exists caja_id uuid references public.cajas(id) on delete restrict;
comment on column public.caja_menor.caja_id is
  'A qué caja pertenece este movimiento. Backfill: todas las filas existentes a "Caja menor" (ver arriba).';

-- `medio_pago` (2026-09-12): YA existe como tipo desde 202609120002_pagos_orden.sql, se reutiliza tal
-- cual (mismo criterio que reutilizar `origen_gasto`/`estado_orden` en vez de crear un enum paralelo).
-- Backfill a 'efectivo' (punto 7b más abajo, DESPUÉS de reescribir sincronizar_gasto_caja_menor): una
-- caja MENOR históricamente solo se pagaba en efectivo (no había otro medio que capturar); es una
-- suposición de dominio explícita, no un valor arbitrario.
alter table public.caja_menor add column if not exists medio_pago public.medio_pago;

-- `iva` (2026-09-12): hasta esta migración `sincronizar_gasto_caja_menor` forzaba `iva = 0` en el gasto
-- generado — un gasto de caja SÍ puede llevar IVA (p. ej. una factura de ferretería pagada de caja
-- menor). `default 0`: un movimiento sin IVA capturado (todo lo histórico) sigue leyéndose como 0, sin
-- backfill necesario. Mismo molde `numeric(16,2)` con `= trunc(...)` que el resto de columnas de dinero.
alter table public.caja_menor add column if not exists iva numeric(16,2) not null default 0 check (iva >= 0 and iva = trunc(iva));

-- ---------------------------------------------------------------------------
-- 4) `gastos` gana caja_id, concepto, medio_pago, registrado_por, cierre_id — todas NULLABLE: un gasto
--    de origen 'requisicion' no tiene ni caja ni medio de pago ni registrador propio (nace de una
--    orden), y solo un gasto de origen 'caja_menor' las trae, copiadas por el trigger de más abajo.
-- ---------------------------------------------------------------------------
alter table public.gastos add column if not exists caja_id uuid references public.cajas(id) on delete restrict;
alter table public.gastos add column if not exists concepto text;
alter table public.gastos add column if not exists medio_pago public.medio_pago;
alter table public.gastos add column if not exists registrado_por uuid references public.usuarios(id) on delete set null;
comment on column public.gastos.caja_id is 'Copia de caja_menor.caja_id (origen caja_menor). NULL en origen requisicion.';
comment on column public.gastos.concepto is 'Copia de caja_menor.concepto, para que la pantalla "Gastos y caja" muestre una descripción sin ir a buscarla a otra tabla.';
comment on column public.gastos.medio_pago is 'Copia de caja_menor.medio_pago. NULL en origen requisicion (una orden no tiene un único medio de pago: se paga con pagos_orden, cada uno con el suyo).';
comment on column public.gastos.registrado_por is 'Copia de caja_menor.registrado_por: quién dio de alta el movimiento de caja que generó este gasto.';

-- ---------------------------------------------------------------------------
-- 5) `ingresos`: tabla NUEVA y APARTE de `gastos` — nunca un gasto en negativo. Mismo molde de
--    columnas de dinero/fecha que `gastos`/`caja_menor` (numeric(16,2) entero, periodo generado).
-- ---------------------------------------------------------------------------
create table if not exists public.ingresos (
  id uuid primary key default gen_random_uuid(),
  caja_id uuid not null references public.cajas(id) on delete restrict,
  centro_costo_id uuid not null references public.centros_costo(id) on delete restrict,
  obra_id uuid references public.obras(id) on delete restrict,
  fecha date not null,
  concepto text not null check (nullif(btrim(concepto), '') is not null),
  valor numeric(16,2) not null check (valor > 0 and valor = trunc(valor)),
  medio_pago public.medio_pago not null,
  tercero text,
  registrado_por uuid not null references public.usuarios(id) on delete restrict,
  cierre_id uuid,
  -- Mismo cast a timestamp que `gastos.periodo` (202608240001): date_trunc sobre un argumento date
  -- resuelve a la sobrecarga timestamptz (STABLE), y una columna generada exige IMMUTABLE.
  periodo date generated always as (date_trunc('month', fecha::timestamp)::date) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.ingresos is
  'Ingresos de caja/banco/personal. Tabla APARTE de gastos a propósito: nunca un gasto negativo.';

-- ---------------------------------------------------------------------------
-- 6) `cierres_caja`: un cierre por (caja, mes).
-- ---------------------------------------------------------------------------
create table if not exists public.cierres_caja (
  id uuid primary key default gen_random_uuid(),
  caja_id uuid not null references public.cajas(id) on delete restrict,
  periodo date not null,
  estado public.estado_cierre not null default 'abierto',
  saldo_inicial numeric(16,2) not null default 0,
  total_ingresos numeric(16,2) not null default 0,
  total_gastos numeric(16,2) not null default 0,
  saldo_final numeric(16,2) not null default 0,
  cerrado_por uuid references public.usuarios(id) on delete restrict,
  cerrado_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint cierres_caja_caja_periodo_unico unique (caja_id, periodo)
);
comment on table public.cierres_caja is
  'Un cierre mensual por caja. CashService.closeCashPeriod es la única vía de escritura de la '
  'aplicación (ver lib/services/cash-service.ts): calcula los totales, etiqueta los movimientos del '
  'periodo con cierre_id MIENTRAS SIGUE abierto (el trigger de abajo bloquearía esa misma escritura '
  'si el periodo ya estuviera cerrado) y solo al final marca estado=''cerrado''.';

-- Ahora que `cierres_caja` existe, se agregan los `cierre_id` que quedaron pendientes en el punto 3/4.
alter table public.caja_menor add column if not exists cierre_id uuid references public.cierres_caja(id) on delete restrict;
alter table public.ingresos add constraint ingresos_cierre_id_fkey foreign key (cierre_id) references public.cierres_caja(id) on delete restrict;
alter table public.gastos add column if not exists cierre_id uuid references public.cierres_caja(id) on delete restrict;

-- ---------------------------------------------------------------------------
-- 6b) Índices. VAN AQUÍ, antes de cualquier UPDATE de datos (punto 7b): un `create index`/`alter
--     table` sobre `gastos` DESPUÉS de que el backfill de más abajo dispare (vía trigger) un UPDATE de
--     `gastos.valor_base`/`iva` falla con "cannot ... because it has pending trigger events" — ese
--     UPDATE deja en cola el disparador DIFERIDO `gastos_reparto_cuadra_padre` (`after update of
--     valor_base, iva ... deferrable initially deferred`, 202608240001), y Postgres prohíbe cualquier
--     DDL posterior sobre esa misma tabla dentro de la misma transacción mientras ese evento siga sin
--     dispararse. Bloqueante real, encontrado corriendo esta migración contra Postgres embebido (no
--     contra mocks): con los índices después del backfill, `npm run verify:schema` fallaba aquí.
-- ---------------------------------------------------------------------------
create index if not exists cajas_activas_busqueda_idx on public.cajas(nombre) where activo;
create index if not exists caja_menor_caja_fecha_idx on public.caja_menor(caja_id, fecha);
create index if not exists caja_menor_cierre_idx on public.caja_menor(cierre_id) where cierre_id is not null;
create index if not exists gastos_caja_idx on public.gastos(caja_id) where caja_id is not null;
create index if not exists gastos_cierre_idx on public.gastos(cierre_id) where cierre_id is not null;
create index if not exists ingresos_caja_fecha_idx on public.ingresos(caja_id, fecha);
create index if not exists ingresos_centro_costo_periodo_idx on public.ingresos(centro_costo_id, periodo);
create index if not exists ingresos_cierre_idx on public.ingresos(cierre_id) where cierre_id is not null;
create index if not exists cierres_caja_caja_periodo_idx on public.cierres_caja(caja_id, periodo);

-- ---------------------------------------------------------------------------
-- 7) `sincronizar_gasto_caja_menor`: reescritura completa (no merge) de la versión VIGENTE, que es la
--    de 202609120001_centros_costo.sql (no la original de 202608240001, ver el aviso grande de arriba
--    de ese archivo). Suma la propagación de caja_id/medio_pago/iva (antes forzado a 0) al lado de
--    centro_costo_id, que sigue derivándose de la obra exactamente igual que hasta hoy — y de paso
--    concepto/registrado_por, que la pantalla "Gastos y caja" necesita para mostrar un gasto de caja
--    sin ir a buscar la fila de caja_menor aparte.
--
--    ORDEN DELIBERADO: esta reescritura va ANTES del backfill de más abajo (punto 7b), no después.
--    `caja_menor_gasto` (la única disparadora de esta función) es "before insert OR UPDATE" sin lista
--    de columnas — CUALQUIER UPDATE de una fila de caja_menor con `gasto_id` ya asignado, incluido el
--    propio UPDATE del backfill, dispara un `update gastos set ... valor_base = new.valor, iva = new.iva
--    ...`. Si esa función siguiera siendo la VIEJA (que fuerza `iva = 0` y no conoce `caja_id`/
--    `medio_pago`), el backfill de abajo dejaría el gasto de cada movimiento legado desincronizado con
--    su propia caja_menor recién migrada — el mismo bug de fondo que esta migración corrige, colándose
--    por la puerta de atrás del propio backfill.
-- ---------------------------------------------------------------------------
create or replace function public.sincronizar_gasto_caja_menor()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_gasto uuid; v_centro_costo_id uuid; begin
  select centro_costo_id into v_centro_costo_id from public.obras where id = new.obra_id;
  if tg_op = 'INSERT' then
    insert into public.gastos(
      obra_id, origen, referencia_id, etiqueta_id, proveedor_id, fecha_orden, fecha, valor_base, iva,
      centro_costo_id, caja_id, concepto, medio_pago, registrado_por, cierre_id
    )
    values (
      new.obra_id, 'caja_menor', new.id, new.etiqueta_id, new.proveedor_id, new.fecha, new.fecha,
      new.valor, new.iva, v_centro_costo_id, new.caja_id, new.concepto, new.medio_pago,
      new.registrado_por, new.cierre_id
    )
    returning id into v_gasto;
    new.gasto_id := v_gasto;
  elsif new.gasto_id is not null then
    update public.gastos set
      obra_id = new.obra_id, etiqueta_id = new.etiqueta_id, proveedor_id = new.proveedor_id,
      fecha_orden = new.fecha, fecha = new.fecha, valor_base = new.valor, iva = new.iva,
      centro_costo_id = v_centro_costo_id, caja_id = new.caja_id, concepto = new.concepto,
      medio_pago = new.medio_pago, registrado_por = new.registrado_por, cierre_id = new.cierre_id
    where id = new.gasto_id;
  end if;
  return new;
end; $$;

-- ---------------------------------------------------------------------------
-- 7b) Backfill de caja_id/medio_pago para las filas que ya existían, ahora que la función de arriba ya
--     está instalada. NO puede ir antes que las columnas de `gastos` del punto 4 — el UPDATE de la
--     función de sincronización (disparado por el UPDATE de caja_id/medio_pago de aquí abajo) escribe
--     en `gastos.caja_id`/`medio_pago`, que deben existir YA como columnas.
--
--     DELIBERADAMENTE NULLABLE (sin `alter column ... set not null` después del backfill, a diferencia
--     de `centros_costo_id` en 202609120001): varios arneses de este repo, de migraciones ANTERIORES a
--     esta (schema_verification.sql, centros_costo_verification.sql, gasto_fecha_pago_verification.sql,
--     generic_attachments_verification.sql), insertan en `caja_menor` sin mencionar `caja_id`/
--     `medio_pago` — exigir NOT NULL los habría roto a todos por un cambio de esquema ajeno a lo que
--     cada uno prueba. La aplicación (`ProcurementService.registerPettyCash`, ver
--     lib/services/procurement-service.ts) sigue exigiendo ambos como obligatorios en el formulario;
--     esto es solo la base de datos absteniéndose de una restricción que un lote grande de pruebas
--     legado no puede cumplir retroactivamente.
-- ---------------------------------------------------------------------------
update public.caja_menor c set caja_id = (select id from public.cajas where nombre = 'Caja menor') where c.caja_id is null;
update public.caja_menor set medio_pago = 'efectivo' where medio_pago is null;

-- ---------------------------------------------------------------------------
-- 8) `validar_catalogos_activos_caja_menor`: se extiende (mismo criterio "activo" que obra/etiqueta/
--    proveedor de 202608240001) para que un movimiento no pueda nacer ni reasignarse a una caja de
--    baja. Reescritura completa de la función, igual que en el punto 7.
-- ---------------------------------------------------------------------------
create or replace function public.validar_catalogos_activos_caja_menor()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_obra_activa boolean; v_etiqueta_activa boolean; v_proveedor_activo boolean; v_usuario_activo boolean; v_caja_activa boolean; begin
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
  if new.caja_id is not null then
    select activo into v_caja_activa from public.cajas where id = new.caja_id;
    if coalesce(v_caja_activa, false) = false then
      raise exception 'La caja del movimiento debe estar activa' using errcode = '23514';
    end if;
  end if;
  return new;
end; $$;
drop trigger if exists caja_menor_catalogos_activos on public.caja_menor;
create trigger caja_menor_catalogos_activos before insert or update of obra_id, etiqueta_id, proveedor_id, registrado_por, caja_id
  on public.caja_menor for each row execute function public.validar_catalogos_activos_caja_menor();

-- ---------------------------------------------------------------------------
-- 9) `validar_periodo_caja_abierto`: rechaza insertar/editar un movimiento (caja_menor o ingresos) con
--    fecha dentro de un periodo YA cerrado para esa caja. Una sola función para las dos tablas (ambas
--    tienen caja_id y fecha) — mismo criterio que `es_aprobador_de` (202609110004): una sola definición
--    en vez de repetir la consulta en cada trigger.
--
--    ORDEN DE DISPARO: se registra con el prefijo "0_" (mismo truco que
--    `requisiciones_0_derivar_sociedad`, ver 202608240001) para que Postgres la dispare ANTES que
--    `caja_menor_catalogos_activos`/`caja_menor_gasto` dentro del mismo evento BEFORE ("0" ordena antes
--    que "c" alfabéticamente) — así un movimiento contra un periodo cerrado se rechaza sin haber
--    disparado ya la sincronización del gasto.
--
--    CashService.closeCashPeriod (lib/services/cash-service.ts) etiqueta los movimientos del periodo
--    con `cierre_id` MIENTRAS el cierre sigue `abierto` y solo AL FINAL lo marca `cerrado` — si lo
--    hiciera al revés, esa misma escritura de etiquetado quedaría bloqueada por este trigger.
create or replace function public.validar_periodo_caja_abierto()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_estado public.estado_cierre; begin
  select estado into v_estado from public.cierres_caja
   where caja_id = new.caja_id and periodo = date_trunc('month', new.fecha::timestamp)::date;
  if v_estado = 'cerrado' then
    raise exception 'La caja % ya cerró el periodo de %; no se pueden registrar ni editar movimientos de un mes cerrado', new.caja_id, new.fecha
      using errcode = '23514';
  end if;
  return new;
end; $$;
drop trigger if exists caja_menor_0_periodo_cerrado on public.caja_menor;
create trigger caja_menor_0_periodo_cerrado before insert or update on public.caja_menor
  for each row execute function public.validar_periodo_caja_abierto();
drop trigger if exists ingresos_0_periodo_cerrado on public.ingresos;
create trigger ingresos_0_periodo_cerrado before insert or update on public.ingresos
  for each row execute function public.validar_periodo_caja_abierto();

-- ---------------------------------------------------------------------------
-- 10) `ingresos`: mismo criterio "activo" que caja_menor (punto 8), pero sin proveedor/etiqueta —
--     un ingreso no tiene ninguno de los dos. Obra es OPCIONAL en ingresos (a diferencia de
--     caja_menor): un ingreso puede no venir de ninguna obra concreta (p. ej. un anticipo de cliente
--     que todavía no se asignó).
-- ---------------------------------------------------------------------------
create or replace function public.validar_catalogos_activos_ingresos()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_obra_activa boolean; v_caja_activa boolean; v_centro_activo boolean; v_usuario_activo boolean; begin
  if new.obra_id is not null then
    select o.estado = 'activa' and s.activa into v_obra_activa
      from public.obras o join public.sociedades s on s.id = o.sociedad_id where o.id = new.obra_id;
    if coalesce(v_obra_activa, false) = false then
      raise exception 'La obra del ingreso debe estar activa' using errcode = '23514';
    end if;
  end if;
  select activo into v_caja_activa from public.cajas where id = new.caja_id;
  if coalesce(v_caja_activa, false) = false then
    raise exception 'La caja del ingreso debe estar activa' using errcode = '23514';
  end if;
  select activo into v_centro_activo from public.centros_costo where id = new.centro_costo_id;
  if coalesce(v_centro_activo, false) = false then
    raise exception 'El centro de costo del ingreso debe estar activo' using errcode = '23514';
  end if;
  select estado = 'activo' into v_usuario_activo from public.usuarios where id = new.registrado_por;
  if coalesce(v_usuario_activo, false) = false then
    raise exception 'El responsable del ingreso debe estar activo' using errcode = '23514';
  end if;
  return new;
end; $$;
drop trigger if exists ingresos_catalogos_activos on public.ingresos;
create trigger ingresos_catalogos_activos before insert or update of obra_id, caja_id, centro_costo_id, registrado_por
  on public.ingresos for each row execute function public.validar_catalogos_activos_ingresos();

-- ---------------------------------------------------------------------------
-- 11) Vista `movimientos_centro_costo`: el cruce ingresos (+) / gastos (−) por centro de costo. Reusa
--     `gasto_distribucion` (202609120001) para el lado de gastos — ya resuelve la rama con y sin
--     reparto entre obras — en vez de repetir esa unión aquí.
-- ---------------------------------------------------------------------------
create or replace view public.movimientos_centro_costo with (security_invoker = true) as
  select i.id as movimiento_id, i.centro_costo_id, i.periodo, i.fecha, 'ingreso'::text as origen, i.valor as valor
    from public.ingresos i
  union all
  select gd.gasto_id as movimiento_id, gd.centro_costo_id, gd.periodo, gd.fecha, ('gasto_' || gd.origen)::text as origen, -gd.valor as valor
    from public.gasto_distribucion gd;
comment on view public.movimientos_centro_costo is
  'Cruce de ingresos (+) y gastos (−, vía gasto_distribucion) por centro de costo y periodo. '
  'origen: ''ingreso'', ''gasto_requisicion'' o ''gasto_caja_menor''.';

-- ---------------------------------------------------------------------------
-- 13) Triggers estándar (set_updated_at / escribir_auditoria / bloquear_eliminacion_catalogo): mismo
--     patrón idempotente que 202609120001 para `centros_costo`. `cierres_caja` NO lleva
--     bloquear_eliminacion_catalogo: no es un catálogo maestro, es un registro operativo, y reabrir ya
--     tiene su propio camino (CashService.reopenCashPeriod cambia `estado`, nunca borra la fila).
-- ---------------------------------------------------------------------------
do $$ begin
  create trigger cajas_updated_at before update on public.cajas
    for each row execute function public.set_updated_at();
exception when duplicate_object then null; end $$;
do $$ begin
  create trigger cajas_auditoria after insert or update or delete on public.cajas
    for each row execute function public.escribir_auditoria();
exception when duplicate_object then null; end $$;
do $$ begin
  create trigger cajas_sin_borrado_fisico before delete on public.cajas
    for each row execute function public.bloquear_eliminacion_catalogo();
exception when duplicate_object then null; end $$;
do $$ begin
  create trigger ingresos_updated_at before update on public.ingresos
    for each row execute function public.set_updated_at();
exception when duplicate_object then null; end $$;
do $$ begin
  create trigger ingresos_auditoria after insert or update or delete on public.ingresos
    for each row execute function public.escribir_auditoria();
exception when duplicate_object then null; end $$;
do $$ begin
  create trigger cierres_caja_updated_at before update on public.cierres_caja
    for each row execute function public.set_updated_at();
exception when duplicate_object then null; end $$;
do $$ begin
  create trigger cierres_caja_auditoria after insert or update or delete on public.cierres_caja
    for each row execute function public.escribir_auditoria();
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- 14) RLS
-- ---------------------------------------------------------------------------
-- `cajas`: catálogo maestro, mismo criterio que `centros_costo` (lectura para cualquier usuario activo,
-- escritura solo para quien administra catálogos).
alter table public.cajas enable row level security;
do $$ begin
  create policy "cajas_lectura" on public.cajas for select to authenticated using (public.is_active_user());
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "cajas_admin" on public.cajas for all to authenticated using (public.can_manage_catalogos()) with check (public.can_manage_catalogos());
exception when duplicate_object then null; end $$;
revoke all on public.cajas from anon;

-- `ingresos`: mismo criterio que `caja_menor` (lectura compras/contabilidad; escritura quien registra),
-- pero la escritura usa exactamente el conjunto de roles de `income:register` (lib/domain/rules.ts):
-- revisor, contabilidad, admin_sixteam — `can_operate_compras()` ya es revisor OR admin_sixteam, así
-- que solo hace falta sumarle `has_role('contabilidad')` (idéntico al criterio de `pagos_orden`,
-- 202609120002, para `payment:register`).
alter table public.ingresos enable row level security;
create policy "ingresos_lectura_operativa" on public.ingresos for select to authenticated using (
  public.is_active_user() and (public.can_operate_compras() or public.has_role('contabilidad'))
);
create policy "ingresos_alta_operativa" on public.ingresos for insert to authenticated with check (
  public.is_active_user() and (public.can_operate_compras() or public.has_role('contabilidad')) and registrado_por = auth.uid()
);
-- UPDATE: además de "quien lo registró", CashService.closeCashPeriod necesita poder etiquetar CUALQUIER
-- ingreso del periodo con `cierre_id` (no solo los propios) — igual que `caja_menor_cierre_update` más
-- abajo. AVISO HONESTO (mismo que pagos_orden/aprobador_por_item): hoy la aplicación se conecta con el
-- rol dueño de las tablas y autoriza en el servicio; esto es defensa en profundidad, no la cerradura
-- principal.
create policy "ingresos_edicion_operativa" on public.ingresos for update to authenticated using (
  public.is_active_user() and (public.can_operate_compras() or public.has_role('contabilidad'))
) with check (
  public.is_active_user() and (public.can_operate_compras() or public.has_role('contabilidad'))
);
revoke all on public.ingresos from anon;

-- `caja_menor` YA tiene RLS habilitada y sus policies de lectura/alta/edición desde 202608240001 (la
-- edición de hoy, `caja_menor_operador_update`, solo cubre `can_operate_compras()` = revisor O
-- admin_sixteam). Cierre mensual (`cash:close`) es de contabilidad Y admin_sixteam: contabilidad
-- necesita poder etiquetar `cierre_id` en movimientos de caja_menor que NO registró ella, y hoy no
-- puede. Postgres combina varias policies PERMISSIVE del mismo comando con OR, así que esto SUMA esa
-- posibilidad sin tocar ni reemplazar la policy existente (aditivo, igual que el resto de esta
-- migración con el esquema).
create policy "caja_menor_cierre_update" on public.caja_menor for update to authenticated using (
  public.is_active_user() and public.has_role('contabilidad')
) with check (
  public.is_active_user() and public.has_role('contabilidad')
);

-- `cierres_caja`: mismo criterio de lectura que `caja_menor`/`ingresos`; escritura (abrir/cerrar/
-- reabrir totales) exclusiva de contabilidad y admin_sixteam — a propósito SIN `can_operate_compras()`
-- (que incluiría a revisor): cerrar caja no es un gesto de compras, es contable.
alter table public.cierres_caja enable row level security;
create policy "cierres_caja_lectura_operativa" on public.cierres_caja for select to authenticated using (
  public.is_active_user() and (public.can_operate_compras() or public.has_role('contabilidad'))
);
create policy "cierres_caja_escritura_contabilidad" on public.cierres_caja for all to authenticated using (
  public.is_active_user() and (public.has_role('contabilidad') or public.has_role('admin_sixteam'))
) with check (
  public.is_active_user() and (public.has_role('contabilidad') or public.has_role('admin_sixteam'))
);
revoke all on public.cierres_caja from anon;
