// @vitest-environment jsdom

// Revisión de una solicitud de pago (adenda de pagos, S2): el valor es editable y se muestra el
// original cuando difiere (RF-307/D5), la empresa facturada arranca con la guardada/derivada y viaja
// en review() (RF-009), y "Aprobar yo mismo" (RF-308/A9) guarda la revisión con el propio visor como
// aprobador ANTES de `send_and_approve` — y solo se ofrece a quien tiene revisor + aprobador (o admin).

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectedRequisitionDetail } from "../../components/screens/connected";
import type { DetailBundle } from "../../components/screens/connected/shared";

const catalogs = {
  works: [{ id: "work-1", name: "Torre Norte", societyId: "soc-1", costCenterId: "cc-1" }],
  tags: [{ id: "tag-1", name: "Honorarios" }],
  suppliers: [{ id: "sup-1", name: "Contratista ABC" }],
  items: [],
  approvers: [
    { id: "approver-1", name: "Nelson Aprobador" },
    { id: "master-1", name: "Daniel Maestro" },
  ],
  societies: [
    { id: "soc-1", name: "Constructora Norte" },
    { id: "soc-2", name: "Inmobiliaria Sur" },
  ],
  costCenters: [{ id: "cc-1", name: "Obra civil", societyId: "soc-1" }],
  features: {},
};

function paymentRequisition(overrides: Record<string, unknown> = {}) {
  return {
    id: "req-1",
    consecutive: "RQ-010",
    type: "pago" as const,
    societyId: "soc-1",
    channel: "interno",
    status: "en_revision",
    tagId: "tag-1",
    workId: "work-1",
    items: [
      { id: "item-1", description: "Pago acta 3", quantity: 1, unit: "servicio", finalSupplierId: "sup-1", unitBase: 100_000, ivaRate: 0 },
    ],
    ...overrides,
  };
}

function renderDetail(
  requisitionOverrides: Record<string, unknown> = {},
  role: "Revisor" | "Aprobador" | "Contabilidad" | "Administrador Sixteam" = "Revisor",
  bundleOverrides: Record<string, unknown> = {},
) {
  const data = {
    requisition: paymentRequisition(requisitionOverrides),
    catalogs,
    orders: [],
    expenses: [],
    history: [],
    attachments: [],
    ...bundleOverrides,
  } as DetailBundle;
  return render(<ConnectedRequisitionDetail data={data} role={role} go={vi.fn()} refresh={vi.fn()} />);
}

const okResponse = () =>
  new Response(JSON.stringify({ id: "req-1", items: [] }), { status: 200, headers: { "Content-Type": "application/json" } });

const bodiesOf = (fetchMock: { mock: { calls: unknown[][] } }) =>
  fetchMock.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)));

describe("valor editable con el original al lado (tipo=pago)", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("rotula la columna como Valor y solo muestra el original cuando el valor editado difiere", () => {
    renderDetail();
    expect(screen.getByRole("columnheader", { name: "Valor" })).toBeInTheDocument();
    expect(screen.queryByTestId("original-amount")).toBeNull();
    fireEvent.change(screen.getByRole("spinbutton", { name: "Precio unitario de Pago acta 3" }), { target: { value: "120000" } });
    expect(screen.getByTestId("original-amount")).toHaveTextContent("Valor original");
    expect(screen.getByTestId("original-amount")).toHaveTextContent("100.000");
    fireEvent.change(screen.getByRole("spinbutton", { name: "Precio unitario de Pago acta 3" }), { target: { value: "100000" } });
    expect(screen.queryByTestId("original-amount")).toBeNull();
  });

  it("tras una recarga, el original sale del primer evento revisada (montoAntes), no del valor ya corregido", () => {
    renderDetail(
      { items: [{ id: "item-1", description: "Pago acta 3", quantity: 1, unit: "servicio", finalSupplierId: "sup-1", unitBase: 120_000, ivaRate: 0 }] },
      "Revisor",
      {
        history: [
          { event: "revisada", at: "2026-09-15T10:05:00.000Z", data: { montoAntes: 110_000, montoDespues: 120_000 } },
          { event: "revisada", at: "2026-09-15T10:00:00.000Z", data: { montoAntes: 100_000, montoDespues: 110_000 } },
          { event: "creada", at: "2026-09-15T09:00:00.000Z", data: {} },
        ],
      },
    );
    expect(screen.getByTestId("original-amount")).toHaveTextContent("100.000");
  });

  it("la ficha de solo lectura también enseña el valor original al aprobador o a contabilidad", () => {
    renderDetail(
      { status: "en_aprobacion", items: [{ id: "item-1", description: "Pago acta 3", quantity: 1, unit: "servicio", finalSupplierId: "sup-1", unitBase: 120_000, ivaRate: 0 }] },
      "Contabilidad",
      { history: [{ event: "revisada", at: "2026-09-15T10:00:00.000Z", data: { montoAntes: 100_000, montoDespues: 120_000 } }] },
    );
    expect(screen.getByTestId("requisition-original-amount")).toHaveTextContent("100.000");
  });
});

