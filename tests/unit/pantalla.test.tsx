// @vitest-environment jsdom

/**
 * RF-1104: modo pantalla. Cubre las dos piezas que un validador anterior encontró sin consumir:
 * GET /api/pantalla (app/api/pantalla/route.ts) y el cliente de kiosco (app/pantalla/pantalla-client.tsx).
 * No repite las pruebas de ScreenSessionService (ya cubiertas en tests/unit/screen-session.test.ts) — aquí
 * se usa una instancia real de ese servicio con un repositorio en memoria, para ejercer authenticate()
 * de verdad en vez de simularlo.
 */
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Expense, Order, Requisition } from "../../lib/domain";
import {
  ScreenSessionService,
  type ScreenSessionRepository,
  type ScreenSessionServiceDependencies,
} from "../../lib/services/screen-session-service";

const mocks = vi.hoisted(() => ({
  screenSessionDeps: undefined as ScreenSessionServiceDependencies | undefined,
  postgresDeps: undefined as { requisitions: { list: () => Promise<Requisition[]> }; expenses: { list: () => Promise<Expense[]> }; orders: { list: () => Promise<Order[]> } } | undefined,
}));

vi.mock("../../lib/infrastructure/screen-session-repository", () => ({
  createScreenSessionServiceDependencies: () => mocks.screenSessionDeps,
}));
vi.mock("../../lib/infrastructure/postgres-repositories", () => ({
  createPostgresDependencies: () => mocks.postgresDeps,
}));

import { GET } from "../../app/api/pantalla/route";
import { PantallaClient } from "../../app/pantalla/pantalla-client";

/** Un repositorio de sesiones de pantalla en memoria — el mismo contrato que implementa
 *  lib/infrastructure/screen-session-repository.ts contra Postgres, sin la base de datos. */
function inMemoryScreenSessionDeps(): ScreenSessionServiceDependencies {
  const rows = new Map<string, { id: string; tokenHash: string; active: boolean }>();
  const repository: ScreenSessionRepository = {
    insert: async (record) => { rows.set(record.id, { id: record.id, tokenHash: record.tokenHash, active: true }); },
    list: async () => [],
    findById: async () => null,
    findActiveByTokenHash: async (tokenHash) => {
      const row = [...rows.values()].find((entry) => entry.tokenHash === tokenHash && entry.active);
      return row ? { id: row.id, name: "TV oficina", lastUsedAt: null } : null;
    },
    touchUsage: async () => {},
    revoke: async (id) => {
      const row = rows.get(id);
      if (!row || !row.active) return null;
      row.active = false;
      return { id, name: "TV oficina", active: false, createdBy: "admin-1", createdAt: new Date().toISOString(), lastUsedAt: null, expiresAt: null };
    },
  };
  return { repository, audit: { append: async () => {} }, clock: { now: () => new Date("2026-08-24T12:00:00.000Z") }, ids: { next: () => `screen-${rows.size + 1}` }, pepper: "p".repeat(32) };
}

const requesterName = "Juliana Pérez", requesterPhone = "+573001112233";
function fixtureCollections(): { requisitions: Requisition[]; expenses: Expense[]; orders: Order[] } {
  const items = [{ id: "item-1", description: "Cemento", quantity: 2, unit: "bulto", unitBase: 50_000, unitIva: 9_500 }];
  const requisitions: Requisition[] = [
    { id: "req-1", consecutive: "REQ-2026-0001", type: "compra", workId: "work-1", requesterId: "user-1", channel: "web", requiredDate: "2026-08-20", status: "en_revision", items },
    { id: "req-2", consecutive: "REQ-2026-0002", type: "compra", workId: "work-2", channel: "publico", requiredDate: "2026-08-21", status: "en_aprobacion", externalRequester: { name: requesterName, phone: requesterPhone }, items },
    { id: "req-3", consecutive: "REQ-2026-0003", type: "compra", workId: "work-1", requesterId: "user-2", channel: "web", requiredDate: "2026-08-19", status: "aprobada", items },
  ];
  const orders: Order[] = [
    { id: "order-1", consecutive: "OC-2026-0001", type: "OC", requisitionId: "req-3", supplierId: "supplier-1", itemIds: ["item-1"], status: "generada" },
  ];
  const period = new Date().toISOString().slice(0, 7);
  const expenses: Expense[] = [
    { id: "exp-1", workId: "work-1", origin: "requisicion", referenceId: "order-1", tagId: "tag-1", supplierId: "supplier-1", date: `${period}-05`, base: 100_000, iva: 19_000, total: 119_000, period },
  ];
  return { requisitions, expenses, orders };
}

function requestWithToken(token?: string): Request {
  return new Request("http://localhost/api/pantalla", { headers: token !== undefined ? { "x-pantalla-token": token } : {} });
}

