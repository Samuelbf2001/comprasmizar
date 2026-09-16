-- Post-check para 202609150003_centro_costo_tipo_empresa_facturada.sql sobre los datos legado de su
-- .pre.sql: la requisición hereda su propia sociedad como empresa facturada, el gasto de la orden copia
-- la de su requisición, el gasto de caja menor la de su obra, y el centro legado queda de tipo obra.
do $$
declare v_empresa uuid; v_tipo text;
begin
  select empresa_facturada_id into v_empresa from public.requisiciones where id = '93000000-0000-4000-8000-000000000506';
  if v_empresa is distinct from '93000000-0000-4000-8000-000000000501' then
    raise exception 'Backfill legado: la requisición debía heredar su sociedad como empresa facturada (obtenido %)', v_empresa;
  end if;

  select empresa_facturada_id into v_empresa from public.gastos where id = '93000000-0000-4000-8000-000000000508';
  if v_empresa is distinct from '93000000-0000-4000-8000-000000000501' then
    raise exception 'Backfill legado: el gasto de la orden debía copiar la empresa facturada de su requisición (obtenido %)', v_empresa;
  end if;

  select g.empresa_facturada_id into v_empresa
    from public.gastos g join public.caja_menor c on c.gasto_id = g.id
   where c.id = '93000000-0000-4000-8000-000000000509';
  if v_empresa is distinct from '93000000-0000-4000-8000-000000000501' then
    raise exception 'Backfill legado: el gasto de caja menor debía tomar la sociedad de su obra (obtenido %)', v_empresa;
  end if;

  select tipo into v_tipo from public.centros_costo where id = '93000000-0000-4000-8000-000000000502';
  if v_tipo is distinct from 'obra' then
    raise exception 'Backfill legado: un centro existente debe quedar de tipo obra (obtenido %)', v_tipo;
  end if;
end $$;
