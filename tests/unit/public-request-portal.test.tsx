// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PublicRequestRedirect, PublicRequestScreen } from "../../components/screens/public-request";

// Portal público UNIFICADO (2026-09-11). Hasta ahora había dos formularios —escritorio y móvil— con
// dos árboles de componentes y dos URLs; sobrevive uno solo, responsive, sobre la base móvil (mejor
// validación por campo y CSS aislado). Este archivo cubre sobre la pantalla que queda TODO lo que
// antes se repartía entre las dos: la compuerta, el selector de obra del enlace general, el envío
// con `x-public-link-token`, las respuestas 202/503 y la fecha opcional.
//
// Lo de la fecha viene de la reunión: el esquema HTTP (lib/http/schemas.ts, `z.string().date()
// .optional()`) ya la aceptaba opcional en los tres canales, pero el portal la marcaba `required` y,
// peor, mandaba '' cuando quedaba vacía. Una fecha VÁLIDA no es lo mismo que AUSENTE, y como el
// endpoint público responde 202 neutro incluso cuando el esquema rechaza, el fallo nunca se veía.
const workId = "11111111-1111-4111-8111-111111111111";
const token = "a".repeat(64);

function setHash(params: Record<string, string>) {
  window.location.hash = new URLSearchParams(params).toString();
}

/** Atraviesa la compuerta de contraseña + teléfono. */
async function pasarCompuerta() {
  await waitFor(() => expect(screen.getByText(/Pide lo que tu obra necesita/i)).toBeInTheDocument());
  fireEvent.change(document.querySelector('input[name="access-code"]') as HTMLInputElement, { target: { value: "clave-1234" } });
  fireEvent.change(document.querySelector('input[name="access-phone"]') as HTMLInputElement, { target: { value: "3001234567" } });
  fireEvent.click(screen.getByRole("button", { name: /Continuar/i }));
  await screen.findByText(/¿Para quién y cuándo\?/i);
}

/** Completa los dos pasos y envía. `conFecha` false limpia la fecha, que viene precargada con hoy. */
async function rellenarYEnviar({ conFecha = false }: { conFecha?: boolean } = {}) {
  if (!conFecha) fireEvent.change(document.querySelector('input[name="date"]') as HTMLInputElement, { target: { value: "" } });
  fireEvent.change(document.querySelector('input[name="requestor"]') as HTMLInputElement, { target: { value: "Ana Solicitante" } });
  fireEvent.click(screen.getByRole("button", { name: /Continuar a material/i }));
  await screen.findByText(/Describe el material\./i);
  fireEvent.change(document.querySelector('input[name="description"]') as HTMLInputElement, { target: { value: "Cemento gris" } });
  fireEvent.change(document.querySelector('input[name="quantity"]') as HTMLInputElement, { target: { value: "5" } });
  fireEvent.change(document.querySelector('input[name="unit"]') as HTMLInputElement, { target: { value: "bulto" } });
  fireEvent.click(screen.getByRole("button", { name: /Enviar requisición/i }));
}

