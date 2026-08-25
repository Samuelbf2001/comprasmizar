import { z } from "zod";
import { assertSameOrigin, authenticatedJson, parseJson, parsePathParams } from "../../../../lib/http/api";
import { createSupplierServiceDependencies } from "../../../../lib/infrastructure/supplier-repositories";
import { SupplierService } from "../../../../lib/services";
import { supplierCreateSchema } from "../route";

export const runtime = "nodejs";
// Contact and bankDetails replace their respective JSON objects; `{}` deliberately clears stale sensitive fields.
const patchSchema = z.object({
  name: supplierCreateSchema.shape.name.optional(),
  nit: supplierCreateSchema.shape.nit.nullable().optional(),
  contact: supplierCreateSchema.shape.contact.optional(),
  bankDetails: supplierCreateSchema.shape.bankDetails.optional(),
  active: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "At least one change is required");
const paramsSchema = z.object({ id: z.string().uuid() }).strict();
function service() { return new SupplierService(createSupplierServiceDependencies()); }
export function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) { return authenticatedJson(async (actor) => { const { id } = await parsePathParams(params, paramsSchema); return service().get(id, actor); }); }
export function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) { return authenticatedJson(async (actor) => { const { id } = await parsePathParams(params, paramsSchema); assertSameOrigin(request); return service().update(id, await parseJson(request, patchSchema), actor); }); }
