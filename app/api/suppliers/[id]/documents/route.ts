import { z } from "zod";
import { assertSameOrigin, authenticatedJson, parseJson, parsePathParams } from "../../../../../lib/http/api";
import { createSupplierServiceDependencies } from "../../../../../lib/infrastructure/supplier-repositories";
import { SupplierService } from "../../../../../lib/services";

export const runtime = "nodejs";
export const supplierDocumentSchema = z.object({ type: z.enum(["rut", "camara_comercio", "certificacion_bancaria", "certificado_calidad"]), name: z.string().trim().min(1).max(180), mimeType: z.enum(["application/pdf", "image/jpeg", "image/png"]), sizeBytes: z.number().int().positive().max(10 * 1024 * 1024) }).strict();
const paramsSchema = z.object({ id: z.string().uuid() }).strict();
function service() { return new SupplierService(createSupplierServiceDependencies()); }
export function POST(request: Request, { params }: { params: Promise<{ id: string }> }) { return authenticatedJson(async (actor) => { const { id } = await parsePathParams(params, paramsSchema); assertSameOrigin(request); return service().prepareDocument(id, await parseJson(request, supplierDocumentSchema), actor); }, 201); }
