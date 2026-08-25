import { z } from "zod";
import { assertSameOrigin, authenticatedJson, parseJson } from "../../../lib/http/api";
import { createScreenSessionServiceDependencies } from "../../../lib/infrastructure/screen-session-repository";
import { ScreenSessionService } from "../../../lib/services/screen-session-service";

export const runtime = "nodejs";
/** RF-1104: solo un administrador puede crear sesiones de pantalla; la autorización real vive en el servicio. */
export const screenSessionCreateSchema = z.object({ name: z.string().trim().min(3).max(120), expiresAt: z.string().datetime().nullable().optional() }).strict();

function service() { return new ScreenSessionService(createScreenSessionServiceDependencies()); }
export function GET() { return authenticatedJson((actor) => service().list(actor)); }
/** El cuerpo de la respuesta trae el token en claro; es la única vez que existe fuera de este proceso. */
export function POST(request: Request) { return authenticatedJson(async (actor) => { assertSameOrigin(request); const input = await parseJson(request, screenSessionCreateSchema); return service().create(actor, input); }, 201); }
