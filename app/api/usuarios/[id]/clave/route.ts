import { z } from "zod";
import type { Role } from "../../../../../lib/domain";
import { assertSameOrigin, authenticatedJson, parseJson, parsePathParams } from "../../../../../lib/http/api";
import { resetPasswordAsAdmin } from "../../../../../lib/infrastructure/local-auth";
import { sharedPostgres } from "../../../../../lib/infrastructure/postgres-repositories";
import { runtimeEnv } from "../../../../../lib/security/env";
import { assertCanResetPassword } from "../../../../../lib/services";

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
 * 25-sep-2026: la puerta deja de ser el nombre del rol y pasa a ser el permiso `user:reset_password`
 * (revisor, admin_mizar y admin_sixteam por defecto), y ahora mira A QUIÉN se le restablece: la cuenta
 * de un Administrador Sixteam solo la restablece otro Administrador Sixteam (`assertCanResetPassword`).
 * Antes cualquier Administrador Mizar podía cambiarle la clave a un Administrador Sixteam.
 *
 * Queda auditado como CLAVE_RESTABLECIDA sobre la cuenta afectada y a nombre de quien la restableció
 * (ver `resetPasswordAsAdmin`), y cierra TODAS las sesiones de esa cuenta: si se restablece porque
 * alguien perdió el control de su acceso, dejar vivas las sesiones abiertas anularía el propósito.
 */
const bodySchema = z.object({ password: z.string().min(8).max(200) });
const paramsSchema = z.object({ id: z.string().uuid() });

export async function POST(request: Request, context: { params: Promise<unknown> }): Promise<Response> {
  return authenticatedJson(async (actor) => {
    assertSameOrigin(request);
    const { id } = await parsePathParams(context.params, paramsSchema);
    const { password } = await parseJson(request, bodySchema);
    const sql = sharedPostgres(runtimeEnv().DATABASE_URL);
    const rows = await sql<Array<{ roles: Role[] }>>`select coalesce(array_agg(ur.rol) filter (where ur.rol is not null), '{}') as roles from usuarios u left join usuario_roles ur on ur.usuario_id = u.id where u.id = ${id} group by u.id`;
    assertCanResetPassword(actor, rows[0] ? { roles: rows[0].roles } : null);
    // Sin conservar ninguna sesión: se cierran todas las de la cuenta intervenida. La sesión del
    // administrador no se toca porque pertenece a otro usuario.
    await resetPasswordAsAdmin(id, password, actor.id);
    return { ok: true };
  });
}
