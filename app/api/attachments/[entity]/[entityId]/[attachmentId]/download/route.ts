import { z } from "zod";
import { apiError, parsePathParams } from "../../../../../../../lib/http/api";
import { requireServerActor } from "../../../../../../../lib/infrastructure/auth";
import { createPrivateAttachmentServiceDependencies } from "../../../../../../../lib/infrastructure/attachment-repositories";
import { PrivateAttachmentService } from "../../../../../../../lib/services";
import { attachmentParamsSchema } from "../../route";

export const runtime = "nodejs";
const downloadParamsSchema = attachmentParamsSchema.extend({ attachmentId: z.string().uuid() }).strict();
export async function GET(_request: Request, { params }: { params: Promise<{ entity: string; entityId: string; attachmentId: string }> }) {
  try { const { entity, entityId, attachmentId } = await parsePathParams(params, downloadParamsSchema), url = await new PrivateAttachmentService(createPrivateAttachmentServiceDependencies()).download(entity, entityId, attachmentId, await requireServerActor()), response = Response.redirect(url, 302); response.headers.set("Cache-Control", "no-store"); response.headers.set("Referrer-Policy", "no-referrer"); return response; }
  catch (error) { return apiError(error); }
}
