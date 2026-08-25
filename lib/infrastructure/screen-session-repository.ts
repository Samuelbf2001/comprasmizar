import type { Sql } from "postgres";
import type { ScreenSessionRecord, ScreenSessionRepository, ScreenSessionServiceDependencies } from "../services/screen-session-service";
import { mcpEnv, runtimeEnv } from "../security/env";
import { sharedPostgres } from "./postgres-repositories";

type Row = Record<string, unknown>;
function toRecord(row: Row): ScreenSessionRecord {
  return {
    id: String(row.id),
    name: String(row.nombre),
    active: row.activa === true,
    createdBy: String(row.creada_por),
    createdAt: new Date(String(row.fecha_creacion)).toISOString(),
    lastUsedAt: row.ultima_vez_usada ? new Date(String(row.ultima_vez_usada)).toISOString() : null,
    expiresAt: row.expira_at ? new Date(String(row.expira_at)).toISOString() : null,
  };
}

class PostgresScreenSessionRepository implements ScreenSessionRepository {
  constructor(private readonly sql: Sql) {}
  async insert(record: { id: string; name: string; tokenHash: string; createdBy: string; createdAt: Date; expiresAt: Date | null }): Promise<void> {
    await this.sql`insert into sesiones_pantalla (id, nombre, token_hash, creada_por, fecha_creacion, expira_at) values (${record.id}, ${record.name}, ${record.tokenHash}, ${record.createdBy}, ${record.createdAt.toISOString()}, ${record.expiresAt ? record.expiresAt.toISOString() : null})`;
  }
  async list(): Promise<ScreenSessionRecord[]> {
    return (await this.sql<Row[]>`select id, nombre, activa, creada_por, ultima_vez_usada, fecha_creacion, expira_at from sesiones_pantalla order by fecha_creacion desc`).map(toRecord);
  }
  async findById(id: string): Promise<ScreenSessionRecord | null> {
    const rows = await this.sql<Row[]>`select id, nombre, activa, creada_por, ultima_vez_usada, fecha_creacion, expira_at from sesiones_pantalla where id=${id}`;
    return rows[0] ? toRecord(rows[0]) : null;
  }
  // Consulta deliberadamente acotada a id/nombre/último uso: ninguna ruta de autenticación de pantalla
  // puede devolver token_hash ni ningún dato fuera de sesiones_pantalla, por construcción de esta query.
  async findActiveByTokenHash(tokenHash: string, at: Date): Promise<{ id: string; name: string; lastUsedAt: string | null } | null> {
    const rows = await this.sql<Row[]>`select id, nombre, ultima_vez_usada from sesiones_pantalla where token_hash=${tokenHash} and activa=true and (expira_at is null or expira_at > ${at.toISOString()})`;
    const row = rows[0];
    return row ? { id: String(row.id), name: String(row.nombre), lastUsedAt: row.ultima_vez_usada ? new Date(String(row.ultima_vez_usada)).toISOString() : null } : null;
  }
  async touchUsage(id: string, at: Date): Promise<void> { await this.sql`update sesiones_pantalla set ultima_vez_usada=${at.toISOString()} where id=${id}`; }
  async revoke(id: string): Promise<ScreenSessionRecord | null> {
    const rows = await this.sql<Row[]>`update sesiones_pantalla set activa=false where id=${id} and activa=true returning id, nombre, activa, creada_por, ultima_vez_usada, fecha_creacion, expira_at`;
    return rows[0] ? toRecord(rows[0]) : null;
  }
}

/**
 * Reutiliza el pepper de `mcp_api_keys` (MCP_KEY_PEPPER) en vez de introducir un secreto nuevo: este
 * módulo no puede tocar lib/security/env.ts ni .env.example (otros agentes trabajan en paralelo sobre
 * el resto del repo). Es seguro porque solo se guarda un hash HMAC-SHA256 de un valor de un solo uso
 * y los dos espacios de token nunca colisionan: los tokens de pantalla llevan el prefijo
 * "mizar_pantalla_" y los de MCP "mizar_" a secas, antes de hashear. Migrar a un pepper dedicado
 * (SCREEN_SESSION_PEPPER) es un cambio de una línea en env.ts + .env.example, fuera de este alcance.
 */
export function createScreenSessionServiceDependencies(databaseUrl = runtimeEnv().DATABASE_URL): ScreenSessionServiceDependencies {
  const sql = sharedPostgres(databaseUrl);
  return {
    repository: new PostgresScreenSessionRepository(sql),
    audit: { append: async (event) => { await sql`insert into auditoria (entidad, entidad_id, evento, origen, usuario_id, fecha, datos_json) values (${event.entity}, ${event.entityId}, ${event.event}, ${event.origin}, ${event.actorId ?? null}, ${event.at.toISOString()}, ${JSON.stringify(event.data ?? {})}::jsonb)`; } },
    clock: { now: () => new Date() },
    ids: { next: () => crypto.randomUUID() },
    pepper: mcpEnv().MCP_KEY_PEPPER,
  };
}
