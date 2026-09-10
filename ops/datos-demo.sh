#!/usr/bin/env bash
# Carga los maestros y los datos de demostración en la base autoalojada del VPS.
#
# Se usa cuando la plataforma arranca VACÍA — es decir, cuando no hay volcado de Supabase que
# restaurar. Aplica supabase/seed.sql (usuarios por rol, sociedades, 17 obras, etiquetas,
# proveedores, catálogo de ítems) y supabase/seed-demo.sql (requisiciones por todos los estados,
# órdenes, gastos y caja menor) para que las bandejas y el dashboard tengan algo que mostrar.
#
# ANTES DE OPERAR DE VERDAD, RECREA LA BASE. Los datos demo no se pueden "borrar y ya":
#   - `auditoria` es inmutable por diseño (un trigger rechaza UPDATE y DELETE), así que la actividad
#     de demostración deja rastro permanente en el registro contable;
#   - los consecutivos REQ-2026-0001 en adelante quedan consumidos y las requisiciones reales
#     empezarían en un número que no cuadra con nada.
# Recrear la base es barato mientras no haya datos reales:
#   docker compose down && docker volume rm <proyecto>_db_data && docker compose up -d db
#   ops/apply-migrations.sh
# y ahí sí cargar solo `supabase/seed.sql` con este mismo guion en modo `maestros`.
#
# Uso:
#   ops/datos-demo.sh maestros   solo supabase/seed.sql
#   ops/datos-demo.sh completo   seed.sql + seed-demo.sql (para mostrar la plataforma)
set -euo pipefail

MODO="${1:-}"
COMPOSE_DIR="${COMPOSE_DIR:-/opt/mizar}"
REPO_DIR="${REPO_DIR:-$COMPOSE_DIR}"
DB_USER="${POSTGRES_USER:-mizar}"
DB_NAME="${POSTGRES_DB:-mizar}"

case "$MODO" in
  maestros|completo) ;;
  *) echo "Uso: ops/datos-demo.sh maestros|completo" >&2; exit 2 ;;
esac

cd "$COMPOSE_DIR"
psql_run() { docker compose exec -T db psql -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 "$@"; }

# Freno de seguridad: si ya hay requisiciones, esta base no está vacía y cargar datos de
# demostración encima mezclaría inventado con real. Es exactamente el error que no se puede deshacer
# por la inmutabilidad de `auditoria`.
existentes="$(psql_run -tAc "select count(*) from public.requisiciones" | tr -d '[:space:]')"
if [ "$existentes" != "0" ]; then
  echo "ABORTADO: la base ya tiene $existentes requisiciones. Este guion solo carga sobre una base vacía." >&2
  exit 1
fi

echo "-> supabase/seed.sql (maestros)"
psql_run < "$REPO_DIR/supabase/seed.sql" > /dev/null

if [ "$MODO" = "completo" ]; then
  echo "-> supabase/seed-demo.sql (movimiento de demostración)"
  psql_run < "$REPO_DIR/supabase/seed-demo.sql" > /dev/null
fi

psql_run -c "select
  (select count(*) from public.usuarios) as usuarios,
  (select count(*) from public.obras) as obras,
  (select count(*) from public.items) as items,
  (select count(*) from public.requisiciones) as requisiciones,
  (select count(*) from public.ordenes) as ordenes,
  (select count(*) from public.gastos) as gastos;"

echo
echo "Listo. Las seis cuentas de prueba usan la contraseña 'local-only-change-me'."
echo "CÁMBIALAS antes de exponer el dominio: POST /api/usuarios/<id>/clave como administrador."