describe("GET /api/pantalla", () => {
  beforeEach(() => {
    mocks.screenSessionDeps = inMemoryScreenSessionDeps();
    const { requisitions, expenses, orders } = fixtureCollections();
    mocks.postgresDeps = { requisitions: { list: async () => requisitions }, expenses: { list: async () => expenses }, orders: { list: async () => orders } };
  });

  it("responde 404 neutro sin token", async () => {
    const response = await GET(requestWithToken());
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });

  it("responde 404 neutro con un token que no existe", async () => {
    const response = await GET(requestWithToken("mizar_pantalla_" + "0".repeat(64)));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });

  it("responde 404 neutro con una cadena sin el prefijo de pantalla", async () => {
    const response = await GET(requestWithToken("cualquier-cosa"));
    expect(response.status).toBe(404);
  });

  it("responde 200 con métricas agregadas para un token de pantalla válido", async () => {
    const service = new ScreenSessionService(mocks.screenSessionDeps!);
    const { token } = await service.create({ id: "admin-1", roles: ["admin_mizar"] }, { name: "TV oficina" });

    const response = await GET(requestWithToken(token));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body.sessionName).toBe("TV oficina");
    expect(body.metrics.byStatus).toMatchObject({ en_revision: 1, en_aprobacion: 1, aprobada: 1 });
    expect(body.metrics.inProcessValue).toBe(119_000 * 2); // req-1 (en_revision) + req-2 (en_aprobacion), misma línea cada una
    expect(body.metrics.periodExpense).toBe(119_000);
    expect(body.metrics.pendingOrders).toBe(1);
    expect(body.metrics.expenseByWork).toEqual([{ key: "work-1", total: 119_000 }]);
  });

  it("nunca incluye nombres, teléfonos, ids ni consecutivos de requisiciones individuales", async () => {
    const service = new ScreenSessionService(mocks.screenSessionDeps!);
    const { token } = await service.create({ id: "admin-1", roles: ["admin_mizar"] }, { name: "TV oficina" });

    const response = await GET(requestWithToken(token));
    const raw = JSON.stringify(await response.json());

    for (const forbidden of [requesterName, requesterPhone, "req-1", "req-2", "req-3", "REQ-2026", "OC-2026", "requesterId", "externalRequester", "attentionQueue", "recentActivity", "consecutive", "declineReason", "returnReason"]) {
      expect(raw).not.toContain(forbidden);
    }
  });

  it("un token revocado deja de autenticar de inmediato — vuelve el 404 neutro", async () => {
    const service = new ScreenSessionService(mocks.screenSessionDeps!);
    const { token, session } = await service.create({ id: "admin-1", roles: ["admin_mizar"] }, { name: "TV oficina" });
    expect((await GET(requestWithToken(token))).status).toBe(200);

    await service.revoke({ id: "admin-1", roles: ["admin_mizar"] }, session.id);

    const response = await GET(requestWithToken(token));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });
});

describe("PantallaClient", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    window.history.replaceState(null, "", "/pantalla");
    window.sessionStorage.clear();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
    window.history.replaceState(null, "", "/pantalla");
    window.sessionStorage.clear();
  });

  it('muestra "Pantalla no autorizada" y no llama a la red cuando no hay token', async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    render(<PantallaClient />);
    expect(await screen.findByText("Pantalla no autorizada")).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("lee el token del fragmento, limpia el hash y consulta /api/pantalla con el header x-pantalla-token", async () => {
    const token = "mizar_pantalla_" + "a".repeat(64);
    window.history.replaceState(null, "", `/pantalla#${token}`);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ sessionName: "TV oficina", period: "2026-08", metrics: { byStatus: { en_revision: 2 }, inProcessValue: 0, periodExpense: 0, pendingOrders: 0, expenseByWork: [], expenseByTag: [], expenseByPeriod: [] } }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );

    render(<PantallaClient />);

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith("/api/pantalla", expect.objectContaining({ headers: { "x-pantalla-token": token } })));
    expect(window.location.hash).toBe("");
    expect(window.sessionStorage.getItem("mizar_pantalla_token")).toBe(token);
    expect(await screen.findByText("TV oficina")).toBeInTheDocument();
  });

  it("reutiliza el token guardado en sessionStorage cuando no hay fragmento (recarga de la pantalla)", async () => {
    const token = "mizar_pantalla_" + "b".repeat(64);
    window.sessionStorage.setItem("mizar_pantalla_token", token);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ sessionName: "TV oficina", period: "2026-08", metrics: { byStatus: {}, inProcessValue: 0, periodExpense: 0, pendingOrders: 0, expenseByWork: [], expenseByTag: [], expenseByPeriod: [] } }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );

    render(<PantallaClient />);

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith("/api/pantalla", expect.objectContaining({ headers: { "x-pantalla-token": token } })));
  });

  it("la revocación surte efecto en máximo un ciclo: un refresco con 404 vuelve al estado no autorizado", async () => {
    vi.useFakeTimers();
    const token = "mizar_pantalla_" + "c".repeat(64);
    window.history.replaceState(null, "", `/pantalla#${token}`);
    const okResponse = () => new Response(JSON.stringify({ sessionName: "TV oficina", period: "2026-08", metrics: { byStatus: {}, inProcessValue: 0, periodExpense: 0, pendingOrders: 0, expenseByWork: [], expenseByTag: [], expenseByPeriod: [] } }), { status: 200, headers: { "Content-Type": "application/json" } });
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(okResponse())
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "not_found" }), { status: 404 }));

    render(<PantallaClient />);
    // El primer refresco se dispara de inmediato (no depende del timer); se drena con el reloj falso
    // porque avanzarlo también procesa la cola de microtareas entre pasos.
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText("TV oficina")).toBeInTheDocument();

    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Pantalla no autorizada")).toBeInTheDocument();
    expect(window.sessionStorage.getItem("mizar_pantalla_token")).toBeNull();

    // Un tercer ciclo no debería seguir golpeando la red: la sesión de refresco se detuvo.
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("una falla de red en el refresco también hace fallar cerrado al estado no autorizado", async () => {
    const token = "mizar_pantalla_" + "d".repeat(64);
    window.history.replaceState(null, "", `/pantalla#${token}`);
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));

    render(<PantallaClient />);

    expect(await screen.findByText("Pantalla no autorizada")).toBeInTheDocument();
  });
});
