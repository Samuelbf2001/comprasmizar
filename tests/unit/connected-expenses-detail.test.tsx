// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConnectedExpenses,
  ConnectedRequisitionDetail,
  groupExpensesByWorkAndTag,
} from "../../components/screens/connected";

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
    { id: "exp-1", workId: "work-1", origin: "requisicion", referenceId: "r-1", tagId: "tag-1", date: "2026-08-01", total: 100000, period: "2026-08" },
    { id: "exp-2", workId: "work-1", origin: "requisicion", referenceId: "r-2", tagId: "tag-2", date: "2026-08-02", total: 50000, period: "2026-08" },
    { id: "exp-3", workId: "work-1", origin: "caja_menor", referenceId: "p-1", tagId: "tag-1", date: "2026-08-03", total: 20000, period: "2026-08" },
    { id: "exp-4", workId: "work-2", origin: "requisicion", referenceId: "r-3", tagId: "tag-2", date: "2026-08-04", total: 30000, period: "2026-08" },
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
    render(
      <ConnectedExpenses
        data={{ expenses: rows, catalogs, pettyCash: [], pettyAttachments: {} }}
        pathname="/gastos"
        role="Contabilidad"
        refresh={vi.fn()}
      />,
    );
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
    { id: "exp-1", workId: "work-1", origin: "requisicion", referenceId: "r-1", tagId: "tag-1", date: "2026-08-01", total: 100000, period: "2026-08" },
  ];
  const expenseData = { expenses: rows, catalogs, pettyCash: [], pettyAttachments: {} };

  beforeEach(() => vi.restoreAllMocks());

  it("no ofrece repartir el gasto a un rol sin permiso (Contabilidad)", () => {
    render(<ConnectedExpenses data={expenseData} pathname="/gastos" role="Contabilidad" refresh={vi.fn()} />);
    expect(screen.queryByTestId("expense-share-trigger")).toBeNull();
  });

  it("bloquea el envío mientras la suma no cuadre al peso o repita una obra", () => {
    render(<ConnectedExpenses data={expenseData} pathname="/gastos" role="Revisor" refresh={vi.fn()} />);
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
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ updated: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const refresh = vi.fn();
    render(<ConnectedExpenses data={expenseData} pathname="/gastos" role="Revisor" refresh={refresh} />);
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

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
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

  it("muestra el id del solicitante interno cuando no hay solicitante externo", () => {
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
    expect(screen.getByTestId("requisition-requester")).toHaveTextContent("Usuario user-42");
  });

  it("muestra qué usuario ejecutó cada evento del historial, o que fue automático", () => {
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
    expect(actors[0]).toHaveTextContent("Usuario user-42");
    expect(actors[1]).toHaveTextContent("Usuario automático");
  });
});
