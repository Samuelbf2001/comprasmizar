-- Arnés de 202609150005_proveedores_homonimos.sql. Registrado en scripts/verify-schema.ts.
-- Formato del repo: begin -> do $$ ... $$ -> rollback.
begin;

-- 1. El índice conserva su nombre y su expresión, ahora parcial sobre tipo NIT.
do $$
declare v_def text;
begin
  select indexdef into v_def from pg_indexes where schemaname = 'public' and indexname = 'proveedores_razon_social_normalizada_unico_idx';
  if v_def is null or v_def not like '%UNIQUE INDEX%' or v_def not like '%lower(btrim(razon_social))%' or v_def not like '%tipo_identificacion%' then
    raise exception 'proveedores_razon_social_normalizada_unico_idx debe ser UNIQUE, funcional sobre razon_social y parcial por tipo NIT (obtenido %)', v_def;
  end if;
end $$;

-- 2. Dos personas homónimas con cédulas distintas conviven; una persona y una empresa homónimas también;
--    dos NIT con la misma razón social siguen chocando; la misma cédula sigue chocando. El choque entre
--    NIT se prueba con un nombre ASCII: la base del arnés nace con LC_CTYPE 'C' (ver verify-schema.ts),
--    donde `lower()` no baja una É — en producción (UTF8 con locale real) sí; la prueba no debe depender de eso.
do $$
begin
  insert into public.proveedores (razon_social, tipo_identificacion, identificacion) values ('Juan Pérez', 'CC', '71.111.111');
  insert into public.proveedores (razon_social, tipo_identificacion, identificacion) values ('Juan Pérez', 'CC', '71.222.222');
  insert into public.proveedores (razon_social, tipo_identificacion, identificacion) values ('Juan Pérez ', 'CE', 'E-3333');
  insert into public.proveedores (razon_social, tipo_identificacion, identificacion) values ('Juan Pérez', 'NIT', '900.444.444-1');
  if (select count(*) from public.proveedores where btrim(razon_social) = 'Juan Pérez') <> 4 then
    raise exception 'debían convivir tres personas y una empresa homónimas';
  end if;

  begin
    insert into public.proveedores (razon_social, tipo_identificacion, identificacion) values ('Juan Pérez', 'NIT', '900.555.555-1');
    raise exception 'dos NIT con la misma razón social debían chocar';
  exception when unique_violation then null;
  end;
  insert into public.proveedores (razon_social, tipo_identificacion, identificacion) values ('Sixteam SAS', 'NIT', '901.555.666-1');
  begin
    insert into public.proveedores (razon_social, tipo_identificacion, identificacion) values ('  SIXTEAM SAS ', 'NIT', '901.999.999-9');
    raise exception 'dos NIT con la misma razón social (otra caja/espacios) debían chocar';
  exception when unique_violation then null;
  end;
  begin
    insert into public.proveedores (razon_social, tipo_identificacion, identificacion) values ('Otro Nombre', 'CC', '71111111');
    raise exception 'la misma cédula con otro nombre debía chocar';
  exception when unique_violation then null;
  end;
end $$;

rollback;
