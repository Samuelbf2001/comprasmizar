import { listPublicCompanies, verificarCodigoPublico } from "../../../../lib/infrastructure/public-access";
import { isPublicConfigured } from "../../../../lib/security/env";
import { publicFormRateLimiter } from "../../../../lib/security/rate-limit";

export const runtime = "nodejs";

/**
 * Empresas que puede elegir quien radica por el portal público.
 *
 * Reunión 2026-08-31, y recordatorio de Ernesto el 11-sep-2026 ("en el formulario público aparece
 * seleccionar obra y ya dijimos era empresa"): el solicitante elige EMPRESA. La obra es el centro de
 * costo y la asigna el revisor, que es quien sabe a qué contrato cargar el gasto. El Flow de WhatsApp
 * ya funcionaba así; el portal se había quedado con el selector viejo.
 *
 * ES UN ORÁCULO DE LA CONTRASEÑA, exactamente igual que `POST /api/public/works`, y conviene decirlo
 * sin adornos: lista con empresas significa "acertaste", lista vacía significa "no". Sin token no hay
 * otra forma de decidir a quién se le enseña la lista, y sin lista no se puede elegir empresa ni
 * radicar.
 *
 * Lo único que lo acota es `publicFormRateLimiter` (20/min por IP), aplicado ANTES de tocar la base —
 * la misma defensa que protege la contraseña en el endpoint de radicación, así que este oráculo no
 * abarata un ataque que ya fuera posible allí: quien pueda probar contraseñas aquí podía probarlas
 * igual radicando. Limitación real de ese limitador: vive en la memoria del proceso, así que se
 * reinicia en cada despliegue y no se comparte entre réplicas.
 *
 * La forma de la respuesta es idéntica en éxito y en rechazo (`{ companies: [...] }`), sin códigos ni
 * mensajes distintos, para no dar más señal que la longitud de la lista.
 */
export async function POST(request: Request) {
  if (!isPublicConfigured()) return Response.json({ error: "service_unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  const empty = Response.json({ companies: [] }, { headers: { "Cache-Control": "no-store" } });
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
  try { return (await verificarCodigoPublico(code)) ? Response.json({ companies: await listPublicCompanies() }, { headers: { "Cache-Control": "no-store" } }) : empty; } catch { return empty; }
}
