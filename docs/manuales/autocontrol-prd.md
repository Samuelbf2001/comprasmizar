# Autocontrol documental contra PRD

## Fuentes revisadas

- PRD §4–§5: roles, reglas transversales y estados del flujo.
- PRD §6: M1–M12, incluido Kapso, seguridad, dashboard y MCP.
- PRD §11: pirámide de pruebas, recorridos E2E, datos de prueba y definición de hecho.
- PRD §15: criterios de aceptación Básico y Completo.
- PRD §17: **no existe en el archivo `PRD.md` actual**; no se inventó contenido para esa sección.
- Pantallas actuales: dashboard, revisión, aprobaciones, órdenes, gastos, catálogos, reportes, portal público, shell por rol, estados demo y mensajes Kapso seguro.

## Cobertura

| Requisito | Documento | Cobertura | Estado honesto |
|---|---|---|---|
| Roles y autorización | manuales por rol + matriz | Capacidades, menú, guard Auth y permisos de servicio | Demo y fail-closed verificados; migración RLS no ejecutada/UAT pendiente |
| Ciclo y estados | solicitante, revisor, aprobador | Captura → revisión → aprobación → OC/OP → gasto | Reglas y unidad transaccional probadas; persistencia PostgreSQL no demostrada |
| Contabilidad/Helisa | contabilidad | Filtro, exportación, paridad | Helisa no conectado; P1/paridad abiertos |
| WhatsApp/Kapso | whatsapp-kapso | Firma, ledger idempotente, creación texto/link, log e inbox embebido | Código probado sin BD; adjuntos, cuenta, plantillas y fixture firmado real pendientes |
| MCP | mcp-sixteam | 4 lecturas/estado y 2 escrituras, API key HMAC, rate-limit, auditoría y veto de aprobación | Catálogo/seguridad probados; endpoint con key/BD real no confirmado |
| Dashboard/pantalla | matriz + admin | Métricas y modo pantalla | Demo; token readonly y auto-refresh pendientes |
| Pruebas E2E | recorridos-aceptacion | 14 casos demo habilitados + 14 gates reales explícitos | Demo pasa en desktop/móvil; fixtures/UAT reales pendientes |
| Capacitación | plan-y-asistencia | Agenda, asistencia, firma y criterio | Plantilla, no acta firmada |

## No se afirmó

No se afirmaron credenciales, capturas reales, plantillas aprobadas, número Kapso, datos de Mizar, paridad contable, restore, auditoría de producción, cierres P1–P7 ni conectividad backend.
