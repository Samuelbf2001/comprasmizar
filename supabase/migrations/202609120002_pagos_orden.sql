-- PAGOS PARCIALES DE ORDEN (Ernesto, reunión agosto: "saber cuánto se ha pagado de cada orden").
-- Aditiva: ningún DROP de columna/tabla, ningún ALTER TYPE ... ADD VALUE (ver trampa más abajo). No
-- toca `ordenes.estado_administrativo` ni `assertAdminTransition` (lib/domain/rules.ts): el eje
-- pendiente -> contabilizada -> pagada sigue existiendo tal cual; esta migración solo AÑADE el
-- detalle de qué pagos componen ese "pagada". El número es …0002 porque …0001 (aprobador por ítem con
-- adjuntos) la aplica otro cambio en paralelo — dos migraciones con el mismo prefijo se pisan en
-- apply-migrations.sh (una se aplica y la otra se da por hecha), y ese fallo no avisa.
--
-- TRAMPA EVITADA: los valores de un enum recién creado con `alter type ... add value` NO se pueden
-- usar todavía dentro de la MISMA transacción que lo crea (Postgres lo rechaza: "unsafe use of new
-- value... before it has been committed"). Aquí no hace falta esquivarla con dos migraciones porque
-- `medio_pago` es un enum COMPLETAMENTE NUEVO creado con `create type ... as enum (...)` de una sola
-- vez (no un `alter type` sobre uno existente) — esa forma sí se puede usar en la misma transacción
-- que la tabla que lo consume, ver más abajo.

-- ---------------------------------------------------------------------------
-- 1) Enum del medio de pago
-- ---------------------------------------------------------------------------
do $$ begin
  create type public.medio_pago as enum ('efectivo', 'transferencia', 'cheque', 'tarjeta', 'otro');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- 2) Tabla pagos_orden
-- ---------------------------------------------------------------------------
-- `valor numeric(16,2)` con `= trunc(valor)`: mismo molde que `gastos.valor_base`/`gastos.iva`
-- (202608240001) y `caja_menor.valor` — el dominio entero asume "peso colombiano entero"
-- (lib/domain/model.ts: "Monetary values are integer Colombian pesos (COP)", `assertCop` en
-- lib/domain/rules.ts), así que un pago con centavos sería el único valor monetario de toda la base
-- que rompe esa invariante, y silenciosamente: nada en la capa de servicio ni en la pantalla espera
-- centavos. `on delete restrict` hacia `ordenes`/`usuarios`, igual que `orden_items.orden_id` y
-- `caja_menor.registrado_por` — un pago histórico no debe poder desaparecer por accidente al borrar
-- su orden o su usuario; `registrado_por` es la única FK `on delete set null` de las dos porque el
-- propio enunciado la pide NULLABLE (a diferencia de `caja_menor.registrado_por`, que es obligatoria).
create table if not exists public.pagos_orden (
  id uuid primary key default gen_random_uuid(),
  orden_id uuid not null references public.ordenes(id) on delete restrict,
  fecha date not null,
  valor numeric(16,2) not null check (valor > 0 and valor = trunc(valor)),
  medio_pago public.medio_pago not null,
  referencia_externa text,
  registrado_por uuid references public.usuarios(id) on delete set null,
  created_at timestamptz not null default now()
);

comment on table public.pagos_orden is
  'Pagos parciales de una orden. El saldo pagado de una orden es sum(valor) de sus filas; '
  'ProcurementService.registerOrderPayment (lib/services/procurement-service.ts) es la única vía de '
  'escritura de la aplicación. No sustituye ordenes.estado_administrativo/pagada_at: cuando el saldo '
  'llega al total, updateOrderAdminStatus(...,''pagada'') sigue siendo quien cierra ese eje.';

-- Único índice pedido: (orden_id, fecha). Sirve tanto al listado "pagos de esta orden, en orden
-- cronológico" (la ficha de la pantalla) como al cálculo de "fecha del último pago" que necesita la
-- compatibilidad de `updateOrderAdminStatus` (ver procurement-service.ts).
create index if not exists pagos_orden_orden_fecha_idx on public.pagos_orden(orden_id, fecha);

