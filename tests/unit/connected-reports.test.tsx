// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectedReports } from "../../components/screens/connected";
import { groupCommittedVsPaid } from "../../components/screens/connected/reports";
import type { ReportBundle } from "../../components/screens/connected/shared";
import type { OrderReportRow } from "../../lib/services/report-service";

afterEach(() => cleanup());

const moneyFormatter = new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 });
const money = (value: number) => moneyFormatter.format(value).replace(/ /g, " ");

// RF-707: la pantalla pide /api/reports/orders al montar; cada prueba simula esa respuesta.
const orderRows: OrderReportRow[] = [
  { id: "ord-1", consecutive: "OC-2026-0001", type: "OC", requisitionId: "req-1", generatedAt: "2026-09-05T00:00:00.000Z", period: "2026-09", workId: "work-1", costCenterId: "cc-1", billedCompanyId: "soc-1", total: 100_000, paidAmount: 40_000, paymentStatus: "parcial", paymentMethods: ["efectivo"] },
  { id: "ord-2", consecutive: "OP-2026-0002", type: "OP", requisitionId: "req-2", generatedAt: "2026-09-12T00:00:00.000Z", period: "2026-09", workId: "work-2", costCenterId: "cc-2", billedCompanyId: "soc-2", total: 50_000, paidAmount: 50_000, paymentStatus: "pagada", paymentMethods: ["transferencia"] },
  { id: "ord-3", consecutive: "OC-2026-0003", type: "OC", requisitionId: "req-3", generatedAt: "2026-08-20T00:00:00.000Z", period: "2026-08", workId: "", costCenterId: "cc-1", billedCompanyId: "soc-1", total: 30_000, paidAmount: 0, paymentStatus: "pendiente", paymentMethods: [] },
];
function mockOrders(rows: OrderReportRow[] = orderRows) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url.startsWith("/api/reports/orders")) return new Response(JSON.stringify({ rows }), { status: 200, headers: { "Content-Type": "application/json" } });
    throw new Error(`Fetch no simulado para "${url}"`);
  });
}
beforeEach(() => {
  vi.restoreAllMocks();
  mockOrders();
});

const catalogs: ReportBundle["catalogs"] = {
  works: [
    { id: "work-1", name: "Altos de La Pradera" },
    { id: "work-2", name: "Bodega Industrial Norte" },
  ],
  tags: [
    { id: "tag-1", name: "Materiales" },
    { id: "tag-2", name: "Servicios" },
  ],
  suppliers: [],
  items: [],
  features: {},
  users: [
    { id: "juliana", name: "Juliana Rojas" },
    { id: "nelson", name: "Nelson Ríos" },
  ],
  approvers: [
    { id: "juliana", name: "Juliana Rojas" },
    { id: "nelson", name: "Nelson Ríos" },
  ],
  // Centros de costo (UI, 2026-09-12).
  costCenters: [
    { id: "cc-1", name: "Administrativo" },
    { id: "cc-2", name: "Obra civil" },
  ],
  societies: [
    { id: "soc-1", name: "Constructora Mizar S.A.S." },
    { id: "soc-2", name: "PROIM S.A.S." },
  ],
};

// `billedCompanyId` viaja en GET /api/reports aunque el tipo de shared.tsx no lo declare (ver reports.tsx).
const rows: ReportBundle["rows"] = [
  {
    id: "req-1", consecutive: "REQ-2026-0001", date: "2026-08-15T00:00:00.000Z",
    workId: "work-1", tagId: "tag-1", costCenterId: "cc-1", approverIds: ["juliana"], status: "aprobada",
    supplierIds: [], base: 100_000, iva: 19_000, total: 119_000, items: [], billedCompanyId: "soc-1",
  } as ReportBundle["rows"][number],
  {
    id: "req-2", consecutive: "REQ-2026-0002", date: "2026-09-05T00:00:00.000Z",
    workId: "work-2", tagId: "tag-2", costCenterId: "cc-2", approverIds: ["nelson"], status: "en_aprobacion",
    supplierIds: [], base: 50_000, iva: 9_500, total: 59_500, items: [], billedCompanyId: "soc-2",
  } as ReportBundle["rows"][number],
  {
    id: "req-3", consecutive: "REQ-2026-0003", date: "2026-09-20T00:00:00.000Z",
    workId: "work-1", tagId: "tag-1", costCenterId: "cc-1", approverIds: ["juliana"], status: "en_aprobacion",
    supplierIds: [], base: 30_000, iva: 5_700, total: 35_700, items: [], billedCompanyId: "soc-1",
  } as ReportBundle["rows"][number],
];

function exportHref(): string {
  return screen.getByRole("link", { name: /descargar excel/i }).getAttribute("href") ?? "";
}

