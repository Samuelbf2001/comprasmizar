-- Arnés de 202609150002_proveedores_identificacion.sql. Registrado en scripts/verify-schema.ts.
-- Formato del repo: begin -> do $$ ... $$ (uno por grupo) -> rollback. Corre sobre la base YA sembrada
-- por supabase/seed.sql (cinco proveedores con NIT, insertados DESPUÉS de la migración: el espejo
-- nit -> identificacion de esas filas lo hace el trigger, no el backfill — el backfill sobre datos
-- legado lo cubre supabase/tests/legacy/202609150002_proveedores_identificacion.{pre,post}.sql).
begin;

-- 1. Objetos de esquema y espejo sobre las filas sembradas: ningún proveedor con NIT queda sin
--    identificación, y ambas columnas dicen lo mismo.
do $$
declare v_count int;
begin
  select count(*) into v_count from information_schema.columns
   where table_schema = 'public' and table_name = 'proveedores'
     and column_name in ('tipo_identificacion', 'identificacion', 'identificacion_normalizada', 'pendiente_normalizacion');
  if v_count <> 4 then raise exception 'faltan columnas de identificación en proveedores (hay %)', v_count; end if;
  if not exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 'proveedores' and indexname = 'proveedores_identificacion_unico_idx') then
    raise exception 'falta el índice único proveedores_identificacion_unico_idx';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'proveedores_identificacion' and not tgisinternal) then
    raise exception 'falta el trigger proveedores_identificacion';
  end if;
  select count(*) into v_count from public.proveedores where nit is not null and (identificacion is null or identificacion <> nit);
  if v_count > 0 then raise exception '% proveedor(es) con NIT sin identificación espejo', v_count; end if;
  select count(*) into v_count from public.proveedores where tipo_identificacion <> 'NIT' or pendiente_normalizacion;
  if v_count > 0 then raise exception 'los proveedores sembrados deben quedar como NIT y no pendientes (hay % distintos)', v_count; end if;
end $$;

-- 2. Persona natural (CC): sin NIT, con identificación normalizada, pendiente de normalizar. La misma
--    cédula con otra puntuación se rechaza; los mismos dígitos bajo tipo NIT son OTRO tercero.
do $$
declare v_persona uuid; v_empresa uuid; v_nit text; v_norm text;
begin
  insert into public.proveedores (razon_social, tipo_identificacion, identificacion, pendiente_normalizacion)
    values ('Topógrafo Demo', 'CC', '1.020.304.050', true)
    returning id into v_persona;
  select nit, identificacion_normalizada into v_nit, v_norm from public.proveedores where id = v_persona;
  if v_nit is not null then raise exception 'una persona (CC) no debe llevar nit (obtenido %)', v_nit; end if;
  if v_norm <> '1020304050' then raise exception 'identificacion_normalizada debía ser 1020304050, es %', v_norm; end if;

  begin
    insert into public.proveedores (razon_social, tipo_identificacion, identificacion)
      values ('Topógrafo Demo dos', 'CC', '1020304050');
    raise exception 'se permitió una segunda cédula equivalente (misma persona)';
  exception when unique_violation then null;
  end;

  -- Mismos dígitos como NIT: tercero distinto, permitido — y el espejo rellena `nit`.
  insert into public.proveedores (razon_social, tipo_identificacion, identificacion)
    values ('Empresa Homónima SAS', 'NIT', '1020304050')
    returning id into v_empresa;
  select nit into v_nit from public.proveedores where id = v_empresa;
  if v_nit <> '1020304050' then raise exception 'con tipo NIT, nit debe espejar identificacion (obtenido %)', v_nit; end if;
  if exists (select 1 from public.proveedores where id = v_empresa and pendiente_normalizacion) then
    raise exception 'pendiente_normalizacion debe ser false por defecto';
  end if;
end $$;

-- 3. El espejo funciona en las dos direcciones y respeta al que cambió: el camino legado (solo `nit`)
--    arrastra `identificacion`; el camino nuevo (solo `identificacion`) arrastra `nit`; cambiar el tipo
--    a persona borra `nit`; volver a NIT lo recompone desde `identificacion`.
do $$
declare v_id uuid; v_nit text; v_ident text;
begin
  insert into public.proveedores (razon_social, nit) values ('Ferretería Espejo', '800.111.222-3') returning id into v_id;
  select nit, identificacion into v_nit, v_ident from public.proveedores where id = v_id;
  if v_ident <> '800.111.222-3' then raise exception 'insert legado solo con nit: identificacion debía espejarlo (obtenido %)', v_ident; end if;

  update public.proveedores set nit = '800.111.222-4' where id = v_id;
  select identificacion into v_ident from public.proveedores where id = v_id;
  if v_ident <> '800.111.222-4' then raise exception 'update legado de nit: identificacion debía seguirlo (obtenido %)', v_ident; end if;

  update public.proveedores set identificacion = '800.111.222-5' where id = v_id;
  select nit into v_nit from public.proveedores where id = v_id;
  if v_nit <> '800.111.222-5' then raise exception 'update de identificacion: nit debía seguirla (obtenido %)', v_nit; end if;

  update public.proveedores set tipo_identificacion = 'CE' where id = v_id;
  select nit, identificacion into v_nit, v_ident from public.proveedores where id = v_id;
  if v_nit is not null or v_ident <> '800.111.222-5' then raise exception 'al pasar a persona, nit debe quedar NULL y la identificación intacta (nit=%, ident=%)', v_nit, v_ident; end if;

  update public.proveedores set tipo_identificacion = 'NIT' where id = v_id;
  select nit into v_nit from public.proveedores where id = v_id;
  if v_nit <> '800.111.222-5' then raise exception 'al volver a NIT, nit debe recomponerse desde identificacion (obtenido %)', v_nit; end if;
end $$;

-- 4. Auditoría: la identificación de un proveedor se redacta (dato personal cuando es una cédula);
--    la razón social sigue visible, como hasta hoy.
do $$
declare v_id uuid; v_datos jsonb;
begin
  insert into public.proveedores (razon_social, tipo_identificacion, identificacion, pendiente_normalizacion)
    values ('Maestro Auditado', 'CC', '71.555.666', true)
    returning id into v_id;
  select datos_json into v_datos from public.auditoria
   where entidad = 'proveedores' and entidad_id = v_id and evento = 'INSERT' order by fecha desc limit 1;
  if v_datos is null then raise exception 'el alta del proveedor no dejó fila en auditoria'; end if;
  if v_datos::text like '%71.555.666%' or v_datos::text like '%71555666%' then
    raise exception 'la auditoría filtró la identificación del proveedor: %', v_datos;
  end if;
  if (v_datos -> 'datos_nuevos' ->> 'razon_social') is distinct from 'Maestro Auditado' then
    raise exception 'la razón social debe seguir visible en auditoría';
  end if;
end $$;

rollback;
