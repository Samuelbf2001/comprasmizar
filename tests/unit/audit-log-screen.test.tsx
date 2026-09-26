// @vitest-environment jsdom

// Historial de cambios (ADM-08 / RF-1003, 25-sep-2026): la pantalla pinta lo que ya viene traducido
// de GET /api/audit. Aquí se fija que: renderiza la tabla con quién/qué/sobre qué/origen, no pinta un
// solo UUID, cada filtro viaja en la URL, «Ver detalle» despliega el antes/después, «Cargar más» usa el
// cursor, y los estados vacío y de error se comportan como el resto de pantallas conectadas.
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuditLogScreen } from "../../components/screens/audit-log";

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const DANIEL = "10000000-0000-4000-8000-000000000002";

const entry = (key: string, overrides: Record<string, unknown> = {}) => ({
  key,
  at: "2026-09-25T15:30:00.123456Z",
  actor: "Daniel Hernández",
  action: "Aprobó la requisición",
  subject: "REQ-2026-0045",
  entityLabel: "Requisición",
  origin: "web",
  originLabel: "Plataforma web",
  details: [{ label: "Estado", before: "En aprobación", after: "Aprobada" }],
  ...overrides,
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

let auditResponses: Array<() => Response>;
let auditUrls: string[];
beforeEach(() => {
  vi.restoreAllMocks();
  auditUrls = [];
  auditResponses = [];
  vi.spyOn(globalThis, "fetch").mockImplementation((input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/catalogs") return Promise.resolve(json({ users: [{ id: DANIEL, name: "Daniel Hernández" }], works: [], tags: [], suppliers: [], items: [] }));
    if (url.startsWith("/api/audit")) {
      auditUrls.push(url);
      const next = auditResponses.shift();
      return Promise.resolve(next ? next() : json({ rows: [], nextCursor: null }));
    }
    return Promise.reject(new Error(`fetch no esperado: ${url}`));
  });
});
afterEach(() => cleanup());

describe("AuditLogScreen", () => {
  it("pinta la tabla en lenguaje de negocio, sin UUID, y despliega el antes/después", async () => {
    auditResponses.push(() => json({
      rows: [
        entry("10"),
        entry("9", { action: "Cambió el aprobador de Nelson Rincón a Juliana Rojas", subject: "Materiales", entityLabel: "Etiqueta", details: [{ label: "Aprobador", before: "Nelson Rincón", after: "Juliana Rojas" }] }),
        entry("8", { actor: "Portal público", action: "Radicó una requisición por el portal público", origin: "publico", originLabel: "Portal público", details: [] }),
      ],
      nextCursor: null,
    }));
    render(<AuditLogScreen />);
    expect(screen.getByRole("heading", { name: "Historial de cambios" })).toBeInTheDocument();
    expect(screen.getByTestId("audit-skeleton")).toBeInTheDocument();
    expect(await screen.findByText("Cambió el aprobador de Nelson Rincón a Juliana Rojas")).toBeInTheDocument();
    expect(screen.getAllByText("REQ-2026-0045")).toHaveLength(2);
    expect(screen.getByText("Materiales")).toBeInTheDocument();
    for (const header of ["Fecha y hora", "Quién", "Qué pasó", "Sobre qué", "Origen"]) expect(screen.getByRole("columnheader", { name: header })).toBeInTheDocument();
    // Sin detalle no hay botón (la radicación pública no trae antes/después).
    expect(screen.getAllByRole("button", { name: /Ver detalle/ })).toHaveLength(2);
    const [, toggle] = screen.getAllByRole("button", { name: /Ver detalle/ });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Nelson Rincón")).toBeInTheDocument();
    expect(screen.getByText("Juliana Rojas")).toBeInTheDocument();
    expect(document.body.textContent ?? "").not.toMatch(UUID_RE);
  });

  it("cada filtro viaja en la URL y «Limpiar filtros» vuelve a la vista completa", async () => {
    render(<AuditLogScreen />);
    await screen.findByText("Todavía no hay cambios registrados");
    await screen.findByRole("option", { name: "Daniel Hernández" });
    fireEvent.change(screen.getByLabelText("Sobre qué"), { target: { value: "pago" } });
    await waitFor(() => expect(auditUrls.at(-1)).toContain("entity=pago"));
    fireEvent.change(screen.getByLabelText("Origen"), { target: { value: "whatsapp" } });
    fireEvent.change(screen.getByLabelText("Quién"), { target: { value: DANIEL } });
    fireEvent.change(screen.getByLabelText("Qué pasó"), { target: { value: "aprobacion" } });
    fireEvent.change(screen.getByLabelText("Desde"), { target: { value: "2026-09-01" } });
    fireEvent.change(screen.getByLabelText("Hasta"), { target: { value: "2026-09-30" } });
    await waitFor(() => {
      const url = new URL(auditUrls.at(-1)!, "https://x.test");
      expect(Object.fromEntries(url.searchParams)).toEqual({ limit: "50", entity: "pago", origin: "whatsapp", actor: DANIEL, event: "aprobacion", from: "2026-09-01", to: "2026-09-30" });
    });
    expect(await screen.findByText("No hay cambios con estos filtros")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Limpiar filtros" })[0]);
    await waitFor(() => expect(auditUrls.at(-1)).toBe("/api/audit?limit=50"));
  });

  it("«Cargar más» pide la página siguiente con el cursor y la agrega abajo", async () => {
    auditResponses.push(() => json({ rows: [entry("10")], nextCursor: "CURSOR-1" }));
    auditResponses.push(() => json({ rows: [entry("9", { subject: "REQ-2026-0001" })], nextCursor: null }));
    render(<AuditLogScreen />);
    fireEvent.click(await screen.findByRole("button", { name: "Cargar más" }));
    expect(await screen.findByText("REQ-2026-0001")).toBeInTheDocument();
    expect(screen.getByText("REQ-2026-0045")).toBeInTheDocument();
    expect(auditUrls.at(-1)).toContain("cursor=CURSOR-1");
    expect(screen.queryByRole("button", { name: "Cargar más" })).toBeNull();
  });

  it("muestra el error con «Reintentar» y vuelve a pedir", async () => {
    auditResponses.push(() => json({ error: "forbidden" }, 403));
    auditResponses.push(() => json({ rows: [entry("10")], nextCursor: null }));
    render(<AuditLogScreen />);
    expect(await screen.findByRole("alert")).toHaveTextContent("No tienes permiso para esto");
    fireEvent.click(screen.getByRole("button", { name: /Reintentar/ }));
    expect(await screen.findByText("Aprobó la requisición")).toBeInTheDocument();
  });
});
