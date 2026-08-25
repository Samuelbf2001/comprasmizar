import { apiError, parsePathParams } from "../../../../../../../lib/http/api";
import { requireServerActor } from "../../../../../../../lib/infrastructure/auth";
import { createSupplierServiceDependencies } from "../../../../../../../lib/infrastructure/supplier-repositories";
import { SupplierService } from "../../../../../../../lib/services";
import { z } from "zod";

export const runtime = "nodejs";
const paramsSchema = z.object({ id: z.string().uuid(), documentId: z.string().uuid() }).strict();
export async function GET(_request: Request, { params }: { params: Promise<{ id: string; documentId: string }> }) {
  try { const { id, documentId } = await parsePathParams(params, paramsSchema), url = await new SupplierService(createSupplierServiceDependencies()).downloadDocument(id, documentId, await requireServerActor()), response = Response.redirect(url, 302); response.headers.set("Cache-Control", "no-store"); response.headers.set("Referrer-Policy", "no-referrer"); return response; }
  catch (error) { return apiError(error); }
}
