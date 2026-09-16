# TASKS — Adenda «Órdenes de Pago y caja menor» (ejecución)

**Fuente:** [PRD-pagos-y-caja-menor.md](../PRD-pagos-y-caja-menor.md) v1.0 · gap analysis contra `main` @ f9a7e00 (15-sep-2026, 22:40).
**Método:** desarrollo-con-ia + tres mecanismos GSD (Verificar ejecutable por paquete · ESTADO.md por worktree · verificador de plan antes de repartir).
**Base de todas las ramas:** `origin/main` fresco (f9a7e00). Ola 2 se corta desde la rama de la ola 1 ya integrada.

## 0. Lo que ya existe en `main` (no reconstruir)

| Ya está | Dónde |
|---|---|
| `tipo=pago` con una línea (concepto = `descripcion_libre`, beneficiario = `proveedor_final_id`, valor) | `lib/domain/rules.ts:211-224`, `lib/services/procurement-service.ts:65-178`, `components/screens/connected/new-requisition.tsx:533-600` |
| Pagos parciales: tabla `pagos_orden`, trigger anti-sobrepago, `registerOrderPayment`, panel Pagos | `supabase/migrations/202609120002_pagos_orden.sql`, `procurement-service.ts:579-596`, `app/api/orders/[id]/payments/route.ts`, `orders.tsx:661-760` |
| Centros de costo: catálogo, herencia obra→requisición→gasto, exigido al enviar a aprobación | `202609120001`, `rules.ts:153`, `procurement-service.ts:201-216,307` |
| PDF de OP con rótulo, consecutivo `OP-`, bloque beneficiario, tabla concepto/valor | `lib/reports/pdf.ts:31-70` |
| Bypass M-5: `admin_sixteam` decide cualquier requisición; revisor+aprobador puede autoasignarse y aprobar (dos eventos) | `rules.ts:261-271`, `procurement-service.ts:217-222`, test `procurement-service.test.ts:793` |
| Edición de montos en `review()` para `tipo=pago` | `procurement-service.ts:174-178,229-245` |
| Reportes con filtros obra/periodo/aprobador/etiqueta/centro de costo + Excel + compilado mensual | `reports.tsx`, `app/api/reports/*` |

## 1. Decisiones de diseño (postura firme)

