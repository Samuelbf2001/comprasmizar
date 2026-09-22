# Runbook operativo

## Despliegue

1. Ejecutar lint, typecheck, cobertura, build y E2E en CI.
2. Construir una imagen inmutable con el SHA del commit.
3. Aplicar migraciones primero en dev y ejecutar las verificaciones de RLS.
   > **Qué protege el portal (decisión del cliente, 11-sep-2026).** Ernesto pidió que la ruta fuera
   > pública: `https://<dominio>/requisiciones/publica` abre sin enlace firmado, y **la contraseña es
   > la única llave**, acompañada del rate limit por IP y por obra. Es coherente con lo que dijo al
   > definir el acceso — «no necesito que sea lo más seguro del mundo, simplemente que no cualquiera
   > pueda ingresar» —, pero conviene saber lo que implica: cualquiera que dé con la URL puede probar
   > contraseñas, acotado a 20 intentos por minuto y por IP. Si un día se quiere subir el listón, lo
   > barato es rotar la contraseña; lo siguiente, volver a exigir enlace firmado.
   >
   > Los enlaces con token **siguen sirviendo y no hay que retirarlos**: acotan a UNA obra, que es
   > para lo que tienen sentido ahora (un contratista que solo debe radicar contra la suya).
   > Se generan con `npx tsx scripts/generate-public-link.ts <obra-uuid>`; sin argumentos el guion
   > imprime la URL pública.

4. **Obligatorio tras aplicar `202609070002_acceso_publico_global.sql` (contraseña global del portal):** fijar la contraseña del portal desde Catálogos › Acceso público (`PATCH /api/public-access`, solo admin_mizar/admin_sixteam). La tabla `acceso_publico` nace con el hash en `null` — hasta que alguien fije la contraseña, **el portal público rechaza todo código**, para toda obra con `public_submission_enabled = true`, sin excepción ni aviso visible del lado del solicitante (recibe un 202 neutro indistinguible del éxito). El panel de administración sí muestra un aviso prominente mientras tanto (`role="alert"`, "El portal de requisiciones está cerrado…") — no depender solo de que alguien recuerde este paso.
5. Hacer respaldo pre-despliegue de producción.
6. Desplegar la imagen, esperar `/api/health` y ejecutar smoke tests por rol.
7. Conservar el tag anterior. Rollback de app significa volver al tag; nunca revertir una migración destructiva sin plan probado.

## Respaldo y restauración

**Qué ya está automatizado:** [`ops/backup-daily.sh`](../ops/backup-daily.sh) corre por cron en el VPS a las 03:00 hora Colombia (`0 8 * * *` en UTC). Cada ejecución hace `pg_dump --format=custom` contra el Postgres autoalojado, empaqueta los soportes del volumen de almacenamiento, calcula SHA-256 y sube los tres archivos a Google Drive ([`ops/gdrive.mjs`](../ops/gdrive.mjs)), purgando lo que pase de 35 días. El guion exige `GDRIVE_FOLDER_ID` y, además, o bien `BACKUP_PASSPHRASE` (cifra con AES-256-GCM, [`ops/backup-crypto.mjs`](../ops/backup-crypto.mjs)) o bien `BACKUP_ENCRYPT=no`; sin eso aborta antes de tocar nada.

**Cifrado: desactivado a propósito desde el 18-sep-2026** (`BACKUP_ENCRYPT=no` en `/opt/mizar/.env.backup`, decisión de Ernesto). Los respaldos suben en claro (`mizar-<sello>.dump` y `soportes-<sello>.tar`) a la carpeta «Respaldos Mizar» del Drive privado de Ernesto@sixteam.pro, y en el VPS quedan con permisos de solo root. Razón: la frase de cifrado solo vivía en el VPS, y perderla con el servidor significaba perder los datos. Consecuencia que hay que tener presente: los volcados traen hashes de contraseñas, teléfonos y los adjuntos, así que **esa carpeta no se comparte con nadie** y quien acceda a esa cuenta de Google accede a todo. Para volver a cifrar: guardar una `BACKUP_PASSPHRASE` fuera del VPS y quitar `BACKUP_ENCRYPT=no`. Los respaldos ya subidos con la frase anterior (`.enc`) solo se abren con esa frase; se purgan solos a los 35 días.

**Se respaldan DOS cosas, y la restauración necesita las dos.** `pg_dump` no incluye los archivos: los soportes de requisiciones y los documentos de proveedor viven en el volumen `storage_data`, no en la base. Por eso cada día suben `mizar-<sello>.dump` (base) y `soportes-<sello>.tar` (archivos); con el cifrado activo llevan el sufijo `.enc`. Restaurar solo la base deja todas las requisiciones sin sus fotos y facturas.

- **Si se vuelve a cifrar, la frase vive fuera del VPS.** `BACKUP_PASSPHRASE` va en el gestor de secretos del equipo. Si se pierde junto con el servidor, los respaldos cifrados no sirven de nada y un incidente recuperable se convierte en pérdida total. Con el cifrado apagado (estado actual) no hay frase que perder.
- **Retención:** 35 días en Google Drive y 35 días en el disco local del VPS (`/var/backups/mizar`). Son dos copias con fallos independientes: un borrado accidental en Drive no toca la local, y la muerte del VPS no toca la de Drive.
- **Ensayo de restauración obligatorio:** [`ops/restore-verify.sh`](../ops/restore-verify.sh) baja el respaldo más reciente de Drive, verifica el checksum, lo descifra si está cifrado y lo restaura en una base desechable, comprobando que traiga migraciones, usuarios y obras. Debe ejecutarse y anotarse aquí **antes de dar el sistema por productivo** y repetirse **trimestralmente**. Un backup que nunca se restauró no es un backup.
- **Vigilancia del propio cron:** el guion escribe `/var/backups/mizar/ultimo-exito` al terminar bien. Si esa marca tiene más de 48 horas, el respaldo lleva dos días sin correr aunque nadie haya visto un error. Es la señal que hay que monitorear, no la ausencia de correos.
- **Fecha del último ensayo de restauración:** 2026-09-18, con `mizar-20260918-204525.dump` bajado de Drive (checksum correcto, restaurado en base desechable: 17 migraciones, 7 usuarios, 17 obras). El guion restaura solo la base; el `.tar` de soportes se subió y su checksum es válido, pero no se ha desempaquetado en un ensayo. Próximo: en 3 meses.

> Histórico: hasta el 2026-09-10 el respaldo lo hacía `.github/workflows/backup.yml` con `pg_dump` por internet contra Supabase, cifrando con GPG. Al pasar a Postgres autoalojado sin puerto público (ver [docs/migracion-autoalojado.md](migracion-autoalojado.md)) ese workflow dejó de poder alcanzar la base y se retiró. Los artifacts `.gpg` que queden de esa época se descifran con `gpg --decrypt`, no con `ops/backup-crypto.mjs`: son formatos distintos.

## Incidentes

- Severidad alta: acceso indebido, pérdida de datos o indisponibilidad total. Revocar sesiones/keys, preservar logs y responder dentro del SLA de cuatro horas.
- Nunca copiar secretos ni payloads con PII al ticket. Usar identificadores y timestamps.
- Para Kapso, comparar firma del webhook, `kapso_message_id`, entrega y reintentos en `whatsapp_eventos`.
- Para inconsistencias contables, congelar el periodo afectado y ejecutar el comparador contra el dataset dorado antes de corregir datos.

## Rotación

Rotar service-role de Supabase, secreto Kapso, pepper MCP, código de formulario público y llaves de despliegue antes de producción y tras cualquier exposición. Las API keys MCP son individuales, revocables y auditadas.

