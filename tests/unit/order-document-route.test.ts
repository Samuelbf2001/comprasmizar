import { inflateSync } from "node:zlib";
import { beforeEach, describe, expect, it, vi } from "vitest";

// GET /api/orders/[id]/document — ítem 4 del encargo (feat/solicitud-de-pago): antes de esta
// prueba, los datos bancarios del beneficiario (proveedores.datos_bancarios) nunca salían de la
// ficha del proveedor — nada ejercitaba la ruta completa (permiso + join de catálogos + PDF) con un
// actor real. "Lección del día: probar el actor completo, no los extremos" — dos actores
// COMPLETOS (contabilidad con order:read, y uno sin ese permiso), no un mock que salte la
// autorización.
//
// Mismo patrón de mocks que tests/unit/public-access-route.test.ts: se sustituyen las
// dependencias de infraestructura para probar el contrato HTTP + el ensamblado del documento, no SQL.
// vi.hoisted: vi.mock() se eleva por encima de los imports, así que cualquier dato que sus
// factories necesiten (order/requisition/supplier, no solo el actor) debe vivir aquí — un `const`
// normal declarado más abajo no está garantizado disponible para el factory en ese punto.
const mocks = vi.hoisted(() => {
  const order = {
    id: "order-1",
    consecutive: "OP-2026-0001",
    type: "OP" as const,
    requisitionId: "req-1",
    supplierId: "supplier-1",
    itemIds: ["item-1"],
    status: "generada" as const,
    adminStatus: "pendiente" as const,
    generatedAt: "2026-09-05T00:00:00.000Z",
  };
  const requisition = {
    id: "req-1",
    consecutive: "REQ-2026-0001",
    type: "pago" as const,
    societyId: "society-1",
    workId: "work-1",
    requesterId: "req-user",
    channel: "web" as const,
    status: "aprobada" as const,
    approverId: "approver-1",
    items: [
      {
        id: "item-1",
        description: "Pago acta 3 - Contratista ABC",
        quantity: 1,
        unit: "servicio",
        unitBase: 500_000,
        ivaRate: 0.19,
        finalSupplierId: "supplier-1",
      },
    ],
  };
  const supplier = {
    id: "supplier-1",
    name: "Contratista ABC S.A.S.",
    nit: "900111222-3",
    contact: { name: "Ana Ríos", phone: "3000000000", email: "ana@contratista.test", address: "Calle 1 # 2-3" },
    bankDetails: {
      bankName: "Bancolombia",
      accountType: "ahorros" as const,
      accountNumber: "123-456789-00",
      accountHolder: "Contratista ABC S.A.S.",
      accountHolderNit: "900111222-3",
    },
    active: true,
  };
  return { actor: { id: "cont-1", roles: ["contabilidad"] as string[] }, order, requisition, supplier };
});

vi.mock("../../lib/infrastructure/auth", () => ({
  requireServerActor: async () => mocks.actor,
}));
vi.mock("../../lib/infrastructure/postgres-repositories", () => ({
  createPostgresDependencies: () => ({
    requisitions: { get: async (id: string) => (id === mocks.requisition.id ? mocks.requisition : null) },
    orders: { listVisibleTo: async () => [mocks.order] },
    catalogs: {
      get: async (kind: string, id: string) => {
        if (kind === "works" && id === "work-1") return { id, name: "Obra Prueba", active: true };
        if (kind === "societies" && id === "society-1") return { id, name: "Constructora Ejemplo", nit: "900000000-1" };
        if (kind === "users" && id === "approver-1") return { id, name: "Nelson Ortiz" };
        if (kind === "users" && id === "elaborator-1") return { id, name: "Daniel Ramírez" };
        return null;
      },
    },
    audit: {
      list: async () => [{ entity: "orden", entityId: mocks.order.id, event: "generada", actorId: "elaborator-1", at: new Date(), origin: "web" as const }],
      append: async () => {},
    },
  }),
}));
vi.mock("../../lib/infrastructure/supplier-repositories", () => ({
  createPostgresSupplierRepository: () => ({ get: async (id: string) => (id === mocks.supplier.id ? mocks.supplier : null) }),
}));

import { GET } from "../../app/api/orders/[id]/document/route";

/** Mismo helper que tests/unit/order-document-pdf.test.ts para leer el texto de un PDF de pdf-lib. */
function extractPdfText(bytes: ArrayBuffer): string {
  const raw = Buffer.from(bytes).toString("latin1");
  const chunks: string[] = [];
  for (const match of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    let content: string;
    try {
      content = inflateSync(Buffer.from(match[1], "latin1")).toString("latin1");
    } catch {
      continue;
    }
    for (const literal of content.matchAll(/\(((?:[^()\\]|\\.)*)\)|<([0-9A-Fa-f\s]+)>/g)) {
      if (literal[1] !== undefined) chunks.push(literal[1].replace(/\\([()\\])/g, "$1"));
      else if (literal[2] !== undefined) chunks.push(Buffer.from(literal[2].replace(/\s/g, ""), "hex").toString("latin1"));
    }
  }
  return chunks.join(" ");
}

describe("GET /api/orders/[id]/document — actor completo (feat/solicitud-de-pago)", () => {
  beforeEach(() => {
    mocks.actor = { id: "cont-1", roles: ["contabilidad"] };
  });

  it("contabilidad (order:read) descarga la OP con los datos bancarios del beneficiario", async () => {
    const response = await GET(new Request("http://localhost/api/orders/order-1/document"), { params: Promise.resolve({ id: "order-1" }) });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/pdf");
    const text = extractPdfText(await response.arrayBuffer());
    expect(text).toContain("ORDEN DE PAGO");
    expect(text).toContain("Pago acta 3 - Contratista ABC");
    expect(text).toContain("DATOS BANCARIOS");
    expect(text).toContain("Bancolombia");
    expect(text).toContain("123-456789-00");
  });

  it("un actor sin order:read (solicitante) recibe 403, no el PDF", async () => {
    mocks.actor = { id: "sol-1", roles: ["solicitante"] };
    const response = await GET(new Request("http://localhost/api/orders/order-1/document"), { params: Promise.resolve({ id: "order-1" }) });
    expect(response.status).toBe(403);
    expect(response.headers.get("Content-Type")).not.toBe("application/pdf");
  });
});
