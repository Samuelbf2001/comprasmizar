-- Arnés de 202609110001_alta_de_usuarios.sql: alta de cuentas desde la propia plataforma.
-- Registrado en scripts/verify-schema.ts. Formato del repo: begin -> do $$ ... $$ -> rollback.
begin;

-- 1. El índice único existe SOBRE LA EXPRESIÓN que usa el login, no sobre la columna cruda.
do $$
declare v_count int;
begin
  select count(*) into v_count from pg_indexes
   where schemaname = 'auth' and tablename = 'users'
     and indexdef ilike '%unique%' and indexdef ilike '%lower(email%';
  if v_count < 1 then raise exception 'falta el índice único sobre lower(auth.users.email)'; end if;
end $$;

-- 2. Comportamiento: dos correos que solo difieren en mayúsculas son la MISMA cuenta.
--    Sin esto, `where lower(u.email) = lower($1) limit 1` (local-auth.ts) elegiría una al azar y la
--    persona entraría unas veces con unos roles y otras con otros.
do $$
begin
  insert into auth.users (email, encrypted_password) values ('Prueba.Alta@mizar.test', 'x');
  begin
    insert into auth.users (email, encrypted_password) values ('prueba.alta@mizar.test', 'y');
    raise exception 'se aceptaron dos cuentas con el mismo correo en distinta caja';
  exception when unique_violation then null;
  end;
end $$;

-- 3. El alta completa —cuenta, usuario y roles— tal como la ejecuta el repositorio
--    (lib/infrastructure/postgres-repositories.ts, rama `kind === "users"` de create).
do $$
declare v_id uuid; v_roles int; v_valida boolean;
begin
  insert into auth.users (aud, role, email, encrypted_password, email_confirmed_at)
  values ('authenticated', 'authenticated', 'alta.completa@mizar.test',
          extensions.crypt('clave-inicial-123', extensions.gen_salt('bf', 12)), now())
  returning id into v_id;

  insert into public.usuarios (id, nombre, email, estado) values (v_id, 'Alta Completa', 'alta.completa@mizar.test', 'activo');
  insert into public.usuario_roles (usuario_id, rol) values (v_id, 'solicitante'), (v_id, 'revisor');

  select count(*) into v_roles from public.usuario_roles where usuario_id = v_id;
  if v_roles <> 2 then raise exception 'los roles del alta no quedaron guardados (se esperaban 2, hay %)', v_roles; end if;

  -- Y la contraseña recién creada sirve para entrar: misma comprobación que hace signIn().
  select u.encrypted_password = extensions.crypt('clave-inicial-123', u.encrypted_password)
    into v_valida from auth.users u where u.id = v_id;
  if not v_valida then raise exception 'la contraseña del alta no valida contra extensions.crypt'; end if;

  -- Y una equivocada no entra (si esto pasara, `crypt` no estaría comparando nada).
  select u.encrypted_password = extensions.crypt('otra-clave-distinta', u.encrypted_password)
    into v_valida from auth.users u where u.id = v_id;
  if v_valida then raise exception 'una contraseña incorrecta validó como correcta'; end if;
end $$;

rollback;
