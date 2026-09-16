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

/** «+ Crear proveedor…» ya no es un botón único en una barra masiva (ese botón usaba SIEMPRE
 *  `lines[0].id`, así que el proveedor nuevo terminaba en el primer ítem sin importar en qué fila
 *  se hubiera pulsado) — ahora es la última opción del `<select>` de proveedor de CADA fila. */
function openQuickSupplierFromRow(nombre = "Arena") {
  const select = screen.getByRole("combobox", { name: `Proveedor de ${nombre}` });
  fireEvent.change(select, { target: { value: "__nuevo__" } });
  return select;
}

describe("alta rápida de proveedor desde una fila (fija el line.id correcto)", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("crea solo con nombre, omite la identificación vacía y asigna inmediatamente a ESA fila sin duplicar POST", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "supplier-2", name: "Canteras Norte" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    renderDetail();
    const trigger = openQuickSupplierFromRow();
    fireEvent.change(screen.getByLabelText("Razón social *"), {
      target: { value: "Canteras Norte" },
    });
    const submit = screen.getByRole("button", { name: "Crear y asignar" });
    fireEvent.click(submit);
    fireEvent.click(submit);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    // Alta rápida unificada (components/screens/supplier-quick-create.tsx): sin identificación no
    // viaja tipo ni número; la ficha queda marcada pendiente de completar.
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ name: "Canteras Norte", pendingNormalization: true }),
      }),
    );
    expect(screen.getByRole("combobox", { name: "Proveedor de Arena" })).toHaveValue(
      "supplier-2",
    );
    expect(screen.getByText(/Canteras Norte quedó asignado al ítem/)).toBeInTheDocument();
    // El foco vuelve al disparador — que ahora es el <select> de la fila, no un botón aparte.
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
    openQuickSupplierFromRow();
    fireEvent.change(screen.getByLabelText("Razón social *"), {
      target: { value: "Duplicado" },
    });
    fireEvent.change(screen.getByLabelText("Identificación (opcional)"), {
      target: { value: "900123" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Crear y asignar" }));

    const dialog = screen.getByRole("dialog", { name: "Nuevo proveedor" });
    await waitFor(() =>
      expect(within(dialog).getByRole("alert")).toHaveTextContent("mismo NIT"),
    );
    expect(dialog).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("atrapa Tab y Shift+Tab en el diálogo; para Aprobador la fila ni siquiera existe (no ve la revisión)", () => {
    renderDetail();
    openQuickSupplierFromRow();
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
    // Un Aprobador no revisa (la requisición sigue en_revision): no ve la tabla editable en
    // absoluto, así que el <select> de proveedor de la fila ni siquiera está en el DOM.
    expect(screen.queryByRole("combobox", { name: /Proveedor de/ })).toBeNull();
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
      // approverId: sugerencia por defecto de la etiqueta (reunión 2026-09) — prerellena el select
      // "Aprobador" al elegir "tag-1", pero el revisor puede cambiarlo (ver `approvers`, abajo).
      tags: [{ id: "tag-1", name: "Urgente", approverId: "approver-1" }],
      suppliers: [],
      items: [],
      approvers: [
        { id: "approver-1", name: "Nelson Aprobador" },
        { id: "approver-2", name: "Sonia Aprobadora" },
      ],
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

  // Reunión 2026-09: el 19 % se tecleaba una vez por ítem, y ese tecleo repetido era la mayor
  // parte del coste de revisar. La acción masiva ya no vive en una barra fija: cuelga de un
  // botón «⋯ a todos» en la cabecera de su propia columna — sigue siendo un solo gesto.
  it("aplica el IVA a todos los ítems vigentes de una sola vez y respeta los declinados (vía autoguardado)", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "req-1", items: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const varias = {
      ...reviewData,
      requisition: {
        ...reviewData.requisition,
        items: [
          { id: "item-1", description: "Arena", quantity: 1, unit: "saco", unitBase: 100000 },
          { id: "item-2", description: "Cemento", quantity: 2, unit: "bulto", unitBase: 50000 },
          {
            id: "item-3",
            description: "Arenilla",
            quantity: 1,
            unit: "m3",
            unitBase: 20000,
            status: "declinado" as const,
            declineReason: "Se cubre con la arena",
          },
        ],
      },
    };
    render(<ConnectedRequisitionDetail data={varias} role="Revisor" go={vi.fn()} refresh={vi.fn()} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Etiqueta" }), {
      target: { value: "tag-1" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Obra" }), { target: { value: "work-1" } });

    // Un solo gesto: abrir el menú de la columna IVA y elegir "19 % a todos".
    fireEvent.click(screen.getByRole("button", { name: "Aplicar un IVA a todos los ítems vigentes" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "19 % a todos" }));

    await vi.advanceTimersByTimeAsync(1600);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    vi.useRealTimers();
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    const porId = Object.fromEntries(body.items.map((i: { id: string }) => [i.id, i]));
    expect(porId["item-1"].ivaRate).toBe(0.19);
    expect(porId["item-2"].ivaRate).toBe(0.19);
    // El declinado no se toca: aplicarle una tasa a una línea que no se va a comprar no significa nada.
    expect(porId["item-3"].ivaRate).toBeUndefined();
    expect(porId["item-3"].status).toBe("declinado");
  });

  it("envía IVA/Desc como fracción, obra y forma de pago al pulsar Enviar a aprobación, sin exigir proveedor", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "req-1", items: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    render(<ConnectedRequisitionDetail data={reviewData} role="Revisor" go={vi.fn()} refresh={vi.fn()} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Etiqueta" }), {
      target: { value: "tag-1" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Obra" }), {
      target: { value: "work-1" },
    });
    // El proveedor sigue sin asignarse (por definir) y "Enviar a aprobación" no está bloqueado por eso.
    fireEvent.change(screen.getByRole("combobox", { name: "IVA de Arena" }), {
      target: { value: "0.19" },
    });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Descuento de Arena" }), {
      target: { value: "10" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Enviar a aprobación" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [primera, segunda] = fetchMock.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)));
    expect(primera.action).toBe("review");
    expect(primera.workId).toBe("work-1");
    expect(primera.paymentTerms).toBe("ANTICIPADO");
    expect(primera.items[0].ivaRate).toBe(0.19);
    expect(primera.items[0].discountRate).toBe(0.1);
    // Elegir "tag-1" prerellenó el aprobador con su sugerencia por defecto (approver-1); el review
    // enviado lo lleva sin que el revisor haya tocado el select de aprobador.
    expect(primera.approverId).toBe("approver-1");
    expect(segunda).toEqual({ action: "send_for_approval" });
  });

  // Reunión 2026-09 (decisión del cliente): "etiqueto a qué obra va y etiqueto quién me va a aprobar" —
  // el aprobador se sugiere por la etiqueta pero el revisor puede cambiarlo. Ya no hay un botón
  // deshabilitado con el motivo al lado: la primaria SIEMPRE se puede pulsar, y si falta algo
  // enfoca y marca el campo que falta.
  it("elegir etiqueta pre-rellena el aprobador (sugerencia por defecto) pero se puede cambiar", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "req-1", items: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    render(<ConnectedRequisitionDetail data={reviewData} role="Revisor" go={vi.fn()} refresh={vi.fn()} />);
    const approverSelect = screen.getByRole("combobox", { name: "Aprobador" });
    expect(approverSelect).toHaveValue(""); // nada elegido todavía: sin sugerencia disparada
    fireEvent.change(screen.getByRole("combobox", { name: "Obra" }), { target: { value: "work-1" } });

    // Sin etiqueta, pulsar la primaria enfoca y marca el campo que falta en vez de solo avisar.
    fireEvent.click(screen.getByRole("button", { name: "Enviar a aprobación" }));
    expect(screen.getByText("Falta elegir la etiqueta.")).toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "Etiqueta" }));
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.change(screen.getByRole("combobox", { name: "Etiqueta" }), { target: { value: "tag-1" } });
    expect(approverSelect).toHaveValue("approver-1"); // sugerencia por defecto de la etiqueta

    // El revisor cambia el aprobador sugerido: la elección manual gana, no la etiqueta.
    fireEvent.change(approverSelect, { target: { value: "approver-2" } });
    expect(approverSelect).toHaveValue("approver-2");
    fireEvent.click(screen.getByRole("button", { name: "Enviar a aprobación" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [primera] = fetchMock.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)));
    expect(primera.approverId).toBe("approver-2");
  });

  it("sin aprobador, pulsar Enviar a aprobación enfoca el select de aprobador y no manda nada", () => {
    // Etiqueta sin aprobador por defecto: elegirla no prerellena nada.
    const sinSugerencia = { ...reviewData, catalogs: { ...reviewData.catalogs, tags: [{ id: "tag-2", name: "Sin sugerencia" }] } };
    const fetchMock = vi.spyOn(globalThis, "fetch");
    render(<ConnectedRequisitionDetail data={sinSugerencia} role="Revisor" go={vi.fn()} refresh={vi.fn()} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Etiqueta" }), { target: { value: "tag-2" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Obra" }), { target: { value: "work-1" } });
    expect(screen.getByRole("combobox", { name: "Aprobador" })).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "Enviar a aprobación" }));
    expect(screen.getByText("Falta elegir el aprobador.")).toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "Aprobador" }));
    expect(fetchMock).not.toHaveBeenCalled();
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

