import type { Actor, Role } from "../domain";
import { runtimeEnv } from "../security/env";
import { sharedPostgres } from "./postgres-repositories";
export async function lookupMcpActor(keyHash: string, databaseUrl = runtimeEnv().DATABASE_URL): Promise<Actor | null> { const sql = sharedPostgres(databaseUrl); const rows = await sql<{ usuario_id: string; rol: Role }[]>`select k.usuario_id, ur.rol from mcp_api_keys k join usuarios u on u.id=k.usuario_id and u.estado='activo' join usuario_roles ur on ur.usuario_id=u.id where k.key_hash=${keyHash} and k.activa=true and k.revocada_at is null`; if (!rows.length) return null; await sql`update mcp_api_keys set ultima_vez_usada=now() where key_hash=${keyHash}`; return { id: rows[0].usuario_id, roles: rows.map((row) => row.rol) }; }
