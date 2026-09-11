import { isKapsoConfigured, isMcpConfigured, isPublicConfigured, isRuntimeConfigured } from "../../../lib/security/env";
import { appOrigin } from "../../../lib/http/api";
import { contarFallidos24h } from "../../../lib/infrastructure/whatsapp-delivery-status";
export const runtime = "nodejs";
// `origin` se informa desde el 11-sep-2026: sin él, una imagen construida sin NEXT_PUBLIC_APP_URL
// dejaba la plataforma en solo lectura (toda escritura 503 por assertSameOrigin) mientras /api/health
// seguía diciendo "ok". Ver el comentario de `appOrigin` en lib/http/api.ts.
//
// `whatsapp_fallidos_24h` se añade por la misma razón que `origin`: para que un fallo silencioso se
// vea desde fuera. Hasta ahora un aviso que Meta descartaba quedaba como `enviado` y solo se
// descubría preguntándole a alguien por qué no había recibido nada. Un número distinto de 0 aquí
// significa que hay avisos que NO llegaron — ver `whatsapp_eventos.motivo_fallo` para el porqué.
//
// Se consulta la base, así que un fallo de conexión devolvería `null` en vez de tumbar el health:
// este endpoint también lo usa el healthcheck del contenedor, y no puede depender de que la
// estadística funcione.
export async function GET() {
  const core = isRuntimeConfigured(), origin = Boolean(appOrigin());
  let fallidos: number | null = null;
  if (core) { try { fallidos = await contarFallidos24h(); } catch { fallidos = null; } }
  return Response.json(
    {
      status: core && origin ? "ok" : "unconfigured",
      components: { public: isPublicConfigured(), kapso: isKapsoConfigured(), mcp: isMcpConfigured(), origin },
      whatsapp_fallidos_24h: fallidos,
      commit: process.env.APP_COMMIT?.trim() || null,
    },
    { status: core && origin ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
