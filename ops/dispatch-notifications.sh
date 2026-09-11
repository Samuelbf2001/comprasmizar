#!/usr/bin/env bash
# Drena la cola de notificaciones salientes (tabla `notificaciones`) llamando al endpoint interno
# `POST /api/internal/dispatch-notifications`. Pensado para correr cada minuto desde cron en el VPS.
#
# Por qué existe: la cola es un outbox con lease durable y reintentos (lib/infrastructure/
# notification-dispatcher.ts), pero NADIE la drena sola. Sin este cron ninguna notificación de
# WhatsApp sale nunca — ni el aviso al aprobador, ni el acuse al solicitante. El repositorio se quedó
# sin disparador cuando se retiró `.github/workflows/backup.yml` en 527086a.
#
# Por qué se llama DESDE DENTRO del contenedor y no por el dominio público: el endpoint solo se
# autentica con el secreto compartido (no mira el origen), así que exponerlo a internet no aporta
# nada y amplía la superficie. `docker compose exec` lo alcanza en localhost:3000, que es donde
# escucha; el servicio no publica puerto en el anfitrión a propósito.
#
# El secreto se lee de .env.production EN TIEMPO DE EJECUCIÓN y nunca aparece en el crontab ni en el
# log: si se rota el fichero, el cron sigue funcionando sin tocar nada más.
set -euo pipefail

COMPOSE_DIR="${COMPOSE_DIR:-/opt/mizar}"
COMPOSE_PROJECT="${COMPOSE_PROJECT:-mizar}"
ENV_FILE="${ENV_FILE:-$COMPOSE_DIR/.env.production}"

cd "$COMPOSE_DIR"

if [ ! -r "$ENV_FILE" ]; then echo "[$(date -u +%FT%TZ)] no se puede leer $ENV_FILE" >&2; exit 2; fi

# `cut -d= -f2-` y no `cut -d= -f2`: un secreto en base64 puede contener '='.
# `\042\047` son la comilla doble y la simple en octal: escribirlas literalmente aquí obliga a un
# rompecabezas de escapes que es justo donde estos guiones se rompen en silencio.
SECRET="$(grep -m1 '^NOTIFICATION_DISPATCH_SECRET=' "$ENV_FILE" | cut -d= -f2- | tr -d '\042\047')"
if [ -z "$SECRET" ]; then echo "[$(date -u +%FT%TZ)] falta NOTIFICATION_DISPATCH_SECRET en $ENV_FILE" >&2; exit 2; fi

# El secreto viaja como variable de entorno del proceso dentro del contenedor, no como argumento:
# los argumentos son visibles en `ps` para cualquier usuario del anfitrión.
respuesta="$(docker compose -p "$COMPOSE_PROJECT" exec -T -e DISPATCH_SECRET="$SECRET" app node -e '
const secret = process.env.DISPATCH_SECRET;
fetch("http://127.0.0.1:3000/api/internal/dispatch-notifications", {
  method: "POST",
  headers: { "content-type": "application/json", "x-dispatch-secret": secret },
})
  .then(async (response) => {
    const cuerpo = await response.text();
    process.stdout.write(`${response.status} ${cuerpo}`);
    // 503 = mal configurado, 401 = secreto equivocado. Los dos son averías de instalación y tienen
    // que ser ruidosas. Un 200 con fallos DENTRO del resumen es otra cosa: son notificaciones
    // concretas que no salieron (p. ej. una plantilla que aún no existe en Meta) y la cola ya las
    // reintenta sola con backoff; eso no es una avería del cron.
    process.exitCode = response.status === 200 ? 0 : 1;
  })
  .catch((error) => { process.stdout.write(`error ${error.message}`); process.exitCode = 1; });
' < /dev/null 2>&1)" || {
  echo "[$(date -u +%FT%TZ)] FALLO al invocar el despachador: $respuesta" >&2
  exit 1
}

echo "[$(date -u +%FT%TZ)] $respuesta"
