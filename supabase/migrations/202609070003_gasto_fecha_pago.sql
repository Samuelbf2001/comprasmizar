-- Decisión del cliente (reunión 2026-09, literal): "que quede como fechas aparte cuándo se sube y
-- cuándo se paga; la del gasto es la del pago". Hasta hoy `gastos.fecha` se poblaba en el momento en
-- que nacía el registro (generación de la orden, o el movimiento de caja menor) y de ahí salían el
-- reporte de gastos por periodo y el dashboard. Eso mezclaba dos cosas distintas: cuándo se
-- COMPROMETE el dinero (se genera la orden) y cuándo se GASTA de verdad (se paga). Esta migración
-- separa ambas fechas:
--   - `fecha_orden`: nace con el registro, nunca cambia. Generación de la orden o fecha del
--     movimiento de caja menor.
--   - `fecha`: pasa a significar FECHA DE PAGO. Para `origen = 'requisicion'` queda NULL hasta que la
--     orden se marca pagada (es un compromiso, no un gasto, todavía). Para `origen = 'caja_menor'` NO
--     cambia de comportamiento: se paga en el acto, así que `fecha` sigue siendo la del movimiento.
--   - `periodo` (columna generada a partir de `fecha`) hereda NULL mientras no se paga — es
--     exactamente el significado correcto: un gasto sin pagar no pertenece a ningún periodo de cierre.
-- Todo aditivo salvo dos `drop not null`, documentados abajo. Nada de `drop column`, nada de
-- `alter type ... add value`. Idempotente al estilo del repo (add column if not exists, backfills
-- repetibles, create or replace).

-- ---------------------------------------------------------------------------
-- 1) gastos.fecha_orden: nace = fecha (el significado que `fecha` tenía HASTA esta migración).
--    `default current_date`: el servicio (ProcurementService) SIEMPRE la pasa explícita — el default
--    es solo la red de seguridad para un insert de bajo nivel que no la mencione (p. ej.
--    supabase/tests/schema_verification.sql, arnés existente que esta tarea tiene prohibido tocar y
--    que inserta en `gastos` sin `fecha_orden`); sin él, esa fila NOT NULL rompería ese arnés.
-- ---------------------------------------------------------------------------
alter table public.gastos add column if not exists fecha_orden date default current_date;
update public.gastos set fecha_orden = fecha where fecha_orden is null;
alter table public.gastos alter column fecha_orden set not null;

-- ---------------------------------------------------------------------------
-- 2) gastos.fecha pasa a significar fecha de PAGO: se vuelve opcional. Postgres sí permite `drop not
--    null` sobre una columna referenciada por una GENERATED ALWAYS AS STORED (aquí, `periodo`): la
--    generada no impone ninguna restricción de no-nulidad sobre su expresión base, solo re-evalúa la
--    expresión (que con `fecha` NULL da `periodo` NULL). Verificado contra Postgres real en
--    supabase/tests/gasto_fecha_pago_verification.sql — ver informe de esta tarea para cómo se probó.
-- ---------------------------------------------------------------------------
alter table public.gastos alter column fecha drop not null;

-- Backfill de `origen = 'requisicion'`: fecha de pago (hora Colombia) si la orden que generó el gasto
-- ya está pagada; NULL si no. `at time zone 'America/Bogota'` sobre un timestamptz da la hora de pared
-- en Bogotá (UTC-5 fijo, sin horario de verano) — mismo criterio que `colombiaDateParts()`
-- (lib/services/procurement-service.ts), aquí en SQL porque el backfill corre una sola vez en la base.
update public.gastos g
   set fecha = (o.pagada_at at time zone 'America/Bogota')::date
  from public.ordenes o
 where g.origen = 'requisicion' and g.referencia_id = o.id and o.estado_administrativo = 'pagada';

update public.gastos g
   set fecha = null
  from public.ordenes o
 where g.origen = 'requisicion' and g.referencia_id = o.id and o.estado_administrativo <> 'pagada';

-- `origen = 'caja_menor'` NO se toca: ya quedó en su valor correcto (= fecha_orden, backfilleada en el
-- paso 1) porque la caja menor se paga en el acto.

comment on column public.gastos.fecha_orden is
  'Fecha en que nace el registro: generación de la orden (ordenes.fecha_generacion) o fecha del '
  'movimiento de caja menor. Fija desde el alta, nunca se recalcula.';
comment on column public.gastos.fecha is
  'Decisión del cliente (reunión 2026-09): la fecha del GASTO es la fecha de PAGO, no la de '
  'generación. NULL mientras la orden que lo originó no se ha pagado (es un compromiso, todavía no '
  'un gasto) — periodo (columna generada) hereda ese NULL a propósito, porque un gasto sin pagar no '
  'pertenece a ningún periodo de cierre. Para origen = caja_menor coincide siempre con fecha_orden: '
  'se paga en el acto.';

-- ---------------------------------------------------------------------------
-- 3) sincronizar_gasto_caja_menor (migración base 202608240001_core_compras.sql): ahora escribe
--    también fecha_orden, además de fecha, en el insert y en el update. Reescritura completa
--    (create or replace no hace merge).
-- ---------------------------------------------------------------------------
create or replace function public.sincronizar_gasto_caja_menor()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_gasto uuid; begin
  if tg_op = 'INSERT' then
    insert into public.gastos(obra_id, origen, referencia_id, etiqueta_id, proveedor_id, fecha_orden, fecha, valor_base, iva)
    values (new.obra_id, 'caja_menor', new.id, new.etiqueta_id, new.proveedor_id, new.fecha, new.fecha, new.valor, 0)
    returning id into v_gasto;
    new.gasto_id := v_gasto;
  elsif new.gasto_id is not null then
    update public.gastos set obra_id = new.obra_id, etiqueta_id = new.etiqueta_id, proveedor_id = new.proveedor_id,
      fecha_orden = new.fecha, fecha = new.fecha, valor_base = new.valor, iva = 0 where id = new.gasto_id;
  end if;
  return new;
end; $$;
