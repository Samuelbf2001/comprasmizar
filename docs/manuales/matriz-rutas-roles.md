# Matriz de rutas, roles, capacidades, estado y gate

Estado `Demo` significa que la ruta es navegable con datos sintéticos y sin persistencia. `Código conectado` significa que la pantalla llama servicios autenticados y falla cerrada, pero todavía no tiene evidencia E2E con Supabase/UAT; no equivale a producción.

| Ruta | Rol(es) | Capacidad | Estado actual | Gate antes de declarar conectado |
|---|---|---|---|---|
| `/` | Todos autenticados según rol | Métricas por rol | Demo + código conectado | Datos reales, permisos/RLS y modo pantalla |
| `/requisiciones/publica` | Externo autorizado | Crear requisición | Demo mobile-first + código conectado | P2 real, migración aplicada, adjuntos y recorrido persistente |
| `/requisiciones/nueva` | Solicitante | Captura interna, soporte general y foto por ítem | Demo + código conectado | CC2-02 real, SQL/RLS/Storage y recorrido persistente |
| `/requisiciones/mis` | Solicitante | Consultar propias | Demo placeholder + código conectado | RLS y estados sobre Supabase real |
| `/revision` | Revisor/Daniel | Normalizar, cotizar, enrutar, declinar | Demo lista/Kanban + código conectado | Filtros, impuestos P1, adjuntos, auditoría en BD y UAT |
| `/aprobaciones` | Aprobadores | Aprobar/devolver propia | Demo + código conectado | RLS, auditoría y recorrido con aprobadores reales |
| `/ordenes` | Revisor, Contabilidad, Admin | Consultar/cumplir según rol | Demo + código conectado | PDF descargable validado P4 y E2E multi-proveedor |
| `/gastos` | Revisor consulta/crea caja y adjunta recibo; Contabilidad consulta/descarga | Gastos y caja menor | Demo + código conectado | Reparto P3, SQL/RLS/Storage, paridad y Helisa |
| `/catalogos` | Sixteam; Mizar solo en Completo | CRUD maestro | Demo con gate | Autoservicio P7, RLS, importación real |
| `/proveedores` | Revisor y Sixteam; Mizar en Completo; Contabilidad lectura | Directorio, alta, ficha, bancos, documentos e historial | Demo + código conectado | Migraciones/RLS/Storage reales, RF-603 dentro de revisión y UAT |
| `/mensajes` | Daniel y perfiles autorizados | Inbox Kapso/log | Demo segura sin iframe; iframe HTTPS conectado solo al configurar | Adjuntos, cuenta/número/plantillas y webhook real Kapso |
| `/reportes` | Admin, Contabilidad lectura | Resumen/exportación | Demo + lectura conectada; builders provisionales | Rutas de descarga aceptadas, dataset real, paridad, Helisa y PDF P4 |
| `/configuracion` | Sixteam | Seguridad, backups, pantalla, integración | Demo/guard de rol | Infraestructura, secretos rotados, restore |
| `/ayuda` | Todos autenticados | Manuales y soporte | Demo | UAT/capacitación y enlaces publicados |

## Reglas de autorización

- El servidor debe aplicar autorización; el menú es solo una ayuda visual.
- Contabilidad es solo lectura + exportación.
- Admin-Mizar en Básico no normaliza ítems ni edita catálogos.
- La aprobación no está disponible para MCP.
- El formulario público solo puede crear requisiciones.
