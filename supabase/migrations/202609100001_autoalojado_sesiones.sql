-- Migración a Postgres autoalojado (2026-09-10): sesiones propias, en reemplazo del JWT de Supabase
-- Auth. Ver docs/migracion-autoalojado.md para el plan completo y lib/infrastructure/local-auth.ts
-- para el lado de aplicación.
--
-- Por qué token opaco en tabla y no JWT propio: la revocación. Dar de baja a alguien o cerrar sesión
-- borra la fila y surte efecto en la siguiente petición; un JWT seguiría siendo válido hasta vencer.
-- El costo (una consulta por petición) es el mismo que ya pagaba la consulta de roles, que el caché
-- de perfil de 60 s (lib/infrastructure/actor-cache.ts) amortiza.
--
-- Las contraseñas NO se tocan: siguen en `auth.users.encrypted_password` con el mismo bcrypt que
-- escribía Supabase Auth, verificadas con `extensions.crypt`. Nadie pierde su contraseña en el corte.

create table if not exists public.sesiones (
  id uuid primary key default gen_random_uuid(),
  usuario_id uuid not null references auth.users(id) on delete cascade,
  -- SHA-256 del token, nunca el token. Un volcado de la base no permite suplantar a nadie.
  -- El nombre de la columna ya está en la lista de `public.auditoria_campo_sensible` desde la
  -- migración base, así que cualquier auditoría futura sobre esta tabla lo redacta de oficio.
  token_hash text not null,
  creada_at timestamptz not null default now(),
  ultimo_uso_at timestamptz not null default now(),
  expira_at timestamptz not null,
  constraint sesiones_vigencia check (expira_at > creada_at)
);

create unique index if not exists sesiones_token_hash_idx on public.sesiones(token_hash);
create index if not exists sesiones_usuario_idx on public.sesiones(usuario_id);
-- Respalda la purga del cron diario (ops/backup-daily.sh) sin recorrer la tabla entera.
create index if not exists sesiones_expira_idx on public.sesiones(expira_at);

alter table public.sesiones enable row level security;

-- CRÍTICO: el bootstrap (supabase/bootstrap/00_compat_autoalojado.sql, heredado del prelude de
-- pruebas) hace `alter default privileges in schema public grant all on tables to anon,
-- authenticated, service_role` para reproducir el arranque de un proyecto Supabase. Es decir: esta
-- tabla NACE con privilegios concedidos a esos tres roles. Sin el revoke de abajo, `authenticated`
-- tendría privilegio de tabla sobre las sesiones de todo el mundo y solo lo frenaría la ausencia de
-- policies. Se revoca explícitamente: las sesiones las maneja únicamente la conexión de la
-- aplicación (dueña de la tabla), nunca un rol de PostgREST.
revoke all on table public.sesiones from anon, authenticated, service_role;
