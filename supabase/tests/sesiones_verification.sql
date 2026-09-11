-- Arnés de la migración 202609100001_autoalojado_sesiones.sql (migración a Postgres autoalojado).
-- Registrado en scripts/verify-schema.ts. Mismo formato que el resto: begin -> do $$ ... $$ (uno por
-- grupo de aserciones, para que el mensaje señale cuál falló) -> rollback, así nunca deja basura en
-- la base contra la que se ejecuta.
begin;

do $$
declare v_count int; v_usuario uuid;
begin
  -- 1. La tabla existe con las columnas que consume lib/infrastructure/local-auth.ts.
  select count(*) into v_count from information_schema.columns
   where table_schema = 'public' and table_name = 'sesiones'
     and column_name in ('id', 'usuario_id', 'token_hash', 'creada_at', 'ultimo_uso_at', 'expira_at');
  if v_count <> 6 then raise exception 'public.sesiones no declara las 6 columnas esperadas (encontradas: %)', v_count; end if;

  -- 2. RLS activo. No hay policies a propósito: solo la conexión dueña toca esta tabla.
  select count(*) into v_count from pg_class where relname = 'sesiones' and relnamespace = 'public'::regnamespace and relrowsecurity;
  if v_count <> 1 then raise exception 'public.sesiones no tiene row level security activo'; end if;

  -- 3. LO IMPORTANTE: el revoke de la migración. El bootstrap concede privilegios de fábrica sobre
  --    toda tabla nueva de `public` a anon/authenticated/service_role (reproduce el arranque de
  --    Supabase). Sin el revoke explícito, los tokens de sesión de todo el mundo quedarían al alcance
  --    de cualquier rol de PostgREST y solo los frenaría la ausencia de policies. Esta comprobación
  --    es la que se romperá si alguien reordena o borra ese revoke.
  select count(*) into v_count from information_schema.role_table_grants
   where table_schema = 'public' and table_name = 'sesiones' and grantee in ('anon', 'authenticated', 'service_role');
  if v_count <> 0 then raise exception 'public.sesiones concede % privilegios a roles de PostgREST; deberían ser 0', v_count; end if;

  -- 4. token_hash es único: dos sesiones no pueden compartir token.
  select count(*) into v_count from pg_indexes
   where schemaname = 'public' and tablename = 'sesiones' and indexdef ilike '%unique%' and indexdef ilike '%token_hash%';
  if v_count < 1 then raise exception 'falta el índice único sobre sesiones.token_hash'; end if;
end $$;

-- 5. Comportamiento: vigencia validada por la base y token atado a un usuario que existe.
--
-- Nota que costó una corrida del arnés descubrir: NO se prueba el `on delete cascade` borrando el
-- usuario, porque en esta plataforma un usuario no se borra nunca — `public.usuarios` usa baja
-- reversible y un trigger rechaza el DELETE ("usuarios usa desactivación reversible"). La cascada
-- queda como red de seguridad estructural, pero es inalcanzable en operación normal.
-- El cierre de acceso al dar de baja a alguien NO depende de borrar sus sesiones: la sesión sigue
-- viva pero `loadProfileFromDb` (lib/infrastructure/auth.ts) exige `estado = 'activo'` y lanza
-- ACCOUNT_INACTIVE, y `invalidateActorCache(userId)` hace que surta efecto de inmediato en vez de
-- esperar los 60 s del caché de perfil.
do $$
declare v_usuario uuid := '10000000-0000-4000-8000-000000000002'; v_fk int;
begin
  -- El check de vigencia impide guardar una sesión que nace vencida.
  begin
    insert into public.sesiones (usuario_id, token_hash, creada_at, expira_at)
    values (v_usuario, 'hash-invalido-para-prueba', now(), now() - interval '1 hour');
    raise exception 'sesiones_vigencia permitió una sesión que expira antes de crearse';
  exception when check_violation then null;
  end;

  -- Un token no puede apuntar a un usuario inexistente.
  begin
    insert into public.sesiones (usuario_id, token_hash, expira_at)
    values ('00000000-0000-0000-0000-0000000000ff', 'hash-sin-usuario', now() + interval '1 hour');
    raise exception 'se aceptó una sesión para un usuario que no existe en auth.users';
  exception when foreign_key_violation then null;
  end;

  -- Y la cascada está declarada, aunque hoy no haya forma de dispararla.
  select count(*) into v_fk from information_schema.referential_constraints rc
    join information_schema.table_constraints tc on tc.constraint_name = rc.constraint_name
   where tc.table_schema = 'public' and tc.table_name = 'sesiones' and rc.delete_rule = 'CASCADE';
  if v_fk < 1 then raise exception 'sesiones.usuario_id no declara on delete cascade'; end if;

  -- Una sesión normal sí entra (el rollback final la deshace).
  insert into public.sesiones (usuario_id, token_hash, expira_at)
  values (v_usuario, 'hash-de-prueba', now() + interval '1 hour');
end $$;

-- El rollback deshace también el borrado del usuario del seed que hizo el bloque anterior: ningún
-- arnés posterior ve efectos de este.
rollback;
