-- Ejecutar tras migraciones + seed local:
-- psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/supplier_documents_verification.sql
-- Los fixtures y ataques se revierten siempre.
begin;

do $$
declare
  v_proveedor constant uuid := '40000000-0000-0000-0000-000000000001';
  v_adjunto uuid := '60000000-0000-0000-0000-000000000001';
  v_ruta text := 'proveedores/40000000-0000-0000-0000-000000000001/60000000-0000-0000-0000-000000000001/rut-qa.pdf';
  v_requisicion uuid; v_orden uuid; v_item_1 uuid; v_item_2 uuid; v_storage_qual text;
begin
  if not exists (select 1 from storage.buckets where id = 'proveedor-documentos-privados' and public = false) then
    raise exception 'El bucket de proveedores debe ser privado';
  end if;
  if not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'proveedor_historial_ordenes' and c.relkind = 'v'
      and coalesce(c.reloptions, '{}'::text[]) @> array['security_invoker=true']) then
    raise exception 'proveedor_historial_ordenes debe ser SECURITY INVOKER';
  end if;
  select qual into v_storage_qual from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'expediente_proveedor_storage_lectura_privada' and cmd = 'SELECT';
  if v_storage_qual is null
    or v_storage_qual like '%owner_id%'
    or v_storage_qual not like '%adjuntos%'
    or v_storage_qual not like '%storage_bucket%'
    or v_storage_qual not like '%url_storage%'
    or v_storage_qual not like '%proveedor-documentos-privados%' then
    raise exception 'Storage read no está ligado al bucket y metadata canónica, o hereda owner_id';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
    and policyname like 'expediente_proveedor_storage_%' and cmd in ('INSERT', 'UPDATE', 'DELETE')) then
    raise exception 'Storage de proveedor no debe aceptar escrituras JWT directas';
  end if;

  -- Ruta/nombre no pueden cruzar expedientes, usar traversal o MIME inseguro.
  begin
    insert into public.adjuntos(id, entidad, entidad_id, url_storage, tipo, nombre_original, tamano_bytes, storage_bucket, mime_type, checksum_sha256, subido_por)
    values (v_adjunto, 'proveedor', v_proveedor, 'proveedores/otro/60000000-0000-0000-0000-000000000001/rut-qa.pdf', 'rut', 'rut-qa.pdf', 1024, 'proveedor-documentos-privados', 'application/pdf', repeat('a', 64), '10000000-0000-0000-0000-000000000002');
    raise exception 'Aceptó ruta de expediente mal formada';
  exception when sqlstate '23514' then null;
  end;
  begin
    insert into public.adjuntos(id, entidad, entidad_id, url_storage, tipo, nombre_original, tamano_bytes, storage_bucket, mime_type, checksum_sha256, subido_por)
    values ('60000000-0000-0000-0000-000000000002', 'proveedor', v_proveedor,
      'proveedores/40000000-0000-0000-0000-000000000001/60000000-0000-0000-0000-000000000002/../rut.pdf', 'rut', '../rut.pdf', 1024, 'proveedor-documentos-privados', 'application/pdf', repeat('a', 64), '10000000-0000-0000-0000-000000000002');
    raise exception 'Aceptó nombre de archivo inseguro';
  exception when sqlstate '23514' then null;
  end;
  begin
    insert into public.adjuntos(id, entidad, entidad_id, url_storage, tipo, nombre_original, tamano_bytes, storage_bucket, mime_type, checksum_sha256, subido_por)
    values ('60000000-0000-0000-0000-000000000003', 'proveedor', '40000000-0000-0000-0000-000000009999',
      'proveedores/40000000-0000-0000-0000-000000009999/60000000-0000-0000-0000-000000000003/rut.pdf', 'rut', 'rut.pdf', 1024, 'proveedor-documentos-privados', 'application/pdf', repeat('a', 64), '10000000-0000-0000-0000-000000000002');
    raise exception 'Aceptó proveedor inexistente';
  exception when sqlstate '23503' then null;
  end;
  begin
    insert into public.adjuntos(id, entidad, entidad_id, url_storage, tipo, nombre_original, tamano_bytes, storage_bucket, mime_type, checksum_sha256, subido_por)
    values ('60000000-0000-0000-0000-000000000004', 'proveedor', v_proveedor,
      'proveedores/40000000-0000-0000-0000-000000000001/60000000-0000-0000-0000-000000000004/calidad.pdf', 'certificado_calidad', 'calidad.pdf', 1024, 'proveedor-documentos-privados', 'application/x-msdownload', repeat('a', 64), '10000000-0000-0000-0000-000000000002');
    raise exception 'Aceptó MIME no permitido';
  exception when sqlstate '23514' then null;
  end;
  begin
    insert into public.adjuntos(id, entidad, entidad_id, url_storage, tipo, nombre_original, tamano_bytes, storage_bucket, mime_type, subido_por)
    values ('60000000-0000-0000-0000-000000000006', 'proveedor', v_proveedor,
      'proveedores/40000000-0000-0000-0000-000000000001/60000000-0000-0000-0000-000000000006/nullos.pdf', 'rut', 'nullos.pdf', 1024, null, null, '10000000-0000-0000-0000-000000000002');
    raise exception 'Aceptó bucket o MIME NULL para proveedor';
  exception when sqlstate '23514' then null;
  end;

  insert into public.adjuntos(id, entidad, entidad_id, url_storage, tipo, nombre_original, tamano_bytes, storage_bucket, mime_type, checksum_sha256, subido_por)
  values (v_adjunto, 'proveedor', v_proveedor, v_ruta, 'rut', 'rut-qa.pdf', 1024, 'proveedor-documentos-privados', 'application/pdf', repeat('a', 64), '10000000-0000-0000-0000-000000000002');
  begin
    update public.adjuntos set nombre_original = 'otro.pdf' where id = v_adjunto;
    raise exception 'Permitió modificar evidencia de proveedor';
  exception when sqlstate '55000' then null;
  end;
  begin
    delete from public.adjuntos where id = v_adjunto;
    raise exception 'Permitió borrar evidencia de proveedor';
  exception when sqlstate '55000' then null;
  end;
  if exists (select 1 from public.auditoria where entidad = 'adjuntos' and entidad_id = v_adjunto
    and datos_json::text ~ 'rut-qa.pdf|proveedores/40000000|aaaaaaaaaaaaaaaa|application/pdf') then
    raise exception 'Auditoría expone metadata/ruta privada de adjunto';
  end if;

  -- Acceso cruzado: conocer UUID/ruta no da lectura ni escritura de proveedor.
  perform set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000001', true);
  execute 'set local role authenticated';
  if exists (select 1 from public.adjuntos where id = v_adjunto) then
    raise exception 'Acceso cruzado: solicitante leyó documento de proveedor';
  end if;
  begin
    insert into public.adjuntos(id, entidad, entidad_id, url_storage, tipo, nombre_original, tamano_bytes, storage_bucket, mime_type, checksum_sha256, subido_por)
    values ('60000000-0000-0000-0000-000000000005', 'proveedor', v_proveedor,
      'proveedores/40000000-0000-0000-0000-000000000001/60000000-0000-0000-0000-000000000005/ataque.pdf', 'rut', 'ataque.pdf', 1024, 'proveedor-documentos-privados', 'application/pdf', repeat('a', 64), '10000000-0000-0000-0000-000000000001');
    raise exception 'Solicitante escribió metadata privada';
  exception when sqlstate '42501' then null;
  end;
  execute 'reset role';

  perform set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000004', true);
  execute 'set local role authenticated';
  if not exists (select 1 from public.adjuntos where id = v_adjunto) then
    raise exception 'Contabilidad no puede leer expediente privado';
  end if;
  begin
    update public.adjuntos set nombre_original = 'cambio.pdf' where id = v_adjunto;
    raise exception 'Contabilidad escribió evidencia privada';
  exception when sqlstate '42501' then null;
  end;
  execute 'reset role';

  -- RF-604: una sola fila por OC/OP, sin duplicar sus ítems/totales.
  select id into v_item_1 from public.items where nombre_normalizado = 'cemento gris 50 kg';
  select id into v_item_2 from public.items where nombre_normalizado = 'arena de rio';
  insert into public.requisiciones(consecutivo, tipo, obra_id, solicitante_id, canal)
    values ('', 'compra', '30000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'web') returning id into v_requisicion;
  insert into public.requisicion_items(requisicion_id, item_id, cantidad, unidad, valor_base, iva)
    values (v_requisicion, v_item_1, 2, 'bulto', 1000, 190), (v_requisicion, v_item_2, 3, 'm3', 2000, 380);
  insert into public.ordenes(consecutivo, tipo, requisicion_id, proveedor_id)
    values ('', 'OC', v_requisicion, v_proveedor) returning id into v_orden;
  insert into public.orden_items(orden_id, requisicion_item_id)
    select v_orden, id from public.requisicion_items where requisicion_id = v_requisicion;
  if not exists (select 1 from public.proveedor_historial_ordenes
    where orden_id = v_orden and proveedor_id = v_proveedor and cantidad_items = 2
      and valor_base = 8000 and iva = 1520 and valor_total = 9520)
    or (select count(*) from public.proveedor_historial_ordenes where orden_id = v_orden) <> 1 then
    raise exception 'Historial de proveedor duplica o calcula mal los totales';
  end if;

  update public.proveedores set datos_bancarios = '{"cuenta":"PII_BANCO_NO_AUDITAR"}'::jsonb where id = v_proveedor;
  if exists (select 1 from public.auditoria where entidad = 'proveedores' and entidad_id = v_proveedor
    and datos_json::text like '%PII_BANCO_NO_AUDITAR%') then
    raise exception 'Auditoría expone PII bancaria';
  end if;
end $$;

rollback;