-- ---------------------------------------------------------------------------
-- 3) Trigger: un pago no puede hacer que la suma de pagos de la orden supere el total de su gasto
-- ---------------------------------------------------------------------------
-- El total de referencia es `gastos.valor_total` de la fila con `origen = 'requisicion'` y
-- `referencia_id = orden_id` — así es como una orden y su gasto se relacionan hoy (ver
-- `generateOrders`/`saveExpense` en procurement-service.ts/postgres-repositories.ts: cada orden
-- generada nace con UN gasto propio, `gastos_origen_referencia_unico` garantiza que es uno solo). Si
-- esa fila no existe (p. ej. una orden `no_necesario` cuyo gasto ya se borró, ver
-- `updateOrderStatus`), no hay total contra el que medir y el pago se rechaza explícito en vez de
-- colarse contra un total inexistente.
--
-- SECURITY DEFINER + search_path fijo: mismo criterio que el resto de funciones de RLS/triggers de
-- este archivo de base (ver `es_aprobador_de`, 202609110004) — no depende de los privilegios ni el
-- search_path de quien dispara el trigger.
create or replace function public.validar_pago_no_excede_orden()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_total numeric(16,2);
  v_pagado_previo numeric(16,2);
begin
  select g.valor_total into v_total
    from public.gastos g
   where g.origen = 'requisicion' and g.referencia_id = new.orden_id;
  if v_total is null then
    raise exception 'La orden % no tiene un gasto asociado; no se puede registrar un pago', new.orden_id
      using errcode = '23514';
  end if;

  -- `id <> new.id`: en un UPDATE (de valor u orden_id) no hay que contar el propio pago dos veces;
  -- en un INSERT la fila con ese id todavía no existe, así que la exclusión es un no-op inofensivo.
  select coalesce(sum(valor), 0) into v_pagado_previo
    from public.pagos_orden
   where orden_id = new.orden_id and id <> new.id;

  if v_pagado_previo + new.valor > v_total then
    raise exception 'El pago de % excede el saldo pendiente de la orden % (pagado %, total %)',
      new.valor, new.orden_id, v_pagado_previo, v_total
      using errcode = '23514';
  end if;
  return new;
end; $$;

do $$ begin
  create trigger pagos_orden_no_excede before insert or update of valor, orden_id on public.pagos_orden
    for each row execute function public.validar_pago_no_excede_orden();
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- 4) RLS: "como ordenes" (Ernesto) — lectura operativa igual que `ordenes_lectura_operativa`
-- (202609110004: compras/contabilidad/aprobador de la requisición dueña); escritura acotada a quien
-- puede mover el eje administrativo hacia "pagada" en el servicio (permiso nuevo `payment:register`
-- en lib/domain/rules.ts: revisor, contabilidad, admin_sixteam — `can_operate_compras()` ya es
-- revisor OR admin_sixteam, así que solo hace falta sumarle `has_role('contabilidad')`).
--
-- AVISO HONESTO (igual que 202609110004): hoy la aplicación se conecta con el rol dueño de las
-- tablas y autoriza en el servicio (`assertPermission`); esto es defensa en profundidad, no la
-- cerradura principal.
alter table public.pagos_orden enable row level security;

create policy "pagos_orden_lectura_operativa" on public.pagos_orden for select to authenticated using (
  public.is_active_user() and (
    public.can_operate_compras() or public.has_role('contabilidad') or exists (
      select 1 from public.ordenes o join public.requisiciones r on r.id = o.requisicion_id
       where o.id = orden_id and public.es_aprobador_de(r.id)
    )
  )
);

create policy "pagos_orden_escritura_operativa" on public.pagos_orden for insert to authenticated with check (
  public.is_active_user() and (public.can_operate_compras() or public.has_role('contabilidad'))
);
