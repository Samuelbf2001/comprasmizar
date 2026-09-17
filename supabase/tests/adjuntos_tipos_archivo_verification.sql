-- Ejecutar contra una BD local migrada:
-- psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/adjuntos_tipos_archivo_verification.sql
-- Todos los fixtures y ataques se revierten.
--
-- 202609170002: el soporte del portal público admite muchos formatos (decisión de Ernesto, 2026-09-17).
-- Lo que esta prueba fija es que AMPLIAR la lista no aflojó ninguna de las tres barreras que ya había:
-- la lista blanca de MIME sigue siendo cerrada, la extensión sigue teniendo que corresponder con el
-- MIME, y `tipo = 'foto'` sigue significando imagen — invariante que antes se cumplía por accidente
-- (todos los MIME permitidos menos el PDF eran imágenes) y ahora está escrita.
begin;

do $$
declare
  v_requisicion uuid;
  v_item uuid;
  v_adjunto uuid;
  v_path text;
  v_mime text;
  v_nombre text;
  v_aceptados int := 0;
  v_par record;
begin
  insert into public.requisiciones(consecutivo, tipo, obra_id, solicitante_id, canal)
    values ('', 'compra', '30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'web')
    returning id into v_requisicion;
  insert into public.requisicion_items(requisicion_id, descripcion_libre, cantidad, unidad)
    values (v_requisicion, 'Cemento gris', 1, 'bulto') returning id into v_item;

  -- 1) Cada formato nuevo entra como `soporte` de un ÍTEM (el camino del portal público), con su
  --    extensión canónica y bajo la ruta canónica de requisicion-items.
  for v_par in select * from (values
    ('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'cantidades.xlsx'),
    ('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'cuenta-de-cobro.docx'),
    ('application/vnd.openxmlformats-officedocument.presentationml.presentation', 'propuesta.pptx'),
    ('application/vnd.ms-excel', 'presupuesto.xls'),
    ('text/plain', 'lista.csv'),
    ('text/plain', 'notas.txt'),
    ('application/pdf', 'factura.pdf')
  ) as t(mime, nombre) loop
    v_adjunto := gen_random_uuid();
    v_path := 'requisicion-items/' || v_item || '/' || v_adjunto || '/' || v_par.nombre;
    insert into public.adjuntos(id, entidad, entidad_id, url_storage, tipo, nombre_original, tamano_bytes, storage_bucket, mime_type, subido_por)
      values (v_adjunto, 'requisicion_item', v_item, v_path, 'soporte', v_par.nombre, 4096, 'requisicion-adjuntos', v_par.mime, null);
    v_aceptados := v_aceptados + 1;
  end loop;
  if v_aceptados <> 7 then
    raise exception 'No se admitieron los siete formatos de soporte del portal';
  end if;

  -- 2) La foto de siempre sigue entrando exactamente igual, como `foto`.
  v_adjunto := gen_random_uuid();
  v_path := 'requisicion-items/' || v_item || '/' || v_adjunto || '/frente-obra.webp';
  insert into public.adjuntos(id, entidad, entidad_id, url_storage, tipo, nombre_original, tamano_bytes, storage_bucket, mime_type, subido_por)
    values (v_adjunto, 'requisicion_item', v_item, v_path, 'foto', 'frente-obra.webp', 2048, 'requisicion-adjuntos', 'image/webp', null);

  -- 3) `tipo = 'foto'` con un MIME que no es imagen se rechaza: un PDF nunca se guarda como foto.
  v_adjunto := gen_random_uuid();
  v_path := 'requisicion-items/' || v_item || '/' || v_adjunto || '/factura.pdf';
  begin
    insert into public.adjuntos(id, entidad, entidad_id, url_storage, tipo, nombre_original, tamano_bytes, storage_bucket, mime_type, subido_por)
      values (v_adjunto, 'requisicion_item', v_item, v_path, 'foto', 'factura.pdf', 4096, 'requisicion-adjuntos', 'application/pdf', null);
    raise exception 'Una foto aceptó un MIME que no es de imagen';
  exception when sqlstate '23514' then null;
  end;

  -- 4) La extensión sigue teniendo que corresponder con el MIME, en los formatos nuevos también:
  --    un ejecutable renombrado a .xlsx, o un texto con nombre de hoja de cálculo, no pasan.
  for v_par in select * from (values
    ('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'malicioso.exe'),
    ('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'confuso.xls'),
    ('text/plain', 'confuso.xlsx'),
    ('application/vnd.ms-excel', 'confuso.xlsx'),
    ('text/plain', 'confuso.pdf')
  ) as t(mime, nombre) loop
    v_adjunto := gen_random_uuid();
    v_path := 'requisicion-items/' || v_item || '/' || v_adjunto || '/' || v_par.nombre;
    begin
      insert into public.adjuntos(id, entidad, entidad_id, url_storage, tipo, nombre_original, tamano_bytes, storage_bucket, mime_type, subido_por)
        values (v_adjunto, 'requisicion_item', v_item, v_path, 'soporte', v_par.nombre, 4096, 'requisicion-adjuntos', v_par.mime, null);
      raise exception 'Aceptó la extensión % con el MIME %', v_par.nombre, v_par.mime;
    exception when sqlstate '23514' then null;
    end;
  end loop;

  -- 5) La lista blanca sigue CERRADA: un zip, un HTML o un SVG no son formatos de soporte por mucho
  --    que su nombre y su MIME sean coherentes entre sí.
  for v_par in select * from (values
    ('application/zip', 'paquete.zip'),
    ('text/html', 'pagina.html'),
    ('image/svg+xml', 'dibujo.svg'),
    ('application/x-msdownload', 'instalador.exe')
  ) as t(mime, nombre) loop
    v_adjunto := gen_random_uuid();
    v_path := 'requisicion-items/' || v_item || '/' || v_adjunto || '/' || v_par.nombre;
    begin
      insert into public.adjuntos(id, entidad, entidad_id, url_storage, tipo, nombre_original, tamano_bytes, storage_bucket, mime_type, subido_por)
        values (v_adjunto, 'requisicion_item', v_item, v_path, 'soporte', v_par.nombre, 4096, 'requisicion-adjuntos', v_par.mime, null);
      raise exception 'Aceptó el MIME % fuera de la lista blanca', v_par.mime;
    exception when sqlstate '23514' then null;
    end;
  end loop;

  -- 6) El tope exterior no se movió con la ampliación: 20 MiB + 1 byte se sigue rechazando.
  v_adjunto := gen_random_uuid();
  v_path := 'requisicion-items/' || v_item || '/' || v_adjunto || '/enorme.xlsx';
  begin
    insert into public.adjuntos(id, entidad, entidad_id, url_storage, tipo, nombre_original, tamano_bytes, storage_bucket, mime_type, subido_por)
      values (v_adjunto, 'requisicion_item', v_item, v_path, 'soporte', 'enorme.xlsx', 20971521, 'requisicion-adjuntos',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', null);
    raise exception 'Aceptó un soporte por encima de la barrera exterior de 20 MiB';
  exception when sqlstate '23514' then null;
  end;

  -- 7) El expediente de proveedor NO se amplió: un RUT en Excel se sigue rechazando (su constraint es
  --    otra, 202608240002, y esta migración no la toca).
  v_adjunto := gen_random_uuid();
  begin
    insert into public.adjuntos(id, entidad, entidad_id, url_storage, tipo, nombre_original, tamano_bytes, storage_bucket, mime_type, subido_por)
      values (v_adjunto, 'proveedor', '40000000-0000-4000-8000-000000000001',
        'proveedores/40000000-0000-4000-8000-000000000001/' || v_adjunto || '/rut.xlsx', 'rut', 'rut.xlsx', 4096,
        'proveedor-documentos-privados', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', null);
    raise exception 'El expediente de proveedor aceptó una hoja de cálculo';
  exception when sqlstate '23514' then null;
  end;

  -- 8) Las funciones auxiliares dicen lo mismo que la constraint, y no quedaron expuestas a anon.
  v_mime := 'text/plain'; v_nombre := 'lista.csv';
  if not public.mime_adjunto_generico_permitido(v_mime)
    or not public.nombre_mime_adjunto_valido(v_nombre, v_mime)
    or public.nombre_mime_adjunto_valido('lista.pdf', v_mime)
    or public.tipo_mime_adjunto_coherente('foto', v_mime)
    or not public.tipo_mime_adjunto_coherente('soporte', v_mime)
    or not public.tipo_mime_adjunto_coherente('foto', 'image/png')
    or public.mime_adjunto_generico_permitido('application/zip')
    or public.mime_adjunto_generico_permitido(null) then
    raise exception 'Los helpers de tipo de archivo no coinciden con la constraint';
  end if;
  if has_function_privilege('anon', 'public.mime_adjunto_generico_permitido(text)', 'execute')
    or has_function_privilege('anon', 'public.tipo_mime_adjunto_coherente(text,text)', 'execute') then
    raise exception 'Un helper de tipo de archivo quedó ejecutable por anon';
  end if;

  -- 9) El bucket declara los mismos formatos que acepta la constraint: si divergieran, el próximo
  --    lector creería la declaración equivocada.
  if not exists (
    select 1 from storage.buckets
    where id = 'requisicion-adjuntos'
      and allowed_mime_types @> array[
        'application/pdf', 'image/jpeg', 'image/png', 'image/webp',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'application/vnd.ms-excel', 'text/plain'
      ]
  ) then
    raise exception 'El bucket privado no declara los formatos que la constraint admite';
  end if;
  if exists (
    select 1 from storage.buckets, unnest(allowed_mime_types) as declarado(mime)
    where id = 'requisicion-adjuntos' and not public.mime_adjunto_generico_permitido(declarado.mime)
  ) then
    raise exception 'El bucket privado declara un formato que la constraint rechaza';
  end if;
end $$;

rollback;
