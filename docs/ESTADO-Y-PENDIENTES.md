# Estado y pendientes — Plataforma de Requisiciones Mizar

**Actualizado:** 16 de septiembre de 2026
**Repo:** rama `main`, **local** — pendiente de `git push`.
**Fuente de esta actualización:** ejecución de la adenda [`PRD-pagos-y-caja-menor.md`](../PRD-pagos-y-caja-menor.md) la noche del 15→16-sep-2026, siguiendo [`docs/TASKS-pagos-y-caja.md`](TASKS-pagos-y-caja.md).

---

## 1. ¿En qué etapa estamos?

La adenda de **Órdenes de Pago y caja menor** está **implementada e integrada en `main` LOCAL**: ola 1 (núcleo, un worktree secuencial) + ola 2 (cinco paquetes en paralelo: Órdenes, Captura/revisión, Portal público, WhatsApp, Reportes/cierre de caja) + tres parches puntuales del coordinador sobre `shared.tsx` y el portal público. El flujo de compras (OC) validado con Daniel el 11-sep **sigue funcionando igual**: la adenda no lo reemplaza, agrega la Orden de Pago (OP) como segundo documento del mismo flujo.

El módulo «Gastos y caja» del 12-sep quedó **retirado de la UI y del API** (el gasto directo sin requisición, la pestaña Ingresos, el cierre mensual por caja): sus tablas no se borraron, quedan dormidas para la fase 2 financiera. En su lugar, cualquier gasto —incluida la caja menor— nace de una requisición normal y se paga con medio `caja/transferencia/tarjeta/otro`, con comprobante y anulación con motivo; un «Cierre de caja» filtra esos pagos por rango de fechas.

**QA adversarial hecho** (16-sep, madrugada; [`docs/qa/QA-pagos-y-caja.md`](qa/QA-pagos-y-caja.md)): 14 hallazgos, de los cuales **13 quedaron resueltos** esa misma mañana en dos paquetes verificados e integrados (§7 del informe). El restante (H10) es una decisión con el contador, no un defecto. Estado final de `main` local: lint 0, typecheck 0, 94 archivos / 1169 pruebas, 23 migraciones con sus arneses contra Postgres real, E2E 51 verdes y 0 rojos (15 omitidos por requerir backend real).

Falta antes de considerar esto "en producción": **`git push`** (nada llegó a GitHub ni al VPS todavía), el despliegue, publicar en Meta el Flow de pago y el v4 del Flow de captura, y que Daniel/Claudia/el contador cierren las preguntas abiertas de la adenda (P8–P12, ver `PRD-pagos-y-caja-menor.md` §8).

---

## 2. Hecho en esta ejecución

### 2.1 Núcleo y datos (ola 1: N1–N4)

- Pagos con **anulación** (no se borra: motivo, quién y cuándo), **nota** y **comprobante** como adjunto polimórfico (entidad `pago_orden`); estado de pago **derivado** (`pendiente/parcial/pagada`, no se guarda) — `lib/domain/rules.ts`, `lib/services/procurement-service.ts`.
- «Pagar saldo» sustituye a un «Marcar pagada» que inventaba un pago `otro`: ahora exige saldo 0 o responde `SALDO_PENDIENTE`.
- Beneficiario **persona o empresa**: `proveedores.tipo_identificacion/identificacion/pendiente_normalizacion`, `resolveOrCreateBeneficiary` para portal/WhatsApp — `lib/services/supplier-service.ts`.
- **Homónimos**: la razón social solo es única entre proveedores con NIT; dos personas con el mismo nombre y cédulas distintas conviven.
- **Centro de costo con tipo** (obra/administrativo/personal/empresa) y **empresa facturada** independiente del centro de costo (monto auditado antes/después en `tipo=pago`); **auto-aprobación** de usuario maestro en un solo paso (`sendAndApproveAsMaster`, dos eventos auditados) — `lib/services/procurement-service.ts`.
- **Obra opcional**: un centro administrativo/personal/empresa ya no exige obra (gasto ya no cuelga de una obra inventada).

### 2.2 Órdenes (S1)

