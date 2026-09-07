import { beforeEach, describe, expect, it, vi } from "vitest";

// app/api/public-access/route.ts: PATCH fija la contraseña GLOBAL del portal público (solo
// admin_mizar/admin_sixteam); GET informa si hay una configurada y cuándo cambió, nunca el hash. Mismo
// patrón de mocks que tests/unit/public-portal-hardening.test.ts: se sustituyen las dependencias de
// infraestructura para probar SOLO el contrato HTTP (roles, assertSameOrigin, forma del body), no SQL.
const mocks = vi.hoisted(() => ({
  getStatus: vi.fn(),
  setPassword: vi.fn(),
  actor: { id: "actor-1", roles: ["admin_mizar"] as string[] },
}));

vi.mock("../../lib/infrastructure/auth", () => ({
  requireServerActor: async () => mocks.actor,
}));
vi.mock("../../lib/infrastructure/postgres-repositories", () => ({
  createPostgresDependencies: () => ({ audit: { append: async () => {}, list: async () => [] }, clock: { now: () => new Date("2026-09-07T12:00:00.000Z") } }),
}));
vi.mock("../../lib/infrastructure/public-access", () => ({
  createPublicAccessAdminRepository: () => ({ getStatus: mocks.getStatus, setPassword: mocks.setPassword }),
}));

import { GET, PATCH } from "../../app/api/public-access/route";

function patchRequest(body: unknown, origin = "https://app.mizar.test"): Request {
  return new Request("https://app.mizar.test/api/public-access", {
    method: "PATCH",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify(body),
  });
}

describe("PATCH/GET /api/public-access — administración de la contraseña global del portal", () => {
  beforeEach(() => {
    mocks.getStatus.mockReset().mockResolvedValue({ configured: false, updatedAt: null });
    mocks.setPassword.mockReset().mockResolvedValue(undefined);
    mocks.actor = { id: "actor-1", roles: ["admin_mizar"] };
    process.env.NEXT_PUBLIC_APP_URL = "https://app.mizar.test";
  });

  it("GET nunca expone el hash: solo configured/updatedAt", async () => {
    mocks.getStatus.mockResolvedValue({ configured: true, updatedAt: "2026-09-07T10:00:00.000Z" });
    const response = await GET();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ configured: true, updatedAt: "2026-09-07T10:00:00.000Z" });
    expect(JSON.stringify(body)).not.toMatch(/hash|\$2[aby]\$/i);
  });

  it("PATCH rechaza a un rol sin permiso (revisor) con 403, sin llamar a setPassword", async () => {
    mocks.actor = { id: "revisor-1", roles: ["revisor"] };
    const response = await PATCH(patchRequest({ code: "contraseña-larga" }));
    expect(response.status).toBe(403);
    expect(mocks.setPassword).not.toHaveBeenCalled();
  });

  it("PATCH rechaza códigos de menos de 8 caracteres con 400, sin llamar a setPassword", async () => {
    const response = await PATCH(patchRequest({ code: "corta1" }));
    expect(response.status).toBe(400);
    expect(mocks.setPassword).not.toHaveBeenCalled();
  });

  it("PATCH rechaza un origen distinto al configurado", async () => {
    const response = await PATCH(patchRequest({ code: "contraseña-larga" }, "https://evil.test"));
    expect(response.status).toBe(403);
    expect(mocks.setPassword).not.toHaveBeenCalled();
  });

  it("PATCH con rol permitido y código válido llama a setPassword y devuelve el estado actualizado", async () => {
    // El PATCH exitoso hace un único getStatus() al final (para devolver el estado ya fijado).
    mocks.getStatus.mockResolvedValue({ configured: true, updatedAt: "2026-09-07T12:00:00.000Z" });
    const response = await PATCH(patchRequest({ code: "contraseña-larga" }));
    expect(response.status).toBe(200);
    expect(mocks.setPassword).toHaveBeenCalledWith("contraseña-larga", "actor-1");
    const body = await response.json();
    expect(body).toEqual({ configured: true, updatedAt: "2026-09-07T12:00:00.000Z" });
  });
});
