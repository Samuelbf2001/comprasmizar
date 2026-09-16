# ESTADO — feat/pagos-nucleo
Rama y base: feat/pagos-nucleo desde origin/main @ f9a7e00
Último commit: N1 (este commit) — «Pagos de orden: anulación con motivo, comprobante como adjunto y estado de pago derivado; "pagada" exige saldo cero en vez de inventar un pago»
Hecho:
- N1 (docs/TASKS-pagos-y-caja.md §3): migración `202609150001_pagos_anulacion_comprobante.sql` + `supabase/tests/pagos_anulacion_verification.sql` (registrado en `scripts/verify-schema.ts`): `pagos_orden.nota/anulado/motivo_anulacion/anulado_por/anulado_en`, trigger anti-sobrepago ignora anulados (y se dispara al reactivar), `pagos_orden` entra a `escribir_auditoria`, policy de UPDATE para anular, entidad `pago_orden` en `adjuntos` (check de entidad, path `pagos-orden/…`, metadata, existencia del padre, RLS de lectura y policy de Storage).
- Dominio: `PaymentStatus`, `paymentStatus(total, paid)`, `sumPaid(payments)` (ignora anulados), `assertCanAnnulPayment(payment, reason)`; `OrderPayment` gana `note/annulled/annulmentReason/annulledBy/annulledAt/attachmentId`; `Order` gana `paymentStatus/lastPaymentAt/paymentMethods`; `CashPayment`; `AttachmentEntity` + `pago_orden`.
- Servicio: `registerOrderPayment` acepta `note` y mide el saldo solo con pagos vigentes; `annulOrderPayment(orderId, paymentId, reason, ctx)`; `listCashPayments({from,to,costCenterId?}, ctx)`; `updateOrderAdminStatus(…, "pagada")` ya NO inventa el pago `otro`: exige saldo 0 (`SALDO_PENDIENTE`) y fija la fecha del último pago vigente en el gasto.
- Repositorio Postgres: lateral de pagos solo vigentes + `ultimo_pago`/`medios`/`gasto_total`; filtros de órdenes `costCenterId`, `paymentMethod`, `paymentStatus`, `paidFrom/paidTo` (`ListQuery`, `parseListQuery`, `hasListFilters`); `getOrderPayment`/`annulOrderPayment`/`listCashPayments`; `markExpensePaid(ref, null)` deshace la fecha de pago.
- Rutas: `POST /api/orders/[id]/payments` acepta `note`; nueva `PATCH /api/orders/[id]/payments/[paymentId]` con `{ action: "annul", reason }`; `/api/attachments/pago_orden/...` (prepare/complete/download/batch) para el comprobante.
- `components/screens/connected/payment-labels.tsx`: `MEDIO_PAGO_LABELS` (efectivo → "Caja (efectivo)"), `MEDIO_PAGO_OPTIONS`, `medioPagoLabel`, `PAYMENT_STATUS_LABELS`, `paymentStatusLabel`, `PaymentStatusBadge`.
A medias:
- Nada en N1.
Próximos pasos:
- N2: beneficiario persona o empresa (migración `202609150002_proveedores_identificacion.sql`, `SupplierWrite`, `findByIdentification`, `resolveOrCreateBeneficiary`, `create()` con `beneficiario`, PDF con tipo + identificación).
- N3: `centros_costo.tipo`, `requisiciones/gastos.empresa_facturada_id`, `resolveBilledCompany`, `montoAntes/montoDespues` en `revisada`, `sendAndApproveAsMaster`, acción `send_and_approve`.
Cómo verificar:
- `npm run verify:schema`
- `npm run typecheck`
- `npm run test -- tests/unit/domain.test.ts tests/unit/procurement-service.test.ts tests/integration/order-payments-route.test.ts`
- (también tocados) `npm run test -- tests/unit/postgres-repositories.test.ts tests/unit/attachment-service.test.ts tests/unit/http-api.test.ts tests/integration/routes.test.ts`
Decisiones pendientes del usuario:
- Anular el pago que cerraba una orden ya marcada "pagada" (eje administrativo) la DEVUELVE a "contabilizada" y borra la fecha de pago del gasto (`annulOrderPayment`). Es la única reversa de `assertAdminTransition`; el plan no la fija y el PRD (E2E #6, "vuelve a parcial") la supone. Alternativa: prohibir anular sobre una orden ya "pagada".
- El comprobante NO viaja como `attachmentId` en el POST del pago (el plan lo listaba): un adjunto exige que su padre exista, así que se sube DESPUÉS contra el id del pago (`/api/attachments/pago_orden/<paymentId>`), y `OrderPayment.attachmentId` es de lectura (el adjunto más reciente).
- `updateOrderAdminStatus('pagada')` con saldo lanza `DomainError("SALDO_PENDIENTE")` (422) en vez de devolver `{ok:false, reason:'saldo_pendiente'}`: es el idioma del resto del servicio y de `apiError`.
- Registrar el pago que cubre el saldo NO cierra solo el eje administrativo (`adminStatus` sigue en pendiente/contabilizada); S1 debe encadenar `PATCH adminStatus=pagada` tras "Pagar saldo" si quiere ese atajo. `paymentStatus` (derivado) sí pasa a "pagada" de inmediato.
Riesgos:
- Hasta que S1 sustituya "Marcar pagada" por "Pagar saldo", el botón actual de `orders.tsx` fallará con 422 `SALDO_PENDIENTE` en cualquier orden con saldo (comportamiento buscado por A3, pero visible en `main` si se integra la ola 1 sola).
- `lib/http/api.ts`, `app/api/attachments/**` y `tests/unit/{postgres-repositories,attachment-service,http-api,security}.test.ts` + tres `tests/integration/*` se tocaron fuera de la lista de N1 (fakes de `OrderPaymentRepository`, enums de entidad, parseo de los filtros nuevos): sin ellos los filtros y el comprobante no llegan a la ruta HTTP.
- `paymentStatus` en SQL (filtro) y en TS (`paymentStatus()`) son dos copias de la misma regla; si cambia una, cambia la otra (comentado en ambos sitios).
