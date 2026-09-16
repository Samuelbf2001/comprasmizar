import { apiError, parsePathParams } from "../../../../../../../lib/http/api";
import { requireServerActor } from "../../../../../../../lib/infrastructure/auth";
import { createSupplierServiceDependencies } from "../../../../../../../lib/infrastructure/supplier-repositories";
import { SupplierService } from "../../../../../../../lib/services";
import { z } from "zod";

export const runtime = "nodejs";
const paramsSchema = z.object({ id: z.string().uuid(), documentId: z.string().uuid() }).strict();
export async function GET(request: Request, { params }: { params: Promise<{ id: string; documentId: string }> }) {
  // `Response.redirect()` marca sus headers "immutable" (Fetch Standard): el `.set()` de abajo
  // lanzaba TypeError incluso con la URL ya absoluta, así que se arma la respuesta a mano.
  try { const { id, documentId } = await parsePathParams(params, paramsSchema), url = await new SupplierService(createSupplierServiceDependencies()).downloadDocument(id, documentId, await requireServerActor()); return new Response(null, { status: 302, headers: { Location: new URL(url, request.url).toString(), "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } }); }
  catch (error) { return apiError(error); }
}
