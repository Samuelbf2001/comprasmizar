import { listPublicWorks } from "../../../../lib/infrastructure/public-access";
import { isPublicConfigured, publicEnv } from "../../../../lib/security/env";
import { generalLinkToken } from "../../../../lib/security/public-link";
import { safeEqual } from "../../../../lib/security/crypto";
import { publicFormRateLimiter } from "../../../../lib/security/rate-limit";

export const runtime = "nodejs";

/**
 * Obras que puede elegir quien entra por el enlace GENERAL del portal.
 *
 * Solo responde al token general: un enlace por obra no necesita esta lista (ya trae su obra) y
 * dársela lo convertiría en una llave para radicar contra cualquier otra. La respuesta de rechazo es
 * una lista vacía y no un 401, para no confirmarle a nadie que adivinó a medias.
 *
 * Aquí NO se pide la contraseña, a propósito: exigirla convertiría este endpoint en un oráculo
 * (lista llena = contraseña correcta) y echaría abajo la neutralidad del 202 de
 * /api/public/requisitions. Lo que se expone son nombres de obra a quien ya tiene el enlace; radicar
 * sigue exigiendo contraseña y teléfono.
 */
export async function GET(request: Request) {
  if (!isPublicConfigured()) return Response.json({ error: "service_unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  const empty = Response.json({ works: [] }, { headers: { "Cache-Control": "no-store" } });
  const ip = request.headers.get("x-real-ip") ?? "direct";
  if (!publicFormRateLimiter.consume(ip)) return empty;
  const token = new URL(request.url).searchParams.get("token") ?? "";
  if (!safeEqual(generalLinkToken(publicEnv().PUBLIC_FORM_CODE_PEPPER), token)) return empty;
  try { return Response.json({ works: await listPublicWorks() }, { headers: { "Cache-Control": "no-store" } }); } catch { return empty; }
}
