import { apiError, parsePathParams } from "../../../../../../../lib/http/api";
import { requireServerActor } from "../../../../../../../lib/infrastructure/auth";
import { createSupplierServiceDependencies } from "../../../../../../../lib/infrastructure/supplier-repositories";
import { SupplierService } from "../../../../../../../lib/services";
import { z } from "zod";

export const runtime = "nodejs";
const paramsSchema = z.object({ id: z.string().uuid(), documentId: z.string().uuid() }).strict();
export async function GET(_request: Request, { params }: { params: Promise<{ id: string; documentId: string }> }) {
  // La respuesta se arma a mano (`Response.redirect()` exige URL absoluta y deja los headers inmutables)
  // y el Location va TAL CUAL lo da el almacenamiento: relativo al propio origen. NO se resuelve contra
  // `request.url`: detrás de Traefik esa URL es la interna del contenedor (https://0.0.0.0:3000/…) y el
  // navegador acababa en una dirección inalcanzable (verificado en producción el 21-sep-2026). Un
  // Location relativo lo resuelve el navegador contra la URL pública que él mismo pidió.
  try { const { id, documentId } = await parsePathParams(params, paramsSchema), url = await new SupplierService(createSupplierServiceDependencies()).downloadDocument(id, documentId, await requireServerActor()); return new Response(null, { status: 302, headers: { Location: url, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } }); }
  catch (error) { return apiError(error); }
}
