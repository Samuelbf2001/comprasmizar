// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectedRequisitionDetail } from "../../components/screens/connected";

const baseData = {
  requisition: {
    id: "req-1",
    consecutive: "RQ-001",
    type: "compra" as const,
    workId: "work-1",
    channel: "interno",
    requiredDate: "2026-08-24",
    status: "en_revision",
    items: [
      { id: "item-1", description: "Arena", quantity: 1, unit: "saco" },
    ],
  },
  catalogs: {
    works: [],
    tags: [{ id: "tag-1", name: "Obra" }],
    suppliers: [{ id: "supplier-1", name: "Proveedor existente" }],
    items: [],
    features: {},
  },
  orders: [],
  expenses: [],
  history: [],
  attachments: [],
};

function renderDetail(role: "Revisor" | "Aprobador" = "Revisor") {
  return render(
    <ConnectedRequisitionDetail
      data={baseData}
      role={role}
      go={vi.fn()}
      refresh={vi.fn()}
    />,
  );
}

describe("alta rápida de proveedor desde revisión", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("crea solo con nombre, omite NIT vacío y asigna inmediatamente sin duplicar POST", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "supplier-2", name: "Canteras Norte" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    renderDetail();
    const trigger = screen.getByRole("button", { name: /Crear proveedor para/ });
    fireEvent.click(trigger);
    fireEvent.change(screen.getByLabelText("Razón social *"), {
      target: { value: "Canteras Norte" },
    });
    const submit = screen.getByRole("button", { name: "Crear y asignar" });
    fireEvent.click(submit);
    fireEvent.click(submit);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ name: "Canteras Norte" }),
      }),
    );
    expect(screen.getByRole("combobox", { name: "Proveedor final" })).toHaveValue(
      "supplier-2",
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Canteras Norte quedó asignado",
    );
    expect(document.activeElement).toBe(trigger);
  });

  it("conserva el diálogo y muestra un conflicto del backend", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ message: "Ya existe un proveedor con el mismo NIT" }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      }),
    );
    renderDetail();
    fireEvent.click(screen.getByRole("button", { name: /Crear proveedor para/ }));
    fireEvent.change(screen.getByLabelText("Razón social *"), {
      target: { value: "Duplicado" },
    });
    fireEvent.change(screen.getByLabelText("NIT (opcional)"), {
      target: { value: "900123" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Crear y asignar" }));

    // GRAVE 3 (QA 2026-08-31) añadió otros `role="alert"` fuera del diálogo (razones de
    // botones deshabilitados en este fixture sin obra/etiqueta) — se acota la búsqueda al
    // diálogo de alta de proveedor para no ambigüar con esos.
    const dialog = screen.getByRole("dialog", { name: "Nuevo proveedor" });
    await waitFor(() =>
      expect(within(dialog).getByRole("alert")).toHaveTextContent("mismo NIT"),
    );
    expect(dialog).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("atrapa Tab y Shift+Tab en el diálogo y bloquea la alta para Aprobador", () => {
    renderDetail();
    fireEvent.click(screen.getByRole("button", { name: /Crear proveedor para/ }));
    const close = screen.getByRole("button", { name: "Cerrar alta de proveedor" });
    // El envío solo se habilita con razón social; deshabilitado quedaría fuera
    // de la trampa de foco y nunca sería el último elemento enfocable.
    fireEvent.change(screen.getByLabelText("Razón social *"), {
      target: { value: "Canteras Norte" },
    });
    const submit = screen.getByRole("button", { name: "Crear y asignar" });
    expect(submit).toBeEnabled();
    submit.focus();
    fireEvent.keyDown(submit, { key: "Tab" });
    expect(document.activeElement).toBe(close);
    close.focus();
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(submit);

    cleanup();
    renderDetail("Aprobador");
    expect(screen.queryByRole("button", { name: /Crear proveedor para/ })).toBeNull();
  });
});

// Reunión 2026-08-31: la obra la asigna el revisor (filtrada por la empresa de la
// requisición), el proveedor deja de bloquear "Enviar a aprobación", e IVA/Desc viajan
// como fracción (0.19, no 19) — ver reviewedItemSchema en lib/http/schemas.ts.
describe("revisión: obra por empresa, IVA/Desc como fracción y proveedor sin bloquear", () => {
  const reviewData = {
    requisition: {
      id: "req-1",
      consecutive: "RQ-001",
      type: "compra" as const,
      societyId: "soc-1",
      channel: "interno",
      status: "en_revision",
      items: [
        { id: "item-1", description: "Arena", quantity: 1, unit: "saco", unitBase: 100000 },
      ],
    },
    catalogs: {
      // La obra de otra sociedad ("work-other") no debe ofrecerse: solo las de "soc-1".
      works: [
        { id: "work-1", name: "Torre Norte", societyId: "soc-1" },
        { id: "work-other", name: "Obra de otra empresa", societyId: "soc-2" },
      ],
      tags: [{ id: "tag-1", name: "Urgente" }],
      suppliers: [],
      items: [],
      features: {},
    },
    orders: [],
    expenses: [],
    history: [],
    attachments: [],
  };

  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("filtra la obra por la empresa de la requisición", () => {
    render(<ConnectedRequisitionDetail data={reviewData} role="Revisor" go={vi.fn()} refresh={vi.fn()} />);
    const workSelect = screen.getByRole("combobox", { name: "Obra" });
    expect(screen.getByRole("option", { name: "Torre Norte" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Obra de otra empresa" })).toBeNull();
    expect(workSelect).toBeInTheDocument();
  });

  it("envía IVA/Desc como fracción, obra y forma de pago, sin exigir proveedor para enviar a aprobación", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "req-1", items: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    render(<ConnectedRequisitionDetail data={reviewData} role="Revisor" go={vi.fn()} refresh={vi.fn()} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Etiqueta y ruta de aprobación" }), {
      target: { value: "tag-1" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Obra" }), {
      target: { value: "work-1" },
    });
    // El proveedor sigue sin asignarse (por definir) y "Enviar a aprobación" no está bloqueado por eso.
    fireEvent.change(screen.getByRole("combobox", { name: "IVA %" }), {
      target: { value: "0.19" },
    });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Desc %" }), {
      target: { value: "10" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Guardar revisión" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.workId).toBe("work-1");
    expect(body.paymentTerms).toBe("ANTICIPADO");
    expect(body.items[0].ivaRate).toBe(0.19);
    expect(body.items[0].discountRate).toBe(0.1);

    const sendButton = screen.getByRole("button", { name: "Enviar a aprobación" });
    expect(sendButton).toBeEnabled();
  });
});

// El ítem declinado (por el revisor o el aprobador) se conserva visible y marcado como tal:
// es la trazabilidad que hoy se pierde en el Excel del cliente.
describe("ítem declinado se conserva visible en la ficha", () => {
  afterEach(() => cleanup());

  it("muestra el motivo de declinación en la vista de solo lectura", () => {
    render(
      <ConnectedRequisitionDetail
        role="Contabilidad"
        go={vi.fn()}
        refresh={vi.fn()}
        data={{
          requisition: {
            id: "req-1",
            consecutive: "RQ-001",
            type: "compra",
            channel: "interno",
            status: "aprobada",
            items: [
              { id: "item-1", description: "Arena", quantity: 1, unit: "saco", unitBase: 100000, status: "declinado", declineReason: "Duplicado con otra línea" },
              { id: "item-2", description: "Cemento", quantity: 2, unit: "bulto", unitBase: 50000, status: "aprobado" },
            ],
          },
          catalogs: { works: [], tags: [], suppliers: [], items: [], features: {} },
          orders: [],
          expenses: [],
          history: [],
          attachments: [],
        }}
      />,
    );
    expect(screen.getByText(/Declinado/)).toBeInTheDocument();
    expect(screen.getByText(/Duplicado con otra línea/)).toBeInTheDocument();
    // El ítem vigente sigue ahí, no fue removido por la presencia del declinado.
    expect(screen.getByText("Cemento")).toBeInTheDocument();
  });
});

// "Generar órdenes" es su propio paso con su propio botón (el cliente dijo que no la veía):
// agrupa ítems aprobados por proveedor y anticipa SUPPLIER_REQUIRED antes de que el usuario choque con él.
describe("bloque Generar órdenes agrupa por proveedor", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  const catalogs = {
    works: [{ id: "work-1", name: "Torre Norte", societyId: "soc-1" }],
    tags: [],
    suppliers: [
      { id: "supplier-1", name: "Ferretería Uno" },
      { id: "supplier-2", name: "Ferretería Dos" },
    ],
    items: [],
    features: {},
  };

  it("muestra un grupo por proveedor y advierte de los ítems sin proveedor asignado", () => {
    render(
      <ConnectedRequisitionDetail
        role="Revisor"
        go={vi.fn()}
        refresh={vi.fn()}
        data={{
          requisition: {
            id: "req-1",
            consecutive: "RQ-001",
            type: "compra",
            channel: "interno",
            societyId: "soc-1",
            workId: "work-1",
            status: "aprobada",
            items: [
              { id: "item-1", description: "Arena", quantity: 1, unit: "saco", unitBase: 100000, status: "aprobado", finalSupplierId: "supplier-1" },
              { id: "item-2", description: "Cemento", quantity: 2, unit: "bulto", unitBase: 50000, status: "aprobado", finalSupplierId: "supplier-2" },
              { id: "item-3", description: "Grava", quantity: 3, unit: "m3", unitBase: 20000, status: "aprobado" },
            ],
          },
          catalogs,
          orders: [],
          expenses: [],
          history: [],
          attachments: [],
        }}
      />,
    );
    const groups = screen.getAllByTestId("order-supplier-group");
    expect(groups).toHaveLength(2);
    // `{ selector: "b" }` desambigua el nombre del grupo del mismo nombre repetido como <option> del
    // select de asignación (bloqueante de atasco, reunión 2026-08-31): ambos textos ahora coexisten.
    expect(screen.getByText(/Ferretería Uno/, { selector: "b" })).toBeInTheDocument();
    expect(screen.getByText(/Ferretería Dos/, { selector: "b" })).toBeInTheDocument();
    expect(screen.getByTestId("missing-supplier-warning")).toHaveTextContent("Grava");
    expect(screen.getByRole("button", { name: "Generar órdenes" })).toBeDisabled();
  });

  // Bloqueante de atasco (reunión 2026-08-31): antes este bloque solo mostraba una advertencia con el
  // botón deshabilitado, sin ninguna forma de resolverlo desde aquí. Prueba de punta a punta en la UI:
  // elegir proveedor para el ítem que no lo tiene, disparar assign_suppliers, y que al refrescar con la
  // requisición ya corregida el botón "Generar órdenes" quede habilitado.
  it("permite asignar proveedor a un ítem sin él desde el propio bloque, y tras asignarlo el botón se habilita", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    const dataConProveedorFaltante = {
      requisition: {
        id: "req-1",
        consecutive: "RQ-001",
        type: "compra" as const,
        channel: "interno",
        societyId: "soc-1",
        workId: "work-1",
        status: "aprobada",
        items: [
          { id: "item-1", description: "Arena", quantity: 1, unit: "saco", unitBase: 100000, status: "aprobado" as const, finalSupplierId: "supplier-1" },
          { id: "item-3", description: "Grava", quantity: 3, unit: "m3", unitBase: 20000, status: "aprobado" as const },
        ],
      },
      catalogs,
      orders: [],
      expenses: [],
      history: [],
      attachments: [],
    };
    const { rerender } = render(
      <ConnectedRequisitionDetail role="Revisor" go={vi.fn()} refresh={vi.fn()} data={dataConProveedorFaltante} />,
    );
    const asignarButton = screen.getByRole("button", { name: "Asignar proveedor" });
    expect(asignarButton).toBeDisabled(); // sin selección todavía
    const select = within(screen.getByTestId("missing-supplier-warning")).getByRole("combobox");
    fireEvent.change(select, { target: { value: "supplier-1" } });
    expect(asignarButton).toBeEnabled();
    fireEvent.click(asignarButton);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/requisitions/req-1/actions");
    expect(JSON.parse(String(init.body))).toEqual({ action: "assign_suppliers", assignments: [{ itemId: "item-3", supplierId: "supplier-1" }] });

    // Simula el refresh real (RF-1105: la pantalla vuelve a pintarse con la requisición ya corregida) —
    // el ítem ya trae finalSupplierId, así que la advertencia desaparece y el botón se habilita solo.
    rerender(
      <ConnectedRequisitionDetail
        role="Revisor"
        go={vi.fn()}
        refresh={vi.fn()}
        data={{
          ...dataConProveedorFaltante,
          requisition: {
            ...dataConProveedorFaltante.requisition,
            items: dataConProveedorFaltante.requisition.items.map((item) => (item.id === "item-3" ? { ...item, finalSupplierId: "supplier-1" } : item)),
          },
        }}
      />,
    );
    expect(screen.queryByTestId("missing-supplier-warning")).toBeNull();
    expect(screen.getByRole("button", { name: "Generar órdenes" })).toBeEnabled();
  });

  it("habilita el botón y dispara generate_orders cuando todos los ítems tienen proveedor", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    render(
      <ConnectedRequisitionDetail
        role="Revisor"
        go={vi.fn()}
        refresh={vi.fn()}
        data={{
          requisition: {
            id: "req-1",
            consecutive: "RQ-001",
            type: "compra",
            channel: "interno",
            societyId: "soc-1",
            workId: "work-1",
            status: "aprobada",
            items: [
              { id: "item-1", description: "Arena", quantity: 1, unit: "saco", unitBase: 100000, status: "aprobado", finalSupplierId: "supplier-1" },
            ],
          },
          catalogs,
          orders: [],
          expenses: [],
          history: [],
          attachments: [],
        }}
      />,
    );
    expect(screen.queryByTestId("missing-supplier-warning")).toBeNull();
    const button = screen.getByRole("button", { name: "Generar órdenes" });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    // MENOR: el confirm nativo se reemplazó por un diálogo accesible propio
    // (useConfirmDialog en screen-primitives.tsx) — se confirma haciendo clic en su botón.
    fireEvent.click(await screen.findByTestId("confirm-dialog-confirm"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/requisitions/req-1/actions");
    expect(JSON.parse(String(init.body))).toEqual({ action: "generate_orders" });
  });
});
