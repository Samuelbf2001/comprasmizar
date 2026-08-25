import { runtimeEnv } from "../security/env";
import { sharedPostgres } from "./postgres-repositories";
/** Applies the optional obra phone allowlist; the code/link verifier remains a separate concern. */
export async function isAuthorizedPublicRequester(workId: string, phone: string, databaseUrl = runtimeEnv().DATABASE_URL): Promise<boolean> { const sql = sharedPostgres(databaseUrl), rows = await sql`select o.require_authorized_requester, exists(select 1 from obra_solicitantes_autorizados s where s.obra_id=o.id and s.activo and s.telefono_normalizado=regexp_replace(${phone}, '[^0-9]', '', 'g')) as phone_allowed from obras o where o.id=${workId}`; return Boolean(rows[0] && (!rows[0].require_authorized_requester || rows[0].phone_allowed)); }
