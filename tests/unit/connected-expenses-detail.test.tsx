// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConnectedExpenses,
  ConnectedRequisitionDetail,
  groupExpensesByWorkAndTag,
} from "../../components/screens/connected";
import { monthRangeOf, weekRange } from "../../components/screens/connected/expenses";
import { localTodayISO } from "../../components/screens/connected/shared";
import type { CashCloseReport } from "../../lib/services/report-service";

const moneyFormatter = new Intl.NumberFormat("es-CO", {
  style: "currency",
  currency: "COP",
  maximumFractionDigits: 0,
});
// getByText compara contra el texto ya normalizado del DOM (espacios colapsados a " "),
// pero no normaliza el propio matcher: sin este reemplazo el NBSP que trae
// Intl.NumberFormat ("$ 120.000") nunca calzaría con el nodo renderizado.
const money = (value: number) => moneyFormatter.format(value).replace(/ /g, " ");

afterEach(() => cleanup());

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// A10: la pantalla abre en "Cierre de caja" y consulta /api/reports/cash-close al montar; el resto de
// pruebas (libro de gastos) simula esa respuesta vacía y cambia de pestaña antes de mirar la tabla.
function mockCashClose(report: Partial<CashCloseReport> | (() => Response) = {}) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.startsWith("/api/reports/cash-close")) {
      if (typeof report === "function") return report();
      const params = new URL(url, "http://localhost").searchParams;
      return jsonResponse({ from: params.get("from"), to: params.get("to"), rows: [], total: 0, ...report });
    }
    if (init?.method === "PUT") return jsonResponse({ updated: true });
    throw new Error(`Fetch no simulado para "${url}"`);
  });
}
const openExpenseLedger = () => fireEvent.click(screen.getByRole("tab", { name: "Libro de gastos" }));

const catalogs = {
  works: [
    { id: "work-1", name: "Obra Norte" },
    { id: "work-2", name: "Obra Sur" },
  ],
  tags: [
    { id: "tag-1", name: "Materiales" },
    { id: "tag-2", name: "Mano de obra" },
  ],
  suppliers: [],
  items: [],
  features: {},
};

describe("RF-702: subtotal por etiqueta dentro de cada obra", () => {
  const rows = [
    { id: "exp-1", workId: "work-1", origin: "requisicion", referenceId: "r-1", tagId: "tag-1", orderDate: "2026-08-01", date: "2026-08-01", total: 100000, period: "2026-08" },
    { id: "exp-2", workId: "work-1", origin: "requisicion", referenceId: "r-2", tagId: "tag-2", orderDate: "2026-08-02", date: "2026-08-02", total: 50000, period: "2026-08" },
    { id: "exp-3", workId: "work-1", origin: "caja_menor", referenceId: "p-1", tagId: "tag-1", orderDate: "2026-08-03", date: "2026-08-03", total: 20000, period: "2026-08" },
    { id: "exp-4", workId: "work-2", origin: "requisicion", referenceId: "r-3", tagId: "tag-2", orderDate: "2026-08-04", date: "2026-08-04", total: 30000, period: "2026-08" },
  ];

  it("agrupa y suma los importes por obra y por etiqueta dentro de la obra", () => {
    const groups = groupExpensesByWorkAndTag(rows as never, catalogs);
    expect(groups).toHaveLength(2);
    const norte = groups.find((group) => group.workId === "work-1");
    expect(norte?.subtotal).toBe(170000);
    expect(norte?.tags.find((tag) => tag.tagId === "tag-1")?.subtotal).toBe(120000);
    expect(norte?.tags.find((tag) => tag.tagId === "tag-2")?.subtotal).toBe(50000);
    const sur = groups.find((group) => group.workId === "work-2");
    expect(sur?.subtotal).toBe(30000);
  });

  it("muestra el subtotal por etiqueta, el subtotal por obra y el total general en pantalla", () => {
    mockCashClose();
    render(
      <ConnectedExpenses
        data={{ expenses: rows, catalogs, pettyCash: [], pettyAttachments: {} }}
        role="Contabilidad"
        refresh={vi.fn()}
      />,
    );
    openExpenseLedger();
    const tagRows = screen.getAllByTestId("expense-subtotal-tag");
    const findTagRow = (label: string) =>
      tagRows.find((row) => within(row).queryByText(label));
    expect(
      within(findTagRow("Materiales") as HTMLElement).getByText(money(120000)),
    ).toBeInTheDocument();
    expect(
      within(findTagRow("Mano de obra") as HTMLElement).getByText(money(50000)),
    ).toBeInTheDocument();

    const workRows = screen.getAllByTestId("expense-subtotal-work");
    const findWorkRow = (label: string) =>
      workRows.find((row) => within(row).queryByText(label));
    expect(
      within(findWorkRow("Subtotal Obra Norte") as HTMLElement).getByText(money(170000)),
    ).toBeInTheDocument();
    expect(
      within(findWorkRow("Subtotal Obra Sur") as HTMLElement).getByText(money(30000)),
    ).toBeInTheDocument();

    expect(
      within(screen.getByTestId("expense-grand-total")).getByText(money(200000)),
    ).toBeInTheDocument();
  });
});

