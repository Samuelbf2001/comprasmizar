// @vitest-environment jsdom

// Complemento de hallazgos-permisos-cache-visor.test.tsx: el id de quien mira tiene que LLEGAR desde
// el servidor hasta `vincularCachesAlVisor`, y antes de que las pantallas lean las cachés. Sin esta
// cadena, la función existe pero nadie la llama con el visor correcto.
import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ vincular: vi.fn(), actor: { id: "claudia-1", roles: ["contabilidad"], displayName: "Claudia", email: "c@x.co" } }));

vi.mock("next/navigation", () => ({ usePathname: () => "/ordenes", useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }) }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("../../lib/infrastructure/auth", () => ({ resolveServerActor: async () => mocks.actor }));
vi.mock("../../lib/security/demo-mode", () => ({ demoModeEnabled: () => false }));
vi.mock("../../components/screens/connected/data", async (original) => ({
  ...(await original<typeof import("../../components/screens/connected/data")>()),
  vincularCachesAlVisor: mocks.vincular,
}));

import { getAuthSnapshot } from "../../app/auth-guard";
import MizarApp from "../../components/mizar-app";

describe("el visor viaja del servidor a las cachés de cliente", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    mocks.vincular.mockReset();
  });

  it("getAuthSnapshot entrega el id de quien mira", async () => {
    expect(await getAuthSnapshot()).toMatchObject({ authenticated: true, role: "Contabilidad", viewerId: "claudia-1" });
  });

  it("MizarApp vincula las cachés a ese visor al pintar", () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise<Response>(() => {}));
    render(<MizarApp initialRole="Contabilidad" viewerId="claudia-1" actorName="Claudia" />);
    expect(mocks.vincular).toHaveBeenCalledWith("claudia-1");
  });

  it("en modo demo no hay cuenta real que vincular", () => {
    render(<MizarApp initialRole="Revisor" demoMode />);
    expect(mocks.vincular).not.toHaveBeenCalled();
  });
});
