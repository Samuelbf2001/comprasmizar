import { z } from "zod";
import { authenticatedJson, parsePathParams } from "../../../../../lib/http/api";
import { createPostgresDependencies } from "../../../../../lib/infrastructure/postgres-repositories";
import { createPrivateAttachmentServiceDependencies } from "../../../../../lib/infrastructure/attachment-repositories";
import { PrivateAttachmentService, ProcurementService, type CatalogSupplier } from "../../../../../lib/services";

export const runtime = "nodejs";
const paramsSchema = z.object({ id: z.string().uuid() }).strict();

/**
 * H2 (docs/plan-rendimiento.md): endpoint compuesto del detalle — combina en UNA respuesta lo que
 * antes eran 4+ llamadas del cliente (`/api/requisitions/:id`, `/api/orders`, `/api/expenses`,
 * `/api/requisitions/:id/history`, más una por ítem para adjuntos). El contrato de esos endpoints
 * existentes NO cambia (compatibilidad hacia atrás); este es aditivo — el cliente todavía no lo
 * consume (queda para la fase de bundle/cliente, ver docs/plan-rendimiento.md Fase 2/3).
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  return authenticatedJson(async (actor) => {
    const { id } = await parsePathParams(context.params, paramsSchema);
    const requestContext = { actor };
    const dependencies = createPostgresDependencies();
    const [detail, attachments] = await Promise.all([
      new ProcurementService(dependencies).getRequisitionDetail(id, requestContext),
      new PrivateAttachmentService(createPrivateAttachmentServiceDependencies()).listForRequisition(id, actor),
    ]);
    // QA H5: después de autorizar la lectura, se marca el beneficiario de un pago que sigue pendiente de
    // normalizar, para que el revisor lo complete antes de aprobar. Solo viaja el booleano.
    const beneficiaryIds = detail.requisition.type === "pago"
      ? [...new Set(detail.requisition.items.map((line) => line.finalSupplierId).filter((supplierId): supplierId is string => Boolean(supplierId)))]
      : [];
    const beneficiaries = await Promise.all(beneficiaryIds.map((supplierId) => dependencies.catalogs.get("suppliers", supplierId)));
    const requisition = beneficiaries.some((supplier) => (supplier as CatalogSupplier | null)?.pendingNormalization === true)
      ? { ...detail.requisition, beneficiaryPendingNormalization: true }
      : detail.requisition;
    return { ...detail, requisition, attachments: attachments.attachments, viewerId: actor.id, viewerRoles: actor.roles };
  });
}
