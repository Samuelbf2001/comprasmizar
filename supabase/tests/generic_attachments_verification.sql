-- Ejecutar contra una BD local migrada:
-- psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/generic_attachments_verification.sql
-- Todos los fixtures y ataques se revierten.
begin;

do $$
declare
  v_requisicion uuid;
  v_item uuid;
  v_caja uuid;
  v_etiqueta uuid;
  v_requisicion_orden uuid;
  v_orden uuid;
  v_adjunto uuid := '70000000-0000-0000-0000-000000000001';
  v_adjunto_item uuid := '70000000-0000-0000-0000-000000000002';
  v_adjunto_caja uuid := '70000000-0000-0000-0000-000000000003';
  v_adjunto_orden uuid := '70000000-0000-0000-0000-000000000004';
  v_adjunto_legacy uuid := '70000000-0000-0000-0000-000000000005';
  v_path text;
  v_path_pendiente text;
  v_path_legacy text;
  v_path_rechazo_solicitante text;
  v_path_rechazo_revisor text;
  v_qual text;
  v_check text;
  v_check_expr text;
  v_filas int;
begin
  if not exists (select 1 from storage.buckets where id = 'requisicion-adjuntos' and public = false
    and file_size_limit = 20971520
    and allowed_mime_types @> array['application/pdf', 'image/jpeg', 'image/png', 'image/webp']) then
    raise exception 'Bucket genérico debe ser privado, limitado y con MIME permitido';
  end if;
  if not public.path_adjunto_generico_valido('requisiciones/50000000-0000-0000-0000-000000000001/70000000-0000-0000-0000-000000000001/soporte.pdf')
    or public.path_adjunto_generico_valido('requisiciones/50000000-0000-0000-0000-000000000001/70000000-0000-0000-0000-000000000001/../soporte.pdf')
    or public.path_adjunto_generico_valido('requisiciones/50000000-0000-0000-0000-000000000001/70000000-0000-0000-0000-000000000001/soporte.pdf/extra')
    or public.path_adjunto_generico_valido('proveedores/50000000-0000-0000-0000-000000000001/70000000-0000-0000-0000-000000000001/soporte.pdf') then
    raise exception 'El validador de path canónico es permisivo';
  end if;

  select conbin::text into v_check from pg_constraint
    where conrelid = 'public.adjuntos'::regclass and conname = 'adjuntos_genericos_documento_valido';
  if v_check is null then raise exception 'Falta constraint de metadata genérica'; end if;
  if has_function_privilege('authenticated', 'public.adjunto_generico_existe(text,uuid)', 'execute') then
    raise exception 'El helper SECURITY DEFINER de existencia quedó expuesto';
  end if;
  if has_function_privilege('anon', 'public.adjunto_generico_existe(text,uuid)', 'execute')
    or has_function_privilege('anon', 'public.puede_leer_adjunto(text,uuid,uuid)', 'execute')
    or has_function_privilege('anon', 'public.puede_leer_adjunto_generico_finalizado(uuid,text,uuid,text,text,text,text,text,bigint,uuid)', 'execute') then
    raise exception 'Una función SECURITY DEFINER de adjuntos quedó ejecutable por anon';
  end if;
  if not has_function_privilege('authenticated', 'public.puede_leer_adjunto(text,uuid,uuid)', 'execute')
    or not has_function_privilege('authenticated', 'public.puede_leer_adjunto_generico_finalizado(uuid,text,uuid,text,text,text,text,text,bigint,uuid)', 'execute')
    or not has_function_privilege('service_role', 'public.adjunto_generico_existe(text,uuid)', 'execute') then
    raise exception 'Los privilegios mínimos de helpers de adjuntos no están completos';
  end if;

  select qual into v_qual from pg_policies where schemaname = 'storage' and tablename = 'objects'
    and policyname = 'mizar_storage_read' and cmd = 'SELECT';
  if v_qual is null or v_qual not like '%adjuntos%' or v_qual not like '%puede_leer_adjunto%'
    or v_qual not like '%puede_leer_adjunto_generico_finalizado%'
    or v_qual like '%owner_id%' then
    raise exception 'Storage read no hereda la visibilidad finalizada del adjunto';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'adjuntos' and cmd in ('INSERT', 'UPDATE', 'DELETE'))
    or exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and cmd in ('INSERT', 'UPDATE', 'DELETE')
      and (coalesce(qual, '') like '%requisicion-adjuntos%' or coalesce(with_check, '') like '%requisicion-adjuntos%'))
    or exists (select 1 from pg_policies where schemaname = 'storage' and policyname in ('mizar_storage_upload', 'mizar_storage_update'))
    or has_table_privilege('authenticated', 'public.adjuntos', 'INSERT') then
    raise exception 'Adjuntos genéricos conserva una escritura JWT directa';
  end if;
  -- has_table_privilege('authenticated','storage.objects','INSERT') NO se
  -- verifica aquí: ese grant es infraestructura de Supabase (storage.objects
  -- es propiedad de supabase_storage_admin) que el rol postgres de las
  -- migraciones no puede revocar (confirmado empíricamente: el REVOKE
  -- ejecutado como postgres es un no-op). El invariante real ("ningún JWT
  -- autenticado escribe directo") ya se ejercita como ataque simulado más
  -- abajo contra storage.objects y depende de RLS, no de este grant de
  -- plataforma.
  select qual into v_qual from pg_policies where schemaname = 'public' and tablename = 'adjuntos'
    and policyname = 'adjuntos_lectura_operativa' and cmd = 'SELECT';
  if v_qual is null or v_qual not like '%puede_leer_adjunto_generico_finalizado%' then
    raise exception 'Lectura de adjuntos no cierra filas genéricas legacy';
  end if;

  insert into public.requisiciones(consecutivo, tipo, obra_id, solicitante_id, canal)
    values ('', 'compra', '30000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'web')
    returning id into v_requisicion;
  insert into public.requisicion_items(requisicion_id, descripcion_libre, cantidad, unidad)
    values (v_requisicion, 'Soporte QA', 1, 'unidad') returning id into v_item;
  insert into public.caja_menor(obra_id, fecha, concepto, valor, registrado_por)
    values ('30000000-0000-0000-0000-000000000001', current_date, 'Caja QA adjunto', 1000, '10000000-0000-0000-0000-000000000002')
    returning id into v_caja;

  -- La ruta debe corresponder a entidad, id y adjunto; MIME y tamaño son
  -- validados antes de que haya metadata legible.
  v_path := 'requisiciones/' || v_requisicion || '/' || v_adjunto || '/soporte-qa.pdf';
  begin
    insert into public.adjuntos(id, entidad, entidad_id, url_storage, tipo, nombre_original, tamano_bytes, storage_bucket, mime_type, checksum_sha256, subido_por)
      values (v_adjunto, 'requisicion', v_requisicion, replace(v_path, 'requisiciones/', 'caja-menor/'), 'soporte', 'soporte-qa.pdf', 1024, 'requisicion-adjuntos', 'application/pdf', repeat('b', 64), '10000000-0000-0000-0000-000000000001');
    raise exception 'Aceptó path de otra entidad';
  exception when sqlstate '23514' then null;
  end;
  begin
    insert into public.adjuntos(id, entidad, entidad_id, url_storage, tipo, nombre_original, tamano_bytes, storage_bucket, mime_type, subido_por)
      values (v_adjunto, 'requisicion', v_requisicion, v_path, 'soporte', 'soporte-qa.pdf', 20971521, 'requisicion-adjuntos', 'application/pdf', '10000000-0000-0000-0000-000000000001');
    raise exception 'Aceptó soporte que supera 20 MiB';
  exception when sqlstate '23514' then null;
  end;
  begin
    insert into public.adjuntos(id, entidad, entidad_id, url_storage, tipo, nombre_original, tamano_bytes, storage_bucket, mime_type, subido_por)
      values (v_adjunto, 'requisicion', v_requisicion, v_path, 'soporte', 'soporte-qa.pdf', 1024, null, 'application/pdf', '10000000-0000-0000-0000-000000000001');
    raise exception 'Aceptó storage_bucket NULL';
  exception when sqlstate '23514' then null;
  end;
  begin
    insert into public.adjuntos(id, entidad, entidad_id, url_storage, tipo, nombre_original, tamano_bytes, storage_bucket, mime_type, subido_por)
      values (v_adjunto, 'requisicion', v_requisicion, v_path, 'soporte', 'soporte-qa.pdf', 1024, 'requisicion-adjuntos', null, '10000000-0000-0000-0000-000000000001');
    raise exception 'Aceptó mime_type NULL';
  exception when sqlstate '23514' then null;
  end;
  begin
    insert into public.adjuntos(id, entidad, entidad_id, url_storage, tipo, nombre_original, tamano_bytes, storage_bucket, mime_type, subido_por)
      values (v_adjunto, 'requisicion', v_requisicion, v_path, 'soporte', 'soporte-qa.pdf', null, 'requisicion-adjuntos', 'application/pdf', '10000000-0000-0000-0000-000000000001');
    raise exception 'Aceptó tamano_bytes NULL';
  exception when sqlstate '23514' then null;
  end;
  begin
    insert into public.adjuntos(id, entidad, entidad_id, url_storage, tipo, nombre_original, tamano_bytes, storage_bucket, mime_type, subido_por)
      values (v_adjunto, 'requisicion', v_requisicion, v_path, 'recibo', 'soporte-qa.pdf', 1024, 'requisicion-adjuntos', 'application/pdf', '10000000-0000-0000-0000-000000000001');
    raise exception 'Requisición aceptó tipo no permitido';
  exception when sqlstate '23514' then null;
  end;
  begin
    insert into public.adjuntos(id, entidad, entidad_id, url_storage, tipo, nombre_original, tamano_bytes, storage_bucket, mime_type, subido_por)
      values (v_adjunto, 'requisicion_item', v_item,
        'requisicion-items/' || v_item || '/' || v_adjunto || '/soporte-qa.pdf',
        'soporte', 'soporte-qa.pdf', 1024, 'requisicion-adjuntos', 'application/pdf', '10000000-0000-0000-0000-000000000001');
    raise exception 'Ítem aceptó un tipo distinto de foto';
  exception when sqlstate '23514' then null;
  end;
  begin
    insert into public.adjuntos(id, entidad, entidad_id, url_storage, tipo, nombre_original, tamano_bytes, storage_bucket, mime_type, subido_por)
      values (v_adjunto, 'caja_menor', v_caja,
        'caja-menor/' || v_caja || '/' || v_adjunto || '/foto-qa.png',
        'recibo', 'foto-qa.png', 1024, 'requisicion-adjuntos', 'image/png', '10000000-0000-0000-0000-000000000002');
    raise exception 'Caja menor aceptó tipo distinto de soporte';
  exception when sqlstate '23514' then null;
  end;
  begin
    insert into public.adjuntos(id, entidad, entidad_id, url_storage, tipo, nombre_original, tamano_bytes, storage_bucket, mime_type, subido_por)
      values (v_adjunto, 'requisicion', v_requisicion, v_path, 'soporte', 'soporte-qa.exe', 1024, 'requisicion-adjuntos', 'application/x-msdownload', '10000000-0000-0000-0000-000000000001');
    raise exception 'Aceptó MIME inseguro';
  exception when sqlstate '23514' then null;
  end;
  begin
    insert into public.adjuntos(id, entidad, entidad_id, url_storage, tipo, nombre_original, tamano_bytes, storage_bucket, mime_type, subido_por)
      values (v_adjunto, 'requisicion', v_requisicion,
        replace(v_path, 'soporte-qa.pdf', 'soporte-qa.exe'), 'soporte', 'soporte-qa.exe', 1024, 'requisicion-adjuntos', 'application/pdf', '10000000-0000-0000-0000-000000000001');
    raise exception 'Aceptó extensión incompatible con MIME';
  exception when sqlstate '23514' then null;
  end;
  begin
    insert into public.adjuntos(id, entidad, entidad_id, url_storage, tipo, nombre_original, tamano_bytes, storage_bucket, mime_type, subido_por)
      values (v_adjunto, 'requisicion', '50000000-0000-0000-0000-000000000999',
        'requisiciones/50000000-0000-0000-0000-000000000999/' || v_adjunto || '/soporte-qa.pdf', 'soporte', 'soporte-qa.pdf', 1024, 'requisicion-adjuntos', 'application/pdf', '10000000-0000-0000-0000-000000000001');
    raise exception 'Aceptó soporte de una entidad inexistente';
  exception when sqlstate '23503' then null;
  end;

  insert into public.adjuntos(id, entidad, entidad_id, url_storage, tipo, nombre_original, tamano_bytes, storage_bucket, mime_type, checksum_sha256, subido_por)
    values (v_adjunto, 'requisicion', v_requisicion, v_path, 'soporte', 'soporte-qa.pdf', 1024, 'requisicion-adjuntos', 'application/pdf', repeat('b', 64), '10000000-0000-0000-0000-000000000001');
  insert into public.adjuntos(id, entidad, entidad_id, url_storage, tipo, nombre_original, tamano_bytes, storage_bucket, mime_type, subido_por)
    values (v_adjunto_item, 'requisicion_item', v_item,
      'requisicion-items/' || v_item || '/' || v_adjunto_item || '/foto-qa.webp',
      'foto', 'foto-qa.webp', 2048, 'requisicion-adjuntos', 'image/webp', '10000000-0000-0000-0000-000000000001');
  insert into public.adjuntos(id, entidad, entidad_id, url_storage, tipo, nombre_original, tamano_bytes, storage_bucket, mime_type, subido_por)
    values (v_adjunto_caja, 'caja_menor', v_caja,
      'caja-menor/' || v_caja || '/' || v_adjunto_caja || '/recibo-qa.png',
      'soporte', 'recibo-qa.png', 2048, 'requisicion-adjuntos', 'image/png', '10000000-0000-0000-0000-000000000002');
  v_path_pendiente := 'requisiciones/' || v_requisicion || '/70000000-0000-0000-0000-000000000099/pendiente.pdf';
  v_path_legacy := 'legacy/ruta-no-canonica.pdf';
  -- Fixture mínima compatible con Storage Supabase: el objeto pendiente no
  -- tiene fila adjuntos y por tanto jamás es legible por RLS.
  insert into storage.objects(bucket_id, name, owner_id, metadata)
    values ('requisicion-adjuntos', v_path, '10000000-0000-0000-0000-000000000001', '{}'::jsonb),
      ('requisicion-adjuntos', v_path_pendiente, '10000000-0000-0000-0000-000000000001', '{}'::jsonb),
      ('requisicion-adjuntos', v_path_legacy, '10000000-0000-0000-0000-000000000001', '{}'::jsonb);
  -- Simula una fila de antes de 003. El CHECK es NOT VALID intencionalmente,
  -- por lo que la fixture se inserta durante una ventana de mantenimiento y
  -- se restaura inmediatamente. Tiene bucket moderno y objeto real, pero su
  -- ruta no canónica debe quedar cerrada tanto en metadata como en Storage.
  select pg_get_expr(conbin, conrelid) into v_check_expr from pg_constraint
    where conrelid = 'public.adjuntos'::regclass and conname = 'adjuntos_genericos_documento_valido';
  execute 'alter table public.adjuntos drop constraint adjuntos_genericos_documento_valido';
  insert into public.adjuntos(id, entidad, entidad_id, url_storage, tipo, nombre_original, tamano_bytes, storage_bucket, mime_type, subido_por)
    values (v_adjunto_legacy, 'requisicion', v_requisicion, v_path_legacy, 'soporte',
      'archivo-legacy.pdf', 1024, 'requisicion-adjuntos', 'application/pdf', '10000000-0000-0000-0000-000000000001');
  execute format(
    'alter table public.adjuntos add constraint adjuntos_genericos_documento_valido check (%s) not valid',
    v_check_expr
  );
  if exists (select 1 from public.auditoria where entidad = 'adjuntos' and entidad_id = v_adjunto
    and datos_json::text ~ 'soporte-qa.pdf|requisiciones/|bbbbbbbbbbbbbbbb|application/pdf') then
    raise exception 'Auditoría filtró metadata privada del soporte';
  end if;

  -- Un solicitante puede leer sólo su soporte finalizado, pero nunca escribe
  -- metadata ni Storage: eso requiere prepare signed + HEAD/complete server-side.
  perform set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000001', true);
  execute 'set local role authenticated';
  if not exists (select 1 from public.adjuntos where id = v_adjunto)
    or exists (select 1 from public.adjuntos where id = v_adjunto_legacy)
    or exists (select 1 from storage.objects where bucket_id = 'requisicion-adjuntos' and name = v_path_legacy) then
    raise exception 'RLS no distingue soporte finalizado de fila legacy en metadata o Storage';
  end if;
  if not exists (select 1 from storage.objects where bucket_id = 'requisicion-adjuntos' and name = v_path)
    or exists (select 1 from storage.objects where bucket_id = 'requisicion-adjuntos' and name = v_path_pendiente) then
    raise exception 'RLS Storage no distingue metadata finalizada de carga pendiente';
  end if;
  if public.puede_leer_adjunto('requisicion', v_requisicion, '10000000-0000-0000-0000-000000000002') then
    raise exception 'El helper de lectura permite consultar permisos de otro usuario';
  end if;
  v_path_rechazo_solicitante := 'requisiciones/' || v_requisicion || '/70000000-0000-0000-0000-000000000011/rechazo-solicitante.pdf';
  begin
    insert into public.adjuntos(id, entidad, entidad_id, url_storage, tipo, nombre_original, tamano_bytes, storage_bucket, mime_type, subido_por)
      values ('70000000-0000-0000-0000-000000000011', 'requisicion', v_requisicion, v_path_rechazo_solicitante,
        'soporte', 'rechazo-solicitante.pdf', 1024, 'requisicion-adjuntos', 'application/pdf', auth.uid());
    raise exception 'Solicitante escribió metadata de adjunto directamente';
  exception when sqlstate '42501' then null;
  end;
  begin
    insert into storage.objects(bucket_id, name, owner_id, metadata)
      values ('requisicion-adjuntos', v_path_rechazo_solicitante, auth.uid()::text, '{}'::jsonb);
    raise exception 'Solicitante escribió Storage directamente';
  exception when sqlstate '42501' then null;
  end;
  begin
    update storage.objects set metadata = '{"intento":"solicitante"}'::jsonb
      where bucket_id = 'requisicion-adjuntos' and name = v_path;
    get diagnostics v_filas = row_count;
    -- storage.objects no tiene ninguna policy UPDATE ni ALL (sólo las dos
    -- SELECT ya verificadas arriba), así que un UPDATE de 'authenticated'
    -- no dispara 42501 (ese código sólo aparece cuando falla un WITH CHECK
    -- de INSERT/UPDATE; para UPDATE sin policy aplicable, Postgres filtra
    -- las filas visibles a 0 y el comando simplemente no afecta ninguna,
    -- de forma silenciosa: comportamiento estándar documentado de RLS).
    -- El invariante real ("el solicitante no logra modificar Storage") se
    -- verifica exigiendo 0 filas afectadas, no un código de error concreto.
    if v_filas > 0 then
      raise exception 'Solicitante actualizó Storage directamente';
    end if;
  exception when sqlstate '42501' then null;
  end;
  execute 'reset role';

  -- Ordenes siguen la RLS de ordenes_lectura_operativa: el solicitante no
  -- obtiene soporte de la OC, pero su aprobador enrutado sí.
  select id into v_etiqueta from public.etiquetas where nombre = 'Materiales';
  insert into public.requisiciones(consecutivo, tipo, obra_id, solicitante_id, canal, etiqueta_id)
    values ('', 'compra', '30000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'web', v_etiqueta)
    returning id into v_requisicion_orden;
  insert into public.ordenes(consecutivo, tipo, requisicion_id)
    values ('', 'OC', v_requisicion_orden) returning id into v_orden;
  insert into public.adjuntos(id, entidad, entidad_id, url_storage, tipo, nombre_original, tamano_bytes, storage_bucket, mime_type, subido_por)
    values (v_adjunto_orden, 'orden', v_orden, 'ordenes/' || v_orden || '/orden-qa.pdf', 'soporte', 'orden-qa.pdf', 1024,
      'requisicion-adjuntos', 'application/pdf', '10000000-0000-0000-0000-000000000002');
  perform set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000001', true);
  execute 'set local role authenticated';
  if exists (select 1 from public.adjuntos where id = v_adjunto_orden) then
    raise exception 'Solicitante puede leer soporte de orden';
  end if;
  execute 'reset role';
  insert into public.usuario_roles(usuario_id, rol)
    values ('10000000-0000-0000-0000-000000000005', 'solicitante') on conflict do nothing;
  perform set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000005', true);
  execute 'set local role authenticated';
  if exists (select 1 from storage.objects where bucket_id = 'requisicion-adjuntos' and name = v_path) then
    raise exception 'Otro solicitante puede leer soporte ajeno';
  end if;
  execute 'reset role';
  perform set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000003', true);
  execute 'set local role authenticated';
  if not exists (select 1 from public.adjuntos where id = v_adjunto_orden) then
    raise exception 'Aprobador enrutado no puede leer soporte de orden';
  end if;
  execute 'reset role';

  -- Ni siquiera el revisor escribe por SQL directo: prepare signed y complete
  -- con HEAD son acciones server/service-role, no rutas JWT.
  perform set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000002', true);
  execute 'set local role authenticated';
  v_path_rechazo_revisor := 'caja-menor/' || v_caja || '/70000000-0000-0000-0000-000000000012/rechazo-revisor.pdf';
  begin
    insert into public.adjuntos(id, entidad, entidad_id, url_storage, tipo, nombre_original, tamano_bytes, storage_bucket, mime_type, subido_por)
      values ('70000000-0000-0000-0000-000000000012', 'caja_menor', v_caja, v_path_rechazo_revisor,
        'soporte', 'rechazo-revisor.pdf', 1024, 'requisicion-adjuntos', 'application/pdf', auth.uid());
    raise exception 'Revisor escribió metadata de adjunto directamente';
  exception when sqlstate '42501' then null;
  end;
  begin
    insert into storage.objects(bucket_id, name, owner_id, metadata)
      values ('requisicion-adjuntos', v_path_rechazo_revisor, auth.uid()::text, '{}'::jsonb);
    raise exception 'Revisor escribió Storage directamente';
  exception when sqlstate '42501' then null;
  end;
  begin
    update storage.objects set metadata = '{"intento":"revisor"}'::jsonb
      where bucket_id = 'requisicion-adjuntos' and name = v_path;
    get diagnostics v_filas = row_count;
    -- Mismo motivo que el intento del solicitante más arriba: sin policy
    -- UPDATE/ALL en storage.objects, Postgres no lanza 42501, sólo afecta
    -- 0 filas. Se exige 0 filas afectadas como evidencia del bloqueo real.
    if v_filas > 0 then
      raise exception 'Revisor actualizó Storage directamente';
    end if;
  exception when sqlstate '42501' then null;
  end;
  execute 'reset role';

  -- El contrato genérico no altera el expediente de proveedor ni su bucket.
  if not exists (select 1 from pg_constraint where conrelid = 'public.adjuntos'::regclass
    and conname = 'adjuntos_proveedor_documento_valido') then
    raise exception 'La migración genérica eliminó la integridad de proveedor';
  end if;
  if not exists (select 1 from storage.buckets where id = 'proveedor-documentos-privados' and public = false)
    or not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'expediente_proveedor_storage_lectura_privada' and cmd = 'SELECT') then
    raise exception 'La migración genérica alteró el aislamiento de expediente proveedor';
  end if;
end $$;

rollback;
