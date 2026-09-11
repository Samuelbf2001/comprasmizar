-- Arnés de 202609110004_aprobador_por_item.sql. Registrado en scripts/verify-schema.ts.
-- Formato del repo: begin -> do $$ ... $$ -> rollback.
--
-- Lo que se prueba aquí no cabe en una unidad, porque no vive en TypeScript: las policies de RLS, el
-- trigger de transición y el guardián de la baja de usuarios son reglas de la BASE. Un doble de `sql`
-- comprobaría que llamamos a la consulta, no que la regla esté bien escrita — y la regla es lo único
-- que importa el día que alguien entre por fuera de la aplicación.
--
-- AVISO HONESTO SOBRE EL ALCANCE: hoy la aplicación NO se apoya en estas policies. Se conecta con el
-- rol dueño de las tablas (ver .env.example) y autoriza en el servicio (`NOT_ASSIGNED_APPROVER`), así
-- que RLS es defensa en profundidad. La cerradura principal del «no puedo decidir ítems ajenos» son
-- las pruebas de servicio y del token firmado, no este archivo.
begin;

-- 1. La columna, el índice parcial y el trigger de elegibilidad existen.
do $$
declare v_count int;
begin
  select count(*) into v_count from information_schema.columns
   where table_schema='public' and table_name='requisicion_items' and column_name='aprobador_id';
  if v_count <> 1 then raise exception 'falta requisicion_items.aprobador_id'; end if;

  select count(*) into v_count from pg_indexes
   where schemaname='public' and tablename='requisicion_items' and indexname='requisicion_items_aprobador_idx';
  if v_count <> 1 then raise exception 'falta el índice parcial sobre requisicion_items.aprobador_id'; end if;

  select count(*) into v_count from pg_trigger
   where tgname='requisicion_items_aprobador_elegible' and not tgisinternal;
  if v_count <> 1 then raise exception 'falta el trigger de elegibilidad del aprobador por ítem'; end if;
end $$;

-- 2. `es_aprobador_de`: cabecera O ítem, y nadie más. Es la pieza de la que cuelgan las cuatro policies,
--    así que se comprueba sola antes de comprobarlas a través de ellas.
do $$
declare
  v_req uuid; v_item uuid;
  c_solicitante constant uuid := '10000000-0000-4000-8000-000000000001';
  c_cabecera    constant uuid := '10000000-0000-4000-8000-000000000003'; -- Nelson, aprobador
  c_por_item    constant uuid := '10000000-0000-4000-8000-000000000007'; -- Juliana, aprobadora
  c_contable    constant uuid := '10000000-0000-4000-8000-000000000004';
begin
  insert into public.requisiciones(consecutivo, tipo, obra_id, solicitante_id, canal)
    values ('', 'compra', '30000000-0000-4000-8000-000000000001', c_solicitante, 'web')
    returning id into v_req;
  update public.requisiciones set aprobador_id = c_cabecera where id = v_req;
  insert into public.requisicion_items(requisicion_id, descripcion_libre, cantidad, unidad)
    values (v_req, 'Cemento gris', 20, 'bulto') returning id into v_item;

  if not public.es_aprobador_de(v_req, c_cabecera) then
    raise exception 'es_aprobador_de no reconoce al aprobador de cabecera';
  end if;
  if public.es_aprobador_de(v_req, c_por_item) then
    raise exception 'es_aprobador_de reconoce a quien todavía no tiene ningún ítem';
  end if;

  update public.requisicion_items set aprobador_id = c_por_item where id = v_item;
  if not public.es_aprobador_de(v_req, c_por_item) then
    raise exception 'es_aprobador_de no reconoce al aprobador de un ítem';
  end if;
  -- HERENCIA: designar a alguien por ítem no destituye al de cabecera.
  if not public.es_aprobador_de(v_req, c_cabecera) then
    raise exception 'designar un aprobador por ítem dejó fuera al de cabecera';
  end if;
  if public.es_aprobador_de(v_req, c_contable) then
    raise exception 'es_aprobador_de reconoce a quien no decide nada aquí';
  end if;
end $$;

