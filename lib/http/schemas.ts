import { z } from "zod";

const httpsUrl = z.string().url().max(2_048).refine((value) => new URL(value).protocol === "https:", "HTTPS URL required");
const itemIdentity = {
  itemId: z.string().uuid().optional(),
  description: z.string().trim().min(1).max(500).optional(),
  quantity: z.number().finite().positive().max(1_000_000),
  unit: z.string().trim().min(1).max(40),
  possibleSupplier: z.string().trim().min(1).max(240).optional(),
  productLink: httpsUrl.optional(),
};
/** Fracción 0..1 (0.19, no 19): la UI captura "19 %" y divide antes de mandarla. */
const rateFraction = z.number().min(0).max(1);

// Reunión 2026-08-31: el solicitante elige EMPRESA, no obra (la asigna el revisor en la revisión);
// workId y requiredDate quedan opcionales en los tres canales. `destination` sale del formulario: se
// fusiona en observations.
// Solicitud de pago (feat/solicitud-de-pago): a diferencia de una compra, un pago no tiene un paso
// de revisión previo que complete beneficiario y valor cotizado — se capturan desde esta misma
// petición. `finalSupplierId`/`unitBase`/`ivaRate` quedan opcionales para no tocar el contrato de
// "compra" (que los sigue dejando en 0/ausente y los completa en review()); ProcurementService.create
// exige los tres cuando `type === "pago"` (assertPaymentRequestShape, lib/domain/rules.ts).
const createItemSchema = z.object({
  ...itemIdentity,
  finalSupplierId: z.string().uuid().optional(),
  unitBase: z.number().int().nonnegative().optional(),
  ivaRate: rateFraction.optional(),
}).strict().refine((item) => Boolean(item.itemId || item.description), "itemId or description is required");

export const createRequisitionSchema = z.object({
  type: z.enum(["compra", "pago"]),
  societyId: z.string().uuid(),
  workId: z.string().uuid().optional(),
  requesterId: z.string().uuid().optional(),
  requiredDate: z.string().date().optional(),
  observations: z.string().trim().min(1).max(3_000).optional(),
  items: z.array(createItemSchema).min(1).max(100),
}).strict();

// "unitIva" pasa a derivado: el servidor lo calcula desde ivaRate/unitBase, ya no lo captura el cliente.
export const reviewedItemSchema = z.object({
  id: z.string().uuid(),
  ...itemIdentity,
  finalSupplierId: z.string().uuid().optional(),
  // Aprobador POR ÍTEM (11-sep-2026): la ficha de revisión lo manda por línea cuando se reparte la
  // aprobación. Sin esta clave, `.strict()` rechazaba TODA la revisión en cuanto la pantalla asignaba
  // un aprobador a un ítem — la función entera caía en la frontera HTTP sin que ningún test la cruzara
  // (los de servicio pasan ItemLine directo; los de componente leen el body, no lo validan aquí).
  // Solo uuid: la pantalla omite la clave cuando está vacía (el ítem hereda el aprobador de cabecera),
  // y el servicio valida que sea un aprobador elegible con el mismo isEligibleApprover del de cabecera.
  approverId: z.string().uuid().optional(),
  unitBase: z.number().int().nonnegative(),
  status: z.enum(["pendiente", "aprobado", "declinado"]).optional(),
  declineReason: z.string().trim().min(1).max(2_000).optional(),
  ivaRate: rateFraction.optional(),
  discountRate: rateFraction.optional(),
}).strict()
  .refine((item) => Boolean(item.itemId || item.description), "itemId or description is required")
  // MENOR (QA Postgres real): sin este refine, un "declinado" sin motivo pasaba la validación HTTP y
  // moría en la BD con un 500 crudo (requisicion_items_motivo_declinacion_check, 23514) en vez de un
  // 422 legible — la misma regla que itemDecisionSchema (decisión del aprobador) ya exige aquí, en la
  // ficha de revisión.
  .refine((item) => item.status !== "declinado" || Boolean(item.declineReason?.trim()), { message: "declineReason is required when status is declinado", path: ["declineReason"] });

export const itemDecisionSchema = z.object({
  itemId: z.string().uuid(),
  status: z.enum(["pendiente", "aprobado", "declinado"]),
  declineReason: z.string().trim().min(1).max(2_000).optional(),
  quantity: z.number().finite().positive().max(1_000_000).optional(),
}).strict();

