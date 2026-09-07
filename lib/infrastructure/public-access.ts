import { runtimeEnv } from "../security/env";
import { sharedPostgres } from "./postgres-repositories";
// GRAVE 2 (QA Postgres real): normalizeCoPhone vive en su propio módulo (ver phone.ts) para que
// postgres-repositories.ts también la reutilice (alta de solicitantes_autorizados vía catálogo) sin
// crear un ciclo de imports con este archivo, que ya importa sharedPostgres desde ese módulo.
import { normalizeCoPhone } from "./phone";
/** Applies the optional obra phone allowlist; the code/link verifier remains a separate concern. */
export async function isAuthorizedPublicRequester(workId: string, phone: string, databaseUrl = runtimeEnv().DATABASE_URL): Promise<boolean> { const sql = sharedPostgres(databaseUrl), rows = await sql`select o.require_authorized_requester, exists(select 1 from obra_solicitantes_autorizados s where s.obra_id=o.id and s.activo and s.telefono_normalizado=regexp_replace(${phone}, '[^0-9]', '', 'g')) as phone_allowed from obras o where o.id=${workId}`; return Boolean(rows[0] && (!rows[0].require_authorized_requester || rows[0].phone_allowed)); }

/**
 * Identidad del solicitante del WhatsApp Flow a partir de su número (RF-902), contra la lista
 * blanca GLOBAL `solicitantes_autorizados` (migración 202609010001). El Flow ya no pide nombre ni
 * teléfono: se busca el número en la lista y se devuelve el nombre autorizado. Devuelve `null`
 * cuando el número no está autorizado, para que el adaptador rechace la requisición.
 *
 * Reunión 2026-08-31: antes la lista era por obra (`obra_solicitantes_autorizados`, con su regla de
 * "obra sin exigir autorización" propia de esa tabla) porque el Flow pedía obra. Ahora el
 * solicitante elige empresa, no obra, y ya no hay obra sobre la cual anclar la lista — de ahí la
 * lista GLOBAL, sin la opción de "no exigir autorización" (siempre se exige). La tabla vieja se
 * conserva intacta: la sigue usando el portal público (`isAuthorizedPublicRequester`, arriba), que
 * sigue anclado a la obra.
 */
export async function resolveAuthorizedRequesterName(phone: string, databaseUrl = runtimeEnv().DATABASE_URL): Promise<{ name: string } | null> {
  const sql = sharedPostgres(databaseUrl);
  const rows = await sql<{ nombre: string }[]>`
    select nombre from solicitantes_autorizados where activo and telefono_normalizado = ${normalizeCoPhone(phone)} limit 1`;
  const row = rows[0];
  return row ? { name: String(row.nombre) } : null;
}
