-- BOOTSTRAP de la base autoalojada. Se aplica UNA VEZ, antes de la primera migración, sobre un
-- Postgres recién creado (ver docs/migracion-autoalojado.md).
--
-- Nació como prelude de pruebas (supabase/tests/embedded_postgres_prelude.sql) para poder correr las
-- migraciones contra un Postgres pelado con embedded-postgres. Al pasar la plataforma a Postgres
-- propio (2026-09-10) ese "stub de pruebas" pasó a ser la definición REAL del entorno, así que se
-- promovió a supabase/bootstrap/ — mismo archivo, un solo lugar. Sigue siendo lo que usa
-- scripts/verify-schema.ts, de modo que el arnés de CI y el servidor de producción arrancan desde
-- exactamente el mismo punto de partida; si divergieran, CI dejaría de probar lo que se despliega.
--
-- Crea lo que las migraciones dan por sentado: roles anon/authenticated/service_role, el esquema
-- `auth` (tabla `auth.users` + `auth.uid()`/`auth.role()` leyendo los mismos GUC que usa PostgREST:
-- `request.jwt.claim.sub`/`request.jwt.claim.role`, ya usados por `supabase/tests/*.sql` vía
-- `set_config(...)` + `set local role authenticated`), el esquema `storage` (`buckets`/`objects`,
-- con RLS activo, igual que en un proyecto real) y pgcrypto instalado en un esquema `extensions`
-- (así `extensions.crypt`/`extensions.gen_salt`, que usan las migraciones y el seed, existen).
-- Los ALTER DEFAULT PRIVILEGES reproducen el bootstrap de una nueva base Supabase: anon/authenticated/
-- service_role reciben privilegio de tabla de fábrica sobre CUALQUIER tabla que las migraciones creen
-- después (RLS sigue siendo el control real de fila); sin esto, ninguna tabla de `public` sería
-- siquiera legible por `authenticated` bajo RLS, porque Postgres exige el privilegio de tabla ANTES
-- de evaluar cualquier policy.
--
-- NOTA sobre `storage`: desde la migración a disco propio (lib/infrastructure/local-storage.ts) la
-- plataforma NO usa storage.buckets/storage.objects en tiempo de ejecución. Se mantienen porque las
-- migraciones históricas insertan y crean policies sobre ellas, y reescribir 2.199 líneas de
-- migraciones ya aplicadas para borrar dos tablas vacías sería mucho más riesgo que dejarlas. Son
-- inertes: nadie las lee ni las escribe.
do $$ begin create role anon nologin noinherit; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin noinherit; exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin noinherit bypassrls; exception when duplicate_object then null; end $$;

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  instance_id uuid, aud text, role text, email text, encrypted_password text,
  email_confirmed_at timestamptz, raw_app_meta_data jsonb, raw_user_meta_data jsonb,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create or replace function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create or replace function auth.role() returns text language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.role', true), '')::text $$;

create schema if not exists storage;
create table if not exists storage.buckets (
  id text primary key, name text not null, public boolean not null default false,
  file_size_limit bigint, allowed_mime_types text[]
);
create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id),
  name text, owner uuid, owner_id text, metadata jsonb,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
alter table storage.objects enable row level security;

grant usage on schema public, extensions, storage to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
-- Igual que en un proyecto Supabase real: authenticated/anon arrancan con INSERT/UPDATE/DELETE "de
-- fábrica" sobre storage.objects/buckets (ver el comentario de 202608240003_adjuntos_genericos_privados.sql:
-- ahí se REVOCA insert/update/delete de authenticated/anon sobre storage.objects — ese REVOKE solo
-- tiene algo real que revocar si existió este GRANT antes).
grant select, insert, update, delete on storage.buckets, storage.objects to anon, authenticated, service_role;
