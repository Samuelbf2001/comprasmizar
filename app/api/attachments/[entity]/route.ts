import { z } from "zod";
import { DomainError } from "../../../../lib/domain";
import { authenticatedJson, parsePathParams } from "../../../../lib/http/api";
import { createPrivateAttachmentServiceDependencies } from "../../../../lib/infrastructure/attachment-repositories";
import { PrivateAttachmentService } from "../../../../lib/services";

export const runtime = "nodejs";
const entityParamsSchema = z.object({ entity: z.enum(["requisicion", "requisicion_item", "caja_menor"]) }).strict();
const idsQuerySchema = z.array(z.string().uuid()).min(1).max(100);

/**
 * H2 (docs/plan-rendimiento.md): consulta de adjuntos por lote (`?ids=a,b,c`, 1–100 uuids) — elimina
 * el N+1 de pedir `/api/attachments/:entity/:entityId` una vez por cada fila (caja menor hoy; ítems de
 * requisición ya los cubre `/api/requisitions/:id/detail`). Convive con la ruta existente
 * `/api/attachments/:entity/:entityId` (segmentos distintos, ver docs de Route Handlers).
 */
export function GET(request: Request, { params }: { params: Promise<{ entity: string }> }) {
  return authenticatedJson(async (actor) => {
    const { entity } = await parsePathParams(params, entityParamsSchema);
    const raw = new URL(request.url).searchParams.get("ids") ?? "";
    const ids = raw.split(",").map((id) => id.trim()).filter(Boolean);
    const parsedIds = idsQuerySchema.safeParse(ids);
    if (!parsedIds.success) throw new DomainError("INVALID_INPUT", "ids debe traer entre 1 y 100 uuids separados por coma");
    return new PrivateAttachmentService(createPrivateAttachmentServiceDependencies()).listMany(entity, parsedIds.data, actor);
  });
}
