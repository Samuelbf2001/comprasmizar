# Matriz QA — UI demo y backend real

Estado al 24-ago-2026: los tests de UI verifican el prototipo sin persistencia. No equivalen a aceptación de producción; los flujos que necesitan Auth, RLS, Supabase y transacciones se ejecutan solamente con `E2E_REAL_BACKEND=1`.

| RF / criterio | Prueba | Estado | Evidencia o bloqueo |
| --- | --- | --- | --- |
| RF-104, RF-105 | `public-portal.spec.ts` — acceso, campos y éxito demo | PASS demo | Pasa en desktop y móvil con `localhost`; valida formato mínimo de código/teléfono y ausencia de shell. No valida hash, lista autorizada, rate-limit ni persistencia. |
| RF-101, RF-102 | `public-portal.spec.ts` — requeridos, obra, solicitante e ítem | PASS demo | Desktop y Pixel 7 muestran dentro del resultado “Modo demostración”, `REQ-DEMO-0148` y que no se guardaron datos. El overflow móvil medido es 0 px. |
| RF-301, RF-302 | `demo-operation.spec.ts` — bandeja y estados loading/error/empty/retry | PASS demo | Pasa en desktop y móvil; son estados simulados con accesibilidad visual. |
| RF-305, RF-405 | `demo-operation.spec.ts` — Kanban, detalle y trazabilidad | PASS demo | Pasa en desktop y móvil; auditoría inmutable sigue requiriendo backend real. |
| RF-906 | `demo-operation.spec.ts` — Mensajes sin iframe | PASS demo | Pasa en desktop y móvil para ausencia de `NEXT_PUBLIC_KAPSO_INBOX_URL`. |
| RF-201, RF-302, RF-501, RF-601 | `components/screens/connected.tsx` — captura interna, revisión/aprobación, órdenes y gastos/caja menor | PASS estático / pendiente E2E Auth | Las rutas conectadas consultan exclusivamente `/api/*`, muestran loading/error/empty y no renderizan cifras demo fuera de `NEXT_PUBLIC_DEMO_MODE=true`. `/aprobaciones/:id` abre el detalle conectado; caja menor tiene lectura y captura con permisos de rol. Requiere fixture aislado para probar persistencia y RLS. |
| RF-203, RF-204, RF-205 | `components/screens/catalog-admin.tsx` + `tests/unit/catalog-admin.test.tsx` — obras, etiquetas, ítems y proveedores | PASS componente / pendiente E2E Auth | Adaptador al GET autenticado `/api/catalogs/manage` y POST/PATCH discriminados: altas, edición, active false/true reversible, selector de sociedades y aprobadores elegibles, nombres sin UUID/PII, normalización de propuestas pendientes, validaciones visibles, estados vacíos/errores/éxito y gate por rol/feature. Revisor administra ítems/proveedores; Admin Sixteam todo; Admin Mizar obras/etiquetas/proveedores solo con `catalogos_admin_mizar`; el bootstrap operativo `/api/catalogs` no se usa para CRUD. |
| RF-601, RF-602, RF-604 | `suppliers.test.tsx`, `suppliers.spec.ts` y rutas `/api/suppliers/*` | PASS local / pendiente Supabase | Directorio, alta, ficha, bancos protegidos, documentos privados e historial pasan en desktop/móvil. Contabilidad queda en lectura; las URLs firmadas y datos bancarios no aparecen en listados. Persistencia, RLS y Storage reales siguen pendientes. |
| RF-101, RF-102, RF-801, RF-1005 | `attachment-service.test.ts`, `attachment-upload.test.tsx`, `operational-attachments.test.tsx` y `demo-operation.spec.ts` | PASS local / pendiente Supabase | Soporte general, foto por ítem y recibo de caja usan prepare → multipart → complete, validan PDF/JPEG/PNG/WebP y fallo parcial sin duplicar la entidad. Detalle/caja listan enlaces a `/download`, no capacidades firmadas. SQL/RLS y `HEAD/info` reales no se ejecutaron. |
| RF-004, RF-402, aceptación 4 | `authorization-and-backend.spec.ts` + smoke de build | PASS demo / PASS fail-closed / SKIP Auth real | Selector y guard pasan en ambos viewports. Con build de producción y demo desactivado, `/` y `/revision` responden 307 hacia login; sesión Supabase real sigue pendiente. |
| Seguridad pública | `routes.test.ts`, `security.test.ts`, E2E real | PASS sin configuración / SKIP entorno real | Los endpoints fallan cerrados sin variables y health solo devuelve estados booleanos. Firma, schemas, catálogos MCP y rate-limit tienen prueba local; BD real sigue pendiente. |
| §11.2.1 compra multi-proveedor | `authorization-and-backend.spec.ts` `fixme` | Bloqueado persistencia | Necesita captura real, revisión, dos proveedores, dos OCs/PDFs, cumplimiento, gasto y export. |
| §11.2.2 pago | `authorization-and-backend.spec.ts` `fixme` | Bloqueado persistencia | Necesita etiqueta nómina, aprobación y OP/gasto reales. |
| §11.2.3 devolución | `authorization-and-backend.spec.ts` `fixme` | Bloqueado persistencia | Necesita motivo obligatorio, retorno a revisión, reenvío y auditoría. |
| §11.2.4 declinación | `authorization-and-backend.spec.ts` `fixme` | Bloqueado persistencia | Necesita motivo, exclusión de activa, consulta de declinadas y ausencia de gasto. |
| Responsive | `public-portal.spec.ts`, `demo-operation.spec.ts`, `suppliers.spec.ts` | PASS con corrección en curso | Desktop y móvil pasan los recorridos existentes; miden overflow del portal/Kanban y usabilidad de proveedores. La puerta visual raíz detectó además overflow del encabezado de `/requisiciones/nueva` a 390 px y exige su corrección + caso E2E antes de aprobar RF-1005. |

