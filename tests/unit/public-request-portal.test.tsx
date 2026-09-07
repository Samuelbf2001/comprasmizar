// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PublicRequestScreen } from "../../components/screens/public-request";
import { MobilePublicRequestScreen } from "../../components/screens/public-request-mobile";

// Reunión: "fecha requerida" ya era opcional en el esquema HTTP (lib/http/schemas.ts, z.string().date()
// .optional()) en los tres canales, pero el portal público (desktop y móvil) seguía marcándola required
// y, más grave, el payload mandaba '' cuando quedaba vacía — una fecha VÁLIDA no es lo mismo que
// AUSENTE, y el endpoint público responde 202 neutro incluso cuando el esquema la rechaza (nunca se veía
// el fallo). Estas pruebas fijan que (a) ya no hay asterisco/`required` en el campo y (b) el payload
// omite `requiredDate` por completo cuando el campo queda vacío, en vez de enviar una cadena vacía.
const workId = "11111111-1111-4111-8111-111111111111";
const token = "a".repeat(64);

function setValidHash() {
  window.location.hash = new URLSearchParams({ obra: workId, token }).toString();
}

describe("portal público de escritorio — fecha requerida opcional", () => {
  beforeEach(() => {
    setValidHash();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 202, json: async () => ({ accepted: true }) }));
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.location.hash = "";
  });

  it("ya no marca la fecha como obligatoria (sin asterisco ni atributo required)", async () => {
    render(<PublicRequestScreen demoMode={false} publicConfigured />);
    await waitFor(() => expect(screen.getByText(/Solicita lo que tu obra necesita/i)).toBeInTheDocument());
    // El primer textbox visible es la contraseña; el teléfono usa inputMode="tel".
    fireEvent.change(screen.getAllByRole("textbox")[0], { target: { value: "clave-1234" } });
    const phoneInput = document.querySelector('input[inputmode="tel"]') as HTMLInputElement;
    fireEvent.change(phoneInput, { target: { value: "3001234567" } });
    fireEvent.click(screen.getByRole("button", { name: /Continuar/i }));

    const dateLabel = await screen.findByText(/Fecha requerida/i);
    const dateField = dateLabel.closest("label") as HTMLElement;
    expect(dateField).not.toHaveTextContent("*");
    const dateInput = dateField.querySelector("input[name='date']") as HTMLInputElement;
    expect(dateInput).not.toBeRequired();
  });

  it("envía la requisición SIN requiredDate cuando la fecha queda vacía (el esquema HTTP la acepta opcional)", async () => {
    render(<PublicRequestScreen demoMode={false} publicConfigured />);
    await waitFor(() => expect(screen.getByText(/Solicita lo que tu obra necesita/i)).toBeInTheDocument());
    const inputs = screen.getAllByRole("textbox");
    fireEvent.change(inputs[0], { target: { value: "clave-1234" } });
    const phoneInput = document.querySelector('input[inputmode="tel"]') as HTMLInputElement;
    fireEvent.change(phoneInput, { target: { value: "3001234567" } });
    fireEvent.click(screen.getByRole("button", { name: /Continuar/i }));

    await screen.findByText(/Nueva requisición/i);
    fireEvent.change(document.querySelector("input[name='requestor']") as HTMLInputElement, { target: { value: "Ana Solicitante" } });
    fireEvent.change(document.querySelector("input[name='description']") as HTMLInputElement, { target: { value: "Cemento gris" } });
    fireEvent.change(document.querySelector("input[name='quantity']") as HTMLInputElement, { target: { value: "5" } });
    fireEvent.change(document.querySelector("input[name='unit']") as HTMLInputElement, { target: { value: "bulto" } });
    // Deliberadamente NO se toca input[name='date']: queda vacío.
    fireEvent.click(screen.getByRole("button", { name: /Enviar requisición/i }));

    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1));
    const [, init] = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(String(init?.body));
    expect(body).not.toHaveProperty("requiredDate");
  });
});

describe("portal público móvil — fecha requerida opcional", () => {
  beforeEach(() => {
    setValidHash();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 202, json: async () => ({ accepted: true }) }));
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.location.hash = "";
  });

  it("envía la requisición SIN requiredDate cuando la fecha queda vacía", async () => {
    render(<MobilePublicRequestScreen demoMode={false} publicConfigured />);
    await waitFor(() => expect(screen.getByText(/Pide lo que tu obra necesita/i)).toBeInTheDocument());
    fireEvent.change(document.querySelector('input[name="access-code"]') as HTMLInputElement, { target: { value: "clave-1234" } });
    fireEvent.change(document.querySelector('input[name="access-phone"]') as HTMLInputElement, { target: { value: "3001234567" } });
    fireEvent.click(screen.getByRole("button", { name: /Continuar/i }));

    await screen.findByText(/¿Para quién y cuándo\?/i);
    const dateLabel = screen.getByText(/Fecha requerida/i);
    expect(dateLabel.closest("label")).not.toHaveTextContent("*");
    // A diferencia del portal de escritorio, el campo móvil parte precargado con la fecha de hoy
    // (initialValues()); hay que limpiarlo explícitamente para probar el caso "sin fecha" de verdad.
    fireEvent.change(document.querySelector('input[name="date"]') as HTMLInputElement, { target: { value: "" } });
    fireEvent.change(document.querySelector('input[name="requestor"]') as HTMLInputElement, { target: { value: "Ana Solicitante" } });
    fireEvent.click(screen.getByRole("button", { name: /Continuar a material/i }));

    await screen.findByText(/Describe el material\./i);
    fireEvent.change(document.querySelector('input[name="description"]') as HTMLInputElement, { target: { value: "Cemento gris" } });
    fireEvent.change(document.querySelector('input[name="quantity"]') as HTMLInputElement, { target: { value: "5" } });
    fireEvent.change(document.querySelector('input[name="unit"]') as HTMLInputElement, { target: { value: "bulto" } });
    fireEvent.click(screen.getByRole("button", { name: /Enviar requisición/i }));

    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1));
    const [, init] = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(String(init?.body));
    expect(body).not.toHaveProperty("requiredDate");
  });
});
