-- Arnés de 202609150003_centro_costo_tipo_empresa_facturada.sql. Registrado en scripts/verify-schema.ts.
-- Formato del repo: begin -> do $$ ... $$ (uno por grupo) -> rollback. El backfill sobre datos legado
-- lo cubre supabase/tests/legacy/202609150003_centro_costo_tipo_empresa_facturada.{pre,post}.sql.
begin;

-- 1. Objetos: tipo con default y CHECK; empresa facturada NOT NULL con FK; columna en gastos; índices.
do $$
declare v_tipo text; v_nullable text;
begin
  select column_default, is_nullable into v_tipo, v_nullable from information_schema.columns
   where table_schema = 'public' and table_name = 'centros_costo' and column_name = 'tipo';
  if v_tipo is null or v_nullable <> 'NO' then raise exception 'centros_costo.tipo debe ser NOT NULL con default'; end if;
  select is_nullable into v_nullable from information_schema.columns
   where table_schema = 'public' and table_name = 'requisiciones' and column_name = 'empresa_facturada_id';
  if v_nullable is distinct from 'NO' then raise exception 'requisiciones.empresa_facturada_id debe existir y ser NOT NULL (obtenido %)', v_nullable; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'gastos' and column_name = 'empresa_facturada_id') then
    raise exception 'falta gastos.empresa_facturada_id';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'requisiciones_1_empresa_facturada' and not tgisinternal) then
    raise exception 'falta el trigger requisiciones_1_empresa_facturada';
  end if;
  if not exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 'gastos' and indexname = 'gastos_empresa_facturada_periodo_idx')
    or not exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 'requisiciones' and indexname = 'requisiciones_empresa_facturada_idx') then
    raise exception 'faltan los índices de empresa facturada';
  end if;
  if exists (select 1 from public.centros_costo where tipo <> 'obra') then
    raise exception 'los centros nacidos del backfill de 202609120001 deben ser de tipo obra';
  end if;
end $$;

-- 2. centros_costo.tipo: default obra, admite los cuatro valores, rechaza cualquier otro.
do $$
declare v_tipo text;
begin
  insert into public.centros_costo (nombre) values ('CC Tipo Default Test') returning tipo into v_tipo;
  if v_tipo <> 'obra' then raise exception 'tipo por defecto debía ser obra, es %', v_tipo; end if;
  insert into public.centros_costo (nombre, tipo) values ('CC Administrativo Test', 'administrativo'), ('CC Personal Test', 'personal'), ('CC Empresa Test', 'empresa');
  begin
    insert into public.centros_costo (nombre, tipo) values ('CC Tipo Inválido Test', 'proyecto');
    raise exception 'se aceptó un tipo de centro de costo fuera del CHECK';
  exception when check_violation then null;
  end;
end $$;

-- 3. Empresa facturada: sin informar, la de la requisición (también cuando la sociedad se deriva de la
--    obra, canal público); informada, se respeta aunque sea otra sociedad; ponerla en NULL la vuelve a
--    derivar; una sociedad inexistente rebota por FK.
do $$
declare v_req uuid; v_empresa uuid;
begin
  insert into public.requisiciones(consecutivo, tipo, obra_id, solicitante_id, canal)
    values ('', 'compra', '30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'web')
    returning id, empresa_facturada_id into v_req, v_empresa;
  if v_empresa is distinct from '20000000-0000-4000-8000-000000000001' then
    raise exception 'sin empresa explícita debía derivarse la de la obra/requisición (Mizar), obtenido %', v_empresa;
  end if;

  update public.requisiciones set empresa_facturada_id = '20000000-0000-4000-8000-000000000004' where id = v_req;
  select empresa_facturada_id into v_empresa from public.requisiciones where id = v_req;
  if v_empresa <> '20000000-0000-4000-8000-000000000004' then raise exception 'la empresa facturada explícita (Proim) no se respetó'; end if;

  update public.requisiciones set empresa_facturada_id = null where id = v_req;
  select empresa_facturada_id into v_empresa from public.requisiciones where id = v_req;
  if v_empresa is distinct from '20000000-0000-4000-8000-000000000001' then raise exception 'al poner NULL debía volver a la sociedad de la requisición, obtenido %', v_empresa; end if;

  begin
    update public.requisiciones set empresa_facturada_id = '20000000-0000-4000-8000-0000000000ff' where id = v_req;
    raise exception 'se aceptó una empresa facturada inexistente';
  exception when foreign_key_violation then null;
  end;
end $$;

-- 4. gastos.empresa_facturada_id se guarda como instantánea (el INSERT la fija) y sobrevive a un
--    cambio posterior de la requisición — no es una referencia viva.
do $$
declare v_req uuid; v_orden uuid; v_gasto uuid; v_empresa uuid;
begin
  insert into public.requisiciones(consecutivo, tipo, obra_id, solicitante_id, canal, empresa_facturada_id)
    values ('', 'pago', '30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'web', '20000000-0000-4000-8000-000000000004')
    returning id into v_req;
  insert into public.ordenes(consecutivo, tipo, requisicion_id, proveedor_id, fecha_generacion)
    values ('OP-TEST-EF-0001', 'OP', v_req, '40000000-0000-4000-8000-000000000001', now())
    returning id into v_orden;
  insert into public.gastos(obra_id, origen, referencia_id, proveedor_id, fecha_orden, fecha, valor_base, iva, centro_costo_id, empresa_facturada_id)
    values ('30000000-0000-4000-8000-000000000001', 'requisicion', v_orden, '40000000-0000-4000-8000-000000000001', current_date, null, 100000, 0,
            (select centro_costo_id from public.obras where id = '30000000-0000-4000-8000-000000000001'), '20000000-0000-4000-8000-000000000004')
    returning id into v_gasto;
  update public.requisiciones set empresa_facturada_id = '20000000-0000-4000-8000-000000000001' where id = v_req;
  select empresa_facturada_id into v_empresa from public.gastos where id = v_gasto;
  if v_empresa <> '20000000-0000-4000-8000-000000000004' then raise exception 'la instantánea del gasto no debe moverse al cambiar la requisición'; end if;
end $$;

rollback;
