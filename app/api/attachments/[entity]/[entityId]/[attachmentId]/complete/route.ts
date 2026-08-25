import { z } from "zod";
import { assertSameOrigin, authenticatedJson, parseJson, parsePathParams } from "../../../../../../../lib/http/api";
import { createPrivateAttachmentServiceDependencies } from "../../../../../../../lib/infrastructure/attachment-repositories";
import { PrivateAttachmentService } from "../../../../../../../lib/services";
import { attachmentParamsSchema, attachmentUploadSchema } from "../../route";

export const runtime = "nodejs";
const completeParamsSchema = attachmentParamsSchema.extend({ attachmentId: z.string().uuid() }).strict();
function service() { return new PrivateAttachmentService(createPrivateAttachmentServiceDependencies()); }
export function POST(request: Request, { params }: { params: Promise<{ entity: string; entityId: string; attachmentId: string }> }) { return authenticatedJson(async (actor) => { const { entity, entityId, attachmentId } = await parsePathParams(params, completeParamsSchema); assertSameOrigin(request); return service().complete(entity, entityId, attachmentId, await parseJson(request, attachmentUploadSchema), actor); }); }
