// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessagesScreen } from "../../components/screens/messages";

// La ruta se prueba mockeando el guard de sesión: el objetivo es el contrato de
// seguridad (a quién se entrega la URL), no la integración con Supabase Auth.
vi.mock("../../app/auth-guard", () => ({ getAuthSnapshot: vi.fn() }));
import { getAuthSnapshot } from "../../app/auth-guard";
import { GET } from "../../app/api/kapso-embed/route";

const EMBED = "https://inbox.kapso.ai/embed/token-de-prueba";

describe("/api/kapso-embed — la URL del inbox es credencial portadora", () => {
  beforeEach(() => { vi.restoreAllMocks(); process.env.KAPSO_EMBED_URL = EMBED; });
  afterEach(() => { delete process.env.KAPSO_EMBED_URL; });

  it("entrega la URL solo a una sesión real con rol autorizado", async () => {
    vi.mocked(getAuthSnapshot).mockResolvedValue({ authenticated: true, demoMode: false, role: "Revisor", displayName: "Daniel" });
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: EMBED });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it.each([
    ["sin autenticar", { authenticated: false, demoMode: false, role: "Solicitante" as const, displayName: "" }],
    ["en modo demo", { authenticated: true, demoMode: true, role: "Revisor" as const, displayName: "" }],
    ["con rol no autorizado (Solicitante)", { authenticated: true, demoMode: false, role: "Solicitante" as const, displayName: "" }],
    ["con rol no autorizado (Aprobador)", { authenticated: true, demoMode: false, role: "Aprobador" as const, displayName: "" }],
    ["con rol no autorizado (Contabilidad)", { authenticated: true, demoMode: false, role: "Contabilidad" as const, displayName: "" }],
  ])("nunca filtra la URL %s", async (_caso, snapshot) => {
    vi.mocked(getAuthSnapshot).mockResolvedValue(snapshot);
    const res = await GET();
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain("kapso.ai");
  });

  it("rechaza una URL configurada fuera del dominio kapso.ai o sin HTTPS", async () => {
    vi.mocked(getAuthSnapshot).mockResolvedValue({ authenticated: true, demoMode: false, role: "Administrador Sixteam", displayName: "" });
    for (const mala of ["https://atacante.example.com/embed/x", "http://inbox.kapso.ai/embed/x", "javascript:alert(1)"]) {
      process.env.KAPSO_EMBED_URL = mala;
      const res = await GET();
      expect(res.status, mala).toBe(404);
    }
  });
});

describe("MessagesScreen — el iframe depende del endpoint autenticado", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("monta el iframe cuando el servidor entrega una URL válida", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ url: EMBED }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    render(<MessagesScreen />);
    const iframe = await screen.findByTitle("Bandeja de mensajes Kapso");
    expect(iframe).toHaveAttribute("src", EMBED);
    expect(iframe).toHaveAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");
  });

  it("queda en conexión pendiente cuando el servidor responde 404, sin montar contenido externo", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ estado: "no_disponible" }), { status: 404, headers: { "Content-Type": "application/json" } }),
    );
    render(<MessagesScreen />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "La bandeja está lista para conectarse" })).toBeInTheDocument());
    expect(screen.queryByTitle("Bandeja de mensajes Kapso")).toBeNull();
  });

  it("descarta una URL de dominio no permitido aunque el servidor la entregue", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ url: "https://phishing.example.com/inbox" }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    render(<MessagesScreen />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "La bandeja está lista para conectarse" })).toBeInTheDocument());
    expect(screen.queryByTitle("Bandeja de mensajes Kapso")).toBeNull();
  });
});
