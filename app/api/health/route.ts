import { isKapsoConfigured, isMcpConfigured, isPublicConfigured, isRuntimeConfigured } from "../../../lib/security/env";
import { appOrigin } from "../../../lib/http/api";
export const runtime = "nodejs";
// `origin` se informa desde el 11-sep-2026: sin él, una imagen construida sin NEXT_PUBLIC_APP_URL
// dejaba la plataforma en solo lectura (toda escritura 503 por assertSameOrigin) mientras /api/health
// seguía diciendo "ok". Ver el comentario de `appOrigin` en lib/http/api.ts.
export function GET() { const core = isRuntimeConfigured(), origin = Boolean(appOrigin()); return Response.json({ status: core && origin ? "ok" : "unconfigured", components: { public: isPublicConfigured(), kapso: isKapsoConfigured(), mcp: isMcpConfigured(), origin } }, { status: core && origin ? 200 : 503, headers: { "Cache-Control": "no-store" } }); }
