-- Arnés de 202609150004_obra_opcional_centros_no_obra.sql. Registrado en scripts/verify-schema.ts.
-- Formato del repo: begin -> do $$ ... $$ (uno por grupo) -> rollback. Sin par legado: la migración no
-- backfillea datos (relajar un NOT NULL no cambia ninguna fila existente).
begin;

-- 1. Objetos: gastos.obra_id nullable, trigger presente; requisiciones.obra_id ya era nullable (202609010001).
do $$
declare v_nullable text;
begin
  select is_nullable into v_nullable from information_schema.columns
   where table_schema = 'public' and table_name = 'gastos' and column_name = 'obra_id';
  if v_nullable is distinct from 'YES' then raise exception 'gastos.obra_id debe admitir NULL (obtenido %)', v_nullable; end if;
  select is_nullable into v_nullable from information_schema.columns
   where table_schema = 'public' and table_name = 'requisiciones' and column_name = 'obra_id';
  if v_nullable is distinct from 'YES' then raise exception 'requisiciones.obra_id debía ser nullable desde 202609010001'; end if;
  if not exists (select 1 from pg_trigger where tgname = 'gastos_obra_segun_centro' and not tgisinternal) then
    raise exception 'falta el trigger gastos_obra_segun_centro';
  end if;
end $$;

-- 2. Un gasto sin obra vive bajo un centro administrativo; contra un centro de tipo obra, o sin centro,
--    se rechaza; y quitarle la obra a un gasto de un centro de tipo obra también.
do $$
declare v_cc_admin uuid; v_cc_obra uuid; v_req uuid; v_orden uuid; v_gasto uuid; v_obra uuid;
begin
  insert into public.centros_costo (nombre, tipo, sociedad_id) values ('CC Admin Sin Obra Test', 'administrativo', '20000000-0000-4000-8000-000000000004') returning id into v_cc_admin;
  select centro_costo_id into v_cc_obra from public.obras where id = '30000000-0000-4000-8000-000000000001';
  if v_cc_obra is null then
    insert into public.centros_costo (nombre, tipo, sociedad_id) values ('CC Obra Test', 'obra', '20000000-0000-4000-8000-000000000001') returning id into v_cc_obra;
  end if;

  -- Requisición corporativa de PROIM sin obra (ya permitido), con centro administrativo.
  insert into public.requisiciones(consecutivo, tipo, sociedad_id, obra_id, solicitante_id, canal, centro_costo_id)
    values ('', 'pago', '20000000-0000-4000-8000-000000000004', null, '10000000-0000-4000-8000-000000000001', 'web', v_cc_admin)
    returning id into v_req;
  insert into public.ordenes(consecutivo, tipo, requisicion_id, proveedor_id, fecha_generacion)
    values ('OP-TEST-SO-0001', 'OP', v_req, '40000000-0000-4000-8000-000000000001', now())
    returning id into v_orden;
  insert into public.gastos(obra_id, origen, referencia_id, proveedor_id, fecha_orden, fecha, valor_base, iva, centro_costo_id, empresa_facturada_id)
    values (null, 'requisicion', v_orden, '40000000-0000-4000-8000-000000000001', current_date, null, 250000, 0, v_cc_admin, '20000000-0000-4000-8000-000000000004')
    returning id into v_gasto;
  if not exists (select 1 from public.gasto_distribucion where gasto_id = v_gasto and obra_id is null and centro_costo_id = v_cc_admin) then
    raise exception 'gasto_distribucion debe listar el gasto sin obra bajo su centro de costo';
  end if;

  -- El trigger anti-sobrepago de pagos_orden sigue funcionando contra este gasto (no depende de la obra).
  insert into public.pagos_orden(orden_id, fecha, valor, medio_pago, registrado_por)
    values (v_orden, current_date, 250000, 'transferencia', '10000000-0000-4000-8000-000000000002');

  begin
    insert into public.gastos(obra_id, origen, referencia_id, proveedor_id, fecha_orden, fecha, valor_base, iva, centro_costo_id)
      values (null, 'requisicion', gen_random_uuid(), '40000000-0000-4000-8000-000000000001', current_date, null, 1000, 0, v_cc_obra);
    raise exception 'se aceptó un gasto sin obra contra un centro de tipo obra';
  exception when sqlstate '23514' then null;
  end;
  begin
    insert into public.gastos(obra_id, origen, referencia_id, proveedor_id, fecha_orden, fecha, valor_base, iva, centro_costo_id)
      values (null, 'requisicion', gen_random_uuid(), '40000000-0000-4000-8000-000000000001', current_date, null, 1000, 0, null);
    raise exception 'se aceptó un gasto sin obra y sin centro de costo';
  exception when sqlstate '23514' then null;
  end;

  -- Un gasto normal (con obra, centro de tipo obra) no puede quedarse sin obra por un UPDATE.
  insert into public.requisiciones(consecutivo, tipo, obra_id, solicitante_id, canal)
    values ('', 'compra', '30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'web')
    returning id into v_req;
  insert into public.ordenes(consecutivo, tipo, requisicion_id, proveedor_id, fecha_generacion)
    values ('OC-TEST-SO-0002', 'OC', v_req, '40000000-0000-4000-8000-000000000001', now())
    returning id into v_orden;
  insert into public.gastos(obra_id, origen, referencia_id, proveedor_id, fecha_orden, fecha, valor_base, iva, centro_costo_id)
    values ('30000000-0000-4000-8000-000000000001', 'requisicion', v_orden, '40000000-0000-4000-8000-000000000001', current_date, null, 1000, 0, v_cc_obra)
    returning id into v_gasto;
  select obra_id into v_obra from public.gastos where id = v_gasto;
  if v_obra is null then raise exception 'el gasto con obra debía conservarla'; end if;
  begin
    update public.gastos set obra_id = null where id = v_gasto;
    raise exception 'se permitió quitar la obra a un gasto de un centro de tipo obra';
  exception when sqlstate '23514' then null;
  end;
end $$;

rollback;