describe("empresa facturada (RF-009)", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("arranca con la empresa guardada por el servidor y la muestra en la cabecera", () => {
    renderDetail({ billedCompanyId: "soc-2" });
    expect(screen.getByRole("combobox", { name: "Empresa facturada" })).toHaveValue("soc-2");
    expect(screen.getByTestId("requisition-billed-company")).toHaveTextContent("Inmobiliaria Sur");
  });

  it("sin valor guardado, deriva la del centro de costo (si no, la de la obra/requisición)", () => {
    renderDetail({ costCenterId: "cc-1" });
    expect(screen.getByRole("combobox", { name: "Empresa facturada" })).toHaveValue("soc-1");
    cleanup();
    renderDetail({ societyId: "soc-2", workId: undefined });
    expect(screen.getByRole("combobox", { name: "Empresa facturada" })).toHaveValue("soc-2");
  });

  it("la empresa facturada elegida viaja como billedCompanyId en review() al enviar a aprobación", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse());
    renderDetail({ billedCompanyId: "soc-1", approverId: "approver-1" });
    fireEvent.change(screen.getByRole("combobox", { name: "Empresa facturada" }), { target: { value: "soc-2" } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar a aprobación" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const [review, send] = bodiesOf(fetchMock);
    expect(review.action).toBe("review");
    expect(review.billedCompanyId).toBe("soc-2");
    expect(send).toEqual({ action: "send_for_approval" });
  });
});

