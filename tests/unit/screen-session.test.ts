import { describe, expect, it } from "vitest";
import { hasPermission } from "../../lib/domain";
import {
  SCREEN_SESSION_TOKEN_PREFIX,
  SCREEN_SESSION_TOUCH_THROTTLE_MS,
  ScreenSessionService,
  type ScreenSessionRecord,
  type ScreenSessionRepository,
  type ScreenSessionServiceDependencies,
} from "../../lib/services/screen-session-service";

const admin = { id: "admin-mizar", roles: ["admin_mizar"] as const };
const sixteamAdmin = { id: "admin-sixteam", roles: ["admin_sixteam"] as const };
const reviewer = { id: "reviewer-1", roles: ["revisor"] as const };
const approver = { id: "approver-1", roles: ["aprobador"] as const };
const requester = { id: "requester-1", roles: ["solicitante"] as const };
const accountant = { id: "accountant-1", roles: ["contabilidad"] as const };
const nonAdmins = [reviewer, approver, requester, accountant];

interface StoredRow { id: string; name: string; tokenHash: string; active: boolean; createdBy: string; createdAt: Date; lastUsedAt: Date | null; expiresAt: Date | null }

function fixture(startingAt = new Date("2026-08-24T12:00:00.000Z")) {
  let clockNow = startingAt;
  const rows = new Map<string, StoredRow>();
  const touches: string[] = [];
  const audits: Array<{ entity: string; entityId: string; event: string; actorId?: string; data?: Record<string, unknown> }> = [];
  let findActiveCalls = 0, nextId = 1;

  const toRecord = (row: StoredRow): ScreenSessionRecord => ({ id: row.id, name: row.name, active: row.active, createdBy: row.createdBy, createdAt: row.createdAt.toISOString(), lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null, expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null });

  const repository: ScreenSessionRepository = {
    insert: async (record) => {
      if ([...rows.values()].some((row) => row.name === record.name)) throw Object.assign(new Error("duplicate"), { code: "23505" });
      rows.set(record.id, { id: record.id, name: record.name, tokenHash: record.tokenHash, active: true, createdBy: record.createdBy, createdAt: record.createdAt, lastUsedAt: null, expiresAt: record.expiresAt });
    },
    list: async () => [...rows.values()].map(toRecord),
    findById: async (id) => { const row = rows.get(id); return row ? toRecord(row) : null; },
    findActiveByTokenHash: async (tokenHash, at) => {
      findActiveCalls++;
      const row = [...rows.values()].find((entry) => entry.tokenHash === tokenHash);
      if (!row || !row.active) return null;
      if (row.expiresAt && row.expiresAt.getTime() <= at.getTime()) return null;
      return { id: row.id, name: row.name, lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null };
    },
    touchUsage: async (id, at) => { touches.push(id); const row = rows.get(id); if (row) row.lastUsedAt = at; },
    revoke: async (id) => { const row = rows.get(id); if (!row || !row.active) return null; row.active = false; return toRecord(row); },
  };
  const deps: ScreenSessionServiceDependencies = {
    repository,
    audit: { append: async (event) => { audits.push(event); } },
    clock: { now: () => clockNow },
    ids: { next: () => `session-${nextId++}` },
    pepper: "p".repeat(32),
  };
  return {
    service: new ScreenSessionService(deps),
    rows, touches, audits,
    advance: (date: Date) => { clockNow = date; },
    findActiveCallCount: () => findActiveCalls,
    rawRow: (id: string) => rows.get(id),
  };
}