- `components/screens/connected/orders.tsx`: diálogo de pago (fecha, valor, medio "Caja (efectivo)"/transferencia/tarjeta/otro, referencia, nota) con comprobante en un segundo paso opcional.
- Historial con pagos anulados tachados (motivo y quién anuló) y botón «Anular»; «Pagar saldo» encadena `adminStatus=pagada` cuando el pago deja el saldo en 0.
- `PaymentStatusBadge` en la lista y como tercer eje de la ficha (junto a Entrega/Contabilidad); segunda barra de filtros resuelta por el servidor: medio de pago, estado de pago, centro de costo, empresa facturada, rango de fecha de pago.

### 2.3 Captura y revisión (S2)

- `components/screens/connected/new-requisition.tsx`: en `tipo=pago`, "Fecha del gasto", soporte "Factura o cuenta de cobro (opcional)", beneficiario por identificación con alta rápida unificada (`components/screens/supplier-quick-create.tsx`, un solo diálogo para captura, revisión y directorio).
- `components/screens/connected/detail.tsx`: selector de empresa facturada, "Valor original" visible cuando Daniel edita el monto, botón «Aprobar yo mismo» para quien es revisor y aprobador.
- `components/screens/catalog-admin.tsx` y `components/screens/suppliers.tsx`: tipo en centros de costo; identificación (tipo+número) y marca "Pendiente de completar" en proveedores.

### 2.4 Portal público (S3)

- `app/api/public/requisitions/route.ts`: `publicRequisitionSchema` bifurca por `type` (compra/pago); la rama pago pide beneficiario (identificación+nombre), empresa, monto, concepto, foto opcional. Los errores de forma ahora responden **400 con motivo** (antes se perdían en un 202 neutro genérico).
- `components/screens/public-request.tsx`: camino propio de 3 pasos para "Solicitud de pago" (quién cobra → el pago → resumen), separado del de 5 pasos de compra.
- Corrección del bug crítico del acceso por empresa — ver parches, §2.8.

### 2.5 WhatsApp (S4)

- Tercer Flow, `integrations/whatsapp-flow/solicitud-pago.flow.json` (`scripts/build-flow-pago.ts`): 3 pantallas sin foto — beneficiario, empresa+monto+concepto, resumen.
- `lib/infrastructure/whatsapp-router.ts`: tercer botón del menú «Solicitar un pago»; `lib/infrastructure/flow-sender.ts`: `sendPaymentFlow` (env `WHATSAPP_FLOW_PAGO_ID`).
- `app/api/kapso/route.ts` + `lib/infrastructure/payment-reply-adapter.ts`: la respuesta del Flow de pago crea la solicitud con el beneficiario enlazado o pendiente de normalizar.
- El Flow de captura pasa a **v4** (se retira `tipo_solicitud=pago`, que se perdía en silencio en el v3); el v3 publicado sigue en producción hasta republicar.

### 2.6 Reportes y cierre de caja (S5)

- `components/screens/connected/expenses.tsx` pasa a ser **"Cierre de caja"**: rango de fechas, filtro por centro de costo, pagos vigentes con medio=caja, comprobantes, Excel. Se retiran "Registrar gasto directo", la pestaña Ingresos y el cierre mensual por caja.
- `GET /api/reports/cash-close`; `app/api/petty-cash`, `/incomes`, `/cash-closes` responden **410**.
- `components/screens/connected/reports.tsx`: bloque "Comprometido vs pagado" por centro de costo y por mes, filtros de medio/estado de pago/empresa facturada; Excel de gastos con empresa facturada, estado de pago y pagado.

### 2.7 MCP

- `app/mcp/server.ts`: se retira `registrar_caja_menor`; entran `registrar_pago`, `listar_centros_costo`, `crear_centro_costo`. Aprobar/devolver/declinar siguen fuera del catálogo MCP.

### 2.8 Parches del coordinador (sin `ESTADO.md` propio)

- `components/screens/connected/shared.tsx` gana los tipos de pago de orden (evita duplicarlos en `orders.tsx`) y `uploadOperationalAttachment` admite la entidad `pago_orden`; `.filter-bar{flex-wrap:wrap}` para que la segunda barra de filtros no se recorte — commit `f55dbae`.
- `GET /api/requisitions/[id]/detail` manda `viewerRoles`; `shared.tsx` gana `DetailBundle.viewerRoles`, `RequisitionRow.billedCompanyId`, `costCenters[].societyId` — para que «Aprobar yo mismo» aparezca a cualquier revisor+aprobador, no solo a Administrador Sixteam — commit `342413e`.
- **Bug crítico**: `create()` verificaba el acceso público solo por obra aunque la ruta ya lo hubiera autorizado por sociedad; toda radicación pública **por EMPRESA** moría en `PUBLIC_ACCESS_DENIED` desde el 11-sep. Corregido con `verifySociety` — commits `8775ca2`/`ba591ac`.
- ESLint 9 dejó de ignorar carpetas con punto y el lint de la raíz reventaba con 991 errores de código generado bajo `.claude/worktrees/**/.next`; ajustado en `eslint.config.mjs` — commit `8bc1dd5`.

