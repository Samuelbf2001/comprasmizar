import { z } from "zod";
import { assertSameOrigin, authenticatedJson, parseJson, parsePathParams } from "../../../../../lib/http/api";
import { createPrivateAttachmentServiceDependencies } from "../../../../../lib/infrastructure/attachment-repositories";
import { PrivateAttachmentService } from "../../../../../lib/services";

export const runtime = "nodejs";
export const attachmentParamsSchema = z.object({ entity: z.enum(["requisicion", "requisicion_item", "caja_menor"]), entityId: z.string().uuid() }).strict();
export const attachmentUploadSchema = z.object({ type: z.enum(["soporte", "cotizacion", "foto"]), name: z.string().trim().min(1).max(180), mimeType: z.enum(["application/pdf", "image/jpeg", "image/png", "image/webp"]), sizeBytes: z.number().int().positive().max(20 * 1024 * 1024) }).strict();
function service() { return new PrivateAttachmentService(createPrivateAttachmentServiceDependencies()); }

export function GET(_request: Request, { params }: { params: Promise<{ entity: string; entityId: string }> }) { return authenticatedJson(async (actor) => { const { entity, entityId } = await parsePathParams(params, attachmentParamsSchema); return service().list(entity, entityId, actor); }); }
/** Returns the signed PUT contract expected by Supabase uploadToSignedUrl (FormData file field). */
export function POST(request: Request, { params }: { params: Promise<{ entity: string; entityId: string }> }) { return authenticatedJson(async (actor) => { const { entity, entityId } = await parsePathParams(params, attachmentParamsSchema); assertSameOrigin(request); return service().prepare(entity, entityId, await parseJson(request, attachmentUploadSchema), actor); }, 201); }
