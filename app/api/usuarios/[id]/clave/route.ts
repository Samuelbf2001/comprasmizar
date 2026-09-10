import { z } from "zod";
import { DomainError } from "../../../../../lib/domain";
import { assertSameOrigin, authenticatedJson, parseJson, parsePathParams } from "../../../../../lib/http/api";
import { setPassword } from "../../../../../lib/infrastructure/local-auth";

export const runtime = "nodejs";

/**
 * Restablecimiento de contraseña administrado (migración a autoalojado, 2026-09-10).
 *
 * Con Supabase Auth la recuperación era un correo que enviaba Supabase. Al traer la autenticación a
 * casa no hay servicio de correo detrás, y montar SMTP solo para esto añadiría una pieza de
 * infraestructura —y su mantenimiento, y su reputación de envío— para menos de 30 usuarios. La
 * recuperación pasa a ser un acto administrativo explícito: un Administrador asigna una contraseña
 * temporal y se la entrega al usuario por el canal que ya usan.
 *
 * Queda auditado como CLAVE_CAMBIADA sobre la cuenta afectada (ver local-auth.ts) y cierra TODAS las
 * sesiones de esa cuenta: si se restablece porque alguien perdió el control de su acceso, dejar
 * vivas las sesiones abiertas anularía el propósito.
 */
const bodySchema = z.object({ password: z.string().min(8).max(200) });
const paramsSchema = z.object({ id: z.string().uuid() });

export async function POST(request: Request, context: { params: Promise<unknown> }): Promise<Response> {
  return authenticatedJson(async (actor) => {
    assertSameOrigin(request);
    if (!actor.roles.some((role) => role === "admin_mizar" || role === "admin_sixteam")) {
      throw new DomainError("FORBIDDEN", "Solo un administrador puede restablecer contraseñas");
    }
    const { id } = await parsePathParams(context.params, paramsSchema);
    const { password } = await parseJson(request, bodySchema);
    // Sin `keepToken`: se cierran todas las sesiones de la cuenta intervenida. La sesión del
    // administrador no se toca porque pertenece a otro usuario.
    await setPassword(id, password);
    return { ok: true };
  });
}
