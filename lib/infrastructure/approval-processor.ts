import type { ItemLine, Requisition, Role } from "../domain";
import type { ApprovalDecision } from "./approval-reply-adapter";

/**
 * Convierte la decisión que llegó por WhatsApp en las llamadas que ya existen en el dominio
 * (`decideItems` + `approve`, o `returnForCorrection`). Mismo papel que `kapso-processor.ts` para el
 * Flow de captura: el adaptador traduce, esto orquesta, y el dominio sigue siendo el único que
 * decide si la transición es legal.
 *
 * El planificador (`planApprovalDecision`) es puro a propósito: toda la lógica de "qué se declina,
 * qué motivo lleva, cuándo no se aplica nada" se puede probar sin BD ni servicio.
 */

/** Motivo por defecto de un ítem desmarcado cuando el aprobador no escribió ninguno. El dominio
 * EXIGE motivo para declinar (`decideItems`, y el check `requisicion_items_motivo_declinacion_check`
 * en la BD), y forzar a escribirlo en el Flow encarecería el camino frecuente. El texto dice la
 * verdad —quién y por dónde— en vez de inventar una justificación de negocio. */
export const DEFAULT_DECLINE_REASON = "Desmarcado por el aprobador en WhatsApp, sin motivo escrito";

export type ApprovalPlan =
  | { kind: "return"; comment: string }
  | { kind: "approve"; decisions: Array<{ itemId: string; status: "aprobado" | "declinado"; declineReason?: string }>; declined: number }
  | { kind: "skip"; reason: "not_in_approval" }
  | { kind: "reject"; reason: "missing_reason" | "no_approved_items" };

/**
 * Reglas, todas visibles en un vistazo:
 *  - Una requisición que ya no está `en_aprobacion` no se toca. Cubre el reintento del webhook y a
 *    la persona que responde el Flow dos veces o tarde: es un "ignorado", no un error.
 *  - Devolver exige comentario, porque `assertTransition` lo exige para `devuelta` y porque una
 *    devolución sin motivo obliga al revisor a adivinar.
 *  - Aprobar decide TODAS las líneas vigentes, no solo las desmarcadas: así queda registro explícito
 *    por ítem (`items_decididos`) igual que cuando se aprueba desde la web. Las líneas que el revisor
 *    ya había declinado no se reabren — el Flow ni siquiera se las mostró.
 *  - Desmarcarlas todas NO es una forma de declinar la requisición: el dominio no tiene esa
 *    transición desde `en_aprobacion` (solo `aprobada` o `devuelta`). Se rechaza pidiendo que use
 *    "Devolver", en vez de dejar que `assertHasApprovedLine` reviente más adentro.
 */
export function planApprovalDecision(requisition: Pick<Requisition, "status" | "items">, decision: Pick<ApprovalDecision, "action" | "approvedItemIds" | "reason">): ApprovalPlan {
  if (requisition.status !== "en_aprobacion") return { kind: "skip", reason: "not_in_approval" };

  if (decision.action === "devolver") {
    const comment = decision.reason?.trim() ?? "";
    return comment === "" ? { kind: "reject", reason: "missing_reason" } : { kind: "return", comment };
  }

  const vigentes: ItemLine[] = requisition.items.filter((line) => line.status !== "declinado");
  if (vigentes.length === 0) return { kind: "reject", reason: "no_approved_items" };

  const approved = new Set(decision.approvedItemIds);
  const declineReason = decision.reason?.trim() || DEFAULT_DECLINE_REASON;
  const decisions = vigentes.map((line) => (approved.has(line.id)
    ? { itemId: line.id, status: "aprobado" as const }
    : { itemId: line.id, status: "declinado" as const, declineReason }));
  const declined = decisions.filter((entry) => entry.status === "declinado").length;
  if (declined === decisions.length) return { kind: "reject", reason: "no_approved_items" };
  return { kind: "approve", decisions, declined };
}

/** Puerto mínimo sobre `ProcurementService`: solo lo que este flujo necesita, para que la prueba no
 * tenga que construir el servicio entero con sus repositorios. */
export interface ApprovalCommands {
  decideItems(id: string, decisions: readonly { itemId: string; status: "aprobado" | "declinado"; declineReason?: string }[], context: { actor: { id: string; roles: readonly Role[] }; origin: "kapso" }): Promise<unknown>;
  approve(id: string, context: { actor: { id: string; roles: readonly Role[] }; origin: "kapso" }): Promise<unknown>;
  returnForCorrection(id: string, comment: string, context: { actor: { id: string; roles: readonly Role[] }; origin: "kapso" }): Promise<unknown>;
}

export type ApprovalOutcome =
  | { status: "applied"; action: "aprobada" | "devuelta"; declined: number }
  | { status: "ignored"; reason: "not_in_approval" }
  | { status: "rejected"; reason: "missing_reason" | "no_approved_items" };

/**
 * Ejecuta el plan. `origin: "kapso"` es deliberado y correcto: identifica el canal en la auditoría
 * (`auditoria.origen`) y NO es `"mcp"`, así que no toca la denegación permanente de RF-1205 — ver
 * la justificación completa en la cabecera de approval-reply-adapter.ts. El actor es el usuario real
 * resuelto desde el teléfono; `decideItems`/`approve`/`returnForCorrection` vuelven a comprobar por
 * su cuenta que sea el aprobador asignado.
 */
export async function applyApprovalDecision(commands: ApprovalCommands, requisition: Pick<Requisition, "status" | "items">, decision: ApprovalDecision): Promise<ApprovalOutcome> {
  const plan = planApprovalDecision(requisition, decision);
  const context = { actor: { id: decision.approver.id, roles: decision.approver.roles }, origin: "kapso" as const };

  if (plan.kind === "skip") return { status: "ignored", reason: plan.reason };
  if (plan.kind === "reject") return { status: "rejected", reason: plan.reason };
  if (plan.kind === "return") {
    await commands.returnForCorrection(decision.requisitionId, plan.comment, context);
    return { status: "applied", action: "devuelta", declined: 0 };
  }
  await commands.decideItems(decision.requisitionId, plan.decisions, context);
  await commands.approve(decision.requisitionId, context);
  return { status: "applied", action: "aprobada", declined: plan.declined };
}