---

## 3. Migraciones nuevas

- `202609150001_pagos_anulacion_comprobante.sql` — anulación con motivo/nota/comprobante en `pagos_orden`; el trigger anti-sobrepago ignora pagos anulados; entidad `pago_orden` en `adjuntos`.
- `202609150002_proveedores_identificacion.sql` — `tipo_identificacion`/`identificacion`/`pendiente_normalizacion` en `proveedores`, con backfill desde `nit` y espejo por trigger.
- `202609150003_centro_costo_tipo_empresa_facturada.sql` — `centros_costo.tipo` y `empresa_facturada_id` en `requisiciones` y `gastos`, con backfill desde la sociedad.
- `202609150004_obra_opcional_centros_no_obra.sql` — `gastos.obra_id` admite NULL cuando el centro de costo no es de tipo obra.
- `202609150005_proveedores_homonimos.sql` — el índice único de razón social pasa a exigir unicidad solo entre proveedores con NIT.
- `202609150006_telefono_externo_opcional.sql` — la restricción de `requisiciones` exige solo el nombre del solicitante externo: el portal perdía con un 503 toda solicitud sin teléfono, aunque el teléfono es opcional desde el 11-sep (QA H2).

---

## 4. Decisiones pendientes del usuario (Ernesto / Daniel / contador)

**Núcleo:**

