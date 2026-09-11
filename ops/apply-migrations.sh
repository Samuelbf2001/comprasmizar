#!/usr/bin/env bash
# Aplica el bootstrap y las migraciones al Postgres autoalojado. Reemplaza a `supabase db push`.
#
# Es idempotente: lleva registro de lo aplicado en `public.migraciones_aplicadas` y salta lo que ya
# corrió. Se puede invocar en cada despliegue sin pensarlo.
#
# El orden importa y es el mismo que usa scripts/verify-schema.ts en CI: primero
# supabase/bootstrap/00_compat_autoalojado.sql (roles, esquema auth, pgcrypto), después
# supabase/migrations/*.sql por orden alfabético — que es el cronológico, porque los nombres empiezan
# por marca de tiempo.
set -euo pipefail

REPO_DIR="${REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
COMPOSE_DIR="${COMPOSE_DIR:-/opt/mizar}"
DB_USER="${POSTGRES_USER:-mizar}"
DB_NAME="${POSTGRES_DB:-mizar}"

cd "$COMPOSE_DIR"
psql_run() { docker compose exec -T db psql -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 "$@"; }

# El bootstrap es idempotente por construcción (`if not exists` / `exception when duplicate_object`),
# así que se aplica siempre: es más seguro que llevar registro de si corrió.
echo "-> bootstrap"
psql_run < "$REPO_DIR/supabase/bootstrap/00_compat_autoalojado.sql" > /dev/null

psql_run -c "create table if not exists public.migraciones_aplicadas (
  nombre text primary key,
  aplicada_at timestamptz not null default now()
);" > /dev/null

for migration in "$REPO_DIR"/supabase/migrations/*.sql; do
  name="$(basename "$migration")"
  applied="$(psql_run -tAc "select 1 from public.migraciones_aplicadas where nombre = '$name'")"
  if [ "$applied" = "1" ]; then echo "-- $name (ya aplicada)"; continue; fi
  echo "-> $name"
  # Migración y registro en la MISMA transacción: si la migración falla a la mitad, no queda marcada
  # como aplicada y el siguiente intento la reintenta desde cero. Sin esto, un fallo dejaría el
  # esquema y el registro contradiciéndose, que es el peor estado posible para depurar.
  { echo "begin;"; cat "$migration"; echo ";"; echo "insert into public.migraciones_aplicadas (nombre) values ('$name');"; echo "commit;"; } \
    | psql_run > /dev/null
done

echo "migraciones al día"
