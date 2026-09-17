import { z } from "zod";
import { assertSameOrigin, authenticatedJson, parseJson, parsePathParams } from "../../../../../lib/http/api";
import { createPrivateAttachmentServiceDependencies } from "../../../../../lib/infrastructure/attachment-repositories";
import { ATTACHMENT_MIME_TYPES, MAX_PRIVATE_ATTACHMENT_BYTES, PRIVATE_ATTACHMENT_TYPES } from "../../../../../lib/services/attachment-service";
import { PrivateAttachmentService } from "../../../../../lib/services";

export const runtime = "nodejs";
export const attachmentParamsSchema = z.object({ entity: z.enum(["requisicion", "requisicion_item", "caja_menor", "pago_orden"]), entityId: z.string().uuid() }).strict();
/**
 * La lista de tipos y el tope de tamaño se IMPORTAN de `attachment-service.ts`, no se repiten:
 * hasta 2026-09-17 este esquema decía 20 MB mientras el selector del navegador prometía 10, así que
 * el número que veía quien sube no era el que defendía el servidor. Con una sola constante eso no
 * puede volver a divergir. `mimeType` es lo que DECLARA el cliente al preparar la subida; la
 * autoridad sigue siendo `/api/storage/object`, que husmea los bytes reales, y `complete()`, que
 * exige que coincidan.
 */
export const attachmentUploadSchema = z.object({
  type: z.enum(PRIVATE_ATTACHMENT_TYPES),
  name: z.string().trim().min(1).max(180),
  mimeType: z.string().trim().min(1).max(120).refine((value) => ATTACHMENT_MIME_TYPES.has(value.toLowerCase()), "MIME de soporte no permitido"),
  sizeBytes: z.number().int().positive().max(MAX_PRIVATE_ATTACHMENT_BYTES),
}).strict();
function service() { return new PrivateAttachmentService(createPrivateAttachmentServiceDependencies()); }

export function GET(_request: Request, { params }: { params: Promise<{ entity: string; entityId: string }> }) { return authenticatedJson(async (actor) => { const { entity, entityId } = await parsePathParams(params, attachmentParamsSchema); return service().list(entity, entityId, actor); }); }
/** Contrato de subida firmada: PUT con FormData. Lo servía Supabase Storage; desde la migración a
 *  autoalojado lo atiende /api/storage/object (lib/infrastructure/local-storage.ts) con el mismo
 *  contrato, para no tocar el cliente. */
export function POST(request: Request, { params }: { params: Promise<{ entity: string; entityId: string }> }) { return authenticatedJson(async (actor) => { const { entity, entityId } = await parsePathParams(params, attachmentParamsSchema); assertSameOrigin(request); return service().prepare(entity, entityId, await parseJson(request, attachmentUploadSchema), actor); }, 201); }