- La identificación (cédula) de un proveedor se redacta en `auditoria`; si contabilidad necesita verla en la traza, hay que quitar esa regla. (núcleo N2)
- El dominio usa nombres en inglés (`identificationType`, `billedCompanyId`…) por convención con lo existente (`societyId`, `costCenterId`); las columnas SQL siguen en español. (núcleo N3)
- «Aprobar yo mismo» exige que el maestro figure como aprobador asignado (o sea `admin_sixteam`); si Daniel deja a Juliana como aprobadora, responde `NOT_ASSIGNED_APPROVER` en vez de saltársela. (núcleo N3)
- Un centro administrativo/personal/empresa ya no exige obra; la regla vive en un trigger solo para `gastos` (para `requisiciones` vive en el dominio, porque pasa por estados intermedios legítimos sin obra). (núcleo N4.1)
- El índice único de homónimos se recreó con `drop index` + `create unique index` (mismo nombre): sin precedente literal de `drop` en el repo, aunque sí de recrear triggers/policies/constraints por nombre; alternativa si no convence: dejar el índice viejo y no permitir homónimos. (núcleo N4.2)
- La migración de homónimos usa el índice `…0005`, que el plan no había reservado (reservaba hasta `…0004`). (núcleo N4.2)
- La empresa facturada puede ser cualquier sociedad ACTIVA, sin exigir que coincida con la de la obra/centro de costo; si contabilidad quiere acotarla, es una regla nueva. (núcleo N3)
- Anular el pago que cerraba una orden «pagada» la devuelve a «contabilizada» y borra la fecha de pago del gasto; es la única reversa del eje administrativo — el PRD (E2E #6) la supone. (núcleo N1)
- El comprobante no viaja en el mismo POST del pago (el adjunto exige que el pago ya exista): se sube después contra el id del pago. (núcleo N1)
- `updateOrderAdminStatus('pagada')` con saldo pendiente lanza `DomainError("SALDO_PENDIENTE")` (422), no un `{ok:false}` como decía el plan. (núcleo N1)
- Registrar el pago que cubre el saldo no cierra solo el eje administrativo (`adminStatus`); es S1 quien encadena `PATCH adminStatus=pagada`. (núcleo N1)

**Órdenes (S1):**

- El encadenado a «pagada» se dispara con cualquier pago que deje el saldo en 0 (no solo desde «Pagar saldo»), si quien paga tiene `order:pay` y la orden está contabilizada. (S1 Órdenes)
- «Anular» se ofrece también sobre órdenes ya «pagada» (el servidor las devuelve a «contabilizada»); el diálogo lo avisa. (S1 Órdenes)
- La tercera columna de estado se llama «Pago» (no «Estado de pago»), a juego con «Entrega»/«Contabilidad». (S1 Órdenes)
- `costCenterId` se filtra en el servidor aunque ya viaja en la fila y podría filtrarse en cliente. (S1 Órdenes)

**WhatsApp (S4):**

- El teléfono de quien pide el pago por WhatsApp se guarda como contacto del beneficiario nuevo; si Daniel prefiere que un tercero nazca sin teléfono, hay que quitarlo. (S4 WhatsApp)
- El monto del Flow de pago solo admite dígitos (sin puntos de miles); el adaptador del servidor sí los tolera por si otro emisor los manda. (S4 WhatsApp)
- El Flow de captura pasa a v4 al retirar el tipo pago (exige republicar en Meta y cambiar `WHATSAPP_FLOW_ID`); alternativa si no se quiere republicar ya: dejar el v3 (la opción «pago» ahora se rechaza limpio, sin reintentos). (S4 WhatsApp)
- El botón del menú sigue diciendo «Mis requisiciones» (17 caracteres es el tope de WhatsApp); «Mis solicitudes» también cabría. (S4 WhatsApp)

**Captura (S2):**

- El alta rápida de proveedor marca «Pendiente de completar» por defecto (desmarcable); si Daniel prefiere que sus altas internas nazcan «completas», es invertir el default. (S2 Captura)
- «Nuevo proveedor» en el directorio ya no abre el formulario completo (datos bancarios + documentos) sino el diálogo unificado y luego la ficha; reversible por git. (S2 Captura)
- «Valor original» en `tipo=pago` se muestra a nivel de total (base+IVA), no de precio unitario. (S2 Captura)
- La empresa facturada se muestra y edita en la revisión de AMBOS tipos (RF-009 aplica a toda requisición), aunque el servicio solo la exige en `tipo=pago`. (S2 Captura)

**Portal (S3):**

- La empresa se pide en el paso «El pago», no en el paso 1 (como en compra); alternativa: dejarla en el paso 1 para los dos tipos. (S3 Portal)
- El adjunto del pago es solo FOTO (JPG/PNG/WebP ≤5 MB), no PDF; si Sixteam sube facturas en PDF hay que ampliar `lib/infrastructure/public-photos.ts`. (S3 Portal)
- Tope del monto: 1e12; tope del concepto: 120 caracteres. (S3 Portal)
- Los errores de dominio (409 homónimo, 422 inactivo) ya se muestran tras la contraseña correcta: cambio de postura respecto al «todo 202 neutro» previo. (S3 Portal)
- Los estados HTTP separan forma (400) de dominio (409/422), no todo en 400 como decía el plan literalmente. (S3 Portal)

**Reportes y cierre de caja (S5):**

- Qué se retiró de «Gastos y caja» es reversible por git (tablas intactas): gasto directo sin requisición ni aprobación, pestaña Ingresos, cierre mensual con saldo inicial/final; vuelven en la fase 2 financiera. (S5 Reportes)
- El Aprobador no ve «Cierre de caja» aunque vea Reportes (no tiene `expense:read`); si Juliana debe verlo, hay que darle el permiso. (S5 Reportes)
- «Comprometido» excluye las órdenes `no_necesario`; agrupa por mes de GENERACIÓN de la orden, no por fecha de pago — si contabilidad quiere «pagado por mes de pago» es otra consulta. (S5 Reportes)
- El Excel de gastos (provisional Helisa) imprime la empresa facturada como id crudo, igual que ya hacía con obra/etiqueta/proveedor. (S5 Reportes)
- El cierre de caja no tiene estado cerrado/abierto ni bloqueo de edición (es una vista por rango); bloquear altas en un rango cerrado sería una regla nueva. (S5 Reportes)

---

## 5. Riesgos abiertos (mayor a menor impacto)

1. **Descarga de adjuntos en producción.** Respondía 500 para todos en el backend autoalojado desde el 10-sep (comprobantes, fotos del portal, documentos de proveedor); se corrigió armando el 302 con `Location` absoluta resuelta contra `request.url` (QA H1, `7c4afe7`), probado contra el storage local real pero **no detrás de Caddy en el VPS**. Tras el despliegue, descargar un comprobante y un documento de proveedor para confirmarlo. (QA / paquete A)
2. **Arreglos de UI sin recorrer en navegador contra backend real:** «Aprobar yo mismo» y las acciones del maestro asignado (H3) y la marca de beneficiario pendiente (H5) solo están cubiertos por pruebas unitarias. (QA / paquete B)
3. `paymentStatus` está duplicado en SQL (filtro de la consulta de órdenes) y en TypeScript (`paymentStatus()` de dominio): si cambia la regla en un lado y no en el otro, estado mostrado y filtrado divergen. (núcleo N1)
4. `Expense.workId` sigue tipado `string` y un gasto sin obra viaja como `""` (sentinel temporal) hasta que el coordinador ajuste `app/api/reports/expenses-report.ts` y `lib/reports/types.ts` para aceptar `workId` opcional. (núcleo N4, parche pendiente)
5. `gastos.empresa_facturada_id` es NULLABLE; si el módulo de gasto directo retirado se reactivara sin ajustar su trigger, volvería a nacer sin empresa facturada. (núcleo N2/N3)
6. La lista de órdenes filtrada por el servidor (S1) no se invalida por mutaciones hechas en otras pantallas (a diferencia de la caché de ruta); el desfase dura como mucho hasta la próxima visita a `/ordenes`. (S1 Órdenes)
7. La validación remota de Meta del Flow de pago no se ha corrido (sin credenciales en esta ejecución): falta confirmar `validation_errors: []` antes de publicar. (S4 WhatsApp)
8. Un rechazo del Flow de pago (monto inválido, número no autorizado) responde 200 a Kapso y no le dice nada a la persona; el formulario «se pierde» desde su punto de vista, igual que en captura; queda registrado en `whatsapp_eventos`. (S4 WhatsApp)
9. `razon_social` ahora es única solo entre NIT; el `lower()` de la base depende del locale de producción para nombres con tildes en mayúsculas — verificar el locale del Postgres del VPS antes de confiar en la deduplicación. (núcleo N4.2)
10. `nit` e `identificacion` conviven espejadas por trigger; el importador `scripts/import-master-data.ts` sigue escribiendo solo `nit` y funciona por ese espejo, pero solo para tipo NIT. (núcleo N2)
11. Hasta publicar el v4 de captura, `WHATSAPP_FLOW_ID` sigue apuntando al v3, cuyo JSON ya no coincide con `requisicion-captura.flow.json` del repo. (S4 WhatsApp)
12. `lookupSupplierByIdentification` descarga todo el directorio de proveedores en cada búsqueda (aceptable hoy, no con un catálogo grande). (S2 Captura)
13. `scripts/dev-db.ts` sobre un cluster local creado antes del 15-sep: el seed ya re-siembra identidades por correo, pero no migra ids en cascada a tablas con `on delete restrict`; con datos reales bajo ids viejos sigue haciendo falta `--reset`. Solo afecta el entorno local. (QA H8)
14. `AttachmentPicker` limita a 10 MB mientras `attachmentUploadSchema` admite 20 MB (discrepancia previa a esta ejecución, no se tocó). (S1 Órdenes)
15. `ExpenseBundle` (en `shared.tsx`) sigue declarando `pettyCash`/`pettyAttachments`/`incomes` sin uso; `lib/http/schemas.ts` sigue exportando `pettyCashSchema`/`incomeSchema`/`cashCloseSchema` sin uso. (S5 Reportes)
16. `tests/visual/routes.spec.ts` captura `/gastos` como "gastos-caja-menor": la línea base visual cambia con la pantalla nueva de Cierre de caja. (S5 Reportes)
17. Riesgos menores registrados por los agentes: la tabla de órdenes pasa de 12 a 13 columnas; el progreso del portal usa `style` inline porque el CSS de esa etapa no estaba en la lista exclusiva de S3; un revisor+aprobador que no figura en `catalogs.approvers` ve el error de servidor al usar «Aprobar yo mismo» (sin estado inconsistente); durante la verificación de S3 había ~200 procesos `node` colgados en la máquina, ajenos a esta adenda.

---

## 6. Pasos manuales pendientes

- **Publicar en Meta el Flow de pago**: `npx tsx --env-file=.env.local scripts/publish-whatsapp-flow.ts pago` → confirmar `validation_errors: []`, cargar `WHATSAPP_FLOW_PAGO_ID` en el entorno de producción y quitar `WHATSAPP_FLOW_PAGO_MODE=draft` al publicar (detalle en `integrations/whatsapp-flow/README.md` y en la sección S4 del `ESTADO.md` integrado).
- **Publicar el v4 del Flow de captura**: mismo procedimiento sin el argumento `pago`; al publicar, actualizar `WHATSAPP_FLOW_ID` al nuevo id. Mientras tanto el v3 sigue en producción y su opción «pago» responde un rechazo neutro, no un 503.
- `git push` de `main` — nada de esta ejecución llegó todavía a GitHub ni al VPS.
- Tras desplegar: descargar un comprobante de pago y un documento de proveedor en producción (riesgo 1), y recorrer en la web «Aprobar yo mismo» con Daniel y la marca de beneficiario pendiente (riesgo 2). Los recorridos #2, #6 y #7 ya pasaron en el QA; el #5 pasaba solo por API y su arreglo de UI está integrado.
- Decidir con el contador qué sociedad encabeza la OP cuando la empresa facturada difiere de la sociedad de la requisición (QA H10, ligado a P8).
- Revisar la lista de proveedores de materiales que Daniel envió por WhatsApp el 15-sep (D12).
- Recibir de Daniel la lista expandida de centros de costo (obras + administrativo + personales + PROIM).

---

## 7. Cómo verificar

**General (antes de cualquier despliegue):**

```
npm run lint && npm run typecheck && npm run test && npm run verify:schema
npm run test:e2e
```

**Por área:**

- Núcleo: `npm run test -- tests/unit/domain.test.ts tests/unit/procurement-service.test.ts tests/unit/postgres-repositories.test.ts supplier tests/unit/catalog-service.test.ts`
- Órdenes (S1): `npm run test -- tests/unit/orders tests/unit/connected-orders` (32 pruebas: `connected-orders-admin`, `connected-orders-cost-center`, `connected-orders-lente`, `connected-orders-pagos`)
- Captura y revisión (S2): `npm run test -- connected-new-requisition connected-detail catalog-admin suppliers supplier-quick-create connected-review`
- Portal público (S3): `npm run test -- tests/unit/public tests/integration/public` (106 pruebas) · `npm run test:e2e -- public-portal`
- WhatsApp (S4): `npm run test -- tests/integration/kapso tests/unit/whatsapp-router` · `npx tsx scripts/build-flow-pago.ts --check` · `npx tsx scripts/build-flow-captura.ts --check`
- Reportes y cierre de caja (S5): `npm run test -- connected-expenses-detail tests/unit/reports connected-reports report-service mcp-route cash-routes-retired`

---

## 8. Pendientes de agosto que siguen abiertos (vigente desde 26-ago-2026)

La migración a Postgres autoalojado (10-sep-2026, [`docs/migracion-autoalojado.md`](migracion-autoalojado.md)) y la receta real de despliegue en el VPS ([`docs/despliegue.md`](despliegue.md)) avanzaron bastante desde el 26-ago: Supabase ya no interviene, por lo que los pendientes de esa fecha sobre RLS/rol `authenticated` y región de Supabase quedaron obsoletos y se retiran de esta lista. Antes de dar por ciertos los pendientes de despliegue de agosto, esos dos documentos son la fuente viva. Lo que sigue plausiblemente abierto y no depende de esa migración:

- Cargar datos reales de Mizar (obras, catálogo de ítems, proveedores, usuarios) más allá de los de prueba — bloquea el UAT.
- Cargar la lista blanca de teléfonos autorizados (`obra_solicitantes_autorizados`, hoy vacía): sin esto el WhatsApp Flow de captura rechaza toda solicitud.
- Confirmar el plan de Kapso y quién asume las tarifas de conversación de Meta.
- Prueba de paridad contable: replicar un mes real de GASTOS EN OBRAS.xlsx y cuadrar al 100% (ahora cruza también con P8/P11 de la adenda de pagos).
- Modo pantalla (kiosco): construido a nivel de servicio y ruta; falta un uso real si se quiere el dashboard en un TV.
- PDF por ítem: el Flow de captura permite foto o link por artículo, no un PDF específico (límite de Meta).
- P5 — Propiedad de la plataforma: alinear "propiedad de Sixteam por suscripción" vs "después del año es de ustedes" antes de firmar.
- P1 impuestos · P3 gastos compartidos · P6 costos WhatsApp · P7 alcance contratado (ver `docs/decisiones-provisionales.md`).
- Rotar credenciales compartidas por chat (Kapso, EasyPanel, secretos internos).