describe("RF-305: interfaz de gastos compartidos entre obras", () => {
  const rows = [
    { id: "exp-1", workId: "work-1", origin: "requisicion", referenceId: "r-1", tagId: "tag-1", orderDate: "2026-08-01", date: "2026-08-01", total: 100000, period: "2026-08" },
  ];
  const expenseData = { expenses: rows, catalogs, pettyCash: [], pettyAttachments: {} };

  beforeEach(() => vi.restoreAllMocks());

  it("no ofrece repartir el gasto a un rol sin permiso (Contabilidad)", () => {
    mockCashClose();
    render(<ConnectedExpenses data={expenseData} role="Contabilidad" refresh={vi.fn()} />);
    openExpenseLedger();
    expect(screen.queryByTestId("expense-share-trigger")).toBeNull();
  });

  it("bloquea el envío mientras la suma no cuadre al peso o repita una obra", () => {
    mockCashClose();
    render(<ConnectedExpenses data={expenseData} role="Revisor" refresh={vi.fn()} />);
    openExpenseLedger();
    fireEvent.click(screen.getByTestId("expense-share-trigger"));
    const form = screen.getByTestId("expense-share-form");
    const submit = within(form).getByRole("button", { name: "Confirmar reparto" });
    // Precargado: la primera línea trae la obra original con el total completo, la
    // segunda línea llega vacía -> el reparto no está completo todavía.
    expect(submit).toBeDisabled();

    const [workSelect1, workSelect2] = within(form).getAllByRole("combobox") as HTMLSelectElement[];
    const [amount1, amount2] = within(form).getAllByRole("spinbutton") as HTMLInputElement[];
    // Repetir la misma obra en ambas líneas: debe mostrar el error y seguir bloqueado.
    fireEvent.change(workSelect2, { target: { value: "work-1" } });
    fireEvent.change(amount1, { target: { value: "60000" } });
    fireEvent.change(amount2, { target: { value: "40000" } });
    expect(screen.getByText("Cada obra debe aparecer una sola vez en el reparto.")).toBeInTheDocument();
    expect(submit).toBeDisabled();

    // Obra distinta pero suma que no cuadra con el total del gasto: sigue bloqueado.
    fireEvent.change(workSelect2, { target: { value: "work-2" } });
    fireEvent.change(amount2, { target: { value: "39999" } });
    expect(screen.getByTestId("expense-share-summary")).toHaveTextContent("faltan");
    expect(submit).toBeDisabled();
    void workSelect1;
  });

  it("envía el PUT a /api/expenses/:id/shares con el reparto exacto cuando todo cuadra", async () => {
    const fetchMock = mockCashClose();
    const refresh = vi.fn();
    render(<ConnectedExpenses data={expenseData} role="Revisor" refresh={refresh} />);
    openExpenseLedger();
    fireEvent.click(screen.getByTestId("expense-share-trigger"));
    const form = screen.getByTestId("expense-share-form");
    const [, workSelect2] = within(form).getAllByRole("combobox");
    const [amount1, amount2] = within(form).getAllByRole("spinbutton") as HTMLInputElement[];
    fireEvent.change(workSelect2, { target: { value: "work-2" } });
    fireEvent.change(amount1, { target: { value: "60000" } });
    fireEvent.change(amount2, { target: { value: "40000" } });

    const submit = within(form).getByRole("button", { name: "Confirmar reparto" });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);

    const shareCalls = () => fetchMock.mock.calls.filter(([input]) => String(input).includes("/shares"));
    await waitFor(() => expect(shareCalls()).toHaveLength(1));
    const [url, init] = shareCalls()[0] as [string, RequestInit];
    expect(url).toBe("/api/expenses/exp-1/shares");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual({
      total: 100000,
      shares: [
        { workId: "work-1", amount: 60000 },
        { workId: "work-2", amount: 40000 },
      ],
    });
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("status")).toHaveTextContent("repartido entre las obras");
  });
});