describe("Aprobar yo mismo (RF-308)", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("solo aparece con roles revisor + aprobador (o admin Sixteam), nunca por la lente sola", () => {
    renderDetail({}, "Revisor", { viewerId: "master-1", viewerRoles: ["revisor"] });
    expect(screen.queryByRole("button", { name: "Aprobar yo mismo" })).toBeNull();
    cleanup();
    renderDetail({}, "Revisor", { viewerId: "master-1", viewerRoles: ["aprobador"] });
    expect(screen.queryByRole("button", { name: "Aprobar yo mismo" })).toBeNull();
    cleanup();
    renderDetail({}, "Revisor", { viewerId: "master-1" });
    expect(screen.queryByRole("button", { name: "Aprobar yo mismo" })).toBeNull();
    cleanup();
    renderDetail({}, "Revisor", { viewerId: "master-1", viewerRoles: ["revisor", "aprobador"] });
    expect(screen.getByRole("button", { name: "Aprobar yo mismo" })).toBeInTheDocument();
    cleanup();
    renderDetail({}, "Administrador Sixteam", { viewerId: "admin-1" });
    expect(screen.getByRole("button", { name: "Aprobar yo mismo" })).toBeInTheDocument();
  });

  it("guarda la revisión con approverId = quien mira y DESPUÉS manda send_and_approve, tras confirmar", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse());
    renderDetail({ approverId: "approver-1", billedCompanyId: "soc-1" }, "Revisor", { viewerId: "master-1", viewerRoles: ["revisor", "aprobador"] });
    // El <select> de aprobador sigue apuntando a otra persona: el atajo no depende de él.
    expect(screen.getByRole("combobox", { name: "Aprobador" })).toHaveValue("approver-1");
    fireEvent.click(screen.getByRole("button", { name: "Aprobar yo mismo" }));
    const dialog = await screen.findByRole("dialog", { name: "Aprobar yo mismo" });
    expect(dialog).toHaveTextContent("dos eventos");
    fireEvent.click(screen.getByTestId("confirm-dialog-confirm"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const [review, approve] = bodiesOf(fetchMock);
    expect(review.action).toBe("review");
    expect(review.approverId).toBe("master-1");
    expect(review.billedCompanyId).toBe("soc-1");
    expect(approve).toEqual({ action: "send_and_approve" });
    // No `findByRole("status")`: el indicador de autoguardado también es role="status".
    expect(await screen.findByText(/aprobada en un solo paso/)).toBeInTheDocument();
  });

  it("cancelar la confirmación no manda nada", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse());
    renderDetail({}, "Revisor", { viewerId: "master-1", viewerRoles: ["revisor", "aprobador"] });
    fireEvent.click(screen.getByRole("button", { name: "Aprobar yo mismo" }));
    await screen.findByRole("dialog", { name: "Aprobar yo mismo" });
    fireEvent.click(screen.getByTestId("confirm-dialog-cancel"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("en estado enviada antepone start_review, igual que Enviar a aprobación", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse());
    renderDetail({ status: "enviada" }, "Revisor", { viewerId: "master-1", viewerRoles: ["revisor", "aprobador"] });
    fireEvent.click(screen.getByRole("button", { name: "Aprobar yo mismo" }));
    await screen.findByRole("dialog", { name: "Aprobar yo mismo" });
    fireEvent.click(screen.getByTestId("confirm-dialog-confirm"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(bodiesOf(fetchMock).map((body) => body.action)).toEqual(["start_review", "review", "send_and_approve"]);
  });

  it("un aprobador a secas no lo ve, ni con su propia lente", () => {
    renderDetail({}, "Aprobador", { viewerId: "approver-1", viewerRoles: ["aprobador"] });
    expect(screen.queryByRole("button", { name: "Aprobar yo mismo" })).toBeNull();
  });
});

// QA H3 (adenda de pagos): la lente de sesión del maestro (revisor + aprobador) es «Revisor», y el
// detalle solo ofrecía aprobar a la lente «Aprobador». Lo que decide ahora es si quien mira figura como
// aprobador de la requisición — de la cabecera o de algún ítem —, la misma pregunta que approve().
describe("acciones de aprobación del maestro en en_aprobacion (QA H3)", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  const maestro = { viewerId: "master-1", viewerRoles: ["revisor", "aprobador"] };

  it("con lente Revisor y asignado en la cabecera ve «Aprobar requisición», «Devolver a revisión» y conserva «Reasignar aprobador»", () => {
    renderDetail({ status: "en_aprobacion", approverId: "master-1" }, "Revisor", maestro);
    expect(screen.getByTestId("approval-decisions")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Aprobar requisición" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Más" }));
    expect(screen.getByRole("menuitem", { name: "Devolver a revisión" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Reasignar aprobador" })).toBeInTheDocument();
  });

  it("aprobar manda decide_items y approve con sus líneas", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse());
    renderDetail({ status: "en_aprobacion", approverId: "master-1" }, "Revisor", maestro);
    fireEvent.click(screen.getByRole("button", { name: "Aprobar requisición" }));
    fireEvent.click(await screen.findByTestId("confirm-dialog-confirm"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const [decisiones, aprobar] = bodiesOf(fetchMock);
    expect(decisiones).toMatchObject({ action: "decide_items", decisions: [{ itemId: "item-1", status: "aprobado" }] });
    expect(aprobar).toEqual({ action: "approve" });
  });

  it("si el aprobador asignado es otro, el maestro no ve acciones de aprobación: solo la ficha y «Reasignar aprobador»", () => {
    renderDetail({ status: "en_aprobacion", approverId: "approver-1" }, "Revisor", maestro);
    expect(screen.queryByTestId("approval-decisions")).toBeNull();
    expect(screen.queryByRole("button", { name: /Aprobar/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Más" }));
    expect(screen.queryByRole("menuitem", { name: "Devolver a revisión" })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Reasignar aprobador" })).toBeInTheDocument();
  });

  it("un aprobador que no figura en la requisición tampoco ve acciones, aunque su lente sea «Aprobador»", () => {
    renderDetail({ status: "en_aprobacion", approverId: "master-1" }, "Aprobador", { viewerId: "approver-1", viewerRoles: ["aprobador"] });
    expect(screen.queryByTestId("approval-decisions")).toBeNull();
    expect(screen.queryByRole("button", { name: /Aprobar/ })).toBeNull();
  });

  it("con reparto por ítem, el maestro asignado solo en un ítem ve y decide esa línea", () => {
    renderDetail(
      {
        status: "en_aprobacion",
        approverId: "approver-1",
        items: [
          { id: "item-1", description: "Pago acta 3", quantity: 1, unit: "servicio", finalSupplierId: "sup-1", unitBase: 100_000, ivaRate: 0 },
          { id: "item-2", description: "Pago acta 4", quantity: 1, unit: "servicio", finalSupplierId: "sup-1", unitBase: 50_000, ivaRate: 0, approverId: "master-1" },
        ],
      },
      "Revisor",
      maestro,
    );
    expect(screen.getByText(/Ves 1 de 2 ítems/)).toBeInTheDocument();
    expect(screen.getByText("Pago acta 4")).toBeInTheDocument();
    expect(screen.queryByText("Pago acta 3")).toBeNull();
    expect(screen.getByRole("button", { name: /Aprobar mis ítems \(1\)/ })).toBeInTheDocument();
  });
});
