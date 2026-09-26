import { z } from "zod";
import { DomainError } from "../../../lib/domain";
import { authenticatedJson } from "../../../lib/http/api";
import { PostgresAuditLogRepository } from "../../../lib/infrastructure/audit-log-repository";
import { sharedPostgres } from "../../../lib/infrastructure/postgres-repositories";
import { runtimeEnv } from "../../../lib/security/env";
import { AUDIT_PAGE_MAX } from "../../../lib/services/audit-log-options";
import { AUDIT_ENTITY_KEYS, AUDIT_EVENT_KEYS, AUDIT_ORIGIN_KEYS, AuditLogService } from "../../../lib/services/audit-log-service";

export const runtime = "nodejs";

/**
 * Historial de cambios (ADM-08 / RF-1003, 25-sep-2026): GET de solo lectura sobre `auditoria`.
 * Permiso `audit:read` (lo decide AuditLogService). Filtros, todos opcionales:
 * `from`/`to` (YYYY-MM-DD, hora de Colombia, ambos inclusive), `actor` (id del usuario que hizo el
 * cambio), `entity` (grupo: requisicion, orden, pago…), `event` (familia: aprobacion, devolucion…),
 * `origin` (web, publico, whatsapp, mcp, sistema), `limit` (1–100, 50 por defecto) y `cursor` (el
 * `nextCursor` de la página anterior). Responde `{ rows, nextCursor }` ya en lenguaje de negocio: sin
 * UUID, sin cédulas/NIT, sin datos bancarios, sin contraseñas ni hashes.
 */
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)));
const querySchema = z.object({
  from: date.optional(),
  to: date.optional(),
  actor: z.string().uuid().optional(),
  entity: z.enum(AUDIT_ENTITY_KEYS as [string, ...string[]]).optional(),
  event: z.enum(AUDIT_EVENT_KEYS as [string, ...string[]]).optional(),
  origin: z.enum(AUDIT_ORIGIN_KEYS as [string, ...string[]]).optional(),
  limit: z.coerce.number().int().min(1).max(AUDIT_PAGE_MAX).optional(),
  cursor: z.string().min(1).max(200).optional(),
}).strict();

export function GET(request: Request) {
  return authenticatedJson(async (actor) => {
    const params = Object.fromEntries([...new URL(request.url).searchParams.entries()].filter(([, value]) => value !== ""));
    const parsed = querySchema.safeParse(params);
    if (!parsed.success) throw new DomainError("INVALID_INPUT", "Los filtros del historial no son válidos");
    const { actor: actorId, ...filters } = parsed.data;
    const service = new AuditLogService({ repository: new PostgresAuditLogRepository(sharedPostgres(runtimeEnv().DATABASE_URL)) });
    return service.list(actor, { ...filters, actorId } as Parameters<AuditLogService["list"]>[1]);
  });
}