| # | Decisión | Por qué |
|---|---|---|
| A1 | **Medio "Caja" = valor `efectivo`** ya existente en `pagos_orden.medio_pago`; solo cambia la etiqueta en UI a "Caja (efectivo)". No se toca el enum. | La caja menor es el único efectivo de la empresa; la convención prohíbe `ALTER TYPE … ADD VALUE`. |
| A2 | **Sin columnas nuevas `concepto`, `valor_solicitado`, `fecha_gasto`.** Concepto = `descripcion_libre`; fecha del gasto = `fecha_requerida` reetiquetada en `tipo=pago`; el monto original queda en el evento de dominio `revisada` (`montoAntes`/`montoDespues`). | Ya existen los campos; duplicarlos crea dos verdades. |
| A3 | **"Marcar pagada" deja de inventar un pago `otro`**: se convierte en "Pagar saldo", que abre el mismo diálogo de pago prellenado con el saldo y exige medio. `estado_pago` es derivado (`pendiente / parcial / pagada`) y no se guarda. | RF-508. Conserva el atajo de un clic que Daniel valoró. |
| A4 | **Anular ≠ borrar**: `pagos_orden` gana `anulado`, `motivo_anulacion`, `anulado_por`, `anulado_en`, `nota`; el trigger anti-sobrepago y `paidAmount` ignoran anulados. | RF-510. |
| A5 | **Comprobante de pago** = adjunto polimórfico con entidad `pago_orden` (misma tabla `adjuntos`, mismo patrón con que se añadió `caja_menor` en `202609120003`). | Cero tablas nuevas. |
| A6 | **Beneficiario persona o empresa**: `proveedores` gana `tipo_identificacion` (`NIT`/`CC`/`CE`/`PAS`, default `NIT`), `identificacion` (backfill = `nit`), `pendiente_normalizacion boolean`. `nit` se conserva como legado. Índice único `(tipo_identificacion, identificacion)`. | RF-601/606 sin romper el PDF ni las pruebas actuales. |
| A7 | **Empresa facturada** = `requisiciones.empresa_facturada_id → sociedades`, backfill = `sociedad_id`, default en dominio = sociedad del centro de costo, si no la de la obra; editable en revisión. `gastos` la hereda por trigger existente o por copia en el servicio. | RF-009. Contabilidad ve la razón social del recibo; Claudia ve el centro de costo. |
| A8 | **`centros_costo.tipo`** text con CHECK (`obra`/`administrativo`/`personal`/`empresa`), default `obra`. | RF-007. |
| A9 | **Auto-aprobación en un paso** = método de servicio `sendAndApproveAsMaster(id)` que encadena `sendForApproval` + `approve` y deja **dos** eventos; solo para usuario con roles revisor+aprobador o admin. Botón "Aprobar yo mismo" en revisión. | RF-308. |
| A10 | **Módulo «Gastos y caja» (12-sep): retirada parcial, tablas dormidas.** Se elimina de la UI y del API el "gasto directo" (`registerPettyCash`, `/api/petty-cash` POST, MCP `registrar_caja_menor`) y la pestaña Ingresos; la pestaña "Cierre mensual" se convierte en **"Cierre de caja"** sobre `pagos_orden` con `medio_pago='efectivo'`. Las tablas `cajas`, `ingresos`, `cierres_caja`, `caja_menor` **no se borran** (convención sin DROP) y quedan para la fase 2 financiera. | D2 / RF-708 / §7. Reversible por git si Ernesto lo veta antes de integrar. |
| A11 | **Flow de pago propio** (`scripts/build-flow-pago.ts`, 3 pantallas) + opción de menú "Solicitar un pago". La opción `tipo_solicitud=pago` del Flow de captura se **retira** (hoy se pierde en silencio). | RF-908/902. |
| A12 | **Portal público**: paso 1 "Solicitud de pago" lleva a un camino de 3 pasos (identificación+nombre → empresa+monto+concepto+adjunto opcional → resumen). | RF-108. |
| A13 | Notificación "pagada" al beneficiario (RF-904/P10) **no se construye** hasta que Daniel decida. Nómina multi-beneficiario (P9) **no se construye**. | Preguntas abiertas de la adenda. |

## 2. Índices de migración reservados

| Índice | Paquete | Contenido |
|---|---|---|
| `202609150001_pagos_anulacion_comprobante.sql` | N1 | columnas de anulación/nota en `pagos_orden`; entidad `pago_orden` en `adjuntos`; trigger anti-sobrepago ignora anulados; `pagos_orden` entra a `escribir_auditoria` |
| `202609150002_proveedores_identificacion.sql` | N2 | `tipo_identificacion`, `identificacion`, `pendiente_normalizacion`; backfill; índice único |
| `202609150003_centro_costo_tipo_empresa_facturada.sql` | N3 | `centros_costo.tipo`; `requisiciones.empresa_facturada_id` + backfill; `gastos.empresa_facturada_id` + backfill |

Ningún otro paquete crea migraciones. Cada una trae `supabase/tests/<tema>_verification.sql` y pasa `npm run verify:schema`.

## 3. Ola 1 — Núcleo (un worktree, secuencial, un agente)

Worktree `C:\Users\samue\mizar-pagos-nucleo`, rama `feat/pagos-nucleo` desde `origin/main`. Un commit por paquete. ESTADO.md en la raíz del worktree.

