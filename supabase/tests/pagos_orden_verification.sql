-- Arnés de 202609120002_pagos_orden.sql. Registrado en scripts/verify-schema.ts.
-- Formato del repo: begin -> do $$ ... $$ (uno por grupo) -> rollback.
--
-- Lo que importa de verdad aquí NO cabe en una prueba unitaria porque no vive en TypeScript: el
-- trigger que impide que la suma de pagos supere el total del gasto de la orden, y las policies de
-- RLS. Un doble de `sql` en el servicio comprobaría que llamamos al `insert`, no que la base rechaza
-- lo que el servicio (por un error propio, o por alguien que entra sin pasar por el servicio) dejara
-- pasar.
--
-- AVISO HONESTO (mismo que 202609110004_aprobador_por_item): hoy la aplicación se conecta con el rol
-- dueño de las tablas y autoriza en `ProcurementService.registerOrderPayment`
-- (`assertPermission(..., "payment:register", ...)`); las policies de aquí son defensa en
-- profundidad, no la cerradura principal.
begin;

-- 1. Los objetos de esquema existen: tabla, enum, índice, trigger, RLS habilitada.
do $$
declare v_count int;
begin
  select count(*) into v_count from information_schema.tables
   where table_schema = 'public' and table_name = 'pagos_orden';
  if v_count <> 1 then raise exception 'falta la tabla public.pagos_orden'; end if;

  select count(*) into v_count from pg_type
   where typname = 'medio_pago' and typnamespace = 'public'::regnamespace;
  if v_count <> 1 then raise exception 'falta el enum public.medio_pago'; end if;

  select count(*) into v_count from pg_indexes
   where schemaname = 'public' and tablename = 'pagos_orden' and indexname = 'pagos_orden_orden_fecha_idx';
  if v_count <> 1 then raise exception 'falta el índice pagos_orden_orden_fecha_idx'; end if;

  select count(*) into v_count from pg_trigger
   where tgname = 'pagos_orden_no_excede' and not tgisinternal;
  if v_count <> 1 then raise exception 'falta el trigger pagos_orden_no_excede'; end if;

  if not (select relrowsecurity from pg_class where oid = 'public.pagos_orden'::regclass) then
    raise exception 'public.pagos_orden debe tener RLS habilitada';
  end if;
end $$;