-- 3. El aprobador por ítem tiene que ser elegible, igual que el de cabecera. Sin esto, el camino nuevo
--    esquiva el control que el viejo sí tiene.
do $$
declare v_req uuid; v_item uuid;
begin
  insert into public.requisiciones(consecutivo, tipo, obra_id, solicitante_id, canal)
    values ('', 'compra', '30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'web')
    returning id into v_req;
  insert into public.requisicion_items(requisicion_id, descripcion_libre, cantidad, unidad)
    values (v_req, 'Arena', 3, 'm3') returning id into v_item;
  begin
    -- El solicitante no tiene rol aprobador.
    update public.requisicion_items set aprobador_id = '10000000-0000-4000-8000-000000000001' where id = v_item;
    raise exception 'se pudo designar como aprobador de ítem a un usuario no elegible';
  exception when check_violation then null;
  end;
end $$;

-- 4. `en_aprobacion -> declinada`, la transición que no existía. Con aprobador por ítem hace falta: si
--    todos los ítems acaban declinados no hay nada que aprobar, y sin ella la requisición se atasca.
do $$
declare v_req uuid;
begin
  insert into public.requisiciones(consecutivo, tipo, obra_id, solicitante_id, canal)
    values ('', 'compra', '30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'web')
    returning id into v_req;
  update public.requisiciones set aprobador_id = '10000000-0000-4000-8000-000000000003' where id = v_req;
  update public.requisiciones set estado = 'en_revision' where id = v_req;
  update public.requisiciones set estado = 'en_aprobacion' where id = v_req;
  -- `requisiciones_motivo_declinacion_check` EXIGE motivo al declinar, y el trigger de historial lo
  -- copia como comentario de la transición. O sea: cerrar por «todos los ítems declinados» obliga al
  -- servicio a redactar un motivo de cabecera; no basta con cambiar el estado.
  update public.requisiciones set estado = 'declinada',
    motivo_declinacion = 'Todos los ítems fueron declinados: sin presupuesto' where id = v_req;
  if (select estado from public.requisiciones where id = v_req) <> 'declinada' then
    raise exception 'en_aprobacion -> declinada no quedó aplicada';
  end if;

  -- Y lo que seguía prohibido, sigue prohibido: abrir una transición no puede abrirlas todas.
  begin
    update public.requisiciones set estado = 'en_revision' where id = v_req;
    raise exception 'declinada -> en_revision quedó permitida por accidente';
  exception when check_violation then null;
  end;
end $$;

-- 5. La baja de un usuario también cuenta los ítems suyos. Sin esto se podía desactivar a quien tiene
--    ítems esperando su decisión y dejarlos huérfanos sin un solo aviso.
--
--    CON APROBADOR RECIÉN CREADO, no con Juliana (…0007), que en el seed aprueba la etiqueta activa
--    "Nomina": con ella, `validar_baja_usuario_con_etiquetas_activas` habría lanzado la excepción por
--    su cuenta y esta prueba pasaría en verde sin comprobar nada de lo que dice comprobar.
--
--    Y por eso hay un control ANTES: se da de baja al mismo usuario SIN ítems pendientes y tiene que
--    dejar. Si esa primera baja fallara, la segunda no probaría nada.
do $$
declare v_req uuid; v_item uuid;
  c_suelto constant uuid := '10000000-0000-4000-8000-0000000000aa';
begin
  insert into auth.users (id, instance_id, aud, role, email)
    values (c_suelto, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'aprobador.suelto@mizar.test');
  insert into public.usuarios (id, nombre, email, estado)
    values (c_suelto, 'Aprobador Suelto', 'aprobador.suelto@mizar.test', 'activo');
  insert into public.usuario_roles (usuario_id, rol) values (c_suelto, 'aprobador');

  -- Control: sin nada pendiente, la baja pasa.
  update public.usuarios set estado = 'inactivo' where id = c_suelto;
  if (select estado from public.usuarios where id = c_suelto) <> 'inactivo' then
    raise exception 'el control falló: no se pudo dar de baja a un aprobador sin nada pendiente';
  end if;
  update public.usuarios set estado = 'activo' where id = c_suelto;

  insert into public.requisiciones(consecutivo, tipo, obra_id, solicitante_id, canal)
    values ('', 'compra', '30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'web')
    returning id into v_req;
  update public.requisiciones set aprobador_id = '10000000-0000-4000-8000-000000000003' where id = v_req;
  insert into public.requisicion_items(requisicion_id, descripcion_libre, cantidad, unidad, aprobador_id)
    values (v_req, 'Varilla', 40, 'und', c_suelto) returning id into v_item;
  update public.requisiciones set estado = 'en_revision' where id = v_req;
  update public.requisiciones set estado = 'en_aprobacion' where id = v_req;

  begin
    update public.usuarios set estado = 'inactivo' where id = c_suelto;
    raise exception 'se pudo dar de baja a un aprobador con ítems esperando su decisión';
  exception when check_violation then null;
  end;
end $$;

-- 6. RLS de verdad, con el rol `authenticated` y la identidad puesta como la pone PostgREST. Es el
--    punto del cambio que más fácil se queda corto: las cuatro policies miraban SOLO la cabecera, así
--    que un aprobador por ítem no veía ni la requisición que tiene que decidir.
do $$
declare
  v_req uuid; v_item uuid; v_historial int;
  c_cabecera constant uuid := '10000000-0000-4000-8000-000000000003';
  c_por_item constant uuid := '10000000-0000-4000-8000-000000000007';
  c_ajeno    constant uuid := '10000000-0000-4000-8000-0000000000bb';
begin
  insert into public.requisiciones(consecutivo, tipo, obra_id, solicitante_id, canal)
    values ('', 'compra', '30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'web')
    returning id into v_req;
  update public.requisiciones set aprobador_id = c_cabecera where id = v_req;
  insert into public.requisicion_items(requisicion_id, descripcion_libre, cantidad, unidad, aprobador_id)
    values (v_req, 'Sellante', 2, 'cuñete', c_por_item) returning id into v_item;
  update public.requisiciones set estado = 'en_revision' where id = v_req;
  update public.requisiciones set estado = 'en_aprobacion' where id = v_req;

  perform set_config('request.jwt.claim.sub', c_por_item::text, true);
  execute 'set local role authenticated';
  if not exists (select 1 from public.requisicion_items where id = v_item) then
    raise exception 'RLS: el aprobador de un ítem no puede leer su propio ítem';
  end if;
  select count(*) into v_historial from public.requisicion_historial where requisicion_id = v_req;
  if v_historial = 0 then
    raise exception 'RLS: el aprobador de un ítem no puede leer el historial de la requisición que decide';
  end if;
  execute 'reset role';

  -- EL NEGATIVO, que es la mitad que da valor a lo anterior: abrir la puerta al aprobador por ítem no
  -- puede abrirla a cualquier aprobador. Se usa uno creado aquí, sin rol de compras ni contabilidad y
  -- sin ningún ítem en esta requisición — con Nelson o Juliana, que salen en el seed enredados en
  -- etiquetas y requisiciones, el "no ve" no probaría nada.
  insert into auth.users (id, instance_id, aud, role, email)
    values (c_ajeno, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'aprobador.ajeno@mizar.test');
  insert into public.usuarios (id, nombre, email, estado)
    values (c_ajeno, 'Aprobador Ajeno', 'aprobador.ajeno@mizar.test', 'activo');
  insert into public.usuario_roles (usuario_id, rol) values (c_ajeno, 'aprobador');

  perform set_config('request.jwt.claim.sub', c_ajeno::text, true);
  execute 'set local role authenticated';
  if exists (select 1 from public.requisicion_items where id = v_item) then
    raise exception 'RLS: un aprobador ajeno lee ítems que no le tocan';
  end if;
  if exists (select 1 from public.requisicion_historial where requisicion_id = v_req) then
    raise exception 'RLS: un aprobador ajeno lee el historial de una requisición que no decide';
  end if;
  execute 'reset role';
  -- SE DEVUELVE LA IDENTIDAD, no solo el rol. `reset role` quita el rol pero deja puesto el GUC que
  -- lee auth.uid(), así que los bloques siguientes seguirían corriendo "como" este aprobador y
  -- dispararían `limitar_actualizacion_aprobador` en updates que no tienen nada que ver. Pasó.
  perform set_config('request.jwt.claim.sub', '', true);
end $$;


-- 7. `aprobadores_pendientes`: a quién se le espera todavía. Es la MISMA función que usa el emisor de
--    WhatsApp para agrupar los mensajes (lib/infrastructure/approval-flow-sender.ts), no una copia del
--    predicado: si se comprobara aquí una versión propia, este arnés podría dar verde sobre la misma
--    equivocación que debe cazar — que es lo que ya pasó una vez con `rango_estado_entrega`.
do $$
declare
  v_req uuid; v_l1 uuid; v_l2 uuid; v_pendientes uuid[];
  c_cabecera constant uuid := '10000000-0000-4000-8000-000000000003'; -- Nelson
  c_por_item constant uuid := '10000000-0000-4000-8000-000000000007'; -- Juliana
begin
  insert into public.requisiciones(consecutivo, tipo, obra_id, solicitante_id, canal)
    values ('', 'compra', '30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'web')
    returning id into v_req;
  update public.requisiciones set aprobador_id = c_cabecera where id = v_req;
  insert into public.requisicion_items(requisicion_id, descripcion_libre, cantidad, unidad, aprobador_id)
    values (v_req, 'Arena', 3, 'm3', c_por_item) returning id into v_l1;
  insert into public.requisicion_items(requisicion_id, descripcion_libre, cantidad, unidad)
    values (v_req, 'Cemento', 20, 'bulto') returning id into v_l2; -- sin aprobador: hereda a Nelson

  select array_agg(a order by a) into v_pendientes from public.aprobadores_pendientes(v_req) a;
  if v_pendientes <> array(select unnest(array[c_cabecera, c_por_item]) order by 1) then
    raise exception 'aprobadores_pendientes no agrupa cabecera + ítem: %', v_pendientes;
  end if;

  -- Decidido lo de Juliana, deja de esperarse a Juliana: a quien ya decidió no se le vuelve a escribir.
  update public.requisicion_items set estado = 'aprobado' where id = v_l1;
  select array_agg(a) into v_pendientes from public.aprobadores_pendientes(v_req) a;
  if v_pendientes <> array[c_cabecera] then
    raise exception 'aprobadores_pendientes sigue esperando a quien ya decidió: %', v_pendientes;
  end if;

  -- Un ítem DECLINADO también está decidido: no puede reabrir el aviso.
  update public.requisicion_items set estado = 'declinado', motivo_declinacion = 'sin presupuesto' where id = v_l2;
  select array_agg(a) into v_pendientes from public.aprobadores_pendientes(v_req) a;
  if v_pendientes is not null then
    raise exception 'aprobadores_pendientes devuelve gente con todo decidido: %', v_pendientes;
  end if;
end $$;

rollback;