### N1 — Pagos: anulación, nota, comprobante, estado derivado, pagar saldo
- **Archivos:** migración 0001 + `supabase/tests/pagos_anulacion_verification.sql`; `lib/domain/model.ts` (Payment: `nota`, `anulado`, `motivoAnulacion`, `anuladoPor`, `anuladoEn`, `attachmentId`; `AttachmentEntity` + `pago_orden`; Order: `paymentStatus`, `lastPaymentAt`, `paymentMethods[]`); `lib/domain/rules.ts` (`paymentStatus()`, `assertPaymentWithinOrder` ignora anulados, `assertCanAnnulPayment` motivo obligatorio); `lib/services/procurement-service.ts` (`registerOrderPayment` acepta `nota` y `attachmentId`; nuevo `annulOrderPayment(orderId, paymentId, motivo)`; nuevo `listCashPayments({from,to,costCenterId?})` para el cierre; `updateOrderAdminStatus` **deja de inventar el pago `otro`** — la vía "pagada" pasa a exigir saldo 0 o a devolver `{ok:false, reason:'saldo_pendiente'}`); **`lib/services/list-query.ts`** (extender `costCenterId` a órdenes; añadir `paymentMethod`, `paymentStatus`, `paidFrom`/`paidTo`); **`lib/infrastructure/postgres-repositories.ts`** (UPDATE de anulación; el `left join lateral` de pagos excluye anulados y expone `paymentStatus`/`lastPaymentAt`/`paymentMethods`; filtros nuevos en la consulta de órdenes; consulta de `listCashPayments`); `lib/services/attachment-service.ts` (entidad `pago_orden`); `app/api/orders/[id]/payments/route.ts` (POST con `nota`/`attachmentId`) + nuevo `app/api/orders/[id]/payments/[paymentId]/route.ts` (PATCH anular); **nuevo `components/screens/connected/payment-labels.tsx`** (`MEDIO_PAGO_LABELS` con `efectivo → "Caja (efectivo)"`, `PaymentStatusBadge`) para que la ola 2 no toque `shared.tsx`; tests: ampliar `tests/unit/domain.test.ts` y `tests/unit/procurement-service.test.ts`, crear `tests/integration/order-payments-route.test.ts`.
- **No tocar:** `orders.tsx`, `shared.tsx`, `app/mcp/route.ts`, nada de `cash-service`/`expenses`.
- **Verificar:** `npm run verify:schema` → OK; `npm run typecheck` → 0 errores; `npm run test -- tests/unit/domain.test.ts tests/unit/procurement-service.test.ts tests/integration/order-payments-route.test.ts` → todos verdes, incluidos los nuevos: "anular pago excluye del pagado", "no se puede anular sin motivo", "estado_pago pendiente/parcial/pagada", "pagada exige saldo 0", "listCashPayments solo devuelve efectivo no anulado en el rango".

### N2 — Beneficiario persona o empresa
- **Archivos:** migración 0002 + verificación SQL; `lib/domain/model.ts` (Supplier: `tipoIdentificacion`, `identificacion`, `pendienteNormalizacion`); `lib/services/supplier-service.ts` (`SupplierWrite` con identificación; `findByIdentification(tipo, id)`; `resolveOrCreateBeneficiary({tipo, identificacion, nombre, telefono?})` → crea con `pendiente_normalizacion=true`); `lib/services/procurement-service.ts` `create()` acepta `beneficiario: {tipoIdentificacion, identificacion, nombre}` para canales externos (portal, WhatsApp) además de `proveedor_final_id`; `lib/reports/pdf.ts` muestra `tipo + identificación` en BENEFICIARIO; repositorio de proveedores; tests.
- **No tocar:** pantallas (`new-requisition.tsx`, `catalog-admin.tsx`), portal, Kapso.
- **Verificar:** `npm run verify:schema`; `npm run typecheck`; `npm run test -- supplier tests/unit/procurement-service.test.ts tests/unit/order-document-pdf` → verdes (pegar la lista de archivos que vitest ejecutó; debe incluir al menos un test de `supplier-service`, creándolo si no existe), incluidos "resolveOrCreateBeneficiary reutiliza por identificación", "crea pendiente_normalizacion" y "el PDF muestra tipo + identificación".

### N3 — Centro de costo con tipo, empresa facturada, monto auditado, auto-aprobación
- **Archivos:** migración 0003 + verificación SQL; `lib/domain/model.ts` (CostCenter.tipo; Requisition.empresaFacturadaId; **Order.empresaFacturadaId**); `lib/infrastructure/postgres-repositories.ts` (lectura/escritura de los campos nuevos, filtro `billedCompanyId` en órdenes y gastos); `lib/services/list-query.ts` (`billedCompanyId`); `lib/domain/rules.ts` (`resolveBilledCompany(req, costCenter, work)`; `sendForApproval` exige `empresaFacturadaId` en `tipo=pago`; `assertCanSelfApprove(user)`); `lib/services/procurement-service.ts` (`review()` acepta `empresaFacturadaId`; evento `revisada` incluye `montoAntes/montoDespues` cuando cambia el valor en `tipo=pago`; nuevo `sendAndApproveAsMaster(id)` con dos eventos; `generateOrders`/gasto copian `empresa_facturada_id`); `lib/services/catalog-service.ts` (`costCenters` con `tipo`); repositorios; `app/api/requisitions/[id]/actions/route.ts` (acción `send_and_approve`); tests.
- **No tocar:** pantallas, portal, Kapso, MCP.
- **Verificar:** `npm run verify:schema`; `npm run typecheck`; `npm run test` completo → verde; nuevos: "empresa facturada por defecto = sociedad del CC", "revisada guarda monto antes/después", "send_and_approve deja dos eventos y exige roles".

