// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SuppliersScreen } from "../../components/screens/suppliers";

const supplierId = "11111111-1111-4111-8111-111111111111";
const supplier = {
  id: supplierId,
  name: "Acabados del Norte SAS",
  nit: "901234567-1",
  contact: { name: "Paola Méndez", phone: "+57 310 442 18 90" },
  active: true,
};

const list = (access = { canManage: true, canReadBank: true }) =>
  new Response(JSON.stringify({ suppliers: [supplier], access }), { status: 200 });

const detail = (access = { canManage: true, canReadBank: true }) =>
  new Response(
    JSON.stringify({
      supplier: {
        ...supplier,
        bankDetails: {
          bankName: "Bancolombia",
          accountType: "corriente",
          accountNumber: "123456789",
          accountHolder: supplier.name,
        },
      },
      access,
      orders: [
        {
          id: "order-1",
          consecutive: "OC-2026-0042",
          type: "OC",
          status: "cumplida",
          generatedAt: "2026-08-23T14:00:00.000Z",
          total: 1250000,
        },
      ],
      documents: [],
    }),
    { status: 200 },
  );

describe("SuppliersScreen", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => cleanup());

  it("uses API capabilities for accounting read-only and bank visibility", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(list({ canManage: false, canReadBank: true }))
      .mockResolvedValueOnce(detail({ canManage: false, canReadBank: true }));

    render(<SuppliersScreen role="Contabilidad" demoMode={false} />);
    await screen.findByText("Acabados del Norte SAS");
    expect(screen.queryByRole("button", { name: /Nuevo proveedor/i })).toBeNull();
    const trigger = screen.getByRole("button", { name: /Abrir ficha de Acabados/i });
    trigger.focus();
    fireEvent.click(trigger);
    await screen.findByRole("dialog", { name: /Acabados del Norte/i });
    expect(screen.getByText("Bancolombia")).toBeInTheDocument();
    expect(screen.getByText(/Total comprado/i)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(`/api/suppliers/${supplierId}`, expect.anything());
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(trigger).toHaveFocus();
  });

  // QA H5: la marca «Beneficiario pendiente de completar» de la bandeja y del detalle enlaza aquí.
  it("opens the supplier file named in ?proveedor= without waiting for a click", async () => {
    window.history.replaceState(null, "", `/proveedores?proveedor=${supplierId}`);
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => (String(input) === "/api/suppliers" ? list() : detail()));
    try {
      render(<SuppliersScreen role="Revisor" demoMode={false} />);
      expect(await screen.findByRole("dialog", { name: /Acabados del Norte/i })).toBeInTheDocument();
      expect(fetchMock).toHaveBeenCalledWith(`/api/suppliers/${supplierId}`, expect.anything());
      expect(fetchMock.mock.calls.filter(([input]) => String(input) === `/api/suppliers/${supplierId}`)).toHaveLength(1);
    } finally {
      window.history.replaceState(null, "", "/");
    }
  });

  it("hides bank details and editing controls when the API gates Admin Mizar", async () => {
    render(<SuppliersScreen role="Administrador Mizar" demoMode />);
    expect(await screen.findByText("Cementos del Oriente SAS")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Nuevo proveedor/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Abrir ficha de Cementos/i }));
    expect(await screen.findByRole("dialog", { name: /Cementos del Oriente/i })).toBeInTheDocument();
    expect(screen.queryByText("Bancolombia")).toBeNull();
    expect(screen.getByText(/Datos bancarios no disponibles/i)).toBeInTheDocument();
  });

  it("sends null and empty objects when PATCH clears optional supplier fields", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(list())
      .mockResolvedValueOnce(detail())
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...supplier }), { status: 200 }))
      .mockResolvedValueOnce(detail());

    render(<SuppliersScreen role="Revisor" demoMode={false} />);
    await screen.findByText("Acabados del Norte SAS");
    fireEvent.click(screen.getByRole("button", { name: /Abrir ficha de Acabados/i }));
    await screen.findByRole("dialog", { name: /Acabados del Norte/i });
    fireEvent.click(screen.getByRole("button", { name: "Editar" }));
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByRole("dialog", { name: /Acabados del Norte/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Editar" }));
    // RF-601: el NIT legado se edita como identificación (tipo + número); vaciarla manda null.
    expect(screen.getByRole("combobox", { name: "Tipo de identificación" })).toHaveValue("NIT");
    expect(screen.getByRole("textbox", { name: "Identificación" })).toHaveValue("901234567-1");
    fireEvent.change(screen.getByRole("textbox", { name: "Identificación" }), { target: { value: "" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Nombre de contacto" }), { target: { value: "" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Teléfono" }), { target: { value: "" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Banco" }), { target: { value: "" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Tipo de cuenta" }), { target: { value: "" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Número de cuenta" }), { target: { value: "" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Titular" }), { target: { value: "" } });
    fireEvent.change(screen.getByRole("textbox", { name: "NIT del titular" }), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar cambios" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    expect(fetchMock.mock.calls[2]?.[1]).toEqual(
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ name: supplier.name, identificationType: "NIT", identification: null, pendingNormalization: false, contact: {}, bankDetails: {}, active: true }),
      }),
    );
    expect(await screen.findByRole("status")).toHaveTextContent("Proveedor actualizado correctamente");
  });

  it("prepares, uploads and completes a document with the exact same metadata", async () => {
    const fixtureDocument = {
      id: "22222222-2222-4222-8222-222222222222",
      type: "rut",
      name: "rut-acabados.pdf",
      mimeType: "application/pdf",
      sizeBytes: 4,
      uploadedAt: "2026-08-24T10:00:00.000Z",
    } as const;
    const signedUrl = "https://storage.invalid/private/signed-token";
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(list())
      .mockResolvedValueOnce(detail())
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ document: fixtureDocument, upload: { url: signedUrl, method: "PUT", multipart: { cacheControl: "3600", fileField: "" } } }), { status: 201 }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ document: fixtureDocument }), { status: 200 }))
      .mockResolvedValueOnce(detail());

    render(<SuppliersScreen role="Revisor" demoMode={false} />);
    await screen.findByText("Acabados del Norte SAS");
    fireEvent.click(screen.getByRole("button", { name: /Abrir ficha de Acabados/i }));
    await screen.findByRole("dialog", { name: /Acabados del Norte/i });
    const file = new File(["RUT"], "rut-acabados.pdf", { type: "application/pdf" });
    fireEvent.change(screen.getByLabelText("Adjuntar soporte"), { target: { files: [file] } });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(6));

    const metadata = { type: "rut", name: "rut-acabados.pdf", mimeType: "application/pdf", sizeBytes: 3 };
    // The browser metadata uses the actual File size; assert equality across
    // both API calls instead of relying on a hardcoded byte count.
    expect(fetchMock.mock.calls[2]?.[1]).toEqual(expect.objectContaining({ method: "POST", body: JSON.stringify({ ...metadata, sizeBytes: file.size }) }));
    expect(fetchMock.mock.calls[3]?.[0]).toBe(signedUrl);
    const uploadRequest = fetchMock.mock.calls[3]?.[1] as RequestInit;
    expect(uploadRequest).toEqual(expect.objectContaining({ method: "PUT", body: expect.any(FormData) }));
    const uploadBody = uploadRequest.body as FormData;
    expect(uploadBody.get("cacheControl")).toBe("3600");
    expect(uploadBody.get("")).toEqual(file);
    expect(uploadRequest.headers).toBeUndefined();
    expect(fetchMock.mock.calls[4]?.[1]).toEqual(expect.objectContaining({ method: "POST", body: JSON.stringify({ ...metadata, sizeBytes: file.size }) }));
    expect(await screen.findByRole("status")).toHaveTextContent("Documento adjuntado correctamente");
    expect(document.body.textContent).not.toContain("signed-token");
  });

  // Adenda de pagos (S2): el alta pasa por el diálogo unificado (identidad + contacto) y abre la
  // ficha recién creada; datos bancarios y documentos se completan desde "Editar".
  it("creates a supplier through the unified quick dialog and opens its ficha", async () => {
    const newId = "33333333-3333-4333-8333-333333333333";
    const createdSupplier = {
      id: newId,
      name: "Pedro Pérez",
      nit: null,
      identificationType: "CC",
      identification: "1234567",
      pendingNormalization: true,
      contact: { phone: "3001112233" },
      active: true,
    };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(list())
      .mockResolvedValueOnce(new Response(JSON.stringify(createdSupplier), { status: 201 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ supplier: createdSupplier, access: { canManage: true, canReadBank: true }, orders: [], documents: [] }),
          { status: 200 },
        ),
      );

    render(<SuppliersScreen role="Revisor" demoMode={false} />);
    await screen.findByText("Acabados del Norte SAS");
    fireEvent.click(screen.getByRole("button", { name: "Nuevo proveedor" }));
    const dialog = await screen.findByRole("dialog", { name: "Nuevo proveedor" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: /Razón social/i }), { target: { value: "Pedro Pérez" } });
    fireEvent.change(within(dialog).getByRole("combobox", { name: "Tipo de identificación" }), { target: { value: "CC" } });
    fireEvent.change(within(dialog).getByRole("textbox", { name: /^Identificación/ }), { target: { value: "1234567" } });
    fireEvent.change(within(dialog).getByRole("textbox", { name: /^Teléfono/ }), { target: { value: "3001112233" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Crear proveedor" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/suppliers");
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ name: "Pedro Pérez", identificationType: "CC", identification: "1234567", pendingNormalization: true, contact: { phone: "3001112233" } }),
      }),
    );
    expect(fetchMock.mock.calls[2]?.[0]).toBe(`/api/suppliers/${newId}`);

    const ficha = await screen.findByRole("dialog", { name: /Pedro Pérez/i });
    expect(within(ficha).getByText("CC 1234567")).toBeInTheDocument();
    expect(within(ficha).getByText("Pendiente de completar")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Proveedor creado correctamente"));
    expect(screen.queryByRole("dialog", { name: "Nuevo proveedor" })).toBeNull();
  });

  it("shows identification (type + number) and the pending mark in the directory", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          suppliers: [
            { ...supplier, identificationType: "NIT", identification: "901234567-1" },
            { id: "22222222-2222-4222-8222-222222222222", name: "Pedro Pérez", identificationType: "CC", identification: "1098765", pendingNormalization: true, contact: {}, active: true },
          ],
          access: { canManage: true, canReadBank: true },
        }),
        { status: 200 },
      ),
    );
    render(<SuppliersScreen role="Revisor" demoMode={false} />);
    await screen.findByText("Pedro Pérez");
    expect(screen.getByRole("columnheader", { name: "Identificación" })).toBeInTheDocument();
    expect(screen.getByText("NIT 901234567-1")).toBeInTheDocument();
    expect(screen.getByText("CC 1098765")).toBeInTheDocument();
    expect(screen.getAllByText("Pendiente de completar")).toHaveLength(1);
    // La búsqueda también encuentra por identificación.
    fireEvent.change(screen.getByRole("textbox", { name: "Buscar proveedores" }), { target: { value: "1098765" } });
    expect(screen.queryByText("Acabados del Norte SAS")).toBeNull();
    expect(screen.getByText("Pedro Pérez")).toBeInTheDocument();
  });
});
