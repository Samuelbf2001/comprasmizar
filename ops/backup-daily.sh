#!/usr/bin/env bash
# Respaldo diario del Postgres autoalojado + los soportes en disco, cifrado y subido a Google Drive.
# Pensado para correr desde cron en el VPS. Ver docs/migracion-autoalojado.md para la instalación.
#
# Qué respalda y por qué las DOS cosas: `pg_dump` no incluye los archivos. Con Supabase Storage esa
# mitad la cubría Supabase; ahora los soportes viven en un volumen Docker nuestro y un respaldo que
# solo copiara la base dejaría las requisiciones sin sus fotos ni sus facturas. Se suben dos objetos
# por día, y la restauración necesita los dos.
#
# Falla ruidosamente a propósito (`set -euo pipefail`): un respaldo que falla en silencio es peor que
# no tener respaldo, porque genera confianza sin cobertura. Cron envía la salida por correo si hay
# MAILTO configurado, y el archivo `ultimo-exito` permite que un monitor externo detecte el día que
# esto deja de correr.
set -euo pipefail

COMPOSE_DIR="${COMPOSE_DIR:-/opt/mizar}"
LOCAL_DIR="${BACKUP_LOCAL_DIR:-/var/backups/mizar}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-35}"
REPO_DIR="${REPO_DIR:-$COMPOSE_DIR}"
STAMP="$(date -u +%Y%m%d-%H%M%S)"

# Latido para un monitor externo (healthchecks.io o los heartbeats de Better Stack: los dos aceptan la
# URL a secas para «bien» y la URL + "/fail" para «falló»). Es lo que convierte «el respaldo dejó de
# correr» en una alerta: la marca `ultimo-exito` solo la ve quien entra al VPS a mirarla, y el día que
# el cron no arranca no queda ningún error que leer. Opcional: sin HEARTBEAT_BACKUP_URL el respaldo
# funciona igual. Un fallo al avisar nunca tumba el respaldo.
latido() {
  [ -n "${HEARTBEAT_BACKUP_URL:-}" ] || return 0
  curl -fsS -m 10 --retry 3 -o /dev/null "${HEARTBEAT_BACKUP_URL%/}$1" || echo "[$(date -u +%FT%TZ)] no se pudo avisar al monitor" >&2
}

for variable in GDRIVE_FOLDER_ID BACKUP_PASSPHRASE; do
  if [ -z "${!variable:-}" ]; then echo "Falta la variable $variable" >&2; latido /fail; exit 2; fi
done

mkdir -p "$LOCAL_DIR"
cd "$COMPOSE_DIR"

dump_plain="$LOCAL_DIR/mizar-$STAMP.dump"
dump_enc="$dump_plain.enc"
files_plain="$LOCAL_DIR/soportes-$STAMP.tar"
files_enc="$files_plain.enc"

# Se borran los intermedios EN CLARO pase lo que pase: un volcado sin cifrar olvidado en el disco del
# VPS anula el motivo de cifrar la copia que sube a Drive.
cleanup() { rm -f "$dump_plain" "$files_plain"; }
# Cualquier salida con error (set -e) avisa al monitor además de limpiar.
trap 'estado=$?; cleanup; [ "$estado" -eq 0 ] || latido /fail' EXIT

echo "[$(date -u +%FT%TZ)] volcando la base..."
# `--format=custom` permite restauración selectiva con pg_restore; -T evita que docker asigne un TTY
# que corrompería el binario al pasar por la tubería.
docker compose exec -T db pg_dump \
  -U "${POSTGRES_USER:-mizar}" -d "${POSTGRES_DB:-mizar}" \
  --format=custom --no-owner --no-acl > "$dump_plain"

echo "[$(date -u +%FT%TZ)] empaquetando soportes..."
# Desde dentro del contenedor de la app, que es quien tiene el volumen montado: así no hay que
# adivinar la ruta del volumen en /var/lib/docker ni correr el respaldo como root.
docker compose exec -T app tar -cf - -C /var/lib/mizar/storage . > "$files_plain"

echo "[$(date -u +%FT%TZ)] cifrando..."
node "$REPO_DIR/ops/backup-crypto.mjs" cifrar "$dump_plain" "$dump_enc"
node "$REPO_DIR/ops/backup-crypto.mjs" cifrar "$files_plain" "$files_enc"

# Checksums sobre los archivos CIFRADOS: es lo que realmente viaja a Drive y lo que la restauración
# verifica antes de intentar descifrar.
sha256sum "$dump_enc" "$files_enc" | sed "s|$LOCAL_DIR/||" > "$LOCAL_DIR/mizar-$STAMP.sha256"

echo "[$(date -u +%FT%TZ)] subiendo a Google Drive..."
node "$REPO_DIR/ops/gdrive.mjs" subir "$dump_enc" "$(basename "$dump_enc")"
node "$REPO_DIR/ops/gdrive.mjs" subir "$files_enc" "$(basename "$files_enc")"
node "$REPO_DIR/ops/gdrive.mjs" subir "$LOCAL_DIR/mizar-$STAMP.sha256" "mizar-$STAMP.sha256"

echo "[$(date -u +%FT%TZ)] purgando copias antiguas..."
node "$REPO_DIR/ops/gdrive.mjs" purgar "$RETENTION_DAYS"
find "$LOCAL_DIR" -maxdepth 1 -type f \( -name '*.enc' -o -name '*.sha256' \) -mtime "+$RETENTION_DAYS" -delete

# Higiene de la tabla de sesiones (lib/infrastructure/local-auth.ts). Va aquí porque es el único
# proceso periódico que ya existe; no justifica un cron propio.
echo "[$(date -u +%FT%TZ)] purgando sesiones vencidas..."
docker compose exec -T db psql -U "${POSTGRES_USER:-mizar}" -d "${POSTGRES_DB:-mizar}" -v ON_ERROR_STOP=1 \
  -c "delete from public.sesiones where expira_at <= now() or creada_at <= now() - interval '7 days';" >/dev/null

date -u +%FT%TZ > "$LOCAL_DIR/ultimo-exito"
latido ""
echo "[$(date -u +%FT%TZ)] respaldo completo: $(basename "$dump_enc") + $(basename "$files_enc")"