describe("portal público unificado — enlace por obra", () => {
  beforeEach(() => {
    setHash({ obra: workId, token });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 202, json: async () => ({ accepted: true }) }));
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.location.hash = ""; });

  it("exige contraseña y teléfono antes de mostrar el formulario", async () => {
    render(<PublicRequestScreen demoMode={false} publicConfigured />);
    await waitFor(() => expect(screen.getByText(/Pide lo que tu obra necesita/i)).toBeInTheDocument());
    // Sin datos no se pasa: la compuerta es de cliente, pero el servidor revalida al enviar.
    fireEvent.click(screen.getByRole("button", { name: /Continuar/i }));
    expect(screen.queryByText(/¿Para quién y cuándo\?/i)).not.toBeInTheDocument();
  });

  it("la fecha no está marcada como obligatoria", async () => {
    render(<PublicRequestScreen demoMode={false} publicConfigured />);
    await pasarCompuerta();
    const dateLabel = screen.getByText(/Fecha requerida/i);
    expect(dateLabel.closest("label")).not.toHaveTextContent("*");
    expect(document.querySelector('input[name="date"]')).not.toBeRequired();
  });

  it("envía SIN requiredDate cuando la fecha queda vacía, y con el token del enlace en la cabecera", async () => {
    render(<PublicRequestScreen demoMode={false} publicConfigured />);
    await pasarCompuerta();
    await rellenarYEnviar();
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1));
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(String(url)).toBe("/api/public/requisitions");
    expect((init?.headers as Record<string, string>)["x-public-link-token"]).toBe(token);
    const body = JSON.parse(String(init?.body));
    expect(body).not.toHaveProperty("requiredDate");
    expect(body.workId).toBe(workId);
  });

  it("un 202 lleva a la pantalla de recibido, que NO revela consecutivo", async () => {
    // El 202 es neutro a propósito (anti-enumeración): decir "recibida" no puede convertirse en
    // decir "válida", ni entregar un número con el que tantear.
    render(<PublicRequestScreen demoMode={false} publicConfigured />);
    await pasarCompuerta();
    await rellenarYEnviar();
    await screen.findByText(/La estamos validando/i);
    expect(document.body.textContent).not.toMatch(/REQ-\d{4}-\d{4}/);
  });

  it("un 503 dice que el servicio no está disponible, sin fingir éxito", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 503, json: async () => ({ error: "service_unavailable" }) }));
    render(<PublicRequestScreen demoMode={false} publicConfigured />);
    await pasarCompuerta();
    await rellenarYEnviar();
    await screen.findByText(/no está disponible/i);
    expect(screen.queryByText(/La estamos validando/i)).not.toBeInTheDocument();
  });
});

describe("lo tecleado ANTES de hidratar no se pierde", () => {
  beforeEach(() => {
    setHash({ obra: workId, token });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 202, json: async () => ({ accepted: true }) }));
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.location.hash = ""; });

  it("con los valores escritos directamente en el DOM, la compuerta se abre igual", async () => {
    // Reproduce el caso real: el navegador pinta el HTML del servidor y acepta escritura de
    // inmediato, pero React aún no ha hidratado, así que esas pulsaciones NO pasan por ningún
    // `onChange`. Escribir en `input.value` sin despachar evento es exactamente eso.
    //
    // Con la compuerta controlada, el estado seguía vacío y pulsar Continuar respondía "Ingresa la
    // contraseña del portal y un teléfono válido" con los campos a la vista y llenos — el maestro no
    // tenía forma de entender qué pasaba. Con la compuerta no controlada, los valores se leen del
    // formulario al enviar y entra.
    render(<PublicRequestScreen demoMode={false} publicConfigured />);
    await waitFor(() => expect(screen.getByText(/Pide lo que tu obra necesita/i)).toBeInTheDocument());

    (document.querySelector('input[name="access-code"]') as HTMLInputElement).value = "clave-1234";
    (document.querySelector('input[name="access-phone"]') as HTMLInputElement).value = "3001234567";
    fireEvent.click(screen.getByRole("button", { name: /Continuar/i }));

    expect(await screen.findByText(/¿Para quién y cuándo\?/i)).toBeInTheDocument();
  });

  it("y ese valor llega al envío, no uno vacío", async () => {
    // No basta con que la compuerta se abra: la contraseña viaja en el cuerpo del POST y el servidor
    // la valida. Si se hubiera perdido, el portal respondería 202 neutro y la requisición no se
    // crearía — el fallo más caro de todos, porque no se ve por ninguna parte.
    render(<PublicRequestScreen demoMode={false} publicConfigured />);
    await waitFor(() => expect(screen.getByText(/Pide lo que tu obra necesita/i)).toBeInTheDocument());
    (document.querySelector('input[name="access-code"]') as HTMLInputElement).value = "clave-1234";
    (document.querySelector('input[name="access-phone"]') as HTMLInputElement).value = "3001234567";
    fireEvent.click(screen.getByRole("button", { name: /Continuar/i }));
    await screen.findByText(/¿Para quién y cuándo\?/i);

    await rellenarYEnviar();
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1));
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body));
    expect(body.code).toBe("clave-1234");
    expect(body.phone).toBe("3001234567");
  });

  it("al volver con «Cambiar datos» los campos conservan lo ya escrito", async () => {
    // Efecto colateral de quitar el estado controlado: al desmontarse la compuerta, los campos
    // volverían en blanco. `defaultValue` lo evita, y obligar a reescribir la contraseña sería un
    // castigo gratuito.
    render(<PublicRequestScreen demoMode={false} publicConfigured />);
    await pasarCompuerta();
    fireEvent.click(screen.getByRole("button", { name: /Cambiar datos/i }));
    await waitFor(() => expect(screen.getByText(/Pide lo que tu obra necesita/i)).toBeInTheDocument());
    expect((document.querySelector('input[name="access-code"]') as HTMLInputElement).value).toBe("clave-1234");
    expect((document.querySelector('input[name="access-phone"]') as HTMLInputElement).value).toBe("3001234567");
  });
});

