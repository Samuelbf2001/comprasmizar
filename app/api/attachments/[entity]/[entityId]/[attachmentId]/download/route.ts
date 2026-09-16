import { z } from "zod";
import { apiError, parsePathParams } from "../../../../../../../lib/http/api";
import { requireServerActor } from "../../../../../../../lib/infrastructure/auth";
import { createPrivateAttachmentServiceDependencies } from "../../../../../../../lib/infrastructure/attachment-repositories";
import { PrivateAttachmentService } from "../../../../../../../lib/services";
import { attachmentParamsSchema } from "../../route";

export const runtime = "nodejs";
const downloadParamsSchema = attachmentParamsSchema.extend({ attachmentId: z.string().uuid() }).strict();
export async function GET(request: Request, { params }: { params: Promise<{ entity: string; entityId: string; attachmentId: string }> }) {
  // `Response.redirect()` marca sus headers "immutable" (Fetch Standard): el `.set()` de abajo
  // lanzaba TypeError incluso con la URL ya absoluta, así que se arma la respuesta a mano.
  try { const { entity, entityId, attachmentId } = await parsePathParams(params, downloadParamsSchema), url = await new PrivateAttachmentService(createPrivateAttachmentServiceDependencies()).download(entity, entityId, attachmentId, await requireServerActor()); return new Response(null, { status: 302, headers: { Location: new URL(url, request.url).toString(), "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } }); }
  catch (error) { return apiError(error); }
}