describe("RF-1301: filtros de Reportes mandan los parámetros correctos (pantalla + descarga)", () => {
  it("filtra por obra ocultando filas de otras obras, y el enlace de descarga lleva workId", () => {
    render(<ConnectedReports data={{ rows, catalogs }} role="Contabilidad" />);
    expect(screen.getByText("REQ-2026-0001")).toBeInTheDocument();
    expect(screen.getByText("REQ-2026-0002")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Obra"), { target: { value: "work-1" } });

    expect(screen.getByText("REQ-2026-0001")).toBeInTheDocument();
    expect(screen.getByText("REQ-2026-0003")).toBeInTheDocument();
    expect(screen.queryByText("REQ-2026-0002")).toBeNull();
    expect(exportHref()).toContain("workId=work-1");
  });

  it("filtra por mes (periodo) y el enlace de descarga lleva period", () => {
    render(<ConnectedReports data={{ rows, catalogs }} role="Contabilidad" />);
    fireEvent.change(screen.getByLabelText("Mes"), { target: { value: "2026-09" } });
    expect(screen.queryByText("REQ-2026-0001")).toBeNull();
    expect(screen.getByText("REQ-2026-0002")).toBeInTheDocument();
    expect(screen.getByText("REQ-2026-0003")).toBeInTheDocument();
    expect(exportHref()).toContain("period=2026-09");
  });

  it("filtra por aprobador y por etiqueta, combinados, con el enlace de descarga llevando ambos", () => {
    render(<ConnectedReports data={{ rows, catalogs }} role="Contabilidad" />);
    fireEvent.change(screen.getByLabelText("Aprobador"), { target: { value: "juliana" } });
    fireEvent.change(screen.getByLabelText("Etiqueta"), { target: { value: "tag-1" } });
    expect(screen.getByText("REQ-2026-0001")).toBeInTheDocument();
    expect(screen.getByText("REQ-2026-0003")).toBeInTheDocument();
    expect(screen.queryByText("REQ-2026-0002")).toBeNull();
    const href = exportHref();
    expect(href).toContain("approverId=juliana");
    expect(href).toContain("tagId=tag-1");
  });

  // RF-1301 punto 3: Juliana (aprobadora) entra viendo por defecto solo lo que ya aprobó.
  it("un Aprobador ve 'Aprobadas por mí' marcado por defecto y solo requisiciones aprobadas", () => {
    render(<ConnectedReports data={{ rows, catalogs }} role="Aprobador" />);
    const toggle = screen.getByLabelText(/aprobadas por mí/i) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    expect(screen.getByText("REQ-2026-0001")).toBeInTheDocument();
    expect(screen.queryByText("REQ-2026-0002")).toBeNull();
    expect(screen.queryByText("REQ-2026-0003")).toBeNull();

    fireEvent.click(toggle);
    expect(screen.getByText("REQ-2026-0003")).toBeInTheDocument();
  });

  it("un rol Contabilidad no ve el toggle 'Aprobadas por mí' (es exclusivo del Aprobador)", () => {
    render(<ConnectedReports data={{ rows, catalogs }} role="Contabilidad" />);
    expect(screen.queryByLabelText(/aprobadas por mí/i)).toBeNull();
  });

  it("Revisor ve la pantalla pero SIN botón de descarga (report:read, no report:export)", () => {
    render(<ConnectedReports data={{ rows, catalogs }} role="Revisor" />);
    expect(screen.getByText("REQ-2026-0001")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /descargar excel/i })).toBeNull();
  });

  // Centros de costo (UI, 2026-09-12): el compilado mensual ahora agrupa por CENTRO DE COSTO (Daniel:
  // "el compilado debe ir por obra/centro de costo", y desde que el centro es una entidad propia es el
  // eje correcto — varias obras pueden compartir centro); la obra queda como desglose dentro de cada
  // centro.
  it("el compilado mensual (con mes elegido) agrupa por centro de costo, con la obra como desglose", () => {
    render(<ConnectedReports data={{ rows, catalogs }} role="Contabilidad" />);
    expect(screen.queryByTestId("report-costcenter-subtotals")).toBeNull();
    fireEvent.change(screen.getByLabelText("Mes"), { target: { value: "2026-09" } });
    const subtotals = screen.getByTestId("report-costcenter-subtotals");
    expect(subtotals).toBeInTheDocument();
    // Solo REQ-2026-0002 (work-2/cc-2) y REQ-2026-0003 (work-1/cc-1) caen en septiembre.
    expect(subtotals.textContent).toContain("Administrativo");
    expect(subtotals.textContent).toContain("Obra civil");
    expect(subtotals.textContent).toContain("Altos de La Pradera");
    expect(subtotals.textContent).toContain("Bodega Industrial Norte");
  });

  it("filtra por centro de costo ocultando filas de otros centros, y el enlace de descarga lleva costCenterId", () => {
    render(<ConnectedReports data={{ rows, catalogs }} role="Contabilidad" />);
    fireEvent.change(screen.getByLabelText("Centro de costo"), { target: { value: "cc-1" } });
    expect(screen.getByText("REQ-2026-0001")).toBeInTheDocument();
    expect(screen.getByText("REQ-2026-0003")).toBeInTheDocument();
    expect(screen.queryByText("REQ-2026-0002")).toBeNull();
    expect(exportHref()).toContain("costCenterId=cc-1");
  });

  // RF-707 (adenda de pagos): empresa facturada como filtro y como columna.
  it("filtra por empresa facturada (pantalla + descarga) y la muestra como columna", async () => {
    render(<ConnectedReports data={{ rows, catalogs }} role="Contabilidad" />);
    expect(screen.getAllByText("PROIM S.A.S.").length).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText("Empresa facturada"), { target: { value: "soc-2" } });
    expect(screen.getByText("REQ-2026-0002")).toBeInTheDocument();
    expect(screen.queryByText("REQ-2026-0001")).toBeNull();
    expect(exportHref()).toContain("billedCompanyId=soc-2");
    // El bloque de órdenes obedece el mismo filtro: solo OP-2026-0002 (soc-2).
    await waitFor(() => expect(screen.getByTestId("report-orders-count")).toHaveTextContent("1"));
    expect(screen.getByTestId("report-committed")).toHaveTextContent(money(50_000));
  });
});