describe("portal público unificado — enlace general", () => {
  beforeEach(() => {
    // Sin `obra` en el fragmento: el enlace es general y la obra se elige en el formulario.
    setHash({ token });
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      String(url).startsWith("/api/public/works")
        ? { ok: true, status: 200, json: async () => ({ works: [{ id: workId, name: "Torre Misar Etapa 1" }] }) }
        : { status: 202, json: async () => ({ accepted: true }) }));
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.location.hash = ""; });

  it("pide la lista de obras con el token y la ofrece en el selector", async () => {
    render(<PublicRequestScreen demoMode={false} publicConfigured />);
    await pasarCompuerta();
    await waitFor(() => expect(screen.getByRole("option", { name: "Torre Misar Etapa 1" })).toBeInTheDocument());
    const llamada = vi.mocked(fetch).mock.calls.find(([url]) => String(url).startsWith("/api/public/works"));
    expect(llamada).toBeDefined();
    expect(String(llamada?.[0])).toContain(encodeURIComponent(token));
  });

  it("no deja continuar sin elegir obra, y al elegirla la manda en el payload", async () => {
    render(<PublicRequestScreen demoMode={false} publicConfigured />);
    await pasarCompuerta();
    await screen.findByRole("option", { name: "Torre Misar Etapa 1" });
    fireEvent.change(document.querySelector('input[name="requestor"]') as HTMLInputElement, { target: { value: "Ana Solicitante" } });
    fireEvent.click(screen.getByRole("button", { name: /Continuar a material/i }));
    expect(await screen.findByText(/Selecciona la obra/i)).toBeInTheDocument();

    fireEvent.change(document.querySelector('select[name="work"]') as HTMLSelectElement, { target: { value: workId } });
    await rellenarYEnviar();
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url) === "/api/public/requisitions")).toBe(true));
    const envio = vi.mocked(fetch).mock.calls.find(([url]) => String(url) === "/api/public/requisitions");
    expect(JSON.parse(String(envio?.[1]?.body)).workId).toBe(workId);
  });
});

describe("portal público unificado — enlace inválido", () => {
  afterEach(() => { cleanup(); window.location.hash = ""; });

  it("sin token no habilita el formulario ni finge nada", async () => {
    setHash({ obra: workId });
    render(<PublicRequestScreen demoMode={false} publicConfigured />);
    await waitFor(() => expect(screen.getByText(/Este enlace no está habilitado/i)).toBeInTheDocument());
  });

  it("con el portal sin configurar tampoco se lee el fragmento", async () => {
    setHash({ obra: workId, token });
    render(<PublicRequestScreen demoMode={false} publicConfigured={false} />);
    await waitFor(() => expect(screen.getByText(/Este enlace no está habilitado/i)).toBeInTheDocument());
  });
});

describe("ruta heredada /requisiciones/publica-movil", () => {
  afterEach(() => { cleanup(); window.location.hash = ""; });

  it("reenvía al formulario único CONSERVANDO el fragmento", async () => {
    // Es lo único que impide romper los enlaces móviles ya repartidos: el fragmento no viaja al
    // servidor, así que un redirect de servidor llegaría sin token y el portal diría "no habilitado".
    const replace = vi.fn();
    const original = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...original, hash: `#obra=${workId}&token=${token}`, search: "", replace },
    });
    render(<PublicRequestRedirect />);
    await waitFor(() => expect(replace).toHaveBeenCalledTimes(1));
    expect(replace).toHaveBeenCalledWith(`/requisiciones/publica#obra=${workId}&token=${token}`);
    Object.defineProperty(window, "location", { configurable: true, value: original });
  });
});
