# Runbook operativo

## Despliegue

1. Ejecutar lint, typecheck, cobertura, build y E2E en CI.
2. Construir una imagen inmutable con el SHA del commit.
3. Aplicar migraciones primero en dev y ejecutar las verificaciones de RLS.
4. Hacer respaldo pre-despliegue de producción.
5. Desplegar la imagen, esperar `/api/health` y ejecutar smoke tests por rol.
6. Conservar el tag anterior. Rollback de app significa volver al tag; nunca revertir una migración destructiva sin plan probado.

## Respaldo y restauración

**Qué ya está automatizado:** [`.github/workflows/backup.yml`](../.github/workflows/backup.yml) corre a diario a las 03:00 hora Colombia (`cron: "0 8 * * *"`, UTC) y también admite disparo manual (`workflow_dispatch`). Cada ejecución hace `pg_dump --format=custom` contra `DATABASE_URL`, calcula su SHA-256, valida el archivo con `pg_restore --list` (un dump truncado o corrupto hace fallar el workflow y GitHub notifica), lo cifra con GPG simétrico usando `BACKUP_ENCRYPTION_PASSPHRASE` y sube dump+checksum cifrados como artifact con retención de 14 días. Los runners `ubuntu-latest` traen `postgresql-client` 16 por defecto; como la base real es Postgres 17, el workflow instala `postgresql-client-17` desde el repositorio oficial de PGDG antes de invocar `pg_dump`/`pg_restore`, para no arriesgar un dump que un cliente más viejo no sepa producir fielmente. El workflow está escrito en bash (no reutiliza `ops/*.ps1` vía `pwsh`) porque esos scripts asumen un directorio persistente con purga por antigüedad, que no existe en un runner efímero de Actions; ver el comentario al inicio de `backup.yml` para el detalle. **Antes de que el workflow funcione hay que crear en GitHub (Settings → Secrets and variables → Actions) los secretos `DATABASE_URL`** (conexión **directa** a Postgres, puerto 5432, no el pooler transaccional de pgbouncer — `pg_dump` necesita sesión completa) **y `BACKUP_ENCRYPTION_PASSPHRASE`** (frase de cifrado; guardarla también en el gestor de secretos del equipo, porque sin ella el backup cifrado subido es irrecuperable).
- Supabase: respaldo automático diario con retención contractual mínima de 30 días.
- Copia fría en el VPS (`ops/backup-postgres.ps1` + `ops/restore-verify.ps1`, checksum SHA-256, retención de 35 días): **sigue siendo manual**. El workflow de GitHub Actions es una red de seguridad adicional con retención corta (14 días), no sustituye esta copia fría ni su cron/Task Scheduler, que todavía no existe.
- `pg_restore --list` en el workflow solo confirma que el archivo no está corrupto (lee el catálogo/TOC); **no es una restauración**. La regla sigue siendo obligatoria: la primera restauración real de prueba (`ops/restore-verify.ps1` contra una base de verificación desechable, o el equivalente manual desde el dump cifrado del workflow) debe ejecutarse y documentarse antes de considerar el sistema en producción, y luego repetirse trimestralmente. Un backup que nunca se restauró no es un backup.
- Adjuntos: incluir una exportación/versionado del bucket; una restauración de Postgres no recupera archivos por sí sola.

## Incidentes

- Severidad alta: acceso indebido, pérdida de datos o indisponibilidad total. Revocar sesiones/keys, preservar logs y responder dentro del SLA de cuatro horas.
- Nunca copiar secretos ni payloads con PII al ticket. Usar identificadores y timestamps.
- Para Kapso, comparar firma del webhook, `kapso_message_id`, entrega y reintentos en `whatsapp_eventos`.
- Para inconsistencias contables, congelar el periodo afectado y ejecutar el comparador contra el dataset dorado antes de corregir datos.

## Rotación

Rotar service-role de Supabase, secreto Kapso, pepper MCP, código de formulario público y llaves de despliegue antes de producción y tras cualquier exposición. Las API keys MCP son individuales, revocables y auditadas.

