#!/usr/bin/env bash
# Sincroniza /opt/mizar con el árbol de un commit, BORRANDO lo que ese commit ya no tiene.
#
# POR QUÉ EXISTE
# El despliegue sincronizaba con `git archive origin/main | tar -x -C /opt/mizar`. Eso escribe y
# sobrescribe, pero **nunca borra**: un fichero que el commit elimina se queda en el servidor para
# siempre. El 11-sep-2026 eso rompió un despliegue — la rama borró `app/api/public/works/route.ts`
# y el fichero huérfano siguió en el servidor importando `listPublicWorks`, un símbolo que ya no
# existía, así que `next build` falló. Había SEIS huérfanos acumulados, todos del mismo refactor.
#
# El fallo fue ruidoso por suerte, no por diseño: un huérfano que compile no rompe el build, se queda
# corriendo en producción sin que nadie lo note. Una ruta de API borrada por seguridad seguiría
# sirviendo peticiones después de "borrarla".
#
# QUÉ NO SE BORRA, y por qué cada exclusión
#   .env*                    los secretos y sus respaldos: no están en git y perderlos deja el
#                            servicio sin arrancar
#   .credenciales-iniciales  fichero del operador, ajeno al repositorio
#   respaldos/               volcados de la base hechos a mano; borrarlos sería destruir la red
#   node_modules/ .next/     artefactos de construcción, no fuente
#   .claude/                 configuración local del operador
#
# USO (desde la máquina de desarrollo, en tres pasos)
#   git archive --format=tar origin/main | ssh root@<vps> 'cat > /tmp/mizar-nuevo.tar'
#   scp ops/sync-arbol.sh root@<vps>:/tmp/sync-arbol.sh
#   ssh root@<vps> 'bash /tmp/sync-arbol.sh /tmp/mizar-nuevo.tar'
#
# Se ejecuta desde /tmp, NO desde /opt/mizar/ops/, y no es un capricho: este guion borra ficheros de
# /opt/mizar, así que corriéndose desde ahí puede borrarse a sí mismo mientras bash aún lo está
# leyendo — bash lee el fichero por trozos, y el resultado de eso no está definido. Pasa siempre que
# el commit sincronizado no contenga todavía este guion, que es justo el caso al introducirlo. Desde
# /tmp el problema no existe, y de paso se sincroniza con la versión del guion que trae el commit.
#
# Imprime lo que va a borrar ANTES de borrarlo. Con `--simulacro` solo lo imprime.
set -euo pipefail

TAR="${1:-}"
SIMULACRO="${2:-}"
DESTINO="${DESTINO:-/opt/mizar}"

if [ -z "$TAR" ] || [ ! -f "$TAR" ]; then
  echo "Uso: $0 <ruta-del-tar> [--simulacro]" >&2
  exit 2
fi

TEMPORAL="$(mktemp -d)"
# El temporal se borra pase lo que pase: son ~7 MB de código, no conviene dejarlos rondando en /tmp.
trap 'rm -rf "$TEMPORAL"' EXIT

tar -x -f "$TAR" -C "$TEMPORAL"

# Comprobación de cordura antes de dejar que rsync borre nada. Si el tar viniera truncado o vacío,
# `--delete` vaciaría medio /opt/mizar. Un árbol legítimo de este repo pasa de 300 ficheros.
FICHEROS="$(find "$TEMPORAL" -type f | wc -l)"
if [ "$FICHEROS" -lt 100 ]; then
  echo "ABORTA: el tar solo trae $FICHEROS ficheros; un árbol completo pasa de 300. No se sincroniza." >&2
  exit 1
fi
if [ ! -f "$TEMPORAL/package.json" ] || [ ! -f "$TEMPORAL/compose.yaml" ]; then
  echo "ABORTA: el tar no parece el árbol de esta plataforma (falta package.json o compose.yaml)." >&2
  exit 1
fi

EXCLUSIONES=(
  --exclude=".env*"
  --exclude=".credenciales-iniciales"
  --exclude="respaldos/"
  --exclude="node_modules/"
  --exclude=".next/"
  --exclude=".claude/"
)

echo "[$(date -u +%FT%TZ)] árbol nuevo: $FICHEROS ficheros"
echo "--- lo que se BORRARÁ de $DESTINO por no estar en el commit ---"
rsync -a --delete --dry-run --out-format='%o %n' "${EXCLUSIONES[@]}" "$TEMPORAL/" "$DESTINO/" \
  | grep '^del\.' | sed 's/^del\. /  borrar  /' || echo "  (nada)"

if [ "$SIMULACRO" = "--simulacro" ]; then
  echo "[simulacro] no se ha tocado nada."
  exit 0
fi

rsync -a --delete "${EXCLUSIONES[@]}" "$TEMPORAL/" "$DESTINO/"
echo "[$(date -u +%FT%TZ)] sincronizado."
