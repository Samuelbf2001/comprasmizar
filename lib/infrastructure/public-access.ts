import { runtimeEnv } from "../security/env";
import { sharedPostgres } from "./postgres-repositories";
/** Applies the optional obra phone allowlist; the code/link verifier remains a separate concern. */
export async function isAuthorizedPublicRequester(workId: string, phone: string, databaseUrl = runtimeEnv().DATABASE_URL): Promise<boolean> { const sql = sharedPostgres(databaseUrl), rows = await sql`select o.require_authorized_requester, exists(select 1 from obra_solicitantes_autorizados s where s.obra_id=o.id and s.activo and s.telefono_normalizado=regexp_replace(${phone}, '[^0-9]', '', 'g')) as phone_allowed from obras o where o.id=${workId}`; return Boolean(rows[0] && (!rows[0].require_authorized_requester || rows[0].phone_allowed)); }

/**
 * Identidad del solicitante del WhatsApp Flow a partir de su número (RF-902). El Flow ya no pide
 * nombre ni teléfono: se busca el número en la lista blanca por obra y se devuelve el nombre
 * autorizado. Devuelve `null` cuando el número NO puede solicitar para esa obra, para que el
 * adaptador rechace la requisición como no autorizada.
 *
 * Respeta la misma regla que `isAuthorizedPublicRequester`: si la obra no exige solicitante
 * autorizado (`require_authorized_requester = false`), cualquier número puede solicitar y se usa un
 * nombre genérico basado en los últimos dígitos; si la exige, el número debe estar en la lista.
 */
export async function resolveAuthorizedRequesterName(workId: string, phone: string, databaseUrl = runtimeEnv().DATABASE_URL): Promise<{ name: string } | null> {
  const sql = sharedPostgres(databaseUrl);
  const digits = phone.replace(/[^0-9]/g, "");
  const rows = await sql<{ nombre: string | null; require_authorized_requester: boolean }[]>`
    select s.nombre, o.require_authorized_requester
    from obras o
    left join obra_solicitantes_autorizados s
      on s.obra_id = o.id and s.activo and s.telefono_normalizado = ${digits}
    where o.id = ${workId}
    order by s.nombre nulls last
    limit 1`;
  const row = rows[0];
  if (!row) return null; // la obra no existe
  if (row.nombre) return { name: String(row.nombre) }; // número autorizado: su nombre real
  if (row.require_authorized_requester === false) return { name: `Solicitante ${digits.slice(-4)}` };
  return null; // la obra exige autorización y el número no está en la lista
}
