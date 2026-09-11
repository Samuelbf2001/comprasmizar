import { listPublicCompanies } from "../../../../lib/infrastructure/public-access";
import { isPublicConfigured } from "../../../../lib/security/env";
import { publicFormRateLimiter } from "../../../../lib/security/rate-limit";

export const runtime = "nodejs";

/**
 * Empresas que puede elegir quien radica por el portal público.
 *
 * Reunión 2026-08-31, y recordatorio de Ernesto el 11-sep-2026 («en el formulario público aparece
 * seleccionar obra y ya dijimos era empresa»): el solicitante elige EMPRESA. La obra es el centro de
 * costo y la asigna el revisor, que es quien sabe a qué contrato cargar el gasto. El Flow de WhatsApp
 * ya funcionaba así; el portal se había quedado con el selector viejo.
 *
 * SIN CONTRASEÑA Y SIN TOKEN, a propósito. Lo que devuelve son los nombres de las sociedades del
 * cliente —Mizar, Ictinos…—, que están en la marca, en las facturas y en la fachada: no son un
 * secreto que proteger. Pedir la contraseña aquí no escondería nada y sí crearía un oráculo (lista
 * con empresas = acertaste, lista vacía = no), que es justo lo que el endpoint de obras al que
 * sustituye tenía y por lo que se ha borrado.
 *
 * Lo que acota este endpoint es `publicFormRateLimiter` (20/min por IP), aplicado ANTES de tocar la
 * base. Su limitación real, que conviene no olvidar: vive en la memoria del proceso, así que se
 * reinicia en cada despliegue y no se comparte entre réplicas.
 *
 * Lo que se OFRECE aquí es exactamente lo que el endpoint de radicación ACEPTA (ver `verifySociety`
 * en postgres-repositories.ts): solo sociedades activas. Una lista más ancha que la aceptada sería
 * una invitación a un 202 neutro que no crea nada.
 */
export async function GET(request: Request) {
  if (!isPublicConfigured()) return Response.json({ error: "service_unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  const empty = Response.json({ companies: [] }, { headers: { "Cache-Control": "no-store" } });
  const ip = request.headers.get("x-real-ip") ?? "direct";
  if (!publicFormRateLimiter.consume(ip)) return empty;
  try { return Response.json({ companies: await listPublicCompanies() }, { headers: { "Cache-Control": "no-store" } }); } catch { return empty; }
}
