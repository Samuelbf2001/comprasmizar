import { runtimeEnv } from "../security/env";
import type { PublicAccessAdminRepository, PublicAccessStatus } from "../services";
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

/**
 * Reunión: la contraseña del portal público dejó de ser por obra (`obras.public_code_hash`, obsoleta)
 * y pasó a ser GLOBAL, guardada en `configuracion.acceso_publico_v1` (migración 202609070002). Este
 * repositorio administra ESA fila: nunca ve el hash en JS (extensions.crypt corre en la base) y nunca
 * lo devuelve (getStatus solo informa si hay uno configurado y cuándo cambió).
 */
export function createPublicAccessAdminRepository(databaseUrl = runtimeEnv().DATABASE_URL): PublicAccessAdminRepository {
  const sql = sharedPostgres(databaseUrl);
  return {
    async getStatus(): Promise<PublicAccessStatus> {
      const rows = await sql<{ configured: boolean; updated_at: string | null }[]>`
        select (valor ->> 'codigo_hash') is not null as configured, updated_at
        from configuracion where clave = 'acceso_publico_v1'`;
      const row = rows[0];
      return { configured: row?.configured === true, updatedAt: row?.updated_at ? new Date(row.updated_at).toISOString() : null };
    },
    // updated_at (columna) y actualizado_en (dentro del jsonb) se fijan al mismo now() de la base para
    // que nunca queden desincronizados por el viaje de ida y vuelta con el servidor de aplicación.
    async setPassword(code: string, actorId: string): Promise<void> {
      await sql`
        update configuracion
        set valor = jsonb_build_object('codigo_hash', extensions.crypt(${code}, extensions.gen_salt('bf')), 'actualizado_en', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
            updated_at = now(), updated_by = ${actorId}
        where clave = 'acceso_publico_v1'`;
    },
  };
}
