import { isKapsoConfigured, isMcpConfigured, isPublicConfigured, isRuntimeConfigured } from "../../../lib/security/env";
export const runtime = "nodejs";
export function GET() { const core = isRuntimeConfigured(); return Response.json({ status: core ? "ok" : "unconfigured", components: { public: isPublicConfigured(), kapso: isKapsoConfigured(), mcp: isMcpConfigured() } }, { status: core ? 200 : 503, headers: { "Cache-Control": "no-store" } }); }
