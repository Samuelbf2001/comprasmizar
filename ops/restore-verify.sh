#!/usr/bin/env bash
# Ensayo de restauración: descarga un respaldo de Google Drive, verifica su checksum, lo descifra y
# lo restaura en una base DESECHABLE dentro del mismo Postgres. No toca la base real.
#
# Por qué existe y por qué es obligatorio: un respaldo que nunca se restauró no es un respaldo. Este
# guion convierte esa regla en algo que se puede correr en cinco minutos, para que no haya excusa
# para saltárselo. Debe ejecutarse antes de dar el sistema por productivo y luego cada trimestre.
#
# Uso:  ops/restore-verify.sh                 -> toma el respaldo más reciente de Drive
#       ops/restore-verify.sh mizar-2026....enc  -> uno concreto, por nombre
set -euo pipefail

COMPOSE_DIR="${COMPOSE_DIR:-/opt/mizar}"
REPO_DIR="${REPO_DIR:-$COMPOSE_DIR}"
WORK_DIR="$(mktemp -d)"
DB_USER="${POSTGRES_USER:-mizar}"
VERIFY_DB="verificacion_restore_$(date -u +%H%M%S)"
WANTED="${1:-}"

for variable in GDRIVE_FOLDER_ID BACKUP_PASSPHRASE; do
  if [ -z "${!variable:-}" ]; then echo "Falta la variable $variable" >&2; exit 2; fi
done

cd "$COMPOSE_DIR"
psql_admin() { docker compose exec -T db psql -U "$DB_USER" -d postgres -v ON_ERROR_STOP=1 "$@"; }

cleanup() {
  rm -rf "$WORK_DIR"
  # La base de verificación se borra SIEMPRE, también si la restauración falló: dejarla ocupando
  # disco en el VPS es exactamente el tipo de residuo que después llena el volumen.
  psql_admin -c "drop database if exists \"$VERIFY_DB\";" > /dev/null 2>&1 || true
}
trap cleanup EXIT

echo "-> buscando respaldo en Drive"
listing="$(node "$REPO_DIR/ops/gdrive.mjs" listar)"
if [ -n "$WANTED" ]; then line="$(echo "$listing" | grep -F "$WANTED" | head -1)"
else line="$(echo "$listing" | grep -F 'mizar-' | grep -F '.dump.enc' | head -1)"; fi
[ -n "$line" ] || { echo "No se encontró ningún respaldo que restaurar." >&2; exit 1; }

name="$(echo "$line" | awk '{print $(NF-1)}')"
file_id="$(echo "$line" | awk '{print $NF}')"
echo "-> $name"

node "$REPO_DIR/ops/gdrive.mjs" bajar "$file_id" "$WORK_DIR/$name"

# El checksum acompaña a cada respaldo con el mismo sello de tiempo. Si falta, se avisa pero no se
# aborta: verificar el descifrado con GCM ya detecta corrupción, esto es la comprobación temprana.
stamp="$(echo "$name" | sed -E 's/^mizar-(.*)\.dump\.enc$/\1/')"
sha_line="$(echo "$listing" | grep -F "mizar-$stamp.sha256" | head -1 || true)"
if [ -n "$sha_line" ]; then
  node "$REPO_DIR/ops/gdrive.mjs" bajar "$(echo "$sha_line" | awk '{print $NF}')" "$WORK_DIR/checksums"
  ( cd "$WORK_DIR" && grep -F "$name" checksums | sha256sum -c - ) || { echo "CHECKSUM NO COINCIDE: el archivo en Drive está corrupto." >&2; exit 1; }
  echo "-> checksum correcto"
else
  echo "-- aviso: no se encontró el .sha256 de este respaldo"
fi

echo "-> descifrando"
node "$REPO_DIR/ops/backup-crypto.mjs" descifrar "$WORK_DIR/$name" "$WORK_DIR/restaurar.dump"

echo "-> restaurando en la base desechable $VERIFY_DB"
psql_admin -c "create database \"$VERIFY_DB\";" > /dev/null
docker compose exec -T db pg_restore --no-owner --no-acl --dbname="$VERIFY_DB" --username="$DB_USER" < "$WORK_DIR/restaurar.dump" > /dev/null

# La prueba real no es que pg_restore no falle, sino que los datos estén ahí. Se cuentan las tablas
# de negocio que no pueden estar vacías en una base de producción.
echo "-> verificando contenido"
docker compose exec -T db psql -U "$DB_USER" -d "$VERIFY_DB" -v ON_ERROR_STOP=1 -c "
do \$\$
declare v_migraciones int; v_usuarios int; v_obras int;
begin
  select count(*) into v_migraciones from public.migraciones_aplicadas;
  select count(*) into v_usuarios from public.usuarios;
  select count(*) into v_obras from public.obras;
  if v_migraciones = 0 then raise exception 'El respaldo no trae registro de migraciones aplicadas'; end if;
  if v_usuarios = 0 then raise exception 'El respaldo no trae usuarios'; end if;
  if v_obras = 0 then raise exception 'El respaldo no trae obras'; end if;
  raise notice 'restauración verificada: % migraciones, % usuarios, % obras', v_migraciones, v_usuarios, v_obras;
end \$\$;"

echo "ENSAYO DE RESTAURACIÓN CORRECTO — $name"
echo "Anota la fecha de hoy en docs/runbook-operacion.md."
