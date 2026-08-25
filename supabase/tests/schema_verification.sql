-- Ejecutar contra una BD local migrada: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/schema_verification.sql
begin;

do $$
declare
  required_tables text[] := array['sociedades','obras','usuarios','usuario_roles','modulos','obra_solicitantes_autorizados','etiquetas','proveedores','items','consecutivos','adjuntos','auditoria','requisiciones','requisicion_items','ordenes','orden_items','gastos','gastos_reparto','caja_menor','notificaciones','whatsapp_eventos','kapso_procesamiento','mcp_api_keys','sesiones_pantalla'];
  table_name text;
begin
  foreach table_name in array required_tables loop
    if to_regclass('public.' || table_name) is null then raise exception 'Falta tabla %', table_name; end if;
    if not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = table_name and c.relrowsecurity) then
      raise exception 'RLS no está activo en %', table_name;
    end if;
  end loop;
  if not exists (select 1 from pg_proc where proname = 'next_consecutivo') then raise exception 'Falta next_consecutivo'; end if;
  if not exists (select 1 from storage.buckets where id = 'requisicion-adjuntos' and public = false) then raise exception 'Bucket privado no configurado'; end if;
end $$;

-- Una baja de usuario corta el acceso RLS incluso con una sesión Auth aún válida.
do $$ begin
  update public.usuarios set estado = 'inactivo' where id = '10000000-0000-0000-0000-000000000001';
  perform set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000001', true);
  if public.is_active_user() then raise exception 'Usuario inactivo conserva acceso'; end if;
  if public.has_role('solicitante') then raise exception 'Usuario inactivo conserva un rol operativo'; end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'requisiciones'
    and policyname = 'requisiciones_solicitante_insert' and with_check like '%is_active_user%')
    or not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'items'
      and policyname = 'items_lectura' and qual like '%is_active_user%') then
    raise exception 'RLS no exige usuario activo para acceso propio o catálogos';
  end if;
  if (select count(*) from pg_policies where schemaname = 'public' and policyname in (
    'catalogos_lectura', 'obras_lectura', 'etiquetas_lectura', 'items_lectura', 'modulos_lectura'
  ) and coalesce(qual, '') like '%is_active_user%') <> 5 then
    raise exception 'Lectura de catálogos no exige usuario activo';
  end if;
  -- Ejecutar como authenticated evita que el propietario/superusuario del test
  -- oculte una policy permisiva: un usuario dado de baja no lee ni inserta.
  execute 'set local role authenticated';
  if exists (select 1 from public.items) then
    raise exception 'RLS dejó leer catálogo a usuario inactivo';
  end if;
  begin
    insert into public.requisiciones(consecutivo, tipo, obra_id, solicitante_id, canal)
      values ('', 'compra', '30000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'web');
    raise exception 'RLS dejó crear requisición a usuario inactivo';
  exception
    when sqlstate '42501' then null;
    when sqlstate '23514' then null; -- el trigger BEFORE INSERT de catálogos activos (validar_catalogos_activos_requisicion, SECURITY DEFINER) corre antes que el WITH CHECK de RLS y ya bloquea al mismo usuario inactivo
  end;
  execute 'reset role';
  update public.usuarios set estado = 'activo' where id = '10000000-0000-0000-0000-000000000001';
end $$;

-- Maestros y outbox: campos esenciales, destino único y envío verificable.
do $$
declare v_etiqueta uuid; begin
  begin
    insert into public.sociedades(nombre) values ('   ');
    raise exception 'sociedades aceptó nombre vacío';
  exception when sqlstate '23514' then null;
  end;
  begin
    insert into public.proveedores(razon_social) values ('   ');
    raise exception 'proveedores aceptó razón social vacía';
  exception when sqlstate '23514' then null;
  end;
  begin
    insert into public.etiquetas(nombre, activa) values ('   ', false);
    raise exception 'etiquetas aceptó nombre vacío';
  exception when sqlstate '23514' then null;
  end;
  begin
    insert into public.notificaciones(usuario_id, telefono_destino, canal, plantilla)
      values ('10000000-0000-0000-0000-000000000001', '3000000000', 'whatsapp', 'prueba');
    raise exception 'outbox aceptó dos destinos';
  exception when sqlstate '23514' then null;
  end;
  begin
    insert into public.notificaciones(usuario_id, canal, plantilla, estado_envio)
      values ('10000000-0000-0000-0000-000000000001', 'whatsapp', 'prueba', 'enviado');
    raise exception 'outbox marcó enviado sin timestamp';
  exception when sqlstate '23514' then null;
  end;
  insert into public.etiquetas(nombre, aprobador_id, activa)
    values ('Auditoría QA', '10000000-0000-0000-0000-000000000003', false) returning id into v_etiqueta;
  update public.etiquetas set activa = true where id = v_etiqueta;
  if not exists (
    select 1 from public.auditoria a
    where a.entidad = 'etiquetas' and a.entidad_id = v_etiqueta and a.evento = 'UPDATE'
      and a.datos_json #>> '{datos_cambio,activa,antes}' = 'false'
      and a.datos_json #>> '{datos_cambio,activa,despues}' = 'true'
  ) then raise exception 'Auditoría no conserva el cambio de catálogo'; end if;
  insert into public.notificaciones(usuario_id, canal, plantilla, payload)
    values ('10000000-0000-0000-0000-000000000001', 'whatsapp', 'outbox_auditoria_qa', '{"telefono":"sensible"}');
  if not exists (
    select 1 from public.auditoria a
    where a.entidad = 'notificaciones' and a.evento = 'INSERT'
      and a.datos_json #>> '{datos_nuevos,payload,redactado}' = 'true'
  ) then raise exception 'Auditoría expone o no redacta payload del outbox'; end if;
end $$;

-- Los catálogos sólo se desactivan: no se borran y no pueden alimentar nuevas operaciones.
do $$
declare
  v_etiqueta uuid;
  v_proveedor uuid;
  v_item uuid;
  v_obra_cerrada uuid;
  v_sociedad_inactiva uuid;
  v_obra_sociedad_inactiva uuid;
  v_req uuid;
  v_etiqueta_aprobador_inactivo uuid;
begin
  if (select count(*) from pg_indexes where schemaname = 'public' and indexname in (
    'obras_activas_busqueda_idx', 'etiquetas_activas_busqueda_idx', 'proveedores_activos_busqueda_idx',
    'items_disponibles_busqueda_idx', 'obra_solicitantes_activos_idx'
  )) <> 5 then raise exception 'Faltan índices parciales de catálogos activos'; end if;
  if not exists (
    select 1 from pg_indexes where schemaname = 'public' and indexname = 'proveedores_razon_social_normalizada_unico_idx'
      and indexdef like '%UNIQUE INDEX%' and indexdef like '%lower(btrim(razon_social))%'
  ) then raise exception 'Falta UNIQUE funcional de razón social de proveedor'; end if;
  if (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and not t.tgisinternal and t.tgname in (
        'sociedades_sin_borrado_fisico', 'usuarios_sin_borrado_fisico', 'obras_sin_borrado_fisico',
        'obra_solicitantes_autorizados_sin_borrado_fisico', 'etiquetas_sin_borrado_fisico',
        'proveedores_sin_borrado_fisico', 'items_sin_borrado_fisico', 'requisiciones_catalogos_activos',
        'requisicion_items_catalogos_activos', 'ordenes_catalogos_activos', 'caja_menor_catalogos_activos'
      )) <> 11 then raise exception 'Faltan triggers de baja reversible o catálogos activos'; end if;

  insert into public.etiquetas(nombre, activa) values ('Etiqueta inactiva QA', false) returning id into v_etiqueta;
  begin
    insert into public.requisiciones(consecutivo, tipo, obra_id, solicitante_id, canal, etiqueta_id)
      values ('', 'compra', '30000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'web', v_etiqueta);
    raise exception 'Requisición aceptó etiqueta inactiva';
  exception when sqlstate '23514' then null;
  end;
  begin
    delete from public.etiquetas where id = v_etiqueta;
    raise exception 'Etiqueta permitió DELETE en vez de baja reversible';
  exception when sqlstate '55000' then null;
  end;

  insert into public.obras(nombre, sociedad_id, estado) values ('Obra cerrada QA', '20000000-0000-0000-0000-000000000001', 'cerrada') returning id into v_obra_cerrada;
  begin
    insert into public.requisiciones(consecutivo, tipo, obra_id, solicitante_id, canal)
      values ('', 'compra', v_obra_cerrada, '10000000-0000-0000-0000-000000000001', 'web');
    raise exception 'Requisición aceptó obra cerrada';
  exception when sqlstate '23514' then null;
  end;
  insert into public.sociedades(nombre, activa) values ('Sociedad inactiva QA', false) returning id into v_sociedad_inactiva;
  insert into public.obras(nombre, sociedad_id, estado) values ('Obra sociedad inactiva QA', v_sociedad_inactiva, 'activa') returning id into v_obra_sociedad_inactiva;
  begin
    insert into public.requisiciones(consecutivo, tipo, obra_id, solicitante_id, canal)
      values ('', 'compra', v_obra_sociedad_inactiva, '10000000-0000-0000-0000-000000000001', 'web');
    raise exception 'Requisición aceptó sociedad inactiva';
  exception when sqlstate '23514' then null;
  end;

  insert into public.requisiciones(consecutivo, tipo, obra_id, solicitante_id, canal)
    values ('', 'compra', '30000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'web') returning id into v_req;
  insert into public.proveedores(razon_social, activo) values ('Proveedor inactivo QA', false) returning id into v_proveedor;
  insert into public.proveedores(razon_social) values ('Proveedor duplicado QA');
  begin
    insert into public.proveedores(razon_social) values ('  proveedor duplicado qa  ');
    raise exception 'Proveedor aceptó razón social duplicada por mayúsculas o espacios';
  exception when sqlstate '23505' then null;
  end;
  insert into public.items(nombre, nombre_normalizado, unidad_defecto, estado)
    values ('Ítem inactivo QA', 'item inactivo qa', 'unidad', 'inactivo') returning id into v_item;
  begin
    insert into public.requisicion_items(requisicion_id, item_id, cantidad, unidad)
      values (v_req, v_item, 1, 'unidad');
    raise exception 'Ítem inactivo pudo usarse en requisición';
  exception when sqlstate '23514' then null;
  end;
  begin
    insert into public.requisicion_items(requisicion_id, descripcion_libre, cantidad, unidad, proveedor_final_id)
      values (v_req, 'Proveedor inactivo', 1, 'unidad', v_proveedor);
    raise exception 'Proveedor inactivo pudo asignarse a ítem';
  exception when sqlstate '23514' then null;
  end;
  begin
    insert into public.ordenes(consecutivo, tipo, requisicion_id, proveedor_id)
      values ('', 'OC', v_req, v_proveedor);
    raise exception 'Orden aceptó proveedor inactivo';
  exception when sqlstate '23514' then null;
  end;
  begin
    insert into public.caja_menor(obra_id, fecha, concepto, valor, registrado_por)
      values (v_obra_cerrada, current_date, 'Caja con obra cerrada', 1000, '10000000-0000-0000-0000-000000000002');
    raise exception 'Caja menor aceptó obra cerrada';
  exception when sqlstate '23514' then null;
  end;

  update public.usuarios set estado = 'inactivo' where id = '10000000-0000-0000-0000-000000000001';
  begin
    insert into public.requisiciones(consecutivo, tipo, obra_id, solicitante_id, canal)
      values ('', 'compra', '30000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'web');
    raise exception 'Requisición aceptó solicitante inactivo';
  exception when sqlstate '23514' then null;
  end;
  begin
    insert into public.caja_menor(obra_id, fecha, concepto, valor, registrado_por)
      values ('30000000-0000-0000-0000-000000000001', current_date, 'Caja con usuario inactivo', 1000, '10000000-0000-0000-0000-000000000001');
    raise exception 'Caja menor aceptó responsable inactivo';
  exception when sqlstate '23514' then null;
  end;
  update public.usuarios set estado = 'activo' where id = '10000000-0000-0000-0000-000000000001';

  update public.usuarios set estado = 'inactivo' where id = '10000000-0000-0000-0000-000000000001';
  insert into public.etiquetas(nombre, aprobador_id, activa)
    values ('Etiqueta aprobador inactivo QA', '10000000-0000-0000-0000-000000000001', false) returning id into v_etiqueta_aprobador_inactivo;
  begin
    update public.etiquetas set activa = true where id = v_etiqueta_aprobador_inactivo;
    raise exception 'Etiqueta activó un aprobador inactivo';
  exception when sqlstate '23514' then null;
  end;
  begin
    insert into public.caja_menor(obra_id, fecha, concepto, etiqueta_id, valor, registrado_por)
      values ('30000000-0000-0000-0000-000000000001', current_date, 'Caja con aprobador inactivo', v_etiqueta_aprobador_inactivo, 1000, '10000000-0000-0000-0000-000000000002');
    raise exception 'Caja menor aceptó etiqueta con aprobador inactivo';
  exception when sqlstate '23514' then null;
  end;
  update public.usuarios set estado = 'activo' where id = '10000000-0000-0000-0000-000000000001';
end $$;

-- RF-003/RF-401: la etiqueta activa siempre conserva un aprobador activo y elegible.
do $$
declare v_etiqueta_valida uuid; begin
  if (select count(*) from pg_trigger where not tgisinternal and tgname in (
    'etiquetas_aprobador_elegible', 'usuarios_baja_etiquetas_activas', 'usuario_roles_ultimo_aprobador'
  )) <> 3 then raise exception 'Faltan triggers de integridad etiqueta/aprobador'; end if;
  if not public.es_aprobador_elegible('10000000-0000-0000-0000-000000000003')
    or public.es_aprobador_elegible('10000000-0000-0000-0000-000000000001') then
    raise exception 'Roles elegibles de aprobador no coinciden con el contrato';
  end if;
  begin
    insert into public.etiquetas(nombre, activa) values ('Etiqueta sin aprobador QA', true);
    raise exception 'Etiqueta activa aceptó aprobador nulo';
  exception when sqlstate '23514' then null;
  end;
  begin
    insert into public.etiquetas(nombre, aprobador_id, activa)
      values ('Etiqueta aprobador no elegible QA', '10000000-0000-0000-0000-000000000001', true);
    raise exception 'Etiqueta activa aceptó aprobador sin rol elegible';
  exception when sqlstate '23514' then null;
  end;
  update public.usuarios set estado = 'inactivo' where id = '10000000-0000-0000-0000-000000000001';
  begin
    insert into public.etiquetas(nombre, aprobador_id, activa)
      values ('Etiqueta aprobador baja QA', '10000000-0000-0000-0000-000000000001', true);
    raise exception 'Etiqueta activa aceptó aprobador inactivo';
  exception when sqlstate '23514' then null;
  end;
  update public.usuarios set estado = 'activo' where id = '10000000-0000-0000-0000-000000000001';
  begin
    update public.usuarios set estado = 'inactivo' where id = '10000000-0000-0000-0000-000000000003';
    raise exception 'Desactivación dejó etiquetas activas sin aprobador';
  exception when sqlstate '23514' then null;
  end;
  begin
    delete from public.usuario_roles where usuario_id = '10000000-0000-0000-0000-000000000003' and rol = 'aprobador';
    raise exception 'Retiro dejó etiquetas activas sin rol elegible';
  exception when sqlstate '23514' then null;
  end;
  insert into public.etiquetas(nombre, aprobador_id, activa)
    values ('Etiqueta desactivable QA', '10000000-0000-0000-0000-000000000003', true) returning id into v_etiqueta_valida;
  update public.etiquetas set activa = false where id = v_etiqueta_valida;
  if exists (
    select 1 from public.etiquetas e where e.activa and not public.es_aprobador_elegible(e.aprobador_id)
  ) then raise exception 'Invariante posterior dejó etiqueta activa no enrutable'; end if;
end $$;

-- PII no puede aparecer en datos_json; se preservan nombres de catálogos en otros eventos.
do $$
declare v_req uuid; v_autorizado uuid; v_whatsapp uuid; begin
  insert into public.requisiciones(
    consecutivo, tipo, obra_id, solicitante_nombre_externo, solicitante_telefono_externo, canal
  ) values (
    '', 'compra', '30000000-0000-0000-0000-000000000001', 'QA_NOMBRE_EXTERNO_SECRETO', '3005550109', 'publico'
  ) returning id into v_req;
  insert into public.obra_solicitantes_autorizados(obra_id, nombre, telefono)
    values ('30000000-0000-0000-0000-000000000001', 'QA_SOLICITANTE_AUTORIZADO_SECRETO', '3005550110')
    returning id into v_autorizado;
  insert into public.whatsapp_eventos(direccion, telefono, tipo, kapso_message_id, payload_json)
    values ('entrada', '3005550111', 'mensaje', 'QA_KAPSO_ID_SECRETO', '{"texto":"QA_PAYLOAD_SECRETO"}')
    returning id into v_whatsapp;
  if exists (
    select 1 from public.auditoria a
    where (
      (a.entidad = 'requisiciones' and a.entidad_id = v_req)
      or (a.entidad = 'obra_solicitantes_autorizados' and a.entidad_id = v_autorizado)
      or (a.entidad = 'whatsapp_eventos' and a.entidad_id = v_whatsapp)
    ) and a.datos_json::text ~ 'QA_NOMBRE_EXTERNO_SECRETO|QA_SOLICITANTE_AUTORIZADO_SECRETO|3005550109|3005550110|3005550111|QA_KAPSO_ID_SECRETO|QA_PAYLOAD_SECRETO'
  ) then raise exception 'Auditoría filtró PII de requisición, solicitante autorizado o WhatsApp'; end if;
  if not exists (select 1 from public.auditoria a where a.entidad = 'requisiciones' and a.entidad_id = v_req
    and a.datos_json #>> '{datos_nuevos,solicitante_nombre_externo,redactado}' = 'true'
    and a.datos_json #>> '{datos_nuevos,solicitante_telefono_externo,redactado}' = 'true')
    or not exists (select 1 from public.auditoria a where a.entidad = 'obra_solicitantes_autorizados' and a.entidad_id = v_autorizado
      and a.datos_json #>> '{datos_nuevos,nombre,redactado}' = 'true'
      and a.datos_json #>> '{datos_nuevos,telefono_normalizado,redactado}' = 'true')
    or not exists (select 1 from public.auditoria a where a.entidad = 'whatsapp_eventos' and a.entidad_id = v_whatsapp
      and a.datos_json #>> '{datos_nuevos,telefono,redactado}' = 'true'
      and a.datos_json #>> '{datos_nuevos,payload_json,redactado}' = 'true') then
    raise exception 'PII no quedó marcado como redactado';
  end if;
end $$;

-- Storage genérico sólo expone objetos con metadata finalizada cuya entidad es
-- visible. El prepare de URL firmada y HEAD/complete son server/service-role;
-- clientes JWT no escriben metadata ni storage.objects directamente.
do $$ begin
  if exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects' and cmd in ('INSERT', 'UPDATE', 'DELETE')
      and (coalesce(qual, '') like '%requisicion-adjuntos%' or coalesce(with_check, '') like '%requisicion-adjuntos%')
  ) or (select count(*) from pg_policies where schemaname = 'storage' and policyname = 'mizar_storage_read') <> 1
    or exists (select 1 from pg_policies where schemaname = 'storage' and policyname in ('mizar_storage_upload', 'mizar_storage_update')) then
    raise exception 'Storage genérico no puede tener policies JWT de escritura';
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and policyname = 'mizar_storage_read'
      and coalesce(qual, '') like '%adjuntos%'
      and coalesce(qual, '') like '%puede_leer_adjunto%'
      and coalesce(qual, '') like '%puede_leer_adjunto_generico_finalizado%'
      and coalesce(qual, '') not like '%owner_id%'
  ) then raise exception 'Storage read debe validar metadata finalizada y RLS de adjunto'; end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'adjuntos' and policyname = 'adjuntos_lectura_operativa'
      and coalesce(qual, '') like '%puede_leer_adjunto_generico_finalizado%'
  ) then raise exception 'Adjuntos legacy genéricos pueden escapar por la policy de lectura'; end if;
  -- has_table_privilege(...,'storage.objects',...) NO se verifica para
  -- authenticated/anon: storage.objects es propiedad de supabase_storage_admin
  -- y el rol postgres (con el que corren las migraciones) no puede revocar
  -- ese grant de plataforma (confirmado empíricamente: el REVOKE ejecutado
  -- como postgres es un no-op silencioso). El control real es la ausencia
  -- de policies RLS de escritura para esos roles, ya verificada arriba y
  -- ejercitada con ataques simulados en generic_attachments_verification.sql.
  if has_table_privilege('authenticated', 'public.adjuntos', 'INSERT')
    or has_table_privilege('authenticated', 'public.adjuntos', 'UPDATE')
    or has_table_privilege('authenticated', 'public.adjuntos', 'DELETE') then
    raise exception 'authenticated conserva una escritura directa de adjuntos o Storage';
  end if;
  if has_table_privilege('anon', 'public.adjuntos', 'INSERT') then
    raise exception 'anon conserva una escritura directa de adjuntos o Storage';
  end if;
  if not has_table_privilege('service_role', 'public.adjuntos', 'INSERT')
    or not has_table_privilege('service_role', 'storage.objects', 'INSERT') then
    raise exception 'service_role no puede completar soportes privados';
  end if;
end $$;

-- El dominio usa COP enteros; las cantidades pueden ser decimales, los importes no.
do $$
declare v_req uuid; v_gasto uuid; begin
  insert into public.requisiciones(consecutivo, tipo, obra_id, solicitante_id, canal)
    values ('', 'compra', '30000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'web')
    returning id into v_req;
  begin
    insert into public.requisicion_items(requisicion_id, descripcion_libre, cantidad, unidad, valor_base, iva)
      values (v_req, 'Prueba sin centavos', 1.250, 'unidad', 1000, 0.50);
    raise exception 'requisicion_items aceptó centavos';
  exception when sqlstate '23514' then null;
  end;
  begin
    insert into public.gastos(obra_id, origen, referencia_id, fecha, valor_base, iva)
      values ('30000000-0000-0000-0000-000000000001', 'requisicion', gen_random_uuid(), current_date, 1000.50, 0);
    raise exception 'gastos aceptó centavos';
  exception when sqlstate '23514' then null;
  end;
  insert into public.gastos(obra_id, origen, referencia_id, fecha, valor_base, iva)
    values ('30000000-0000-0000-0000-000000000001', 'requisicion', gen_random_uuid(), current_date, 1000, 0)
    returning id into v_gasto;
  begin
    insert into public.gastos_reparto(gasto_id, obra_id, valor)
      values (v_gasto, '30000000-0000-0000-0000-000000000001', 0.50);
    raise exception 'gastos_reparto aceptó centavos';
  exception when sqlstate '23514' then null;
  end;
  begin
    insert into public.caja_menor(obra_id, fecha, concepto, valor, registrado_por)
      values ('30000000-0000-0000-0000-000000000001', current_date, 'Prueba sin centavos', 0.50, '10000000-0000-0000-0000-000000000002');
    raise exception 'caja_menor aceptó centavos';
  exception when sqlstate '23514' then null;
  end;
end $$;

-- Caja menor delega la creación del gasto al trigger y conserva exactamente un vínculo.
do $$
declare v_cash uuid; v_expense uuid; v_count integer; begin
  insert into public.caja_menor(obra_id, fecha, concepto, etiqueta_id, valor, registrado_por)
    values ('30000000-0000-0000-0000-000000000001', current_date, 'Verificación trigger', null, 1000, '10000000-0000-0000-0000-000000000002')
    returning id, gasto_id into v_cash, v_expense;
  select count(*) into v_count from public.gastos where origen='caja_menor' and referencia_id=v_cash and id=v_expense;
  if v_expense is null or v_count <> 1 then raise exception 'Caja menor no generó exactamente un gasto vinculado'; end if;
end $$;

do $$ begin
  if not exists (select 1 from public.modulos where nombre='ordenes_multi_proveedor' and activo=false) then
    raise exception 'El gate ordenes_multi_proveedor debe existir cerrado por defecto';
  end if;
end $$;

-- Las claves MCP persisten únicamente el HMAC-SHA256 hexadecimal, nunca `mizar_` en claro.
do $$ begin
  begin
    insert into public.mcp_api_keys(usuario_id, nombre, key_hash)
      values ('10000000-0000-0000-0000-000000000002', 'verify-raw-mcp-key', 'mizar_clave_de_prueba_no_permitida');
    raise exception 'mcp_api_keys aceptó clave MCP en claro';
  exception when sqlstate '23514' then null;
  end;
  insert into public.mcp_api_keys(usuario_id, nombre, key_hash)
    values ('10000000-0000-0000-0000-000000000002', 'verify-hmac-sha256', repeat('a', 64));
end $$;

-- El ledger Kapso conserva idempotencia y no permite completar un flow sin su requisición.
do $$
declare v_req uuid; v_tag uuid; begin
  insert into public.kapso_procesamiento(event_id, tipo_evento, estado, payload)
    values ('verify-message-status-without-request', 'message_status', 'completed', '{"delivery":"sent"}');
  update public.kapso_procesamiento set estado = 'retryable' where event_id = 'verify-message-status-without-request';
  if not exists (
    select 1 from public.kapso_procesamiento
    where event_id = 'verify-message-status-without-request' and updated_at >= created_at
  ) then raise exception 'updated_at no está configurado para kapso_procesamiento'; end if;
  begin
    insert into public.kapso_procesamiento(event_id, tipo_evento, estado, payload)
      values ('verify-flow-without-request', 'flow_submission', 'completed', '{}');
    raise exception 'flow_submission pudo completarse sin requisición';
  exception when sqlstate '23514' then null;
  end;
  select id into v_tag from public.etiquetas where nombre = 'Materiales';
  insert into public.requisiciones(consecutivo, tipo, obra_id, solicitante_id, canal, etiqueta_id, kapso_event_id)
    values ('', 'compra', '30000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'whatsapp', v_tag, 'verify-flow-event')
    returning id into v_req;
  insert into public.kapso_procesamiento(event_id, tipo_evento, estado, requisicion_id, payload)
    values ('verify-flow-completed', 'flow_submission', 'completed', v_req, '{"source":"flow"}');
  begin
    insert into public.requisiciones(consecutivo, tipo, obra_id, solicitante_id, canal, kapso_event_id)
      values ('', 'compra', '30000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'whatsapp', 'verify-flow-event');
    raise exception 'Índice parcial de requisiciones.kapso_event_id ausente';
  exception when sqlstate '23505' then null;
  end;
  if not exists (
    select 1 from public.auditoria a
    where a.entidad = 'kapso_procesamiento' and a.origen = 'kapso'
      and a.datos_json ? 'event_id_sha256' and not (a.datos_json ? 'payload')
  ) then raise exception 'Ledger Kapso no audita sin exponer payload'; end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'kapso_procesamiento'
      and policyname = 'kapso_procesamiento_sixteam_tecnico'
  ) then raise exception 'Falta policy técnica de kapso_procesamiento'; end if;
  if not has_table_privilege('service_role', 'public.kapso_procesamiento', 'select')
    or has_table_privilege('anon', 'public.kapso_procesamiento', 'select') then
    raise exception 'Privilegios del ledger Kapso no están cerrados a servicio técnico';
  end if;
end $$;

-- Uniques normales permiten maestros sin NIT y eventos que Kapso aún no identificó.
do $$
declare v_a uuid; v_b uuid; begin
  insert into public.sociedades(nombre) values ('Sociedad sin NIT A'), ('Sociedad sin NIT B');
  insert into public.proveedores(razon_social) values ('Proveedor sin NIT A'), ('Proveedor sin NIT B');
  insert into public.whatsapp_eventos(direccion, telefono, tipo, payload_json) values
    ('entrada', '000000001', 'mensaje', '{}'), ('entrada', '000000002', 'mensaje', '{}');
  insert into public.whatsapp_eventos(direccion, telefono, tipo, kapso_message_id, payload_json)
    values ('entrada', '000000003', 'mensaje', 'verify-nonnull-unique', '{}');
  begin
    insert into public.whatsapp_eventos(direccion, telefono, tipo, kapso_message_id, payload_json)
      values ('entrada', '000000004', 'mensaje', 'verify-nonnull-unique', '{}');
    raise exception 'Índice parcial de kapso_message_id ausente';
  exception when sqlstate '23505' then null;
  end;
  select id into v_a from public.whatsapp_eventos where telefono = '000000001' limit 1;
  if not exists (select 1 from public.auditoria where entidad = 'whatsapp_eventos' and entidad_id = v_a and origen = 'web') then
    raise exception 'Auditoría no persiste origen web';
  end if;
end $$;

-- El origin se puede marcar desde infraestructura de servidor, no desde una RPC anónima.
do $$
declare v_id uuid; begin
  perform set_config('app.audit_origin', 'mcp', true);
  insert into public.whatsapp_eventos(direccion, telefono, tipo, payload_json) values ('salida', '000000005', 'mensaje', '{}') returning id into v_id;
  if not exists (select 1 from public.auditoria where entidad = 'whatsapp_eventos' and entidad_id = v_id and origen = 'mcp') then
    raise exception 'Auditoría no persiste origen mcp';
  end if;
end $$;

-- Un encabezado controlado por cliente no puede hacerse pasar por MCP/Kapso.
do $$
declare v_id uuid; begin
  perform set_config('app.audit_origin', '', true);
  perform set_config('request.headers', '{"x-mizar-audit-origin":"kapso"}', true);
  insert into public.whatsapp_eventos(direccion, telefono, tipo, payload_json) values ('entrada', '000000006', 'mensaje', '{}') returning id into v_id;
  if not exists (select 1 from public.auditoria where entidad = 'whatsapp_eventos' and entidad_id = v_id and origen = 'web') then
    raise exception 'Header no confiable alteró origen de auditoría';
  end if;
  insert into public.auditoria(entidad, evento, origen, datos_json) values ('prueba', 'REQUISICION_APROBADA', 'sistema', '{}');
end $$;

do $$ begin
  if not has_function_privilege('service_role', 'public.crear_requisicion_publica(uuid,text,text,text,public.tipo_requisicion,date,text,text,jsonb)', 'execute') then
    raise exception 'service_role no puede invocar RPC pública protegida';
  end if;
  if has_function_privilege('anon', 'public.crear_requisicion_publica(uuid,text,text,text,public.tipo_requisicion,date,text,text,jsonb)', 'execute')
    or has_function_privilege('authenticated', 'public.crear_requisicion_publica(uuid,text,text,text,public.tipo_requisicion,date,text,text,jsonb)', 'execute') then
    raise exception 'RPC pública protegida quedó expuesta a cliente';
  end if;
end $$;

-- Estado, historial y auditoría se escriben juntos y no admiten corrección destructiva.
do $$
declare v_req uuid; v_historial bigint; begin
  insert into public.requisiciones(consecutivo, tipo, obra_id, solicitante_id, canal)
    values ('', 'compra', '30000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'web')
    returning id into v_req;
  update public.requisiciones set estado = 'en_revision' where id = v_req;
  select id into v_historial from public.requisicion_historial
    where requisicion_id = v_req and estado_nuevo = 'en_revision';
  if v_historial is null or not exists (
    select 1 from public.auditoria a where a.entidad = 'requisiciones' and a.entidad_id = v_req
      and a.evento = 'STATE_CHANGE'
      and a.datos_json #>> '{datos_cambio,estado,antes}' = 'enviada'
      and a.datos_json #>> '{datos_cambio,estado,despues}' = 'en_revision'
  ) then raise exception 'Transición no dejó historial y auditoría completos'; end if;
  begin
    update public.requisicion_historial set comentario = 'alterado' where id = v_historial;
    raise exception 'Historial permitió mutación';
  exception when sqlstate '55000' then null;
  end;
  begin
    delete from public.auditoria where entidad = 'requisiciones' and entidad_id = v_req;
    raise exception 'Auditoría permitió borrado';
  exception when sqlstate '55000' then null;
  end;
end $$;

-- Un aprobador no puede alterar campos de negocio junto con su decisión.
do $$
declare v_req uuid; v_tag uuid; begin
  select id into v_tag from public.etiquetas where nombre = 'Materiales';
  insert into public.requisiciones(consecutivo, tipo, obra_id, solicitante_id, canal, etiqueta_id)
    values ('', 'compra', '30000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'web', v_tag)
    returning id into v_req;
  update public.requisiciones set estado = 'en_revision' where id = v_req;
  update public.requisiciones set estado = 'en_aprobacion' where id = v_req;
  perform set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000003', true);
  begin
    update public.requisiciones set estado = 'aprobada', obra_id = '30000000-0000-0000-0000-000000000002' where id = v_req;
    raise exception 'Aprobador pudo alterar obra';
  exception when sqlstate '42501' then null;
  end;
  update public.requisiciones set estado = 'aprobada' where id = v_req;
end $$;

do $$ begin
  perform set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000005', true);
  if public.can_manage_items() then raise exception 'admin_mizar no debe editar items'; end if;
  if public.can_operate_compras() then raise exception 'admin_mizar no debe operar compras'; end if;
  perform set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000002', true);
  if not public.can_manage_items() then raise exception 'revisor debe editar items'; end if;
  if not public.can_operate_compras() then raise exception 'revisor debe operar compras'; end if;
end $$;

-- Tener también rol aprobador no convierte a Admin-Mizar en operador de compras.
do $$
declare v_req uuid; v_tag uuid; begin
  insert into public.usuario_roles(usuario_id, rol) values ('10000000-0000-0000-0000-000000000005', 'aprobador') on conflict do nothing;
  select id into v_tag from public.etiquetas where nombre = 'Materiales';
  insert into public.requisiciones(consecutivo, tipo, obra_id, solicitante_id, canal, etiqueta_id)
    values ('', 'compra', '30000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'web', v_tag)
    returning id into v_req;
  update public.requisiciones set estado = 'en_revision' where id = v_req;
  update public.requisiciones set estado = 'en_aprobacion' where id = v_req;
  perform set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000005', true);
  begin
    update public.requisiciones set estado = 'aprobada', destino = 'alteración indebida' where id = v_req;
    raise exception 'Multirol aprobador/admin_mizar evadió el límite';
  exception when sqlstate '42501' then null;
  end;
end $$;

do $$
declare a text; b text; begin
  a := public.next_consecutivo('REQ', 2099);
  b := public.next_consecutivo('REQ', 2099);
  if a <> 'REQ-2099-0001' or b <> 'REQ-2099-0002' then raise exception 'Consecutivo inseguro: %, %', a, b; end if;
end $$;

do $$ begin
  begin
    insert into public.gastos_reparto(gasto_id, obra_id, valor) values ('00000000-0000-0000-0000-000000000000', '30000000-0000-0000-0000-000000000001', 1);
    raise exception 'FK de gastos_reparto ausente';
  exception when sqlstate '23503' then null;
  end;
end $$;

rollback;
