import { Buffer } from "node:buffer";
import { DomainError } from "../../../../../lib/domain";
import { apiError } from "../../../../../lib/http/api";
import { requireServerActor } from "../../../../../lib/infrastructure/auth";
import { createPostgresDependencies } from "../../../../../lib/infrastructure/postgres-repositories";
import { buildOrderPdf } from "../../../../../lib/reports";
import { ProcurementService } from "../../../../../lib/services";

export const runtime = "nodejs";

/** Server-rendered, provisional OC/OP. Visibility is checked through the order list first. */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const actor = await requireServerActor(), { id } = await context.params;
    const dependencies = createPostgresDependencies(), service = new ProcurementService(dependencies);
    const order = (await service.listOrders({ actor })).find((candidate) => candidate.id === id);
    if (!order) throw new DomainError("NOT_FOUND", "Orden no encontrada");
    const requisition = await service.getRequisition(order.requisitionId, { actor });
    const lines = requisition.items.filter((line) => order.itemIds.includes(line.id));
    const bytes = await buildOrderPdf({
      consecutive: order.consecutive, type: order.type, work: requisition.workId,
      supplier: order.supplierId ? "Proveedor asignado" : undefined,
      date: requisition.requiredDate,
      items: lines.map((line) => ({ description: line.description ?? line.itemId ?? "Ítem", quantity: line.quantity, unit: line.unit, total: service.lineTotal(line) })),
      total: lines.reduce((total, line) => total + service.lineTotal(line), 0),
    });
    await dependencies.audit.append({ entity: "orden", entityId: order.id, event: "documento_provisional_descargado", actorId: actor.id, at: new Date(), origin: "web", data: { format: "pdf", provisional: true } });
    return new Response(Buffer.from(bytes), { headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename=${order.consecutive}-provisional.pdf`, "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error); }
}