// "Generar órdenes (K)" es la primaria de este estado, al pie del panel de ítems: agrupa ítems
// aprobados por proveedor y anticipa SUPPLIER_REQUIRED antes de que el usuario choque con él.
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
    // La primaria "Generar órdenes (K)" cuenta los grupos YA completos (2), no incluye a Grava.
    expect(screen.getByRole("button", { name: /Generar órdenes \(2\)/ })).toBeEnabled();
  });

  // Bloqueante de atasco (reunión 2026-08-31): ya no hay un botón "Asignar proveedor(es)" aparte —
  // la primaria "Generar órdenes (K)" hace `assign_suppliers` + `generate_orders` en una sola
  // secuencia; si falta elegir un proveedor, pulsarla enfoca el primer select faltante en vez de
  // intentarlo.
  it("si falta elegir un proveedor, pulsar la primaria enfoca el primer select faltante en vez de intentarlo", () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
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
    fireEvent.click(screen.getByRole("button", { name: /Generar órdenes/ }));
    expect(document.activeElement).toBe(within(screen.getByTestId("missing-supplier-warning")).getByRole("combobox"));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("con el proveedor elegido, la primaria manda assign_suppliers y luego generate_orders en una sola secuencia", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } }),
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
    const select = within(screen.getByTestId("missing-supplier-warning")).getByRole("combobox");
    fireEvent.change(select, { target: { value: "supplier-1" } });
    fireEvent.click(screen.getByRole("button", { name: /Generar órdenes/ }));
    fireEvent.click(await screen.findByTestId("confirm-dialog-confirm"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const cuerpos = fetchMock.mock.calls
      .filter(([url]) => String(url) === "/api/requisitions/req-1/actions")
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)));
    expect(cuerpos[0]).toEqual({ action: "assign_suppliers", assignments: [{ itemId: "item-3", supplierId: "supplier-1" }] });
    expect(cuerpos[1]).toEqual({ action: "generate_orders" });
  });

  it("habilita la primaria y dispara solo generate_orders cuando todos los ítems ya tienen proveedor", async () => {
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
    const button = screen.getByRole("button", { name: /Generar órdenes \(1\)/ });
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

// BLOQUEANTE (QA reasignación, reunión 2026-09): el revisor necesita poder reasignar el aprobador de
// una requisición ya en_aprobacion (el caso real: el asignado dejó de ser elegible) sin pasar por
// review(), que solo opera en_revision/devuelta. Ahora vive detrás de «Más ⋯» en vez del bloque
// lateral fijo de siempre.
describe("reasignar aprobador en en_aprobacion (detrás de «Más ⋯»)", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });
  const detailData = {
    requisition: {
      id: "req-1",
      consecutive: "RQ-001",
      type: "compra" as const,
      workId: "work-1",
      channel: "interno",
      requiredDate: "2026-08-24",
      status: "en_aprobacion",
      approverId: "approver-1",
      items: [{ id: "item-1", description: "Arena", quantity: 1, unit: "saco" }],
    },
    catalogs: {
      works: [],
      tags: [{ id: "tag-1", name: "Obra" }],
      suppliers: [],
      items: [],
      users: [{ id: "approver-1", name: "Nelson" }, { id: "approver-2", name: "Sonia" }],
      approvers: [{ id: "approver-1", name: "Nelson" }, { id: "approver-2", name: "Sonia" }],
      features: {},
    },
    orders: [],
    expenses: [],
    history: [],
    attachments: [],
  };

  it("el revisor ve el aprobador asignado y, tras abrir «Más ⋯», el control para reasignarlo con el texto de cuándo usarlo", () => {
    render(<ConnectedRequisitionDetail data={detailData} role="Revisor" go={vi.fn()} refresh={vi.fn()} />);
    expect(screen.getByTestId("requisition-approver")).toHaveTextContent("Nelson");
    expect(screen.queryByTestId("reassign-approver")).toBeNull(); // el diálogo no está abierto todavía
    fireEvent.click(screen.getByRole("button", { name: "Más" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Reasignar aprobador" }));
    expect(screen.getByTestId("reassign-approver")).toHaveTextContent(
      "Si el aprobador asignado no puede atenderla, reasígnala aquí.",
    );
  });

  it("reasignar envía action: reassign_approver con el nuevo approverId", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ...detailData.requisition, approverId: "approver-2" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    render(<ConnectedRequisitionDetail data={detailData} role="Revisor" go={vi.fn()} refresh={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Más" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Reasignar aprobador" }));
    const panel = within(screen.getByTestId("reassign-approver"));
    fireEvent.change(panel.getByRole("combobox"), { target: { value: "approver-2" } });
    fireEvent.click(panel.getByRole("button", { name: "Reasignar aprobador" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/requisitions/req-1/actions");
    expect(JSON.parse(String(init.body))).toEqual({ action: "reassign_approver", approverId: "approver-2" });
  });

  it("un aprobador (no revisor) no ve la opción de reasignar aprobador", () => {
    // El aprobador SÍ ve su propia primaria/menú (decide sus ítems, con "Devolver a revisión" en
    // «Más ⋯») — lo que nunca debe ver es "Reasignar aprobador", que es cosa del revisor.
    render(<ConnectedRequisitionDetail data={detailData} role="Aprobador" go={vi.fn()} refresh={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Más" }));
    expect(screen.getByRole("menuitem", { name: "Devolver a revisión" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Reasignar aprobador" })).toBeNull();
    expect(screen.queryByTestId("reassign-approver")).toBeNull();
  });
});