**Cierre de la ola 1:** `npm run lint && npm run typecheck && npm run test && npm run verify:schema` verdes; ESTADO.md actualizado; informe con `git diff --stat origin/main...HEAD`. El coordinador (esta sesión) corre la suite él mismo antes de integrar a `main`.

## 4. Ola 2 — Superficies (paralelo, archivos disjuntos, desde `feat/pagos-nucleo` integrado)

| Paquete | Worktree / rama | Archivos (exclusivos) | No tocar | Verificar |
|---|---|---|---|---|
| **S1 Órdenes** — diálogo de pago con medio (etiquetas de `payment-labels.tsx`), nota y comprobante; historial con anulados tachados + motivo; botón "Anular" con diálogo de motivo; `PaymentStatusBadge`; "Pagar saldo" prellenado; filtros medio de pago / estado de pago / centro de costo / empresa facturada / rango de fecha de pago (todos ya soportados por `ListQuery` desde la ola 1) | `mizar-ola2-ordenes` · `feat/ordenes-pagos-ui` | `components/screens/connected/orders.tsx`, `tests/unit/connected-orders-*.test.tsx`, `tests/e2e/orders*` | `shared.tsx`, `payment-labels.tsx`, servicios, repositorios, todo lo demás | `npm run typecheck`; `npm run test -- tests/unit/orders tests/unit/connected-orders` verde (debe listar `connected-orders-admin`, `connected-orders-cost-center`, `connected-orders-lente` y el nuevo `connected-orders-pagos`); captura de pantalla del panel con un pago anulado y el badge |
| **S2 Captura y revisión interna** — formulario de pago: fecha del gasto (etiqueta), soporte "Factura o cuenta de cobro", beneficiario por identificación (NIT/CC) con alta rápida, centro de costo + empresa facturada visibles; revisión: editar monto (muestra el original), empresa facturada editable, botón "Aprobar yo mismo" (roles); Catálogos: `tipo` en centros de costo, identificación en proveedores; pantalla Proveedores con identificación | `mizar-ola2-captura` · `feat/captura-pago-ui` | `components/screens/connected/new-requisition.tsx`, `components/screens/connected/detail.tsx`, `components/screens/catalog-admin.tsx`, `components/screens/suppliers.tsx` (el alta rápida de proveedor está inline en los tres: unificar en un componente nuevo `components/screens/supplier-quick-create.tsx` es parte de S2), sus tests en `tests/unit/` | `orders.tsx`, `shared.tsx`, portal, Kapso, reportes | `npm run typecheck`; `npm run test -- connected-new-requisition connected-detail catalog-admin suppliers supplier-quick-create` verde (pegar la lista de archivos ejecutados; mínimo un test por pantalla tocada, creándolo si no existe) |
| **S3 Portal público de pago** — camino de 3 pasos (identificación+nombre → empresa+monto+concepto+adjunto opcional → resumen); `publicRequisitionSchema` con rama `pago`; crea vía `create()` con `beneficiario` pendiente; **quitar el `catch → neutral()` silencioso para errores de forma** (responder 400 con motivo, mantener 202 solo en la ruta anti-enumeración) | `mizar-ola2-portal` · `feat/portal-pago` | `components/screens/public-request.tsx`, `app/api/public/requisitions/route.ts`, `tests/unit/public-*`, `tests/integration/public*`, `tests/e2e/public-portal*` | resto | `npm run test -- tests/unit/public tests/integration/public` verde (incluye `public-request-portal` y `public-portal-hardening`, con un caso nuevo de pago en cada uno); `npm run test:e2e -- public-portal` verde con un caso de pago |
| **S4 WhatsApp Flow de pago** — `scripts/build-flow-pago.ts` (3 pantallas, sin PhotoPicker); menú del router con "Solicitar un pago"; `app/api/kapso/route.ts` + `kapso-contracts.ts` aceptan payload de pago (identificación, nombre, empresa, monto, concepto) → `create()` con `beneficiario`; retirar `tipo_solicitud=pago` del Flow de captura; fixtures nuevas. **No cambiar la firma de `sendRequisitionFlow`** (la usa `app/api/internal/send-flow/route.ts`); si hace falta, añadir `sendPaymentFlow` aparte | `mizar-ola2-whatsapp` · `feat/flow-pago` | `scripts/build-flow-pago.ts`, `scripts/build-flow-captura.ts`, `lib/infrastructure/whatsapp-router.ts`, `lib/infrastructure/flow-sender.ts`, `app/api/kapso/**`, `app/api/internal/send-flow/route.ts`, `lib/infrastructure/kapso-contracts.ts`, `integrations/whatsapp-flow/**`, `tests/integration/kapso*`, `tests/unit/whatsapp-router*` | resto | `npm run test -- tests/integration/kapso tests/unit/whatsapp-router` verde; `npx tsx scripts/build-flow-pago.ts` genera el JSON sin error; la validación remota de Meta (`validation_errors` vía Graph API, procedimiento en `integrations/whatsapp-flow/README.md`) devuelve `[]` — paso manual, pegar la respuesta |
| **S5 Reportes y cierre de caja; retiro de «Gastos y caja»** — reportes: totales comprometido vs pagado por periodo, filtros medio/estado de pago/empresa facturada, Excel; `expenses.tsx` → "Cierre de caja" (rango de fechas, pagos `efectivo`, total, comprobantes, Excel) y **se retiran** "Registrar gasto directo" y la pestaña Ingresos; `/gastos` pasa al menú como "Cierre de caja"; `app/api/petty-cash` POST y `app/api/incomes` responden 410 con mensaje; MCP: quitar `registrar_caja_menor`, añadir `registrar_pago` y `listar_centros_costo`/`crear_centro_costo` | `mizar-ola2-reportes` · `feat/reportes-cierre-caja` | `components/screens/connected/reports.tsx`, `components/screens/connected/expenses.tsx`, `lib/services/cash-service.ts`, `lib/services/report-service.ts`, `app/api/petty-cash/**`, `app/api/incomes/**`, `app/api/cash-closes/**`, `app/api/reports/**`, `app/mcp/route.ts`, `components/layout/app-shell.tsx`, `components/mizar-app.tsx`, sus tests + nuevo `tests/unit/mcp-route.test.ts` | `orders.tsx`, `shared.tsx`, captura, portal, Kapso | `npm run typecheck`; `npm run test -- connected-expenses-detail cash-service tests/unit/reports connected-reports report-service mcp-route` verde; `curl -s -o /dev/null -w '%{http_code}' -X POST http://localhost:3000/api/petty-cash` → `410` |

