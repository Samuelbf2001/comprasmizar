-- Post-check para 202609120003_cajas_ingresos_cierres.sql, ejecutado JUSTO DESPUÉS de esa migración
-- sobre el movimiento legado sembrado por 202609120003_cajas_ingresos_cierres.pre.sql (mecanismo
-- documentado en el encabezado de scripts/verify-schema.ts).
--
-- Por qué existe: sobre una base VACÍA (el resto de este arnés, cajas_ingresos_cierres_verification.sql
-- corre en una base recién migrada, sin movimientos previos) un backfill no-op y uno correcto son
-- indistinguibles. Esta fila SÍ distingue: si el backfill dejara `caja_id`/`medio_pago` en NULL en vez
-- de asignar la caja "Caja menor" y 'efectivo', o si el gasto que ya tenía este movimiento no se
-- resincronizara con esos valores, las aserciones de abajo lo detectan contra un dato que se comporta
-- como una base real (a diferencia de un caja_menor recién insertado por el harness normal, que nace ya
-- con caja_id porque lo manda el INSERT).

do $$
declare v_caja_menor_default uuid; v_caja_id uuid; v_medio_pago text; v_iva numeric;
begin
  select id into v_caja_menor_default from public.cajas where nombre = 'Caja menor';
  if v_caja_menor_default is null then
    raise exception 'Backfill: debe existir una caja "Caja menor" por defecto';
  end if;
  select caja_id, medio_pago::text, iva into v_caja_id, v_medio_pago, v_iva
    from public.caja_menor where id = '91000000-0000-4000-8000-000000000304';
  if v_caja_id is distinct from v_caja_menor_default then
    raise exception 'Backfill legado: el movimiento de caja menor previo a la migración debe quedar asignado a la caja "Caja menor" por defecto (esperado %, obtenido %)', v_caja_menor_default, v_caja_id;
  end if;
  if v_medio_pago is distinct from 'efectivo' then
    raise exception 'Backfill legado: un movimiento de caja menor sin medio de pago capturado debe backfillearse a ''efectivo'' (obtenido %)', v_medio_pago;
  end if;
  if v_iva is distinct from 0 then
    raise exception 'Backfill legado: un movimiento sin IVA capturado debe quedar en 0 (obtenido %)', v_iva;
  end if;
end $$;

-- El gasto que YA existía (creado por sincronizar_gasto_caja_menor antes de esta migración) debe
-- resincronizarse con los mismos valores backfilleados en cuanto la fila de caja_menor se vuelva a
-- tocar — aquí se fuerza un UPDATE inocuo (misma fecha) solo para disparar el trigger reescrito y
-- comprobar que copia caja_id/medio_pago/iva/concepto/registrado_por al gasto.
do $$
declare v_gasto_id uuid; v_caja_id uuid; v_medio_pago text; v_iva numeric; v_concepto text; v_registrado_por uuid;
begin
  update public.caja_menor set fecha = fecha where id = '91000000-0000-4000-8000-000000000304' returning gasto_id into v_gasto_id;
  if v_gasto_id is null then raise exception 'El movimiento legado debe tener un gasto sincronizado'; end if;
  select caja_id, medio_pago::text, iva, concepto, registrado_por into v_caja_id, v_medio_pago, v_iva, v_concepto, v_registrado_por
    from public.gastos where id = v_gasto_id;
  if v_caja_id is null or v_medio_pago is distinct from 'efectivo' or v_iva is distinct from 0
    or v_concepto is distinct from 'Legado caja menor sin caja' or v_registrado_por is distinct from '91000000-0000-4000-8000-000000000303'::uuid then
    raise exception 'El gasto sincronizado del movimiento legado debe llevar caja_id/medio_pago/iva/concepto/registrado_por copiados (caja=%, medio=%, iva=%, concepto=%, registrado_por=%)',
      v_caja_id, v_medio_pago, v_iva, v_concepto, v_registrado_por;
  end if;
end $$;
