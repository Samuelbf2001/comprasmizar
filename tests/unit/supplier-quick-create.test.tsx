// @vitest-environment jsdom

// Alta rápida unificada de proveedor/beneficiario (RF-601/RF-606): un solo diálogo para la captura,
// la revisión y el directorio. Cubre el contrato con POST /api/suppliers (identidad + contacto +
// pendiente de completar), la búsqueda por identificación normalizada y el comportamiento del
// diálogo (validación, doble clic, conflicto del backend, cierre).

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SupplierQuickCreate,
  findSupplierByIdentification,
  identificationLabel,
  lookupSupplierByIdentification,
  quickSupplierPayload,
  validateQuickSupplierDraft,
} from "../../components/screens/supplier-quick-create";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("helpers de identificación", () => {
  it("identificationLabel muestra tipo + número y cae al nit legado", () => {
    expect(identificationLabel({ identificationType: "CC", identification: "1.234.567" })).toBe("CC 1.234.567");
    expect(identificationLabel({ nit: "900123456-7" })).toBe("NIT 900123456-7");
    expect(identificationLabel({})).toBe("");
  });

  it("findSupplierByIdentification compara con la misma normalización que la base (sin puntos ni guiones) y por tipo", () => {
    const suppliers = [
      { id: "a", identificationType: "NIT", identification: "900.123.456-7" },
      { id: "b", identificationType: "CC", identification: "1234567" },
      { id: "c", nit: "800111222" },
    ];
    expect(findSupplierByIdentification(suppliers, "NIT", "9001234567")?.id).toBe("a");
    expect(findSupplierByIdentification(suppliers, "CC", "1.234.567")?.id).toBe("b");
    expect(findSupplierByIdentification(suppliers, "NIT", "1234567")).toBeUndefined();
    expect(findSupplierByIdentification(suppliers, "NIT", "800-111-222")?.id).toBe("c");
    expect(findSupplierByIdentification(suppliers, "NIT", "---")).toBeUndefined();
  });

  it("quickSupplierPayload omite la identificación vacía y el contacto vacío", () => {
    expect(
      quickSupplierPayload({ name: " Pedro Pérez ", identificationType: "CC", identification: "", phone: "", email: "", pendingNormalization: true }),
    ).toEqual({ name: "Pedro Pérez", pendingNormalization: true });
    expect(
      quickSupplierPayload({ name: "Pedro", identificationType: "CC", identification: " 1234567 ", phone: "3001112233", email: "p@x.co", pendingNormalization: false }),
    ).toEqual({ name: "Pedro", identificationType: "CC", identification: "1234567", pendingNormalization: false, contact: { phone: "3001112233", email: "p@x.co" } });
  });

  it("validateQuickSupplierDraft exige nombre y una identificación de 3 a 32 caracteres con algo alfanumérico", () => {
    const base = { name: "Pedro", identificationType: "CC" as const, identification: "", phone: "", email: "", pendingNormalization: true };
    expect(validateQuickSupplierDraft(base)).toBe("");
    expect(validateQuickSupplierDraft({ ...base, name: " " })).toMatch(/razón social/i);
    expect(validateQuickSupplierDraft({ ...base, identification: "12" })).toMatch(/identificación/i);
    expect(validateQuickSupplierDraft({ ...base, identification: "---" })).toMatch(/identificación/i);
    expect(validateQuickSupplierDraft({ ...base, phone: "12" })).toMatch(/teléfono/i);
    expect(validateQuickSupplierDraft({ ...base, email: "sin-arroba" })).toMatch(/correo/i);
  });

  it("lookupSupplierByIdentification lee el directorio y filtra en cliente", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      json({ suppliers: [{ id: "sup-1", name: "Pedro Pérez", identificationType: "CC", identification: "1.234.567" }] }),
    );
    await expect(lookupSupplierByIdentification("CC", "1234567")).resolves.toMatchObject({ id: "sup-1" });
    await expect(lookupSupplierByIdentification("NIT", "1234567")).resolves.toBeNull();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/suppliers");
    vi.restoreAllMocks();
  });
});

