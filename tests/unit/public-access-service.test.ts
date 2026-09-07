import { describe, expect, it } from "vitest";
import type { Actor } from "../../lib/domain";
import { PublicAccessAdminService, type PublicAccessAdminAudit, type PublicAccessAdminRepository, type PublicAccessStatus } from "../../lib/services";

const mizarAdmin: Actor = { id: "mizar-admin", roles: ["admin_mizar"] };
const sixteamAdmin: Actor = { id: "sixteam-admin", roles: ["admin_sixteam"] };
const reviewer: Actor = { id: "revisor-1", roles: ["revisor"] };
const requester: Actor = { id: "solicitante-1", roles: ["solicitante"] };

function deps(status: PublicAccessStatus = { configured: false, updatedAt: null }) {
  const audits: Array<{ entity: string; entityId: string; event: string; actorId?: string; data?: Record<string, unknown> }> = [];
  const setPasswordCalls: Array<{ code: string; actorId: string }> = [];
  const repository: PublicAccessAdminRepository = {
    getStatus: async () => status,
    setPassword: async (code, actorId) => { setPasswordCalls.push({ code, actorId }); status = { configured: true, updatedAt: "2026-09-07T12:00:00.000Z" }; },
  };
  const audit: PublicAccessAdminAudit = { append: async (event) => { audits.push(event); } };
  const service = new PublicAccessAdminService({ repository, audit, clock: { now: () => new Date("2026-09-07T12:00:00.000Z") } });
  return { service, audits, setPasswordCalls };
}

describe("PublicAccessAdminService — administración de la contraseña global del portal", () => {
  it("solo admin_mizar/admin_sixteam pueden consultar o fijar la contraseña", async () => {
    const { service } = deps();
    await expect(service.getStatus(reviewer)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(service.getStatus(requester)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(service.setPassword(reviewer, "contraseña-larga")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(service.getStatus(mizarAdmin)).resolves.toEqual({ configured: false, updatedAt: null });
    await expect(service.getStatus(sixteamAdmin)).resolves.toEqual({ configured: false, updatedAt: null });
  });

  it("rechaza contraseñas de menos de 8 caracteres antes de tocar el repositorio", async () => {
    const { service, setPasswordCalls } = deps();
    await expect(service.setPassword(sixteamAdmin, "corta12")).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(setPasswordCalls).toHaveLength(0);
  });

  // GRAVE (QA Postgres real): el mínimo se medía sobre el texto SIN recortar — ocho espacios en
  // blanco (8 caracteres, cero entropía) pasaban la validación de forma.
  it("rechaza una contraseña que solo llega a 8 caracteres por espacios en blanco (trim antes de medir)", async () => {
    const { service, setPasswordCalls } = deps();
    await expect(service.setPassword(sixteamAdmin, "        ")).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(setPasswordCalls).toHaveLength(0);
  });

  it("recorta espacios al inicio/fin antes de persistir la contraseña", async () => {
    const { service, setPasswordCalls } = deps();
    await service.setPassword(sixteamAdmin, "  contraseña-con-espacios  ");
    expect(setPasswordCalls).toEqual([{ code: "contraseña-con-espacios", actorId: "sixteam-admin" }]);
  });

  it("fija la contraseña, audita quién la cambió SIN el código en claro y devuelve el estado actualizado", async () => {
    const { service, audits, setPasswordCalls } = deps();
    await service.setPassword(mizarAdmin, "contraseña-super-larga");
    expect(setPasswordCalls).toEqual([{ code: "contraseña-super-larga", actorId: "mizar-admin" }]);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ entity: "acceso_publico", entityId: "global", event: "contrasena_actualizada", actorId: "mizar-admin" });
    // El código NUNCA aparece en el evento de auditoría, ni siquiera hasheado.
    expect(JSON.stringify(audits[0])).not.toContain("contraseña-super-larga");
    await expect(service.getStatus(mizarAdmin)).resolves.toEqual({ configured: true, updatedAt: "2026-09-07T12:00:00.000Z" });
  });
});
