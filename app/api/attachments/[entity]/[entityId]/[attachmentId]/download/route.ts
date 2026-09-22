import { z } from "zod";
import { apiError, parsePathParams } from "../../../../../../../lib/http/api";
import { requireServerActor } from "../../../../../../../lib/infrastructure/auth";
import { createPrivateAttachmentServiceDependencies } from "../../../../../../../lib/infrastructure/attachment-repositories";
import { PrivateAttachmentService } from "../../../../../../../lib/services";
import { attachmentParamsSchema } from "../../route";

export const runtime = "nodejs";
const downloadParamsSchema = attachmentParamsSchema.extend({ attachmentId: z.string().uuid() }).strict();
export async function GET(_request: Request, { params }: { params: Promise<{ entity: string; entityId: string; attachmentId: string }> }) {
  // La respuesta se arma a mano (`Response.redirect()` exige URL absoluta y deja los headers inmutables)
  // y el Location va TAL CUAL lo da el almacenamiento: relativo al propio origen. NO se resuelve contra
  // `request.url`: detrás de Traefik esa URL es la interna del contenedor (https://0.0.0.0:3000/…) y el
  // navegador acababa en una dirección inalcanzable (verificado en producción el 21-sep-2026). Un
  // Location relativo lo resuelve el navegador contra la URL pública que él mismo pidió.
  try { const { entity, entityId, attachmentId } = await parsePathParams(params, downloadParamsSchema), url = await new PrivateAttachmentService(createPrivateAttachmentServiceDependencies()).download(entity, entityId, attachmentId, await requireServerActor()); return new Response(null, { status: 302, headers: { Location: url, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } }); }
  catch (error) { return apiError(error); }
}
