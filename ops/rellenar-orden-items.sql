-- Rellena public.orden_items en una base YA CARGADA, sin recargar el seed.
--
-- POR QUÉ EXISTE
-- supabase/seed-demo.sql creaba las cinco órdenes de demostración y ninguna fila de enlace con sus
-- ítems, así que la ficha lateral de cualquiera de ellas mostraba "0 ítems de esta orden · No fue
-- posible cargar los ítems de esta orden". No era un fallo de carga: `listVisibleOrders` sí hidrata
-- `lines` (el json_agg de requisicion_items), pero el `left join orden_items` no encontraba nada.
-- Las órdenes REALES nunca lo tuvieron — `generateOrders` escribe estas filas al generarlas.
--
-- El seed ya viene corregido, pero recargarlo en producción borraría lo que se haya hecho encima
-- (requisiciones radicadas de verdad, aprobaciones, teléfonos repuestos). Este guion arregla lo ya
-- cargado sin tocar nada más.
--
-- CRITERIO, el mismo que aplica generateOrders y el mismo que el seed corregido — las dos consultas
-- son idénticas a propósito, para que no puedan divergir:
--   los ítems VIGENTES de la requisición de origen (todo lo que no esté declinado, igual que
--   `approvedLines` en lib/domain/rules.ts) cuyo proveedor final sea el de la orden; y si en esa
--   requisición NINGÚN ítem tiene proveedor asignado, todos los vigentes.
--
-- SEGURO DE REPETIR. El `not exists` hace dos cosas distintas y ambas importan:
--   - idempotencia: correrlo dos veces no cambia nada la segunda;
--   - y sobre todo, NO TOCA una orden que ya tenga ítems. Una orden creada desde la plataforma
--     nunca entra aquí, así que este guion no puede alterar una orden real.
-- El `on conflict do nothing` es el segundo cinturón, sobre la clave primaria (orden_id,
-- requisicion_item_id).
--
-- USO
--   docker compose -p mizar exec -T db psql -U mizar -d mizar -v ON_ERROR_STOP=1 \
--     -f /dev/stdin < ops/rellenar-orden-items.sql
--
-- Imprime qué va a tocar ANTES de tocarlo, y el resultado después. Todo dentro de una transacción:
-- si algo falla, no queda a medias.

begin;

-- 1. Qué órdenes están sin ítems y cuántas líneas les correspondería recibir.
--    Si esta consulta sale vacía, no hay nada que hacer y el resto no cambia nada.
select o.consecutivo,
       o.tipo,
       p.razon_social as proveedor,
       r.consecutivo  as requisicion,
       count(ri.id)   as lineas_a_enlazar
  from public.ordenes o
  join public.requisiciones r on r.id = o.requisicion_id
  left join public.proveedores p on p.id = o.proveedor_id
  left join public.requisicion_items ri
         on ri.requisicion_id = o.requisicion_id
        and ri.estado <> 'declinado'
        and (ri.proveedor_final_id = o.proveedor_id
             or not exists (select 1 from public.requisicion_items x
                             where x.requisicion_id = o.requisicion_id
                               and x.proveedor_final_id is not null))
 where not exists (select 1 from public.orden_items oi where oi.orden_id = o.id)
 group by o.id, o.consecutivo, o.tipo, p.razon_social, r.consecutivo
 order by o.consecutivo;

-- 2. El relleno.
insert into public.orden_items (orden_id, requisicion_item_id)
select o.id, ri.id
  from public.ordenes o
  join public.requisicion_items ri on ri.requisicion_id = o.requisicion_id
 where ri.estado <> 'declinado'
   and (ri.proveedor_final_id = o.proveedor_id
        or not exists (select 1 from public.requisicion_items x
                        where x.requisicion_id = o.requisicion_id
                          and x.proveedor_final_id is not null))
   and not exists (select 1 from public.orden_items oi where oi.orden_id = o.id)
on conflict do nothing;

-- 3. Comprobación: ninguna orden puede quedar sin ítems, y ningún enlace puede apuntar a un ítem
--    declinado o de otra requisición. Si algo de esto falla, el rollback deja la base como estaba.
do $$
declare v_sin_items int; v_declinados int; v_cruzados int;
begin
  select count(*) into v_sin_items
    from public.ordenes o
   where not exists (select 1 from public.orden_items oi where oi.orden_id = o.id);
  if v_sin_items <> 0 then
    raise exception 'quedan % orden(es) sin ningun item enlazado', v_sin_items;
  end if;

  select count(*) into v_declinados
    from public.orden_items oi
    join public.requisicion_items ri on ri.id = oi.requisicion_item_id
   where ri.estado = 'declinado';
  if v_declinados <> 0 then
    raise exception '% enlace(s) apuntan a un item declinado', v_declinados;
  end if;

  select count(*) into v_cruzados
    from public.orden_items oi
    join public.ordenes o on o.id = oi.orden_id
    join public.requisicion_items ri on ri.id = oi.requisicion_item_id
   where ri.requisicion_id <> o.requisicion_id;
  if v_cruzados <> 0 then
    raise exception '% enlace(s) apuntan a un item de OTRA requisicion', v_cruzados;
  end if;
end $$;

-- 4. Cómo quedó.
select o.consecutivo, count(oi.requisicion_item_id) as items
  from public.ordenes o
  left join public.orden_items oi on oi.orden_id = o.id
 group by o.id, o.consecutivo
 order by o.consecutivo;

commit;