## Ejecución

```powershell
npm run test:e2e
$env:E2E_REAL_BACKEND = '1'
npm run test:e2e
```

El segundo comando no debe ejecutarse contra datos productivos: requiere un entorno aislado con usuarios, obra/código y proveedores de prueba. Las cuatro pruebas `fixme` de compra multi-proveedor, pago, devolución y declinación se habilitan cuando `E2E_REAL_BACKEND=1`; además exigen los IDs aislados `E2E_MULTI_SUPPLIER_REQUISITION_ID`, `E2E_PAYMENT_ID`, `E2E_RETURNED_REQUISITION_ID` y `E2E_DECLINED_REQUISITION_ID`. Fallarán hasta que A2 publique fixtures transaccionales y la UI exponga los `data-testid` descritos; ese fallo es una brecha explícita, no un éxito simulado.

## Hallazgos adversariales para producto

1. El portal público demo acepta cualquier código y teléfono con longitud mínima. Antes de producción debe delegar la verificación a `/api/public/requisitions`, aplicar el código hash/lista autorizada definidos en P2 y limitar intentos.
2. El runner debe usar `localhost`, no `127.0.0.1`: Next 16 bloquea hidratación/HMR con el segundo sin configurar `allowedDevOrigins`. La ejecución demo requiere `NEXT_PUBLIC_DEMO_MODE=true` en el servidor local reutilizado por Playwright en `http://localhost:3000`.
3. Los endpoints ya existen, pero su contrato real debe correrse con credenciales/fixtures aisladas mediante `E2E_REAL_BACKEND=1`; la UI demo no prueba persistencia.
4. El rerun más reciente pasa 22 casos habilitados en desktop/móvil; otros 14 están `skip`/`fixme` porque exigen Auth, Supabase, Kapso o fixtures persistentes reales. El aviso de demo ya permanece visible dentro del resultado móvil.
5. La revisión en navegador confirmó portal público, dashboard y Mensajes sin errores de consola; Mensajes mantiene `iframeCount=0` mientras Kapso no está configurado.
