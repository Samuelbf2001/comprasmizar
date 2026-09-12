-- Post-check para 202609120001_centros_costo.sql, ejecutado JUSTO DESPUÉS de esa migración sobre los
-- datos legado sembrados por 202609120001_centros_costo.pre.sql (ver el mecanismo documentado en el
-- encabezado de scripts/verify-schema.ts y en docs/modelo-datos.md).
--
-- Por qué existe: sobre una base VACÍA (el resto de este arnés, centros_costo_verification.sql) un
-- backfill no-op y uno correcto son indistinguibles — no hay ninguna fila previa que backfillear. Este
-- archivo SÍ distingue: si el backfill dejara `centro_costo_id` NULL en vez de derivarlo de la obra, o
-- si la disambiguación de nombres duplicados no funcionara, las aserciones de abajo lo detectan contra
-- datos que se comportan como una base real. No hace falta rollback/limpieza: ver la nota de namespace
-- de IDs en el .pre.sql de este mismo par.

-- Las DOS obras homónimas ('Legado CC Obra', sociedades distintas) recibieron cada una su PROPIO
-- centro (id = id de su obra, por el truco de backfill) con nombres DISTINTOS entre sí — la
-- disambiguación por sufijo de id evitó chocar contra la unicidad global de centros_costo.nombre.
do $$
declare v_centro_a uuid; v_centro_b uuid; v_nombre_a text; v_nombre_b text;
begin
  select centro_costo_id into v_centro_a from public.obras where id = '90000000-0000-4000-8000-000000000303';
  select centro_costo_id into v_centro_b from public.obras where id = '90000000-0000-4000-8000-000000000304';
  if v_centro_a is null or v_centro_b is null then
    raise exception 'Backfill legado: ambas obras homónimas deben terminar con un centro de costo (obtenido a=%, b=%)', v_centro_a, v_centro_b;
  end if;
  if v_centro_a = v_centro_b then
    raise exception 'Backfill legado: dos obras de sociedades distintas NUNCA deben terminar compartiendo el mismo centro solo por tener el mismo nombre';
  end if;
  select nombre into v_nombre_a from public.centros_costo where id = v_centro_a;
  select nombre into v_nombre_b from public.centros_costo where id = v_centro_b;
  if v_nombre_a = v_nombre_b then
    raise exception 'Backfill legado: los nombres de los centros disambiguados no deben quedar iguales (a=%, b=%)', v_nombre_a, v_nombre_b;
  end if;
  if v_nombre_a !~ ('^Legado CC Obra \(' || right(v_centro_a::text, 8) || '\)$')
    or v_nombre_b !~ ('^Legado CC Obra \(' || right(v_centro_b::text, 8) || '\)$') then
    raise exception 'Backfill legado: el nombre disambiguado debe ser "Legado CC Obra (<8 últimos del id>)" — obtenido a=%, b=%', v_nombre_a, v_nombre_b;
  end if;
end $$;

-- La requisición y el gasto de la orden legado heredaron el centro de SU obra (la A).
do $$
declare v_centro_obra_a uuid; v_centro_requisicion uuid; v_centro_gasto uuid;
begin
  select centro_costo_id into v_centro_obra_a from public.obras where id = '90000000-0000-4000-8000-000000000303';
  select centro_costo_id into v_centro_requisicion from public.requisiciones where id = '90000000-0000-4000-8000-000000000307';
  select centro_costo_id into v_centro_gasto from public.gastos where id = '90000000-0000-4000-8000-000000000309';
  if v_centro_requisicion is distinct from v_centro_obra_a then
    raise exception 'La requisición legado debe heredar el centro de costo de su obra (esperado %, obtenido %)', v_centro_obra_a, v_centro_requisicion;
  end if;
  if v_centro_gasto is distinct from v_centro_obra_a then
    raise exception 'El gasto legado (orden) debe heredar el centro de costo de su obra (esperado %, obtenido %)', v_centro_obra_a, v_centro_gasto;
  end if;
end $$;

-- El gasto de caja menor legado también heredó el centro de la obra A.
do $$
declare v_centro_obra_a uuid; v_centro_gasto_caja uuid;
begin
  select centro_costo_id into v_centro_obra_a from public.obras where id = '90000000-0000-4000-8000-000000000303';
  select g.centro_costo_id into v_centro_gasto_caja
    from public.gastos g join public.caja_menor c on c.gasto_id = g.id
    where c.id = '90000000-0000-4000-8000-00000000030a';
  if v_centro_gasto_caja is distinct from v_centro_obra_a then
    raise exception 'El gasto de caja menor legado debe heredar el centro de costo de su obra (esperado %, obtenido %)', v_centro_obra_a, v_centro_gasto_caja;
  end if;
end $$;
