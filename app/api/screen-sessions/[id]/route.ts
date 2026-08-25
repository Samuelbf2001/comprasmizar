import { z } from "zod";
import { assertSameOrigin, authenticatedJson, parsePathParams } from "../../../../lib/http/api";
import { createScreenSessionServiceDependencies } from "../../../../lib/infrastructure/screen-session-repository";
import { ScreenSessionService } from "../../../../lib/services/screen-session-service";

export const runtime = "nodejs";
const paramsSchema = z.object({ id: z.string().uuid() }).strict();
function service() { return new ScreenSessionService(createScreenSessionServiceDependencies()); }
/** Revocación inmediata: el token deja de autenticar en la siguiente lectura, sin esperar expiración. */
export function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return authenticatedJson(async (actor) => { const { id } = await parsePathParams(params, paramsSchema); assertSameOrigin(request); return service().revoke(actor, id); });
}
