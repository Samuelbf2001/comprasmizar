import { listPublicWorks, verificarCodigoPublico } from "../../../../lib/infrastructure/public-access";
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
/**
 * Misma lista, pero para quien entra por la ruta pública SIN enlace firmado (decisión de Ernesto,
 * 2026-09-11: «que el enlace no necesite un token, sea ruta pública»). La llave es la contraseña.
 *
 * ESTO ES UN ORÁCULO DE LA CONTRASEÑA, y conviene decirlo sin adornos: lista con obras significa
 * "acertaste", lista vacía significa "no". El `GET` de arriba evitaba justo eso, y por eso lleva
 * escrito que no se pide contraseña. Aquí no hay alternativa: sin token no existe otra forma de
 * decidir a quién se le enseña la lista, y sin lista no se puede elegir obra ni radicar.
 *
 * Lo único que lo acota es `publicFormRateLimiter` (20/min por IP), que se aplica ANTES de tocar la
 * base. Es la misma defensa que protege la contraseña en el endpoint de radicación, así que el
 * oráculo no abarata un ataque que ya fuera posible allí: quien pueda probar contraseñas aquí podía
 * probarlas igual radicando. Ojo con una limitación real de ese limitador: vive en la memoria del
 * proceso, así que se reinicia en cada despliegue y no se comparte si algún día hay más de una
 * réplica.
 *
 * La forma de la respuesta es idéntica en los dos casos (`{ works: [...] }`), sin códigos ni
 * mensajes distintos, para no dar más señal que la longitud de la lista.
 */
export async function POST(request: Request) {
  if (!isPublicConfigured()) return Response.json({ error: "service_unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  const empty = Response.json({ works: [] }, { headers: { "Cache-Control": "no-store" } });
  const ip = request.headers.get("x-real-ip") ?? "direct";
  if (!publicFormRateLimiter.consume(ip)) return empty;
  let code = "";
  try {
    const raw = await request.text();
    if (Buffer.byteLength(raw, "utf8") > 4_000) return empty;
    const cuerpo = JSON.parse(raw) as { code?: unknown };
    code = typeof cuerpo.code === "string" ? cuerpo.code.trim() : "";
  } catch { return empty; }
  if (code.length < 4 || code.length > 64) return empty;
  try { return (await verificarCodigoPublico(code)) ? Response.json({ works: await listPublicWorks() }, { headers: { "Cache-Control": "no-store" } }) : empty; } catch { return empty; }
}

export async function GET(request: Request) {
  if (!isPublicConfigured()) return Response.json({ error: "service_unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  const empty = Response.json({ works: [] }, { headers: { "Cache-Control": "no-store" } });
  const ip = request.headers.get("x-real-ip") ?? "direct";
  if (!publicFormRateLimiter.consume(ip)) return empty;
  const token = new URL(request.url).searchParams.get("token") ?? "";
  if (!safeEqual(generalLinkToken(publicEnv().PUBLIC_FORM_CODE_PEPPER), token)) return empty;
  try { return Response.json({ works: await listPublicWorks() }, { headers: { "Cache-Control": "no-store" } }); } catch { return empty; }
}