Dependencias: S1–S5 dependen solo de la ola 1 integrada. Entre sí, ninguna. `components/layout/app-shell.tsx`/`components/mizar-app.tsx` son exclusivos de S5; `components/screens/connected/shared.tsx`, `lib/services/*` (salvo `cash-service`/`report-service` en S5) y `lib/infrastructure/postgres-repositories.ts` **no se tocan en la ola 2** — si una superficie necesita algo ahí, se reporta y lo hace el coordinador en un parche puntual sobre `main`.

## 5. Ola 3 — Integración y QA
1. El coordinador integra S1…S5 a `main` de a una, corriendo `npm run lint && npm run typecheck && npm run test` **él mismo** tras cada merge.
2. Agente QA adversarial: levanta la app (`.claude/launch.json`), recorre los E2E #2, #5, #6 y #7 de la adenda §10 con datos con forma real, reporta en `docs/qa/QA-pagos-y-caja.md` con severidad + repro.
3. Consolidar `ESTADO.md` de cada worktree en `docs/ESTADO-Y-PENDIENTES.md` (desfasado desde el 26-ago) y borrar los `ESTADO.md` de raíz al integrar.
4. Memoria del proyecto: decisiones A1–A13 y lo que quedó abierto.

## 6. Plantilla ESTADO.md (raíz de cada worktree, commiteado)

```
# ESTADO — <rama>
Rama y base: <rama> desde origin/main @ <hash>
Último commit: <hash> <mensaje>
Hecho: - …
A medias: - <qué> en <archivo:línea>
Próximos pasos: - …
Cómo verificar: <comandos exactos>
Decisiones pendientes del usuario: - …
Riesgos: - …
```
