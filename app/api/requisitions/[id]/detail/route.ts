import { z } from "zod";
import { authenticatedJson, parsePathParams } from "../../../../../lib/http/api";
import { createPostgresDependencies } from "../../../../../lib/infrastructure/postgres-repositories";
import { createPrivateAttachmentServiceDependencies } from "../../../../../lib/infrastructure/attachment-repositories";
import { PrivateAttachmentService, ProcurementService } from "../../../../../lib/services";

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
    const [detail, attachments] = await Promise.all([
      new ProcurementService(createPostgresDependencies()).getRequisitionDetail(id, requestContext),
      new PrivateAttachmentService(createPrivateAttachmentServiceDependencies()).listForRequisition(id, actor),
    ]);
    return { ...detail, attachments: attachments.attachments, viewerId: actor.id, viewerRoles: actor.roles };
  });
}
