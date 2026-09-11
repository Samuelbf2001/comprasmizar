-- Arnés de public.orden_items sobre los datos de supabase/seed-demo.sql.
--
-- Es el PRIMER arnés que se ejecuta con el seed de demostración cargado. Hasta ahora
-- scripts/verify-schema.ts solo corría supabase/seed.sql, así que el seed de demostración —el que
-- se usa para enseñar el producto y el que se carga en el servidor— no lo verificaba nadie. De ahí
-- que nadie notara que creaba cinco órdenes y ninguna fila de enlace con sus ítems: la ficha lateral
-- de cualquier orden decía "0 ítems de esta orden" y el fallo solo se veía mirando la pantalla.
--
-- Formato del repo: begin -> do $$ ... $$ (uno por grupo, para que el mensaje señale cuál falló) ->
-- rollback, así nunca deja basura en la base contra la que se ejecuta.
begin;

-- 1. Si la requisición de origen tenía ítems que enlazar, la orden los tiene enlazados.
--
--    Es la aserción que habría atrapado el defecto. `generateOrders` (postgres-repositories.ts)
--    siempre escribe estas filas, así que una orden sin ellas solo puede venir de datos sembrados a
--    mano — que es exactamente lo que pasaba con las cinco del seed de demostración.
--
--    Condicionada a que haya algo que enlazar, y no "toda orden tiene ítems" a secas, por un motivo
--    concreto: los fixtures legados (supabase/tests/legacy/202609070003_gasto_fecha_pago.pre.sql)
--    siembran dos órdenes —OC-LEGADO-FP-0001 y -0002— cuyas requisiciones no tienen ni un solo
--    `requisicion_items`, porque solo existen para probar el backfill de la fecha de pago. Excluirlas
--    por el nombre sería frágil; así quedan fuera por su propia forma, y la invariante dice algo más
--    fuerte: si había algo que enlazar, se enlazó.
do $$
declare v_sin_items int; v_ejemplo text;
begin
  select count(*), min(o.consecutivo) into v_sin_items, v_ejemplo
    from public.ordenes o
   where exists (select 1 from public.requisicion_items ri
                  where ri.requisicion_id = o.requisicion_id and ri.estado <> 'declinado')
     and not exists (select 1 from public.orden_items oi where oi.orden_id = o.id);
  if v_sin_items <> 0 then
    raise exception 'hay % orden(es) cuya requisicion tiene items vigentes pero sin ninguno enlazado (p. ej. %): su ficha mostrara "0 items de esta orden"', v_sin_items, v_ejemplo;
  end if;
end $$;

-- 2. Ningún enlace apunta a un ítem declinado ni a un ítem de OTRA requisición.
--
--    Lo segundo no lo impide ninguna restricción de la base: orden_items solo declara dos claves
--    foráneas sueltas (a ordenes y a requisicion_items), sin nada que exija que el ítem pertenezca a
--    la requisición de la orden. Esa coherencia vive en la capa de servicio, así que aquí se
--    comprueba el resultado.
do $$
declare v_declinados int; v_cruzados int;
begin
  select count(*) into v_declinados
    from public.orden_items oi
    join public.requisicion_items ri on ri.id = oi.requisicion_item_id
   where ri.estado = 'declinado';
  if v_declinados <> 0 then
    raise exception '% enlace(s) apuntan a un item declinado; un item declinado no se ordena (ver approvedLines en lib/domain/rules.ts)', v_declinados;
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

-- 3. El enlace corresponde al proveedor de la orden.
--
--    Una orden es de UN proveedor: `generateOrders` parte la requisición por proveedor final. La
--    excepción admitida —y la única— es la requisición donde ningún ítem tiene proveedor asignado
--    todavía, en la que entran todos los vigentes.
do $$
declare v_ajenos int;
begin
  select count(*) into v_ajenos
    from public.orden_items oi
    join public.ordenes o on o.id = oi.orden_id
    join public.requisicion_items ri on ri.id = oi.requisicion_item_id
   where ri.proveedor_final_id is not null
     and ri.proveedor_final_id <> o.proveedor_id;
  if v_ajenos <> 0 then
    raise exception '% enlace(s) llevan un item cuyo proveedor final no es el de la orden', v_ajenos;
  end if;
end $$;

-- 4. Comportamiento: la sentencia de relleno es IDEMPOTENTE.
--
--    Es la misma que están en supabase/seed-demo.sql y en ops/rellenar-orden-items.sql. Importa
--    porque el guion de ops se aplica sobre una base viva y puede correrse dos veces por error: la
--    segunda no debe insertar nada. El `not exists` sobre orden_items es lo que lo garantiza, y de
--    paso es lo que impide que el relleno toque una orden creada desde la plataforma.
do $$
declare v_antes bigint; v_despues bigint;
begin
  select count(*) into v_antes from public.orden_items;

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

  select count(*) into v_despues from public.orden_items;
  if v_despues <> v_antes then
    raise exception 'el relleno no es idempotente: volvio a insertar % fila(s)', v_despues - v_antes;
  end if;
end $$;

-- 5. Y hay ítems de verdad: que el seed cargue algo no lo garantiza si mañana alguien poda las
--    requisiciones de demostración. Sin esto, los bloques de arriba pasarían con la tabla vacía.
do $$
declare v_enlazables int; v_enlaces bigint;
begin
  -- Órdenes que SÍ tienen algo que enlazar (las legadas, sin ítems, no cuentan; ver el bloque 1).
  select count(*) into v_enlazables
    from public.ordenes o
   where exists (select 1 from public.requisicion_items ri
                  where ri.requisicion_id = o.requisicion_id and ri.estado <> 'declinado');
  select count(*) into v_enlaces from public.orden_items;
  if v_enlazables = 0 then
    raise exception 'el seed de demostracion no dejo ninguna orden con items que enlazar';
  end if;
  if v_enlaces < v_enlazables then
    raise exception 'hay % orden(es) enlazables pero solo % enlace(s): falta al menos un item por orden', v_enlazables, v_enlaces;
  end if;
end $$;

rollback;