-- 2. Pago parcial, y completar el saldo EXACTO al total del gasto (100000 base + 19000 iva =
--    119000, mismos números que gasto_fecha_pago_verification.sql). Un peso más, ya sin saldo, se
--    rechaza.
do $$
declare v_req uuid; v_orden uuid; v_gasto uuid; v_pagado numeric;
begin
  insert into public.requisiciones(consecutivo, tipo, obra_id, solicitante_id, canal)
    values ('', 'compra', '30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'web')
    returning id into v_req;
  insert into public.ordenes(consecutivo, tipo, requisicion_id, proveedor_id, fecha_generacion)
    values ('OC-TEST-PG-0001', 'OC', v_req, '40000000-0000-4000-8000-000000000001', now())
    returning id into v_orden;
  insert into public.gastos(obra_id, origen, referencia_id, proveedor_id, fecha_orden, fecha, valor_base, iva)
    values ('30000000-0000-4000-8000-000000000001', 'requisicion', v_orden, '40000000-0000-4000-8000-000000000001', current_date, null, 100000, 19000)
    returning id into v_gasto;

  insert into public.pagos_orden(orden_id, fecha, valor, medio_pago, registrado_por)
    values (v_orden, current_date, 50000, 'transferencia', '10000000-0000-4000-8000-000000000002');
  select coalesce(sum(valor), 0) into v_pagado from public.pagos_orden where orden_id = v_orden;
  if v_pagado <> 50000 then raise exception 'la suma tras el primer pago parcial no cuadra: %', v_pagado; end if;

  -- 50000 + 69000 = 119000: el saldo EXACTO restante, debe aceptarse (el límite es "> total", no ">= total").
  insert into public.pagos_orden(orden_id, fecha, valor, medio_pago, registrado_por)
    values (v_orden, current_date, 69000, 'efectivo', '10000000-0000-4000-8000-000000000002');
  select coalesce(sum(valor), 0) into v_pagado from public.pagos_orden where orden_id = v_orden;
  if v_pagado <> 119000 then raise exception 'la suma de pagos no alcanzó el total del gasto: %', v_pagado; end if;

  begin
    insert into public.pagos_orden(orden_id, fecha, valor, medio_pago)
      values (v_orden, current_date, 1, 'otro');
    raise exception 'se permitió un pago sobre una orden ya cubierta en su totalidad';
  exception when sqlstate '23514' then null;
  end;
end $$;

-- 3. Un pago parcial que haría exceder el total se rechaza, pero el saldo exacto restante sí se
--    acepta (mismo par de aserciones que arriba, con una orden nueva para no depender del orden de
--    ejecución de los bloques).
do $$
declare v_req uuid; v_orden uuid; v_gasto uuid; v_pagado numeric;
begin
  insert into public.requisiciones(consecutivo, tipo, obra_id, solicitante_id, canal)
    values ('', 'compra', '30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'web')
    returning id into v_req;
  insert into public.ordenes(consecutivo, tipo, requisicion_id, proveedor_id, fecha_generacion)
    values ('OC-TEST-PG-0002', 'OC', v_req, '40000000-0000-4000-8000-000000000001', now())
    returning id into v_orden;
  insert into public.gastos(obra_id, origen, referencia_id, proveedor_id, fecha_orden, fecha, valor_base, iva)
    values ('30000000-0000-4000-8000-000000000001', 'requisicion', v_orden, '40000000-0000-4000-8000-000000000001', current_date, null, 10000, 0)
    returning id into v_gasto;

  insert into public.pagos_orden(orden_id, fecha, valor, medio_pago)
    values (v_orden, current_date, 6000, 'efectivo');

  begin
    -- 6000 + 5000 = 11000 > 10000.
    insert into public.pagos_orden(orden_id, fecha, valor, medio_pago)
      values (v_orden, current_date, 5000, 'efectivo');
    raise exception 'se permitió un pago parcial que hace exceder el total de la orden';
  exception when sqlstate '23514' then null;
  end;

  -- 6000 + 4000 = 10000, el saldo exacto restante.
  insert into public.pagos_orden(orden_id, fecha, valor, medio_pago)
    values (v_orden, current_date, 4000, 'efectivo');
  select coalesce(sum(valor), 0) into v_pagado from public.pagos_orden where orden_id = v_orden;
  if v_pagado <> 10000 then raise exception 'el saldo exacto restante no se aceptó: %', v_pagado; end if;
end $$;

-- 4. Una orden SIN gasto asociado (como una `no_necesario` cuyo gasto ya se anuló, ver
--    `updateOrderStatus` en procurement-service.ts) no tiene total contra el que medir: el pago se
--    rechaza explícito, nunca se cuela contra un total inexistente.
do $$
declare v_req uuid; v_orden uuid;
begin
  insert into public.requisiciones(consecutivo, tipo, obra_id, solicitante_id, canal)
    values ('', 'compra', '30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'web')
    returning id into v_req;
  insert into public.ordenes(consecutivo, tipo, requisicion_id, proveedor_id, fecha_generacion)
    values ('OC-TEST-PG-0003', 'OC', v_req, '40000000-0000-4000-8000-000000000001', now())
    returning id into v_orden;

  begin
    insert into public.pagos_orden(orden_id, fecha, valor, medio_pago)
      values (v_orden, current_date, 1000, 'efectivo');
    raise exception 'se permitió un pago sobre una orden sin gasto asociado';
  exception when sqlstate '23514' then null;
  end;
end $$;

-- 5. RLS de verdad, con el rol `authenticated` y la identidad puesta como la pone PostgREST.
--    `payment:register` (lib/domain/rules.ts) es revisor/contabilidad/admin_sixteam: los dos primeros
--    se prueban aquí como quienes SÍ pueden escribir y leer; un aprobador ajeno a la requisición (sin
--    rol de compras ni contabilidad) no debe poder ni lo uno ni lo otro.
do $$
declare
  v_req uuid; v_orden uuid; v_gasto uuid;
  c_revisor constant uuid := '10000000-0000-4000-8000-000000000002'; -- Daniel, revisor
  c_contabilidad constant uuid := '10000000-0000-4000-8000-000000000004'; -- Claudia, contabilidad
  c_aprobador_ajeno constant uuid := '10000000-0000-4000-8000-000000000003'; -- Nelson, aprobador (no asignado aquí)
  c_solicitante constant uuid := '10000000-0000-4000-8000-000000000001';
begin
  insert into public.requisiciones(consecutivo, tipo, obra_id, solicitante_id, canal)
    values ('', 'compra', '30000000-0000-4000-8000-000000000001', c_solicitante, 'web')
    returning id into v_req;
  insert into public.ordenes(consecutivo, tipo, requisicion_id, proveedor_id, fecha_generacion)
    values ('OC-TEST-PG-0004', 'OC', v_req, '40000000-0000-4000-8000-000000000001', now())
    returning id into v_orden;
  insert into public.gastos(obra_id, origen, referencia_id, proveedor_id, fecha_orden, fecha, valor_base, iva)
    values ('30000000-0000-4000-8000-000000000001', 'requisicion', v_orden, '40000000-0000-4000-8000-000000000001', current_date, null, 20000, 0)
    returning id into v_gasto;

  -- El revisor registra un pago y lo ve.
  perform set_config('request.jwt.claim.sub', c_revisor::text, true);
  execute 'set local role authenticated';
  insert into public.pagos_orden(orden_id, fecha, valor, medio_pago, registrado_por)
    values (v_orden, current_date, 5000, 'transferencia', c_revisor);
  if not exists (select 1 from public.pagos_orden where orden_id = v_orden) then
    raise exception 'RLS: el revisor no ve el pago que acaba de registrar';
  end if;
  execute 'reset role';
  perform set_config('request.jwt.claim.sub', '', true);

  -- Contabilidad también puede escribir: payment:register la incluye, aunque can_operate_compras()
  -- por sí sola (revisor OR admin_sixteam) no la cubra.
  perform set_config('request.jwt.claim.sub', c_contabilidad::text, true);
  execute 'set local role authenticated';
  insert into public.pagos_orden(orden_id, fecha, valor, medio_pago)
    values (v_orden, current_date, 5000, 'efectivo');
  execute 'reset role';
  perform set_config('request.jwt.claim.sub', '', true);

  -- Un aprobador SIN asignar a esta requisición, sin rol de compras ni contabilidad: ni escribe ni lee.
  perform set_config('request.jwt.claim.sub', c_aprobador_ajeno::text, true);
  execute 'set local role authenticated';
  begin
    insert into public.pagos_orden(orden_id, fecha, valor, medio_pago)
      values (v_orden, current_date, 1000, 'efectivo');
    raise exception 'RLS: un aprobador ajeno pudo registrar un pago';
  exception when sqlstate '42501' then null;
  end;
  if exists (select 1 from public.pagos_orden where orden_id = v_orden) then
    raise exception 'RLS: un aprobador ajeno lee pagos de una orden que no le toca';
  end if;
  execute 'reset role';
  -- Se devuelve la identidad, no solo el rol (mismo motivo que aprobador_por_item_verification.sql:
  -- `reset role` quita el rol pero deja puesto el GUC que lee auth.uid()).
  perform set_config('request.jwt.claim.sub', '', true);
end $$;

rollback;
