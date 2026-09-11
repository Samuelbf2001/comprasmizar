-- Post-check para 202609070003_gasto_fecha_pago.sql, ejecutado JUSTO DESPUÉS de esa migración sobre
-- los datos legado sembrados por 202609070003_gasto_fecha_pago.pre.sql (ver el mecanismo documentado
-- en el encabezado de scripts/verify-schema.ts y en docs/modelo-datos.md).
--
-- Por qué existe: sobre una base VACÍA (el resto de este arnés, gasto_fecha_pago_verification.sql)
-- un backfill no-op y uno correcto son indistinguibles — no hay ninguna fila previa que backfillear.
-- Este archivo SÍ distingue: con el bug original (`add column fecha_orden date default current_date`
-- ANTES del backfill) Postgres rellena la columna con el default en el propio ADD COLUMN, así que el
-- UPDATE `where fecha_orden is null` de más abajo nunca encuentra nada que tocar y todo gasto legado
-- queda con `fecha_orden` = la fecha en que corrió la migración, no su fecha real de agosto. Formato:
-- bloques `do $$ ... raise exception ... $$`, uno por aserción, para que el mensaje señale cuál falló.
-- No hace falta rollback/limpieza: ver la nota de namespace de IDs en el .pre.sql de este mismo par.

-- El gasto de la orden LEGADO PAGADA: fecha_orden conserva su fecha original de agosto (no la del
-- backfill ni la de hoy); fecha queda en hora COLOMBIA a partir de pagada_at (2026-09-01 03:30 UTC =
-- 2026-08-31 22:30 en Bogotá, UTC-5 fijo -> fecha = 2026-08-31, NUNCA 2026-09-01); periodo se deriva
-- solo (columna generada) a partir de esa fecha.
do $$
declare v_fecha_orden date; v_fecha date; v_periodo date;
begin
  select fecha_orden, fecha, periodo into v_fecha_orden, v_fecha, v_periodo
    from public.gastos where id = '90000000-0000-4000-8000-000000000007';
  if v_fecha_orden is distinct from '2026-08-10'::date or v_fecha is distinct from '2026-08-31'::date or v_periodo is distinct from '2026-08-01'::date then
    raise exception 'Gasto legado de orden PAGADA: esperado fecha_orden=2026-08-10, fecha=2026-08-31, periodo=2026-08-01 — obtenido fecha_orden=%, fecha=%, periodo=%',
      v_fecha_orden, v_fecha, v_periodo;
  end if;
end $$;

-- El gasto de la orden LEGADO PENDIENTE: fecha_orden conserva su fecha original de agosto; fecha queda
-- NULL (compromiso, todavía no un gasto pagado) y periodo hereda ese NULL.
do $$
declare v_fecha_orden date; v_fecha date; v_periodo date;
begin
  select fecha_orden, fecha, periodo into v_fecha_orden, v_fecha, v_periodo
    from public.gastos where id = '90000000-0000-4000-8000-00000000000a';
  if v_fecha_orden is distinct from '2026-08-20'::date or v_fecha is not null or v_periodo is not null then
    raise exception 'Gasto legado de orden PENDIENTE: esperado fecha_orden=2026-08-20, fecha/periodo NULL — obtenido fecha_orden=%, fecha=%, periodo=%',
      v_fecha_orden, v_fecha, v_periodo;
  end if;
end $$;

-- El gasto de caja menor legado: el backfill de `origen = 'requisicion'` no lo toca (es
-- `origen = 'caja_menor'`); fecha sigue igual a fecha_orden, tal como nació.
do $$
declare v_fecha_orden date; v_fecha date; v_periodo date;
begin
  select g.fecha_orden, g.fecha, g.periodo into v_fecha_orden, v_fecha, v_periodo
    from public.gastos g join public.caja_menor c on c.gasto_id = g.id
    where c.id = '90000000-0000-4000-8000-00000000000b';
  if v_fecha_orden is distinct from '2026-08-25'::date or v_fecha is distinct from '2026-08-25'::date or v_periodo is distinct from '2026-08-01'::date then
    raise exception 'Gasto legado de caja menor: esperado fecha_orden=fecha=2026-08-25, periodo=2026-08-01 — obtenido fecha_orden=%, fecha=%, periodo=%',
      v_fecha_orden, v_fecha, v_periodo;
  end if;
end $$;
