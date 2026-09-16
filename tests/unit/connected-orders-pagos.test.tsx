// @vitest-environment jsdom

// Adenda «Órdenes de Pago y caja menor» (docs/TASKS-pagos-y-caja.md §4, paquete S1): la ficha de la
// orden gana el diálogo de pago (medio con las etiquetas de payment-labels.tsx, nota y comprobante),
// "Pagar saldo" en lugar de "Marcar pagada" mientras haya saldo (A3), el historial con anulados
// tachados y el botón "Anular" con motivo (RF-510), el badge de estado de pago derivado (RF-508) y los
// filtros de pago que resuelve el servidor (RF-509, `parseListQuery` en lib/http/api.ts).

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectedOrders } from "../../components/screens/connected";

const catalogs = {
  works: [{ id: "work-1", name: "Torre Norte" }],
  tags: [],
  suppliers: [{ id: "supplier-1", name: "Ferretería Uno" }],
  items: [],
  features: {},
  costCenters: [{ id: "cc-1", name: "Administrativo" }],
  societies: [{ id: "soc-1", name: "Mizar Construcciones" }],
  users: [{ id: "user-juliana", name: "Juliana Pérez" }],
};
// 1 × $100.000 sin IVA con $50.000 ya pagados: saldo $50.000, estado de pago "parcial".
const line = { id: "item-1", description: "Cemento", quantity: 1, unit: "bulto", unitBase: 100_000, ivaRate: 0 };
const order = {
  id: "order-1",
  consecutive: "OC-001",
  type: "OC" as const,
  requisitionId: "req-1",
  requisitionConsecutive: "RQ-001",
  workId: "work-1",
  costCenterId: "cc-1",
  billedCompanyId: "soc-1",
  supplierId: "supplier-1",
  status: "generada",
  adminStatus: "contabilizada" as const,
  paidAmount: 50_000,
  paymentStatus: "parcial" as const,
  lines: [line],
};
type Row = typeof order;
const vigente = { id: "pago-0", orderId: "order-1", date: "2026-08-01", amount: 50_000, method: "efectivo" as const, note: "Anticipo en caja" };
const anulado = {
  id: "pago-x",
  orderId: "order-1",
  date: "2026-07-20",
  amount: 30_000,
  method: "transferencia" as const,
  externalReference: "TRX-77",
  annulled: true,
  annulmentReason: "Se registró dos veces",
  annulledBy: "user-juliana",
  annulledAt: "2026-07-21T15:00:00.000Z",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/**
 * Enruta por método/URL: historial (GET), pago nuevo (POST), anulación (PATCH del pago), cierre contable
 * (PATCH de estado), lista filtrada (GET con query), comprobante (prepare / PUT firmado / complete) y el
 * resto (expediente del proveedor) con una respuesta neutra.
 */
function mockFetch({ history = [] as unknown[], filtered = [] as Row[] } = {}) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input), method = init?.method ?? "GET";
    if (url === "/api/orders/order-1/payments" && method === "GET") return json(history);
    if (url === "/api/orders/order-1/payments" && method === "POST") {
      const body = JSON.parse(String(init?.body));
      const paidAmount = order.paidAmount + body.amount;
      return json(
        { payment: { id: "pago-nuevo", orderId: "order-1", ...body }, order: { ...order, paidAmount, paymentStatus: paidAmount >= 100_000 ? "pagada" : "parcial" } },
        201,
      );
    }
    if (url === "/api/orders/order-1/payments/pago-0" && method === "PATCH") {
      return json({ payment: { ...vigente, annulled: true }, order: { ...order, paidAmount: 0, paymentStatus: "pendiente" } });
    }
    if (url === "/api/orders/order-1/status" && method === "PATCH") return json({ ...order, adminStatus: "pagada" });
    if (url.startsWith("/api/orders?")) return json(filtered);
    if (url === "/api/attachments/pago_orden/pago-nuevo" && method === "POST") {
      return json({ attachment: { id: "adj-1" }, upload: { url: "https://signed.invalid/put", method: "PUT", multipart: { cacheControl: "3600", fileField: "" } } }, 201);
    }
    if (url === "https://signed.invalid/put") return json({});
    if (url === "/api/attachments/pago_orden/pago-nuevo/adj-1/complete") return json({ attachment: { id: "adj-1" } });
    return json({ id: "supplier-1", documents: [] });
  });
}
type FetchMock = ReturnType<typeof mockFetch>;
const calls = (fetchMock: FetchMock, method: string, url: string) =>
  fetchMock.mock.calls.filter(([input, init]) => String(input) === url && (init?.method ?? "GET") === method);
