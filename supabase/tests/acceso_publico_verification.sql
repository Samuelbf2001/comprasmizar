-- Arnés para 202609070002_acceso_publico_global.sql: contraseña GLOBAL del portal público.
-- Registrado en scripts/verify-schema.ts (corre contra una base VACÍA, sembrada solo por
-- supabase/seed.sql). El caso con datos LEGADO reales (una obra con el hash histórico por obra, de
-- antes de esta migración) vive aparte, en supabase/tests/legacy/202609070002_acceso_publico_global.{pre,post}.sql
-- — ver el mecanismo documentado en el encabezado de scripts/verify-schema.ts y en docs/modelo-datos.md.
-- Mismo formato que schema_verification.sql: begin -> do $$ ... $$ (uno por aserción, para que el
-- mensaje de error señale cuál falló) -> rollback, así nunca deja basura en la base contra la que se
-- ejecuta.
begin;

-- 1) La fila singleton existe desde la migración, con hash vacío por defecto. GRAVE (QA Postgres
--    real): el hash vive en su PROPIA tabla (acceso_publico.public_code_hash) y no dentro de
--    configuracion.valor — ver el comentario al inicio de 202609070002_acceso_publico_global.sql y
--    la aserción 6 más abajo, que prueba justo la razón de este diseño.
do $$
declare v_hash text;
begin
  if not exists (select 1 from public.acceso_publico where id = '00000000-0000-0000-0000-000000000001') then
    raise exception 'Falta la fila singleton de acceso_publico';
  end if;
  select public_code_hash into v_hash from public.acceso_publico where id = '00000000-0000-0000-0000-000000000001';
  if v_hash is not null then raise exception 'acceso_publico debería arrancar sin hash configurado'; end if;
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

-- 3) Con un hash puesto (mismo mecanismo que usará el PATCH de administración: crypt + gen_salt('bf', 12)),
--    la contraseña correcta valida y la incorrecta no.
do $$
begin
  update public.acceso_publico
     set public_code_hash = extensions.crypt('clave-correcta-2026', extensions.gen_salt('bf', 12))
   where id = '00000000-0000-0000-0000-000000000001';

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

-- 6) GRAVE (QA Postgres real, bloqueante 4 del informe): el hash bcrypt NUNCA debe quedar en texto
--    plano dentro de `auditoria`. Con la primera versión de esta migración (hash dentro de
--    `configuracion.valor`, columna no redactada por `auditoria_campo_sensible`) esta aserción
--    FALLABA — el UPDATE de la aserción 3 de arriba dejaba el bcrypt completo (con su prefijo
--    "$2a$") en `auditoria.datos_json` en texto plano. Con el hash en su propia tabla
--    (`acceso_publico.public_code_hash`, columna que SÍ está en la lista de campos sensibles desde
--    la migración base), el trigger `acceso_publico_auditoria` la redacta como {redactado:true} y
--    esta consulta debe dar 0 filas. Verificado en ambos sentidos (ver el informe final de esta
--    tarea): falla contra el código de la migración original, pasa contra este.
do $$
declare v_con_hash_en_claro integer;
begin
  select count(*) into v_con_hash_en_claro
  from public.auditoria
  where entidad = 'acceso_publico' and datos_json::text like '%$2a$%';
  if v_con_hash_en_claro <> 0 then
    raise exception 'El hash bcrypt quedó en texto plano en auditoria (% fila(s)) — auditoria_campo_sensible no está redactando acceso_publico.public_code_hash', v_con_hash_en_claro;
  end if;
end $$;

rollback;
