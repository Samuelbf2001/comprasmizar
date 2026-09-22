#!/usr/bin/env bash
# Respaldo diario del Postgres autoalojado + los soportes en disco, subido a Google Drive.
# Pensado para correr desde cron en el VPS. Ver docs/migracion-autoalojado.md para la instalación.
#
# Cifrado: por defecto SÍ (AES-256-GCM con BACKUP_PASSPHRASE). Se desactiva únicamente con
# BACKUP_ENCRYPT=no, una decisión explícita que queda a la vista en el log. Ernesto lo pidió el
# 18-sep-2026: la copia va del VPS a un Drive privado de Sixteam, y perder la frase (que solo vivía en
# el VPS) significaba perder los datos, un riesgo peor que el que el cifrado cubre. Sin BACKUP_ENCRYPT=no
# y sin frase el guion aborta: un olvido no debe bajar la protección en silencio.
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

for variable in GDRIVE_FOLDER_ID; do
  if [ -z "${!variable:-}" ]; then echo "Falta la variable $variable" >&2; latido /fail; exit 2; fi
done

ENCRYPT=1
if [ "${BACKUP_ENCRYPT:-yes}" = "no" ]; then
  ENCRYPT=0
elif [ -z "${BACKUP_PASSPHRASE:-}" ]; then
  echo "Falta BACKUP_PASSPHRASE (o BACKUP_ENCRYPT=no para subir sin cifrar a propósito)" >&2
  latido /fail
  exit 2
fi

# Los archivos quedan solo para root: sin cifrar, un volcado legible por cualquier usuario del VPS
# sería una fuga (el VPS es compartido con otros proyectos).
umask 077
mkdir -p "$LOCAL_DIR"
cd "$COMPOSE_DIR"

dump_plain="$LOCAL_DIR/mizar-$STAMP.dump"
files_plain="$LOCAL_DIR/soportes-$STAMP.tar"
if [ "$ENCRYPT" = 1 ]; then dump_up="$dump_plain.enc"; files_up="$files_plain.enc"
else dump_up="$dump_plain"; files_up="$files_plain"; fi

# Con cifrado, los intermedios EN CLARO se borran pase lo que pase: un volcado sin cifrar olvidado en
# el disco del VPS anula el motivo de cifrar la copia que sube a Drive. Sin cifrado, esos mismos
# archivos SON el respaldo local: solo se borran si el guion falló antes de terminar, para que un
# volcado a medias no se confunda después con uno bueno.
completed=0
cleanup() {
  if [ "$ENCRYPT" = 1 ] || [ "$completed" != 1 ]; then rm -f "$dump_plain" "$files_plain"; fi
}
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

if [ "$ENCRYPT" = 1 ]; then
  echo "[$(date -u +%FT%TZ)] cifrando..."
  node "$REPO_DIR/ops/backup-crypto.mjs" cifrar "$dump_plain" "$dump_up"
  node "$REPO_DIR/ops/backup-crypto.mjs" cifrar "$files_plain" "$files_up"
else
  echo "[$(date -u +%FT%TZ)] AVISO: respaldo SIN CIFRAR (BACKUP_ENCRYPT=no); lo protege el acceso a la cuenta de Drive."
fi

# Checksums sobre los archivos que realmente viajan a Drive (los cifrados, si los hay): es lo que la
# restauración verifica antes de usarlos.
sha256sum "$dump_up" "$files_up" | sed "s|$LOCAL_DIR/||" > "$LOCAL_DIR/mizar-$STAMP.sha256"

echo "[$(date -u +%FT%TZ)] subiendo a Google Drive..."
node "$REPO_DIR/ops/gdrive.mjs" subir "$dump_up" "$(basename "$dump_up")"
node "$REPO_DIR/ops/gdrive.mjs" subir "$files_up" "$(basename "$files_up")"
node "$REPO_DIR/ops/gdrive.mjs" subir "$LOCAL_DIR/mizar-$STAMP.sha256" "mizar-$STAMP.sha256"

echo "[$(date -u +%FT%TZ)] purgando copias antiguas..."
node "$REPO_DIR/ops/gdrive.mjs" purgar "$RETENTION_DAYS"
find "$LOCAL_DIR" -maxdepth 1 -type f \
  \( -name '*.enc' -o -name '*.sha256' -o -name 'mizar-*.dump' -o -name 'soportes-*.tar' \) \
  -mtime "+$RETENTION_DAYS" -delete

# Higiene de la tabla de sesiones (lib/infrastructure/local-auth.ts). Va aquí porque es el único
# proceso periódico que ya existe; no justifica un cron propio.
echo "[$(date -u +%FT%TZ)] purgando sesiones vencidas..."
docker compose exec -T db psql -U "${POSTGRES_USER:-mizar}" -d "${POSTGRES_DB:-mizar}" -v ON_ERROR_STOP=1 \
  -c "delete from public.sesiones where expira_at <= now() or creada_at <= now() - interval '7 days';" >/dev/null

completed=1
date -u +%FT%TZ > "$LOCAL_DIR/ultimo-exito"
# La marca solo lleva una hora y la lee el monitoreo: no necesita la restricción de los volcados.
chmod 644 "$LOCAL_DIR/ultimo-exito"
latido ""
echo "[$(date -u +%FT%TZ)] respaldo completo: $(basename "$dump_up") + $(basename "$files_up")"
