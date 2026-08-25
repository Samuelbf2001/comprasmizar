# Manuales operativos de Mizar

Estos manuales describen el uso esperado según el PRD, la demo aislada y las pantallas que consumen los servicios autenticados.

## Estado que debe leer el equipo

El checkout contiene dos modos separados: `NEXT_PUBLIC_DEMO_MODE=true` habilita una **demo navegable sin persistencia**; fuera de demo, Auth falla cerrado y las vistas operativas consultan APIs autenticadas para captura, revisión/aprobación, órdenes, gastos y caja menor. Esto sigue sin ser aceptación de producción: no se ejecutaron las migraciones ni recorridos con Supabase, datos, adjuntos, Kapso o usuarios reales.

| Manual | Usuario principal |
|---|---|
| [Solicitante](solicitante.md) | Maestro de obra, personal interno o externo autorizado |
| [Revisor / Daniel](revisor-daniel.md) | Compras, normalización y caja menor |
| [Aprobador](aprobador.md) | Nelson, Claudia, Juliana o Daniel según etiqueta |
| [Contabilidad](contabilidad.md) | Consulta, soportes y exportación para Helisa |
| [Administradores](administradores.md) | Admin Mizar y Admin Sixteam |
| [WhatsApp vía Kapso](whatsapp-kapso.md) | Operación del canal y su bandeja |
| [MCP Sixteam](mcp-sixteam.md) | Diagnóstico y administración técnica segura |

La [matriz de rutas, roles, capacidades, estado y gates](matriz-rutas-roles.md) es la fuente rápida para capacitación y QA.

## Límites no negociables

- Helisa no se integra por API en este alcance: el límite es una exportación compatible, pendiente de validar con contabilidad.
- La aprobación y devolución son actos de control interno en la interfaz autenticada; no se delegan al MCP.
- No se usan credenciales, números reales, capturas reales ni datos inventados en estos manuales.
- “Código conectado” no significa “listo para producción”: revisar gates externos, UAT, permisos/RLS sobre una BD real, auditoría, adjuntos y paridad antes de declarar aceptación.
