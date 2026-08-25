# Guía del MCP para Sixteam

## Propósito

Permitir consultas y administración operativa desde un cliente MCP reutilizando la misma capa de servicio y permisos de la web.

## Capacidades previstas

En F3 se contemplan consultas de requisiciones, órdenes, gastos, embudo, gastos por obra/periodo, ficha de proveedor y exportación de reportes. En F4 se contemplan CRUD de catálogos, crear requisiciones, cambiar cumplimiento de OC, registrar caja menor y reenviar notificaciones.

## Límites obligatorios

- La API key se liga a un usuario real y ejecuta sus permisos; todos los eventos se auditan con origen `mcp`.
- No se puede aprobar ni denegar requisiciones por MCP. Ese acto ocurre en la interfaz autenticada.
- El MCP de Kapso (`https://api.kapso.ai/mcp`) es un complemento de diagnóstico del canal, no un desarrollo de esta plataforma.
- No documentar valores de API keys, tokens, DSN, URLs-capability ni credenciales.

## Estado actual

Esta guía describe el contrato del PRD, no una conexión confirmada. La demo de UI no prueba endpoint MCP, permisos, auditoría ni cliente Claude. Antes de activar: secretos rotados, RLS/servicios verificados, rate limits, logs sin secretos y prueba negativa de aprobación.

## Checklist Sixteam

- [ ] API key ligada a usuario/rol real y revocable.
- [ ] Lecturas respetan filtros y RLS.
- [ ] Escrituras permitidas tienen auditoría `origen=mcp`.
- [ ] Aprobar/denegar devuelve no permitido.
- [ ] Exportaciones no exponen PII fuera del permiso.
- [ ] Pruebas de seguridad y aceptación pasan antes de retirar gates legacy.