describe("ScreenSessionService", () => {
  it("gates create, list and revoke behind an administrator role", async () => {
    for (const actor of nonAdmins) {
      const state = fixture();
      await expect(state.service.create(actor, { name: "Monitor recepción" })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(state.service.list(actor)).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(state.service.revoke(actor, "any-id")).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    const asMizar = fixture();
    await expect(asMizar.service.create(admin, { name: "Monitor recepción" })).resolves.toMatchObject({ session: { active: true } });
    const asSixteam = fixture();
    await expect(asSixteam.service.create(sixteamAdmin, { name: "Monitor recepción" })).resolves.toMatchObject({ session: { active: true } });
  });

  it("issues a one-time hashed token and never leaks it through list() or the stored record", async () => {
    const state = fixture();
    const created = await state.service.create(admin, { name: "Monitor recepción" });
    expect(created.token.startsWith(SCREEN_SESSION_TOKEN_PREFIX)).toBe(true);
    expect(JSON.stringify(created.session)).not.toContain(created.token);
    const stored = state.rawRow(created.session.id);
    expect(stored?.tokenHash).toBeTruthy();
    expect(stored?.tokenHash).not.toBe(created.token);
    const { sessions } = await state.service.list(admin);
    expect(JSON.stringify(sessions)).not.toContain(created.token);
    expect(JSON.stringify(sessions)).not.toContain(stored?.tokenHash);
    expect(sessions).toMatchObject([{ id: created.session.id, name: "Monitor recepción", active: true }]);
  });

  it("authenticates only the exact raw token, never its hash nor an unrelated string", async () => {
    const state = fixture();
    const created = await state.service.create(admin, { name: "Monitor recepción" });
    await expect(state.service.authenticate(created.token)).resolves.toEqual({ kind: "pantalla", sessionId: created.session.id, sessionName: "Monitor recepción" });
    const stored = state.rawRow(created.session.id);
    await expect(state.service.authenticate(stored!.tokenHash)).resolves.toBeNull();
    await expect(state.service.authenticate("not-a-screen-token")).resolves.toBeNull();
    // El rechazo por prefijo es barato: ni siquiera debe tocar el repositorio.
    expect(state.findActiveCallCount()).toBe(1);
  });

  it("revokes immediately: a revoked token stops authenticating right away, and revocation is audited", async () => {
    const state = fixture();
    const created = await state.service.create(admin, { name: "Monitor recepción" });
    await expect(state.service.authenticate(created.token)).resolves.not.toBeNull();
    const revoked = await state.service.revoke(admin, created.session.id);
    expect(revoked.session.active).toBe(false);
    await expect(state.service.authenticate(created.token)).resolves.toBeNull();
    expect(state.audits.map((event) => event.event)).toEqual(["SESION_PANTALLA_CREADA", "SESION_PANTALLA_REVOCADA"]);
    // Revocar dos veces es idempotente: no falla ni duplica el evento de auditoría.
    const revokedAgain = await state.service.revoke(admin, created.session.id);
    expect(revokedAgain.session.active).toBe(false);
    expect(state.audits.filter((event) => event.event === "SESION_PANTALLA_REVOCADA")).toHaveLength(1);
    await expect(state.service.revoke(admin, "no-existe")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("stops authenticating an expired session without requiring explicit revocation", async () => {
    const state = fixture(new Date("2026-08-24T12:00:00.000Z"));
    const created = await state.service.create(admin, { name: "Monitor bodega", expiresAt: "2026-08-24T12:30:00.000Z" });
    await expect(state.service.authenticate(created.token)).resolves.not.toBeNull();
    state.advance(new Date("2026-08-24T12:30:01.000Z"));
    await expect(state.service.authenticate(created.token)).resolves.toBeNull();
    await expect(state.service.create(admin, { name: "Otro monitor", expiresAt: "2020-01-01T00:00:00.000Z" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("throttles the last-used heartbeat instead of writing on every dashboard auto-refresh", async () => {
    const state = fixture(new Date("2026-08-24T12:00:00.000Z"));
    const created = await state.service.create(admin, { name: "Monitor recepción" });
    await state.service.authenticate(created.token);
    expect(state.touches).toEqual([created.session.id]);
    state.advance(new Date("2026-08-24T12:01:00.000Z"));
    await state.service.authenticate(created.token);
    expect(state.touches).toEqual([created.session.id]); // dentro del umbral: no vuelve a escribir
    state.advance(new Date(new Date("2026-08-24T12:01:00.000Z").getTime() + SCREEN_SESSION_TOUCH_THROTTLE_MS + 1));
    await state.service.authenticate(created.token);
    expect(state.touches).toEqual([created.session.id, created.session.id]); // pasado el umbral, sí
  });

  it("validates the session name and surfaces duplicate names as a conflict", async () => {
    const state = fixture();
    await expect(state.service.create(admin, { name: "ab" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await state.service.create(admin, { name: "Monitor recepción" });
    await expect(state.service.create(admin, { name: "Monitor recepción" })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("returns a principal with no role-shaped surface at all — it cannot substitute for an authenticated Actor", async () => {
    const state = fixture();
    const created = await state.service.create(admin, { name: "Monitor recepción" });
    const principal = await state.service.authenticate(created.token);
    expect(principal).not.toBeNull();
    expect("roles" in (principal as object)).toBe(false);
    expect(principal?.kind).toBe("pantalla");
    // Aunque alguien fuerce el tipo para intentar reutilizarlo como Actor, no trae roles: toda
    // verificación de permisos por rol lo rechaza, incluida la lectura del dashboard.
    const forcedActor = { id: principal!.sessionId, roles: (principal as unknown as { roles?: readonly string[] }).roles ?? [] };
    for (const permission of ["dashboard:read", "requisition:read", "requisition:create", "catalog:manage", "report:export"]) {
      expect(hasPermission(forcedActor.roles as never, permission)).toBe(false);
    }
  });

  it("exposes no method beyond session lifecycle management and read-only authentication", () => {
    const methodNames = Object.getOwnPropertyNames(ScreenSessionService.prototype).filter((name) => name !== "constructor");
    expect(methodNames.sort()).toEqual(["authenticate", "create", "list", "revoke"]);
  });
});
