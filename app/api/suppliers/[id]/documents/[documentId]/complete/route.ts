import { z } from "zod";
import { assertSameOrigin, authenticatedJson, parseJson, parsePathParams } from "../../../../../../../lib/http/api";
import { createSupplierServiceDependencies } from "../../../../../../../lib/infrastructure/supplier-repositories";
import { SupplierService } from "../../../../../../../lib/services";
import { supplierDocumentSchema } from "../../route";

export const runtime = "nodejs";
const paramsSchema = z.object({ id: z.string().uuid(), documentId: z.string().uuid() }).strict();
function service() { return new SupplierService(createSupplierServiceDependencies()); }
export function POST(request: Request, { params }: { params: Promise<{ id: string; documentId: string }> }) { return authenticatedJson(async (actor) => { const { id, documentId } = await parsePathParams(params, paramsSchema); assertSameOrigin(request); return service().completeDocument(id, documentId, await parseJson(request, supplierDocumentSchema), actor); }); }
