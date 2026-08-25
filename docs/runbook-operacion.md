# Runbook operativo

## Despliegue

1. Ejecutar lint, typecheck, cobertura, build y E2E en CI.
2. Construir una imagen inmutable con el SHA del commit.
3. Aplicar migraciones primero en dev y ejecutar las verificaciones de RLS.
4. Hacer respaldo pre-despliegue de producción.
5. Desplegar la imagen, esperar `/api/health` y ejecutar smoke tests por rol.
6. Conservar el tag anterior. Rollback de app significa volver al tag; nunca revertir una migración destructiva sin plan probado.

## Respaldo y restauración

- Supabase: respaldo automático diario con retención contractual mínima de 30 días.
- Copia fría: `pg_dump` semanal en formato custom, checksum SHA-256 y retención de 35 días en el VPS.
- Restauración: prueba trimestral y obligatoria antes del primer lanzamiento, tanto desde Supabase como desde la copia fría.
- Adjuntos: incluir una exportación/versionado del bucket; una restauración de Postgres no recupera archivos por sí sola.

## Incidentes

- Severidad alta: acceso indebido, pérdida de datos o indisponibilidad total. Revocar sesiones/keys, preservar logs y responder dentro del SLA de cuatro horas.
- Nunca copiar secretos ni payloads con PII al ticket. Usar identificadores y timestamps.
- Para Kapso, comparar firma del webhook, `kapso_message_id`, entrega y reintentos en `whatsapp_eventos`.
- Para inconsistencias contables, congelar el periodo afectado y ejecutar el comparador contra el dataset dorado antes de corregir datos.

## Rotación

Rotar service-role de Supabase, secreto Kapso, pepper MCP, código de formulario público y llaves de despliegue antes de producción y tras cualquier exposición. Las API keys MCP son individuales, revocables y auditadas.

