import { randomBytes } from "node:crypto";
import { DomainError, type Actor } from "../domain";
import { hmacSha256 } from "../security/crypto";

/**
 * RF-1104: sesiones de pantalla — modo kiosco de solo lectura para dejar el dashboard abierto
 * permanentemente en un monitor de oficina. Un token de pantalla NUNCA es un `Actor`: no tiene
 * `roles`, no puede crear/aprobar/editar nada, y el único dato que autentica es la posibilidad de
 * leer métricas agregadas del dashboard (`DashboardMetrics` en lib/domain). `ScreenSessionPrincipal`
 * es estructuralmente distinto de `Actor` a propósito, para que ningún servicio con autorización por
 * rol pueda aceptarlo por error ni siquiera si alguien intenta forzar el tipo.
 */
export const SCREEN_SESSION_TOKEN_PREFIX = "mizar_pantalla_";
/** No se persiste "último uso" en cada auto-refresco del kiosco: solo si pasó este umbral desde el
 * último toque. Un dashboard refrescando cada pocos segundos, si no, inundaría `auditoria` (la tabla
 * audita cada UPDATE de `sesiones_pantalla`) sin aportar valor a un administrador. */
export const SCREEN_SESSION_TOUCH_THROTTLE_MS = 5 * 60 * 1000;
const ADMIN_ROLES = new Set(["admin_mizar", "admin_sixteam"]);

export interface ScreenSessionRecord {
  id: string; name: string; active: boolean; createdBy: string; createdAt: string; lastUsedAt: string | null; expiresAt: string | null;
}
/** Lo único que autentica un token de pantalla. Deliberadamente sin `roles`: no es un `Actor` y no debe
 * poder usarse donde uno se espera. */
export interface ScreenSessionPrincipal { readonly kind: "pantalla"; readonly sessionId: string; readonly sessionName: string; }

export interface ScreenSessionRepository {
  insert(record: { id: string; name: string; tokenHash: string; createdBy: string; createdAt: Date; expiresAt: Date | null }): Promise<void>;
  list(): Promise<ScreenSessionRecord[]>;
  findById(id: string): Promise<ScreenSessionRecord | null>;
  /** Solo columnas de lectura de pantalla: id, nombre y último uso. `token_hash` nunca sale de la capa de infraestructura. */
  findActiveByTokenHash(tokenHash: string, at: Date): Promise<{ id: string; name: string; lastUsedAt: string | null } | null>;
  touchUsage(id: string, at: Date): Promise<void>;
  /** Revoca solo si la sesión existía y estaba activa; null si ya estaba revocada o no existe. */
  revoke(id: string): Promise<ScreenSessionRecord | null>;
}
export interface ScreenSessionAudit { append(event: { entity: string; entityId: string; event: string; actorId?: string; at: Date; origin: "web"; data?: Record<string, unknown> }): Promise<void>; }
export interface ScreenSessionServiceDependencies { repository: ScreenSessionRepository; audit: ScreenSessionAudit; clock: { now(): Date }; ids: { next(): string }; pepper: string; }

function isAdmin(actor: Actor): boolean { return actor.roles.some((role) => ADMIN_ROLES.has(role)); }
function assertAdmin(actor: Actor): void { if (!isAdmin(actor)) throw new DomainError("FORBIDDEN", "Solo un administrador puede gestionar sesiones de pantalla"); }
function generateRawToken(): string { return `${SCREEN_SESSION_TOKEN_PREFIX}${randomBytes(32).toString("hex")}`; }
function parseExpiry(value: string | null | undefined): Date | null {
  if (value === undefined || value === null) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new DomainError("INVALID_INPUT", "Fecha de expiración inválida");
  return date;
}
function conflict(error: unknown): never {
  if (typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "23505") throw new DomainError("CONFLICT", "Ya existe una sesión de pantalla con ese nombre");
  throw error;
}

export class ScreenSessionService {
  constructor(private readonly deps: ScreenSessionServiceDependencies) {}

  /** Solo un administrador puede ver el inventario de sesiones de pantalla (RF-1104). */
  async list(actor: Actor): Promise<{ sessions: ScreenSessionRecord[] }> { assertAdmin(actor); return { sessions: await this.deps.repository.list() }; }

  /** El token en claro se devuelve UNA sola vez aquí; después solo existe su hash en base de datos. */
  async create(actor: Actor, input: { name: string; expiresAt?: string | null }): Promise<{ session: ScreenSessionRecord; token: string }> {
    assertAdmin(actor);
    const name = input.name.trim();
    if (name.length < 3 || name.length > 120) throw new DomainError("INVALID_INPUT", "El nombre de la sesión debe tener entre 3 y 120 caracteres");
    const now = this.deps.clock.now();
    const expiresAt = parseExpiry(input.expiresAt);
    if (expiresAt && expiresAt.getTime() <= now.getTime()) throw new DomainError("INVALID_INPUT", "La expiración debe ser una fecha futura");
    const id = this.deps.ids.next(), token = generateRawToken(), tokenHash = hmacSha256(token, this.deps.pepper);
    try { await this.deps.repository.insert({ id, name, tokenHash, createdBy: actor.id, createdAt: now, expiresAt }); }
    catch (error) { conflict(error); }
    await this.deps.audit.append({ entity: "sesion_pantalla", entityId: id, event: "SESION_PANTALLA_CREADA", actorId: actor.id, at: now, origin: "web", data: { name } });
    return { session: { id, name, active: true, createdBy: actor.id, createdAt: now.toISOString(), lastUsedAt: null, expiresAt: expiresAt ? expiresAt.toISOString() : null }, token };
  }

  /** Revocación inmediata y auditada. Revocar una sesión ya inactiva es idempotente (no reescribe auditoría);
   * un id inexistente sí es un error, para que el administrador note un id equivocado. */
  async revoke(actor: Actor, id: string): Promise<{ session: ScreenSessionRecord }> {
    assertAdmin(actor);
    const revoked = await this.deps.repository.revoke(id);
    if (revoked) { await this.deps.audit.append({ entity: "sesion_pantalla", entityId: id, event: "SESION_PANTALLA_REVOCADA", actorId: actor.id, at: this.deps.clock.now(), origin: "web" }); return { session: revoked }; }
    const existing = await this.deps.repository.findById(id);
    if (!existing) throw new DomainError("NOT_FOUND", "Sesión de pantalla no encontrada");
    return { session: existing };
  }

  /**
   * ÚNICO punto de entrada que un monitor de oficina puede llamar. Rechaza cualquier cosa que no
   * tenga el prefijo de pantalla sin tocar el repositorio (rechazo barato), nunca devuelve el hash
   * ni cualquier otro dato de `sesiones_pantalla`, y el resultado no tiene forma de `Actor`: no
   * puede colarse en un servicio que decide autorización por rol.
   */
  async authenticate(rawToken: string): Promise<ScreenSessionPrincipal | null> {
    if (typeof rawToken !== "string" || !rawToken.startsWith(SCREEN_SESSION_TOKEN_PREFIX)) return null;
    const now = this.deps.clock.now(), tokenHash = hmacSha256(rawToken, this.deps.pepper);
    const found = await this.deps.repository.findActiveByTokenHash(tokenHash, now);
    if (!found) return null;
    const lastUsedMs = found.lastUsedAt ? new Date(found.lastUsedAt).getTime() : Number.NEGATIVE_INFINITY;
    if (now.getTime() - lastUsedMs >= SCREEN_SESSION_TOUCH_THROTTLE_MS) await this.deps.repository.touchUsage(found.id, now);
    return { kind: "pantalla", sessionId: found.id, sessionName: found.name };
  }
}
