-- Arnés para 202609070002_acceso_publico_global.sql: contraseña GLOBAL del portal público.
-- No está registrado en scripts/verify-schema.ts (a propósito, ver AGENTS.md de esta tarea); se corre
-- a mano contra el mismo Postgres embebido que usa ese arnés. Mismo formato que schema_verification.sql:
-- begin -> do $$ ... $$ (uno por aserción, para que el mensaje de error señale cuál falló) -> rollback,
-- así nunca deja basura en la base contra la que se ejecuta.
begin;

-- 1) La fila de configuración existe desde la migración, con hash vacío por defecto.
do $$
declare v_valor jsonb;
begin
  select valor into v_valor from public.configuracion where clave = 'acceso_publico_v1';
  if v_valor is null then raise exception 'Falta la fila de configuracion acceso_publico_v1'; end if;
  if not (v_valor ? 'codigo_hash') then raise exception 'acceso_publico_v1 no tiene la clave codigo_hash'; end if;
  if (v_valor -> 'codigo_hash') <> 'null'::jsonb then raise exception 'acceso_publico_v1 debería arrancar sin hash configurado'; end if;
end $$;

-- 2) Sin hash configurado, verificar_codigo_publico rechaza CUALQUIER código (nunca "todo vale").
do $$
begin
  if public.verificar_codigo_publico('lo-que-sea') is not false then
    raise exception 'verificar_codigo_publico debe devolver false sin hash configurado';
  end if;
  if public.verificar_codigo_publico('') is not false then
    raise exception 'verificar_codigo_publico debe devolver false (código vacío) sin hash configurado';
  end if;
end $$;

-- 3) Con un hash puesto (mismo mecanismo que usará el PATCH de administración: crypt + gen_salt('bf')),
--    la contraseña correcta valida y la incorrecta no.
do $$
begin
  update public.configuracion
     set valor = jsonb_build_object('codigo_hash', extensions.crypt('clave-correcta-2026', extensions.gen_salt('bf')), 'actualizado_en', now()::text)
   where clave = 'acceso_publico_v1';

  if public.verificar_codigo_publico('clave-correcta-2026') is not true then
    raise exception 'verificar_codigo_publico debe aceptar la contraseña correcta';
  end if;
  if public.verificar_codigo_publico('clave-incorrecta') is not false then
    raise exception 'verificar_codigo_publico debe rechazar una contraseña incorrecta';
  end if;
  if public.verificar_codigo_publico('') is not false then
    raise exception 'verificar_codigo_publico debe rechazar un código vacío aunque haya hash configurado';
  end if;
end $$;

-- 4) obras_codigo_publico_check ya no existe: una obra con public_submission_enabled = true y
--    public_code_hash NULL es válida (la constraint vieja la habría rechazado con 23514).
do $$
declare v_obra_id uuid;
begin
  if exists (select 1 from pg_constraint where conname = 'obras_codigo_publico_check') then
    raise exception 'obras_codigo_publico_check debería haberse eliminado en 202609070002';
  end if;
  insert into public.obras (nombre, sociedad_id, estado, public_submission_enabled, public_code_hash)
  values ('Obra arnés acceso público', '20000000-0000-0000-0000-000000000001', 'activa', true, null)
  returning id into v_obra_id;
  if not exists (select 1 from public.obras where id = v_obra_id and public_submission_enabled and public_code_hash is null) then
    raise exception 'La obra con hash NULL y portal habilitado no quedó guardada como se esperaba';
  end if;
end $$;

-- 5) anon/authenticated no pueden ejecutar la función directamente (mismo criterio que next_consecutivo).
do $$
begin
  if has_function_privilege('anon', 'public.verificar_codigo_publico(text)', 'execute')
    or has_function_privilege('authenticated', 'public.verificar_codigo_publico(text)', 'execute') then
    raise exception 'verificar_codigo_publico no debería ser ejecutable por anon/authenticated';
  end if;
end $$;

rollback;
