# Monitoreo de caídas, errores y logs

**Decisión (18-sep-2026):** todo en **una sola cuenta gratuita de Better Stack**. Es un servicio externo, así que el VPS no suma ningún contenedor ni recolector. La comparación completa con UptimeRobot, Healthchecks.io, Sentry, GlitchTip, Axiom y Grafana Cloud, con fuentes, está en el informe de esa fecha, resumido en la §4.

## 1. Qué vigila qué

| Riesgo | Cómo se detecta | Dónde está hecho |
|---|---|---|
| La plataforma se cae o queda en solo lectura | Monitor *keyword* sobre `/api/health` que exige `"origin":true` | Better Stack Uptime (configurar, §2) |
| Los avisos de WhatsApp fallan | Monitor *keyword* que exige `"whatsapp_fallidos_24h":0` (baja prioridad, solo correo) | Better Stack Uptime (configurar) |
| El respaldo diario no corre o falla | Latido `HEARTBEAT_BACKUP_URL` (24 h + 2 h de margen) | `ops/backup-daily.sh` ✅ |
| El despachador de avisos deja de correr | Latido `HEARTBEAT_DISPATCH_URL` (1 min + 5 min de margen) | `ops/dispatch-notifications.sh` ✅ |
| Errores 500 y errores de render | Línea JSON `error_servidor` en `docker logs` y copia a Better Stack si están `LOG_INGEST_URL`/`LOG_INGEST_TOKEN` | `lib/observability/report-error.ts`, `lib/http/api.ts`, `instrumentation.ts` ✅ |
| Un adjunto del portal se pierde | Evento `adjunto_portal_descartado` (log) + `ADJUNTO_PORTAL_DESCARTADO` (auditoría) | `lib/infrastructure/public-attachments.ts` ✅ |
| Logs que llenan el disco | Docker del VPS rota a 3 × 10 MB por contenedor (`/etc/docker/daemon.json`, verificado) | Ya estaba |
| Vence el certificado o el dominio | Monitor de SSL en Better Stack. `sixteam.pro` tiene renovación automática (próximo cobro 20-oct-2026, verificado) | Better Stack (configurar) |

**Hasta el 18-sep ningún error del servidor quedaba registrado:** `apiError` convertía cualquier fallo en 500 sin escribir nada, y el log del contenedor estaba vacío tras cinco días.

## 2. Alta en Better Stack (Ernesto, ~20 min)

La cuenta la crea una persona; Claude no crea cuentas.

1. Crear la cuenta en https://betterstack.com con un correo del equipo, no uno personal. Al crear la fuente de logs, elegir la región **Germany**.
2. **Uptime → Monitors:**
   - `Mizar — plataforma`: URL `https://comprasmizar.sixteam.pro/api/health`, tipo *Keyword exists*, palabra `"origin":true`. Alertar tras 2 fallos, por correo y push de la app móvil.
   - `Mizar — WhatsApp`: misma URL, palabra `"whatsapp_fallidos_24h":0`, solo correo.
   - Activar el chequeo de SSL en el primero.
3. **Uptime → Heartbeats:**
   - `Mizar — respaldo diario`: periodo 24 h, margen 2 h.
   - `Mizar — despachador de avisos`: periodo 1 min, margen 5 min.
   - Cada uno da una URL; esas son las `HEARTBEAT_*_URL`.
4. **Telemetry → Sources → Connect source → HTTP**, región Germany. Da un *ingesting host* y un *source token*: son `LOG_INGEST_URL` (con `https://` delante) y `LOG_INGEST_TOKEN`. Crear una alerta sobre la consulta `event:"error_servidor"`, con conteo > 0 en 5 min, por correo.
5. Pasar las cuatro URLs y el token por un canal privado, **no por el chat de WhatsApp del proyecto**. Se cargan así:
   - `/opt/mizar/.env.backup` → `HEARTBEAT_BACKUP_URL`.
   - `/opt/mizar/.env.production` → `HEARTBEAT_DISPATCH_URL`, `LOG_INGEST_URL` y `LOG_INGEST_TOKEN`. Para que la app lea las dos últimas hay que reiniciar el contenedor.

Los cuatro monitores caben de sobra en los 10 del plan gratis.

## 3. Qué no hacer

- No montar Uptime Kuma, Grafana, Loki, GlitchTip ni un recolector (Vector, Alloy, Promtail) en el VPS. Un recolector que lee logs por la API de Docker carga `dockerd`, que es lo que provocó el throttling de Hostinger el 14-sep.
- No añadir `docker exec` para los latidos: basta un `curl`. El despachador ya hace 1.440 `docker compose exec` al día.
- No enviar cuerpos de petición, parámetros SQL, cookies ni query strings a ningún servicio. Por ahí viajan cédulas, teléfonos y datos bancarios de proveedores (Ley 1581).
- No bajar los chequeos por debajo del minuto.

## 4. Por qué no las otras

- **Sentry** (`@sentry/nextjs` 10.75): es compatible con Next 16, pero tiene un fallo conocido de recursión de OpenTelemetry con Turbopack (issue #19367, cerrado sin arreglo). Además, su plan gratis da 5.000 errores y un usuario. Hoy un `fetch` propio hace lo mismo sin dependencias. Si más adelante se quiere el SDK, Better Stack Errors acepta su DSN.
- **UptimeRobot:** desde el 26-may-2026 su plan gratis ya admite uso comercial, pero revisa cada 5 minutos y no trae webhooks ni Slack.
- **Healthchecks.io:** buena opción, y la única gratuita con Telegram. Solo vale la pena como segunda cuenta si hace falta Telegram. Ninguna opción gratuita avisa por WhatsApp.