describe("SupplierQuickCreate", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("no pinta nada cerrado; abierto enfoca la razón social y prellena la identificación", () => {
    const { rerender } = render(
      <SupplierQuickCreate open={false} onClose={vi.fn()} onCreated={vi.fn()} initialIdentificationType="CC" initialIdentification="1234567" />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    rerender(
      <SupplierQuickCreate open onClose={vi.fn()} onCreated={vi.fn()} initialIdentificationType="CC" initialIdentification="1234567" />,
    );
    const dialog = screen.getByRole("dialog", { name: "Nuevo proveedor" });
    expect(within(dialog).getByLabelText("Razón social *")).toHaveFocus();
    expect(within(dialog).getByLabelText("Tipo de identificación")).toHaveValue("CC");
    expect(within(dialog).getByLabelText("Identificación (opcional)")).toHaveValue("1234567");
    expect(within(dialog).getByRole("checkbox", { name: /pendiente de completar/i })).toBeChecked();
    expect(within(dialog).getByRole("button", { name: "Crear proveedor" })).toBeDisabled();
  });

  it("crea por POST /api/suppliers con identidad y contacto, avisa al padre una sola vez aunque se pulse dos veces", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      json({ id: "sup-2", name: "Pedro Pérez", identificationType: "CC", identification: "1234567", pendingNormalization: true }, 201),
    );
    const onCreated = vi.fn();
    render(<SupplierQuickCreate open onClose={vi.fn()} onCreated={onCreated} submitLabel="Crear y seleccionar" />);
    fireEvent.change(screen.getByLabelText("Razón social *"), { target: { value: "Pedro Pérez" } });
    fireEvent.change(screen.getByLabelText("Tipo de identificación"), { target: { value: "CC" } });
    fireEvent.change(screen.getByLabelText("Identificación (opcional)"), { target: { value: "1234567" } });
    fireEvent.change(screen.getByLabelText("Teléfono (opcional)"), { target: { value: "3001112233" } });
    const submit = screen.getByRole("button", { name: "Crear y seleccionar" });
    fireEvent.click(submit);
    fireEvent.click(submit);
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/suppliers");
    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toEqual({
      name: "Pedro Pérez",
      identificationType: "CC",
      identification: "1234567",
      pendingNormalization: true,
      contact: { phone: "3001112233" },
    });
    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: "sup-2", name: "Pedro Pérez" }));
  });

  it("valida en cliente antes de llamar al servicio", () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    render(<SupplierQuickCreate open onClose={vi.fn()} onCreated={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Razón social *"), { target: { value: "Pedro" } });
    fireEvent.change(screen.getByLabelText("Identificación (opcional)"), { target: { value: "12" } });
    fireEvent.click(screen.getByRole("button", { name: "Crear proveedor" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/entre 3 y 32/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("conserva el diálogo y muestra el conflicto del backend", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      json({ message: "Ya existe un proveedor con el mismo nombre o identificación" }, 409),
    );
    render(<SupplierQuickCreate open onClose={vi.fn()} onCreated={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Razón social *"), { target: { value: "Duplicado" } });
    fireEvent.click(screen.getByRole("button", { name: "Crear proveedor" }));
    const dialog = screen.getByRole("dialog", { name: "Nuevo proveedor" });
    await waitFor(() => expect(within(dialog).getByRole("alert")).toHaveTextContent(/mismo nombre o identificación/));
    expect(dialog).toBeInTheDocument();
  });

  it("cierra con Escape, con el botón de cerrar y con Cancelar", () => {
    const onClose = vi.fn();
    render(<SupplierQuickCreate open onClose={onClose} onCreated={vi.fn()} />);
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Cerrar alta de proveedor" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("acepta un creador inyectado (modo demo) sin tocar la red", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const onCreated = vi.fn();
    render(
      <SupplierQuickCreate
        open
        onClose={vi.fn()}
        onCreated={onCreated}
        create={async (draft) => ({ id: "demo-1", name: draft.name, identificationType: draft.identificationType, identification: draft.identification })}
      />,
    );
    fireEvent.change(screen.getByLabelText("Razón social *"), { target: { value: "Demo SAS" } });
    fireEvent.click(screen.getByRole("button", { name: "Crear proveedor" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: "demo-1", name: "Demo SAS" })));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
