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
--    TRAMPA (QA Postgres real, bloqueante): en Postgres >= 11, `ADD COLUMN ... DEFAULT <algo>` NO deja
--    la columna en NULL para las filas existentes — las rellena TODAS con el default de inmediato
--    (metadata-only backfill). Si esta columna naciera con `default current_date` puesto desde el
--    ADD COLUMN, el UPDATE de backfill de abajo (`where fecha_orden is null`) nunca encontraría una
--    sola fila que tocar: todo gasto histórico quedaría con `fecha_orden` = la fecha en que corrió
--    ESTA migración, no la fecha real del gasto — y como el backfill de más abajo pone `fecha = NULL`
--    para lo no pagado, esa fecha original se pierde SIN POSIBILIDAD de recuperarla después. Por eso
--    el orden aquí no es cosmético: (a) añadir la columna SIN default, (b) backfillear desde `fecha`
--    mientras esa columna sigue NULL de verdad, y SOLO ENTONCES (c) ponerle default y NOT NULL. No
--    "simplificar" esto de vuelta a un único ADD COLUMN con DEFAULT + NOT NULL: es exactamente el bug
--    que este comentario documenta. `default current_date` en el paso (c): el servicio
--    (ProcurementService) SIEMPRE pasa `fecha_orden` explícita — el default es solo la red de
--    seguridad para un insert de bajo nivel que no la mencione (p. ej.
--    supabase/tests/schema_verification.sql, arnés existente que esta tarea tiene prohibido tocar y
--    que inserta en `gastos` sin `fecha_orden`); sin él, esa fila NOT NULL rompería ese arnés.
-- ---------------------------------------------------------------------------
alter table public.gastos add column if not exists fecha_orden date;
update public.gastos set fecha_orden = fecha where fecha_orden is null;
alter table public.gastos alter column fecha_orden set default current_date;
alter table public.gastos alter column fecha_orden set not null;

-- ---------------------------------------------------------------------------
-- 2) gastos.fecha pasa a significar fecha de PAGO: se vuelve opcional. Postgres sí permite `drop not
--    null` sobre una columna referenciada por una GENERATED ALWAYS AS STORED (aquí, `periodo`): la
--    generada no impone ninguna restricción de no-nulidad sobre su expresión base, solo re-evalúa la
--    expresión (que con `fecha` NULL da `periodo` NULL). Verificado contra Postgres real en
--    supabase/tests/gasto_fecha_pago_verification.sql — ver informe de esta tarea para cómo se probó.
-- ---------------------------------------------------------------------------
alter table public.gastos alter column fecha drop not null;

-- Backfill de `origen = 'requisicion'`: en NULL por defecto (línea de abajo, cubre tanto "orden no
-- pagada" como "referencia_id huérfana" — un gasto de requisición cuyo `referencia_id` no casa con
-- ninguna fila de `ordenes`; QA Postgres real: la semántica vieja lo dejaba con `fecha` puesta porque
-- nunca se tocaba, pero sin una orden real que lo respalde lo razonable es tratarlo como no pagado,
-- igual que cualquier otro compromiso sin pagar), y solo se rellena con la fecha real de pago para las
-- órdenes efectivamente `pagada`.
update public.gastos g
   set fecha = null
 where g.origen = 'requisicion'
   and not exists (
     select 1 from public.ordenes o where o.id = g.referencia_id and o.estado_administrativo = 'pagada'
   );

-- `at time zone 'America/Bogota'` sobre un timestamptz da la hora de pared en Bogotá (UTC-5 fijo, sin
-- horario de verano) — mismo criterio que `colombiaDateParts()` (lib/services/procurement-service.ts),
-- aquí en SQL porque el backfill corre una sola vez en la base. QA Postgres real: `pagada_at` es
-- nullable a propósito (el esquema no ata `estado_administrativo = 'pagada'` a que `pagada_at` esté
-- puesto, ver 202609010001 ~línea 163) — una orden pagada con `pagada_at` NULL no debe perder la
-- fecha del gasto por eso; cae de vuelta a `fecha_orden` (su fecha de nacimiento) en vez de a NULL.
update public.gastos g
   set fecha = coalesce((o.pagada_at at time zone 'America/Bogota')::date, g.fecha_orden)
  from public.ordenes o
 where g.origen = 'requisicion' and g.referencia_id = o.id and o.estado_administrativo = 'pagada';

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