describe("RF-708 / A10: la pantalla /gastos es el cierre de caja sobre pagos en efectivo", () => {
  const expenseData = { expenses: [], catalogs: { ...catalogs, costCenters: [{ id: "cc-1", name: "Administración" }] }, pettyCash: [], pettyAttachments: {} };
  const cashRows: CashCloseReport["rows"] = [
    {
      id: "pay-1", date: "2026-09-14", amount: 640_000, note: "Anticipo topógrafo", attachmentId: "att-1",
      orderId: "ord-1", orderConsecutive: "OP-2026-0007", orderType: "OP", requisitionId: "req-1", requisitionConsecutive: "REQ-2026-0041",
      workId: "work-1", workName: "Obra Norte", costCenterId: "cc-1", costCenterName: "Administración", billedCompanyId: "soc-1", billedCompanyName: "Constructora Mizar S.A.S.", supplierId: "sup-1", supplierName: "Pedro Topógrafo",
    },
    {
      id: "pay-2", date: "2026-09-15", amount: 80_000, orderId: "ord-2", orderConsecutive: "OC-2026-0090", orderType: "OC", requisitionId: "req-2", requisitionConsecutive: "REQ-2026-0042",
      workId: "", workName: "—", costCenterId: "cc-1", costCenterName: "Administración", billedCompanyId: "soc-1", billedCompanyName: "Constructora Mizar S.A.S.", supplierId: "sup-2", supplierName: "Ferretería La 80",
    },
  ];

  beforeEach(() => vi.restoreAllMocks());

  it("weekRange/monthRangeOf: lunes a viernes de la semana (el domingo cierra la que terminó) y el mes completo", () => {
    expect(weekRange("2026-09-16")).toEqual({ from: "2026-09-14", to: "2026-09-18" });
    expect(weekRange("2026-09-14")).toEqual({ from: "2026-09-14", to: "2026-09-18" });
    expect(weekRange("2026-09-20")).toEqual({ from: "2026-09-14", to: "2026-09-18" });
    expect(monthRangeOf("2026-02-10")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
  });

  it("abre en la pestaña de cierre con la semana en curso, pide el rango al servidor y lista los pagos con total y comprobante", async () => {
    const fetchMock = mockCashClose({ rows: cashRows, total: 720_000 });
    render(<ConnectedExpenses data={expenseData} role="Contabilidad" refresh={vi.fn()} />);
    const expected = weekRange(localTodayISO());
    expect(screen.getByLabelText("Desde")).toHaveValue(expected.from);
    expect(screen.getByLabelText("Hasta")).toHaveValue(expected.to);
    await waitFor(() => expect(screen.getAllByTestId("cash-close-row")).toHaveLength(2));
    const requested = new URL(String(fetchMock.mock.calls[0][0]), "http://localhost");
    expect(requested.pathname).toBe("/api/reports/cash-close");
    expect(requested.searchParams.get("from")).toBe(expected.from);
    expect(requested.searchParams.get("to")).toBe(expected.to);
    expect(screen.getByTestId("cash-close-total")).toHaveTextContent(money(720_000));
    expect(screen.getByText("Pedro Topógrafo")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /ver/i })).toHaveAttribute("href", "/api/attachments/pago_orden/pay-1/att-1/download");
    expect(screen.getByText("Sin comprobante")).toBeInTheDocument();
    // Gasto de una orden sin obra (N4): la fila igual se pinta, con su centro de costo.
    expect(screen.getByText("OC-2026-0090")).toBeInTheDocument();
    const href = screen.getByRole("link", { name: /descargar excel/i }).getAttribute("href") ?? "";
    expect(href).toContain("/api/reports/cash-close?");
    expect(href).toContain(`from=${expected.from}`);
    expect(href).toContain("format=xlsx");
  });

  it("'Este mes' cambia el rango y vuelve a consultar; el centro de costo viaja como filtro", async () => {
    const fetchMock = mockCashClose();
    render(<ConnectedExpenses data={expenseData} role="Revisor" refresh={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Este mes" }));
    const expected = monthRangeOf(localTodayISO());
    expect(screen.getByLabelText("Desde")).toHaveValue(expected.from);
    expect(screen.getByLabelText("Hasta")).toHaveValue(expected.to);
    fireEvent.change(screen.getByLabelText("Centro de costo"), { target: { value: "cc-1" } });
    await waitFor(() => {
      const last = new URL(String(fetchMock.mock.calls.at(-1)?.[0]), "http://localhost");
      expect(last.searchParams.get("from")).toBe(expected.from);
      expect(last.searchParams.get("costCenterId")).toBe("cc-1");
    });
    // Revisor no tiene report:export: sin botón de descarga.
    expect(screen.queryByRole("link", { name: /descargar excel/i })).toBeNull();
  });

  it("un rango invertido no consulta y avisa; un error del servidor se muestra", async () => {
    const fetchMock = mockCashClose(() => jsonResponse({ error: "forbidden" }, 403));
    render(<ConnectedExpenses data={expenseData} role="Contabilidad" refresh={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/no permiten esta acción/i));
    const calls = fetchMock.mock.calls.length;
    fireEvent.change(screen.getByLabelText("Hasta"), { target: { value: "2020-01-01" } });
    expect(screen.getByRole("alert")).toHaveTextContent("La fecha inicial debe ser igual o anterior a la final.");
    expect(fetchMock.mock.calls.length).toBe(calls);
  });

  it("retira el gasto directo, la pestaña de ingresos y el cierre mensual por caja", () => {
    mockCashClose();
    render(<ConnectedExpenses data={expenseData} role="Administrador Sixteam" refresh={vi.fn()} />);
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Cierre de caja", "Libro de gastos"]);
    expect(screen.queryByText(/registrar gasto directo/i)).toBeNull();
    expect(screen.queryByText(/registrar ingreso/i)).toBeNull();
    expect(screen.queryByText(/cerrar mes/i)).toBeNull();
  });
});

describe("RF-404 / RF-405: solicitante y usuario en la trazabilidad", () => {
  const baseCatalogs = { works: [], tags: [], suppliers: [], items: [], features: {} };

  it("muestra el nombre y teléfono del solicitante externo", () => {
    render(
      <ConnectedRequisitionDetail
        data={{
          requisition: {
            id: "req-1",
            consecutive: "RQ-001",
            type: "compra",
            workId: "work-1",
            externalRequester: { name: "Juan Pérez", phone: "+573001234567" },
            channel: "whatsapp",
            requiredDate: "2026-08-24",
            status: "en_revision",
            items: [],
          },
          catalogs: baseCatalogs,
          orders: [],
          expenses: [],
          history: [],
          attachments: [],
        }}
        role="Revisor"
        go={vi.fn()}
        refresh={vi.fn()}
      />,
    );
    expect(screen.getByTestId("requisition-requester")).toHaveTextContent("Juan Pérez · +573001234567");
  });

  it("muestra un solicitante interno sin exponer su UUID cuando no hay solicitante externo", () => {
    render(
      <ConnectedRequisitionDetail
        data={{
          requisition: {
            id: "req-1",
            consecutive: "RQ-001",
            type: "compra",
            workId: "work-1",
            requesterId: "user-42",
            channel: "web",
            requiredDate: "2026-08-24",
            status: "en_revision",
            items: [],
          },
          catalogs: baseCatalogs,
          orders: [],
          expenses: [],
          history: [],
          attachments: [],
        }}
        role="Revisor"
        go={vi.fn()}
        refresh={vi.fn()}
      />,
    );
    // GRAVE 4 (QA 2026-08-31): un UUID nunca debe llegar a pantalla. La API no expone el
    // nombre del solicitante interno, así que el fallback es un texto honesto, no el id crudo.
    const requester = screen.getByTestId("requisition-requester");
    expect(requester).toHaveTextContent("Solicitante interno");
    expect(requester).not.toHaveTextContent("user-42");
  });

  it("indica que un evento tuvo actor humano o fue automático, sin exponer el UUID del actor", () => {
    render(
      <ConnectedRequisitionDetail
        data={{
          requisition: {
            id: "req-1",
            consecutive: "RQ-001",
            type: "compra",
            workId: "work-1",
            requesterId: "user-42",
            channel: "web",
            requiredDate: "2026-08-24",
            status: "en_revision",
            items: [],
          },
          catalogs: baseCatalogs,
          orders: [],
          expenses: [],
          history: [
            { event: "creada", at: "2026-08-24T10:00:00.000Z", actorId: "user-42" },
            { event: "iniciada_revision", at: "2026-08-24T11:00:00.000Z" },
          ],
          attachments: [],
        }}
        role="Revisor"
        go={vi.fn()}
        refresh={vi.fn()}
      />,
    );
    const actors = screen.getAllByTestId("audit-actor");
    expect(actors[0]).toHaveTextContent("Usuario interno");
    expect(actors[0]).not.toHaveTextContent("user-42");
    expect(actors[1]).toHaveTextContent("Automático");
  });

  // HUECO 2 (reunión 2026-08-31, QA): el hueco de arriba ("Solicitante interno"/"Usuario interno" sin
  // nombre) se cierra agregando una lista mínima id+nombre a catalogs.users (GET /api/catalogs).
  it("resuelve el nombre del solicitante interno contra catalogs.users cuando el id aparece en la lista", () => {
    const catalogsWithUsers = { ...baseCatalogs, users: [{ id: "user-42", name: "Ana Torres" }] };
    render(
      <ConnectedRequisitionDetail
        data={{
          requisition: {
            id: "req-1",
            consecutive: "RQ-001",
            type: "compra",
            workId: "work-1",
            requesterId: "user-42",
            channel: "web",
            requiredDate: "2026-08-24",
            status: "en_revision",
            items: [],
          },
          catalogs: catalogsWithUsers,
          orders: [],
          expenses: [],
          history: [],
          attachments: [],
        }}
        role="Revisor"
        go={vi.fn()}
        refresh={vi.fn()}
      />,
    );
    const requester = screen.getByTestId("requisition-requester");
    expect(requester).toHaveTextContent("Ana Torres");
    expect(requester).not.toHaveTextContent("user-42");
    expect(requester).not.toHaveTextContent("Solicitante interno");
  });

  it("resuelve el nombre del actor del historial contra catalogs.users, y conserva el fallback si el id no aparece en la lista", () => {
    const catalogsWithUsers = { ...baseCatalogs, users: [{ id: "user-42", name: "Ana Torres" }] };
    render(
      <ConnectedRequisitionDetail
        data={{
          requisition: {
            id: "req-1",
            consecutive: "RQ-001",
            type: "compra",
            workId: "work-1",
            requesterId: "user-42",
            channel: "web",
            requiredDate: "2026-08-24",
            status: "en_revision",
            items: [],
          },
          catalogs: catalogsWithUsers,
          orders: [],
          expenses: [],
          history: [
            { event: "creada", at: "2026-08-24T10:00:00.000Z", actorId: "user-42" },
            { event: "iniciada_revision", at: "2026-08-24T11:00:00.000Z", actorId: "user-desconocido" },
          ],
          attachments: [],
        }}
        role="Revisor"
        go={vi.fn()}
        refresh={vi.fn()}
      />,
    );
    const actors = screen.getAllByTestId("audit-actor");
    expect(actors[0]).toHaveTextContent("Ana Torres");
    expect(actors[0]).not.toHaveTextContent("user-42");
    // Id ausente de catalogs.users: el fallback honesto se conserva, nunca el UUID crudo.
    expect(actors[1]).toHaveTextContent("Usuario interno");
    expect(actors[1]).not.toHaveTextContent("user-desconocido");
  });
});
