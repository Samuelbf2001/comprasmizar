// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    fireEvent.change(screen.getByRole("textbox", { name: "NIT" }), { target: { value: "" } });
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
        body: JSON.stringify({ name: supplier.name, nit: null, contact: {}, bankDetails: {}, active: true }),
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

  it("stages a document on the create form and uploads it right after the supplier is saved", async () => {
    const newId = "33333333-3333-4333-8333-333333333333";
    const createdSupplier = { id: newId, name: "Proveedor Nuevo SAS", nit: null, contact: {}, active: true };
    const fixtureDocument = {
      id: "44444444-4444-4444-8444-444444444444",
      type: "rut",
      name: "rut-nuevo.pdf",
      mimeType: "application/pdf",
      sizeBytes: 3,
      uploadedAt: "2026-08-27T10:00:00.000Z",
    } as const;
    const signedUrl = "https://storage.invalid/private/signed-token-create";
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(list())
      .mockResolvedValueOnce(new Response(JSON.stringify(createdSupplier), { status: 201 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ document: fixtureDocument, upload: { url: signedUrl, method: "PUT", multipart: { cacheControl: "3600", fileField: "" } } }), { status: 201 }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ document: fixtureDocument }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ supplier: createdSupplier, access: { canManage: true, canReadBank: true }, orders: [], documents: [fixtureDocument] }),
          { status: 200 },
        ),
      );

    render(<SuppliersScreen role="Revisor" demoMode={false} />);
    await screen.findByText("Acabados del Norte SAS");
    fireEvent.click(screen.getByRole("button", { name: "Nuevo proveedor" }));
    await screen.findByRole("dialog", { name: "Nuevo proveedor" });
    fireEvent.change(screen.getByRole("textbox", { name: /Razón social/i }), { target: { value: "Proveedor Nuevo SAS" } });
    const file = new File(["RUT"], "rut-nuevo.pdf", { type: "application/pdf" });
    fireEvent.change(screen.getByLabelText("Adjuntar documento"), { target: { files: [file] } });
    expect(await screen.findByText(/rut-nuevo\.pdf/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Crear proveedor" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(6));

    expect(fetchMock.mock.calls[1]?.[1]).toEqual(expect.objectContaining({ method: "POST" }));
    const metadata = { type: "rut", name: "rut-nuevo.pdf", mimeType: "application/pdf", sizeBytes: file.size };
    expect(fetchMock.mock.calls[2]).toEqual([
      `/api/suppliers/${newId}/documents`,
      expect.objectContaining({ method: "POST", body: JSON.stringify(metadata) }),
    ]);
    expect(fetchMock.mock.calls[3]?.[0]).toBe(signedUrl);
    expect(fetchMock.mock.calls[4]).toEqual([
      `/api/suppliers/${newId}/documents/${fixtureDocument.id}/complete`,
      expect.objectContaining({ method: "POST", body: JSON.stringify(metadata) }),
    ]);
    expect(fetchMock.mock.calls[5]?.[0]).toBe(`/api/suppliers/${newId}`);

    expect(await screen.findByRole("dialog", { name: /Proveedor Nuevo SAS/i })).toBeInTheDocument();
    expect(screen.getByText(/rut-nuevo\.pdf/)).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Proveedor creado correctamente");
  });
});