export const requisitionActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start_review") }).strict(),
  // review gana workId (obra la asigna el revisor), paymentTerms (forma de pago, capturada aquí) y
  // approverId (reunión 2026-09: el revisor lo elige, ya no lo deriva la etiqueta). Opcional aquí — un
  // borrador puede guardarse sin aprobador todavía — pero sendForApproval() lo exige antes de avanzar.
  // M-6 (QA reasignación): approverId admite explícitamente `null` (además de ausente/string) para que el
  // revisor pueda DESASIGNAR el aprobador ya elegido, no solo cambiarlo — ver ReviewInput en
  // procurement-service.ts. Un `""` del cliente también debe poder desasignar: se acepta con el mismo
  // significado que `null` en vez de rechazarlo con un error de formato UUID.
  z.object({ action: z.literal("review"), tagId: z.string().uuid(), approverId: z.union([z.string().uuid(), z.literal(""), z.null()]).optional(), workId: z.string().uuid().optional(), paymentTerms: z.string().trim().min(1).max(240).optional(), items: z.array(reviewedItemSchema).min(1).max(100) }).strict(),
  z.object({ action: z.literal("send_for_approval") }).strict(),
  // "approve" pierde multiSupplier: aprobar ya no genera órdenes (eso es generate_orders, un paso propio).
  z.object({ action: z.literal("approve") }).strict(),
  z.object({ action: z.literal("return"), comment: z.string().trim().min(1).max(2_000) }).strict(),
  z.object({ action: z.literal("decline"), reason: z.string().trim().min(1).max(2_000) }).strict(),
  z.object({ action: z.literal("propose_item"), description: z.string().trim().min(1).max(500) }).strict(),
  // Decisión por ítem del aprobador (no cambia el estado de la requisición) y generación explícita de órdenes.
  z.object({ action: z.literal("decide_items"), decisions: z.array(itemDecisionSchema).min(1).max(100) }).strict(),
  // Bloqueante de atasco (reunión 2026-08-31): asigna finalSupplierId a ítems aprobados que quedaron sin
  // proveedor. Shape acotado a {itemId, supplierId} a propósito — ver SupplierAssignment en procurement-service.ts.
  z.object({ action: z.literal("assign_suppliers"), assignments: z.array(z.object({ itemId: z.string().uuid(), supplierId: z.string().uuid() }).strict()).min(1).max(100) }).strict(),
  z.object({ action: z.literal("generate_orders") }).strict(),
  // BLOQUEANTE (QA reasignación, reunión 2026-09): reasigna el aprobador de una requisición, incluida
  // en_aprobacion — ver ProcurementService.reassignApprover. A diferencia de "review", approverId es
  // obligatorio y no vacío: reasignar SIN indicar a quién no tiene sentido (para desasignar, ver "review").
  z.object({ action: z.literal("reassign_approver"), approverId: z.string().uuid() }).strict(),
]);

// Extiende la ruta existente app/api/orders/[id]/status/route.ts (ya auditada y probada) con el eje
// administrativo, en vez de crear una ruta hermana: "status" sigue siendo cumplimiento, "adminStatus" es
// el nuevo eje contable (pendiente → contabilizada → pagada), mutuamente excluyentes en un mismo PATCH.
export const orderStatusSchema = z.union([
  z.object({ status: z.enum(["cumplida", "no_cumplida", "no_necesario"]) }).strict(),
  z.object({ adminStatus: z.enum(["contabilizada", "pagada"]) }).strict(),
]);
export const expenseSharesSchema = z.object({ total: z.number().int().positive(), shares: z.array(z.object({ workId: z.string().uuid(), amount: z.number().int().positive() }).strict()).min(1).max(100) }).strict();
// Reunión agosto 2026: registro de un pago parcial de orden (POST /api/orders/[id]/payments).
// `amount` entero (mismo criterio que expenseSharesSchema/pettyCashSchema arriba: el dominio entero
// asume peso colombiano entero, ver lib/domain/model.ts). `method` son EXACTAMENTE los valores de
// `public.medio_pago` (202609120002_pagos_orden.sql) — lista aparte a propósito, mismo criterio que
// ORDER_STATUS_VALUES más abajo: zod no puede derivar un enum desde un `type` de TypeScript.
export const orderPaymentSchema = z.object({
  date: z.string().date(),
  amount: z.number().int().positive(),
  method: z.enum(["efectivo", "transferencia", "cheque", "tarjeta", "otro"]),
  externalReference: z.string().trim().min(1).max(240).optional(),
}).strict();
export const pettyCashSchema = z.object({ workId: z.string().uuid(), date: z.string().date(), concept: z.string().trim().min(1).max(500), tagId: z.string().uuid(), amount: z.number().int().positive() }).strict();

// Edición de cabecera de requisición (ficha editable). Solo campos que no alteran la identidad ni
// el gasto: fecha requerida y observaciones (`destination` sale: quedó obsoleto). Al menos un campo debe venir.
export const requisitionHeaderSchema = z.object({
  requiredDate: z.string().date().optional(),
  observations: z.string().trim().max(1024).nullable().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "Debe cambiar al menos un campo");

// H3 (docs/plan-rendimiento.md, Fase 3): valores válidos de `status` por entidad, para
// `parseListQuery` (lib/http/api.ts) — `RequisitionStatus`/`OrderStatus` en lib/domain/model.ts son la
// fuente de verdad; estas listas se repiten aquí a propósito (zod no puede derivar un enum desde un
// `type` de TypeScript en tiempo de ejecución) y deben mantenerse en sincronía si el dominio cambia.
// Gastos y caja menor no tienen columna de estado: sus rutas no ofrecen `status` en absoluto.
export const REQUISITION_STATUS_VALUES = ["enviada", "en_revision", "en_aprobacion", "aprobada", "devuelta", "declinada"] as const;
export const ORDER_STATUS_VALUES = ["generada", "cumplida", "no_cumplida", "no_necesario"] as const;