const lastBody = (fetchMock: FetchMock, method: string, url: string) => JSON.parse(String(calls(fetchMock, method, url).at(-1)![1]?.body));

function renderOrders(rows: Row[] = [order], role: "Revisor" | "Contabilidad" | "Aprobador" = "Revisor", refresh = vi.fn()) {
  return render(<ConnectedOrders data={{ rows, catalogs }} role={role} refresh={refresh} go={vi.fn()} />);
}
/** Abre la ficha lateral y espera a que termine la carga perezosa del historial. */
async function abrirFicha(fetchMock: FetchMock) {
  fireEvent.click(screen.getByText("OC-001"));
  await screen.findByRole("dialog", { name: "OC-001" });
  await waitFor(() => expect(calls(fetchMock, "GET", "/api/orders/order-1/payments").length).toBe(1));
  await waitFor(() => expect(screen.queryByText("Cargando pagos…")).toBeNull());
}
function guardarPago({ amount, method }: { amount?: string; method?: string }) {
  if (amount !== undefined) fireEvent.change(screen.getByLabelText("Valor"), { target: { value: amount } });
  if (method !== undefined) fireEvent.change(screen.getByLabelText("Medio"), { target: { value: method } });
  fireEvent.click(screen.getByRole("button", { name: "Guardar pago" }));
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("estado de pago derivado (RF-508)", () => {
  it("la lista y la ficha muestran el PaymentStatusBadge con el estado que trae el servidor", async () => {
    const fetchMock = mockFetch();
    renderOrders();
    const row = screen.getByText("OC-001").closest("tr")!;
    expect(within(row).getByText("Pago parcial")).toHaveAttribute("data-payment-status", "parcial");
    await abrirFicha(fetchMock);
    // Uno en la fila (detrás) y otro en el grupo de ejes de la ficha, junto a Entrega y Contabilidad
    // (`selector: "span"` deja fuera el <option> homónimo del filtro "Estado de pago").
    expect(screen.getAllByText("Pago parcial", { selector: "span" }).length).toBe(2);
    // "Empresa facturada" es también la etiqueta del filtro; la de la ficha va después en el DOM.
    expect(screen.getAllByText("Empresa facturada").at(-1)!.nextElementSibling).toHaveTextContent("Mizar Construcciones");
  });

  it("sin estado de pago en la fila (payload sin join) la celda dice — y la ficha no inventa un eje", async () => {
    const fetchMock = mockFetch();
    renderOrders([{ ...order, paymentStatus: undefined as unknown as "parcial" }]);
    expect(screen.queryByText("Pago parcial", { selector: "span" })).toBeNull();
    await abrirFicha(fetchMock);
    expect(screen.queryByText("Pago parcial", { selector: "span" })).toBeNull();
    expect(screen.queryByText("Pago", { selector: ".order-axis-label" })).toBeNull();
  });
});

describe("diálogo de pago: medio con etiqueta de caja, nota y validación inline", () => {
  it('"Registrar pago" abre el diálogo; el POST lleva medio y nota, y el historial muestra "Caja (efectivo)"', async () => {
    const fetchMock = mockFetch({ history: [vigente] });
    const refresh = vi.fn();
    renderOrders([order], "Contabilidad", refresh);
    await abrirFicha(fetchMock);
    // A1: la caja menor ES el medio `efectivo`; la etiqueta visible es la de payment-labels.tsx.
    expect(screen.getAllByText("Caja (efectivo)").length).toBeGreaterThan(0);
    expect(screen.getByText("Nota: Anticipo en caja")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Registrar pago" }));
    const dialog = screen.getByRole("dialog", { name: "Registrar pago" });
    expect(within(dialog).getByLabelText("Valor")).toHaveValue(null);
    fireEvent.change(screen.getByLabelText("Fecha"), { target: { value: "2026-09-10" } });
    fireEvent.change(screen.getByLabelText("Nota (opcional)"), { target: { value: "Pago en caja" } });
    guardarPago({ amount: "20000", method: "efectivo" });

    await waitFor(() => expect(calls(fetchMock, "POST", "/api/orders/order-1/payments").length).toBe(1));
    expect(lastBody(fetchMock, "POST", "/api/orders/order-1/payments")).toEqual({ date: "2026-09-10", amount: 20_000, method: "efectivo", note: "Pago en caja" });
    // Tras guardar: paso opcional del comprobante, historial recargado y ruta refrescada.
    await screen.findByRole("dialog", { name: "Adjuntar comprobante" });
    await waitFor(() => expect(calls(fetchMock, "GET", "/api/orders/order-1/payments").length).toBe(2));
    expect(refresh).toHaveBeenCalled();
    // Contabilidad no tiene order:pay: aunque el pago cubriera el saldo, nunca se encadena "pagada".
    expect(calls(fetchMock, "PATCH", "/api/orders/order-1/status").length).toBe(0);
  });

  it("exige medio y no deja superar el saldo, sin llamar al servidor", async () => {
    const fetchMock = mockFetch();
    renderOrders();
    await abrirFicha(fetchMock);
    fireEvent.click(screen.getByRole("button", { name: "Registrar pago" }));
    guardarPago({ amount: "10000" });
    expect(await screen.findByRole("alert")).toHaveTextContent("Elige el medio de pago.");
    expect(screen.getByLabelText("Medio")).toHaveAttribute("aria-invalid", "true");
    guardarPago({ amount: "60000", method: "transferencia" });
    expect(await screen.findByRole("alert")).toHaveTextContent(/supera el saldo pendiente/);
    expect(calls(fetchMock, "POST", "/api/orders/order-1/payments").length).toBe(0);
  });
});

describe('"Pagar saldo" sustituye a "Marcar pagada" mientras haya saldo (A3)', () => {
  it("con la orden contabilizada abre el diálogo prellenado con el saldo y, al cubrirlo, encadena adminStatus=pagada", async () => {
    const fetchMock = mockFetch();
    renderOrders();
    await abrirFicha(fetchMock);
    expect(screen.queryByRole("button", { name: "Marcar pagada" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Pagar saldo" }));
    const dialog = screen.getByRole("dialog", { name: "Pagar saldo" });
    expect(within(dialog).getByLabelText("Valor")).toHaveValue(50_000);
    expect(within(dialog).getByText(/pasará a “Pagada” en contabilidad/)).toBeInTheDocument();
    guardarPago({ method: "transferencia" });

    await waitFor(() => expect(calls(fetchMock, "PATCH", "/api/orders/order-1/status").length).toBe(1));
    expect(lastBody(fetchMock, "POST", "/api/orders/order-1/payments")).toEqual({ date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), amount: 50_000, method: "transferencia" });
    expect(lastBody(fetchMock, "PATCH", "/api/orders/order-1/status")).toEqual({ adminStatus: "pagada" });
    expect((await screen.findAllByText(/quedó como "Pagada" en contabilidad/)).length).toBeGreaterThan(0);
  });

  it("cubrir el saldo desde Registrar pago NO encadena pagada si la orden no está contabilizada", async () => {
    const fetchMock = mockFetch();
    renderOrders([{ ...order, adminStatus: "pendiente" as unknown as "contabilizada" }]);
    await abrirFicha(fetchMock);
    expect(screen.queryByRole("button", { name: "Pagar saldo" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Registrar pago" }));
    guardarPago({ amount: "50000", method: "cheque" });
    await screen.findByRole("dialog", { name: "Adjuntar comprobante" });
    expect(calls(fetchMock, "POST", "/api/orders/order-1/payments").length).toBe(1);
    expect(calls(fetchMock, "PATCH", "/api/orders/order-1/status").length).toBe(0);
  });

  it('con saldo cero y contabilizada queda "Marcar pagada" (solo cierra el estado) y "Registrar pago" se deshabilita', async () => {
    const fetchMock = mockFetch();
    renderOrders([{ ...order, paidAmount: 100_000, paymentStatus: "pagada" as unknown as "parcial" }]);
    await abrirFicha(fetchMock);
    expect(screen.queryByRole("button", { name: "Pagar saldo" })).toBeNull();
    expect(screen.getByRole("button", { name: "Registrar pago" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Marcar pagada" }));
    fireEvent.click(await screen.findByTestId("confirm-dialog-confirm"));
    await waitFor(() => expect(calls(fetchMock, "PATCH", "/api/orders/order-1/status").length).toBe(1));
    expect(lastBody(fetchMock, "PATCH", "/api/orders/order-1/status")).toEqual({ adminStatus: "pagada" });
    expect(calls(fetchMock, "POST", "/api/orders/order-1/payments").length).toBe(0);
  });
});

describe("historial: anulados tachados con motivo y quién; Anular con motivo obligatorio (RF-510)", () => {
  it("el pago anulado va tachado, con su motivo y quién lo anuló, sin botón Anular", async () => {
    const fetchMock = mockFetch({ history: [vigente, anulado] });
    renderOrders();
    await abrirFicha(fetchMock);
    const annulledRow = screen.getByText("TRX-77").closest("tr")!;
    expect(screen.getByText("TRX-77").tagName).toBe("DEL");
    expect(within(annulledRow).getByText("Anulado")).toBeInTheDocument();
    expect(within(annulledRow).queryByRole("button", { name: "Anular" })).toBeNull();
    expect(screen.getByText(/^Anulado el \d{2}\/07\/2026 por Juliana Pérez: Se registró dos veces$/)).toBeInTheDocument();
    // El vigente no va tachado y sí se puede anular.
    const liveRow = screen.getAllByText("Caja (efectivo)").find((node) => node.closest("tr"))!.closest("tr")!;
    expect(within(liveRow).queryByText("Anulado")).toBeNull();
    expect(screen.getAllByRole("button", { name: "Anular" }).length).toBe(1);
  });

  it("Anular pide motivo en el diálogo y envía PATCH { action: 'annul', reason }", async () => {
    const fetchMock = mockFetch({ history: [vigente] });
    const refresh = vi.fn();
    renderOrders([order], "Revisor", refresh);
    await abrirFicha(fetchMock);
    fireEvent.click(screen.getByRole("button", { name: "Anular" }));
    const confirmButton = await screen.findByTestId("confirm-dialog-confirm");
    expect(confirmButton).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Motivo de la anulación"), { target: { value: "Duplicado" } });
    expect(confirmButton).toBeEnabled();
    fireEvent.click(confirmButton);
    await waitFor(() => expect(calls(fetchMock, "PATCH", "/api/orders/order-1/payments/pago-0").length).toBe(1));
    expect(lastBody(fetchMock, "PATCH", "/api/orders/order-1/payments/pago-0")).toEqual({ action: "annul", reason: "Duplicado" });
    await waitFor(() => expect(calls(fetchMock, "GET", "/api/orders/order-1/payments").length).toBe(2));
    expect(refresh).toHaveBeenCalled();
  });

  it("un aprobador (sin payment:register) ve el historial pero ni anula ni adjunta", async () => {
    const fetchMock = mockFetch({ history: [vigente] });
    renderOrders([order], "Aprobador");
    await abrirFicha(fetchMock);
    expect(screen.getAllByText("Caja (efectivo)").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Anular" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Adjuntar" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Registrar pago" })).toBeNull();
  });
});

describe("comprobante del pago (adjunto pago_orden, subido tras crear el pago)", () => {
  it("tras guardar, el paso opcional sube el comprobante contra /api/attachments/pago_orden/<paymentId>", async () => {
    const fetchMock = mockFetch();
    renderOrders();
    await abrirFicha(fetchMock);
    fireEvent.click(screen.getByRole("button", { name: "Registrar pago" }));
    guardarPago({ amount: "10000", method: "tarjeta" });
    await screen.findByRole("dialog", { name: "Adjuntar comprobante" });
    const uploadButton = screen.getByRole("button", { name: "Adjuntar comprobante" });
    expect(uploadButton).toBeDisabled();
    const file = new File(["%PDF-1.4"], "recibo.pdf", { type: "application/pdf" });
    fireEvent.change(screen.getByLabelText("Comprobante del pago"), { target: { files: [file] } });
    expect(uploadButton).toBeEnabled();
    fireEvent.click(uploadButton);

    await waitFor(() => expect(calls(fetchMock, "POST", "/api/attachments/pago_orden/pago-nuevo/adj-1/complete").length).toBe(1));
    expect(lastBody(fetchMock, "POST", "/api/attachments/pago_orden/pago-nuevo")).toEqual({ type: "soporte", name: "recibo.pdf", mimeType: "application/pdf", sizeBytes: file.size });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Adjuntar comprobante" })).toBeNull());
    expect((await screen.findAllByText(/Comprobante adjuntado/)).length).toBeGreaterThan(0);
  });

  it("el historial enlaza la descarga del comprobante y ofrece Adjuntar al pago vigente que no lo tiene", async () => {
    const fetchMock = mockFetch({ history: [{ ...vigente, attachmentId: "adj-9" }, { ...vigente, id: "pago-1", note: undefined }] });
    renderOrders();
    await abrirFicha(fetchMock);
    expect(screen.getByRole("link", { name: "Descargar" })).toHaveAttribute("href", "/api/attachments/pago_orden/pago-0/adj-9/download");
    fireEvent.click(screen.getByRole("button", { name: "Adjuntar" }));
    expect(screen.getByRole("dialog", { name: "Adjuntar comprobante" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Medio")).toBeNull();
  });
});

describe("filtros de pago: los resuelve el servidor con los nombres de parseListQuery (RF-509)", () => {
  const filteredRow: Row = { ...order, id: "order-9", consecutive: "OC-009", workId: "work-2" };

  it("cambiar un filtro pide /api/orders con ese parámetro y la lista pasa a ser la del servidor", async () => {
    const fetchMock = mockFetch({ filtered: [filteredRow] });
    renderOrders();
    fireEvent.change(screen.getByLabelText("Medio de pago"), { target: { value: "efectivo" } });
    await waitFor(() => expect(fetchMock.mock.calls.some(([input]) => String(input) === "/api/orders?paymentMethod=efectivo")).toBe(true));
    expect(await screen.findByText("OC-009")).toBeInTheDocument();
    expect(screen.queryByText("OC-001")).toBeNull();
  });

  it("los seis filtros viajan juntos con sus nombres exactos", async () => {
    const fetchMock = mockFetch({ filtered: [filteredRow] });
    renderOrders();
    fireEvent.change(screen.getByLabelText("Medio de pago"), { target: { value: "transferencia" } });
    fireEvent.change(screen.getByLabelText("Estado de pago"), { target: { value: "parcial" } });
    fireEvent.change(screen.getByLabelText("Centro de costo"), { target: { value: "cc-1" } });
    fireEvent.change(screen.getByLabelText("Empresa facturada"), { target: { value: "soc-1" } });
    fireEvent.change(screen.getByLabelText("Pagado desde"), { target: { value: "2026-09-01" } });
    fireEvent.change(screen.getByLabelText("Pagado hasta"), { target: { value: "2026-09-30" } });
    await waitFor(() => expect(fetchMock.mock.calls.filter(([input]) => String(input).startsWith("/api/orders?")).length).toBe(6));
    const last = new URL(String(fetchMock.mock.calls.at(-1)![0]), "http://localhost");
    expect(Object.fromEntries(last.searchParams)).toEqual({
      paymentMethod: "transferencia",
      paymentStatus: "parcial",
      costCenterId: "cc-1",
      billedCompanyId: "soc-1",
      paidFrom: "2026-09-01",
      paidTo: "2026-09-30",
    });
  });

  it("los filtros de siempre siguen aplicando en cliente sobre la lista del servidor, y Limpiar vuelve a la ruta", async () => {
    const fetchMock = mockFetch({ filtered: [filteredRow] });
    renderOrders();
    fireEvent.change(screen.getByLabelText("Estado de pago"), { target: { value: "parcial" } });
    expect(await screen.findByText("OC-009")).toBeInTheDocument();
    // OC-009 es de work-2: el filtro de obra (cliente) la deja fuera aunque el servidor la devolvió.
    fireEvent.change(screen.getByLabelText("Obra"), { target: { value: "work-1" } });
    expect(screen.getByText("Sin resultados para estos filtros")).toBeInTheDocument();
    const requests = fetchMock.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Limpiar filtros" }));
    expect(screen.getByText("OC-001")).toBeInTheDocument();
    expect(screen.queryByText("OC-009")).toBeNull();
    expect(screen.getByLabelText("Estado de pago")).toHaveValue("");
    expect(fetchMock.mock.calls.length).toBe(requests);
  });
});