describe("RF-707: comprometido vs pagado (órdenes)", () => {
  it("groupCommittedVsPaid suma total y pagado por clave, con clave vacía para 'sin centro'/'sin periodo'", () => {
    const groups = groupCommittedVsPaid(orderRows, (row) => row.costCenterId);
    expect(groups).toEqual([
      { key: "cc-1", orders: 2, committed: 130_000, paid: 40_000 },
      { key: "cc-2", orders: 1, committed: 50_000, paid: 50_000 },
    ]);
    expect(groupCommittedVsPaid([{ ...orderRows[0], costCenterId: undefined }], (row) => row.costCenterId)[0].key).toBe("");
  });

  it("pide /api/reports/orders al montar y muestra comprometido, pagado, saldo y las tablas por centro de costo y por periodo", async () => {
    const fetchMock = mockOrders();
    render(<ConnectedReports data={{ rows, catalogs }} role="Contabilidad" />);
    await waitFor(() => expect(screen.getByTestId("report-committed")).toHaveTextContent(money(180_000)));
    expect(String(fetchMock.mock.calls[0][0])).toBe("/api/reports/orders");
    expect(screen.getByTestId("report-paid")).toHaveTextContent(money(90_000));
    expect(screen.getByTestId("report-balance")).toHaveTextContent(money(90_000));
    const byCostCenter = screen.getByTestId("report-by-costcenter");
    expect(within(byCostCenter).getByText("Administrativo")).toBeInTheDocument();
    expect(within(byCostCenter).getByText("Obra civil")).toBeInTheDocument();
    const byPeriod = screen.getByTestId("report-by-period");
    expect(within(byPeriod).getByText("2026-09")).toBeInTheDocument();
    expect(within(byPeriod).getByText("2026-08")).toBeInTheDocument();
  });

  it("medio de pago y estado de pago filtran solo el bloque de órdenes; el mes filtra ambos", async () => {
    render(<ConnectedReports data={{ rows, catalogs }} role="Contabilidad" />);
    await waitFor(() => expect(screen.getByTestId("report-orders-count")).toHaveTextContent("3"));
    fireEvent.change(screen.getByLabelText("Medio de pago"), { target: { value: "efectivo" } });
    expect(screen.getByTestId("report-orders-count")).toHaveTextContent("1");
    expect(screen.getByTestId("report-committed")).toHaveTextContent(money(100_000));
    // Las requisiciones no se ven afectadas por el medio de pago.
    expect(screen.getByText("REQ-2026-0002")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Medio de pago"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Estado de pago"), { target: { value: "pendiente" } });
    expect(screen.getByTestId("report-orders-count")).toHaveTextContent("1");
    expect(screen.getByTestId("report-paid")).toHaveTextContent(money(0));
    fireEvent.change(screen.getByLabelText("Estado de pago"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Mes"), { target: { value: "2026-09" } });
    expect(screen.getByTestId("report-orders-count")).toHaveTextContent("2");
    expect(screen.queryByText("REQ-2026-0001")).toBeNull();
  });

  it("si el servidor niega las órdenes, el bloque muestra el error sin tumbar el reporte de requisiciones", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers: { "Content-Type": "application/json" } }));
    render(<ConnectedReports data={{ rows, catalogs }} role="Revisor" />);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/no permiten esta acción/i));
    expect(screen.getByText("REQ-2026-0001")).toBeInTheDocument();
  });
});
