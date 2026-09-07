-- Verifica 202609070003_gasto_fecha_pago.sql: separación de fecha_orden (nace con el registro) y
-- fecha (fecha de PAGO, decisión del cliente reunión 2026-09). Mismo formato que
-- schema_verification.sql y aprobador_elegido_verification.sql: transacción + bloques `do $$ ... $$`
-- con `raise exception` en fallo, `rollback` al final.
--
-- Deliberadamente NO se registra en scripts/verify-schema.ts en este cambio (otro agente toca ese
-- archivo en paralelo con la Fase de acceso público); ver el informe final de esta tarea para cómo se
-- ejecutó a mano contra el mismo Postgres embebido.
begin;

-- Columnas y nulabilidad correctas: fecha_orden NOT NULL, fecha nullable.
do $$ begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'gastos' and column_name = 'fecha_orden' and is_nullable = 'NO'
  ) then raise exception 'gastos.fecha_orden debe existir y ser NOT NULL'; end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'gastos' and column_name = 'fecha' and is_nullable = 'YES'
  ) then raise exception 'gastos.fecha debe ser nullable (ahora es la fecha de pago)'; end if;
end $$;

-- Una orden generada (simulando ProcurementService.generateOrders): el gasto nace con fecha_orden
-- puesta, fecha NULL y, por tanto, periodo NULL — un compromiso, todavía no un gasto.
do $$
declare v_req uuid; v_orden uuid; v_gasto uuid; begin
  insert into public.requisiciones(consecutivo, tipo, obra_id, solicitante_id, canal)
    values ('', 'compra', '30000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'web')
    returning id into v_req;
  insert into public.ordenes(consecutivo, tipo, requisicion_id, proveedor_id, fecha_generacion)
    values ('OC-TEST-FP-0001', 'OC', v_req, '40000000-0000-0000-0000-000000000001', '2026-08-31 23:30:00-05')
    returning id into v_orden;
  insert into public.gastos(obra_id, origen, referencia_id, proveedor_id, fecha_orden, fecha, valor_base, iva)
    values ('30000000-0000-0000-0000-000000000001', 'requisicion', v_orden, '40000000-0000-0000-0000-000000000001', '2026-08-31', null, 100000, 19000)
    returning id into v_gasto;
  if not exists (select 1 from public.gastos where id = v_gasto and fecha_orden = '2026-08-31' and fecha is null and periodo is null) then
    raise exception 'El gasto de una orden recién generada debe tener fecha_orden puesta, fecha NULL y periodo NULL';
  end if;

  -- Al marcar la orden pagada y fijar fecha, periodo se calcula solo (columna generada).
  update public.ordenes set estado_administrativo = 'contabilizada', contabilizada_at = now() where id = v_orden;
  update public.ordenes set estado_administrativo = 'pagada', pagada_at = '2026-09-01 03:30:00-05' where id = v_orden;
  update public.gastos set fecha = '2026-08-31' where id = v_gasto;
  if not exists (select 1 from public.gastos where id = v_gasto and fecha = '2026-08-31' and periodo = '2026-08-01') then
    raise exception 'Al fijar fecha de pago, periodo debe calcularse solo (columna generada)';
  end if;

  -- gasto_distribucion (vista) sigue funcionando con fecha nula: se prueba ANTES de fijar la fecha
  -- reutilizando un segundo gasto sin pagar, para no perder la fila ya pagada de arriba.
end $$;

-- gasto_distribucion sigue funcionando (no revienta, y expone fecha/periodo NULL) para un gasto sin pagar.
do $$
declare v_req uuid; v_orden uuid; v_gasto uuid; v_fecha date; v_periodo date; begin
  insert into public.requisiciones(consecutivo, tipo, obra_id, solicitante_id, canal)
    values ('', 'compra', '30000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'web')
    returning id into v_req;
  insert into public.ordenes(consecutivo, tipo, requisicion_id, proveedor_id, fecha_generacion)
    values ('OC-TEST-FP-0002', 'OC', v_req, '40000000-0000-0000-0000-000000000001', now())
    returning id into v_orden;
  insert into public.gastos(obra_id, origen, referencia_id, proveedor_id, fecha_orden, fecha, valor_base, iva)
    values ('30000000-0000-0000-0000-000000000001', 'requisicion', v_orden, '40000000-0000-0000-0000-000000000001', current_date, null, 50000, 0)
    returning id into v_gasto;
  select fecha, periodo into v_fecha, v_periodo from public.gasto_distribucion where gasto_id = v_gasto;
  if v_fecha is not null or v_periodo is not null then
    raise exception 'gasto_distribucion debe exponer fecha y periodo NULL para un gasto sin pagar';
  end if;
end $$;

-- Un movimiento de caja menor (vía el trigger sincronizar_gasto_caja_menor) crea el gasto con
-- fecha = fecha_orden = fecha del movimiento: la caja menor se paga en el acto, no cambia.
do $$
declare v_caja uuid; v_gasto uuid; begin
  insert into public.caja_menor(obra_id, fecha, concepto, etiqueta_id, proveedor_id, valor, registrado_por)
    values ('30000000-0000-0000-0000-000000000001', '2026-09-03', 'Taxi obra', (select id from public.etiquetas where nombre = 'Transporte'), null, 25000, '10000000-0000-0000-0000-000000000002')
    returning id, gasto_id into v_caja, v_gasto;
  if not exists (
    select 1 from public.gastos
    where id = v_gasto and origen = 'caja_menor' and fecha_orden = '2026-09-03' and fecha = '2026-09-03' and periodo = '2026-09-01'
  ) then raise exception 'Un gasto de caja menor debe nacer con fecha_orden = fecha = fecha del movimiento (se paga en el acto)'; end if;

  -- Actualizar el movimiento de caja menor (UPDATE, no INSERT) también debe mantener fecha_orden = fecha.
  update public.caja_menor set fecha = '2026-09-04' where id = v_caja;
  if not exists (
    select 1 from public.gastos where id = v_gasto and fecha_orden = '2026-09-04' and fecha = '2026-09-04' and periodo = '2026-09-01'
  ) then raise exception 'Al editar un movimiento de caja menor, fecha_orden y fecha deben seguir la nueva fecha'; end if;
end $$;

rollback;
