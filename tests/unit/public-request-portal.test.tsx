// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PublicRequestRedirect, PublicRequestScreen } from "../../components/screens/public-request";

// jsdom no implementa `URL.createObjectURL`/`revokeObjectURL` (los usa `FotoPreview`, la vista previa
// de la foto opcional por artículo): se rellenan con un stub mínimo UNA sola vez para el archivo
// entero, fuera de cualquier `vi.stubGlobal` — así `vi.unstubAllGlobals()` (que ya corre en los
// `afterEach` de abajo) nunca los toca.
beforeAll(() => {
  if (typeof URL.createObjectURL !== "function") URL.createObjectURL = () => "blob:mock-url";
  if (typeof URL.revokeObjectURL !== "function") URL.revokeObjectURL = () => {};
});

// Portal público GUIADO (11-sep-2026). Hasta ahora eran dos pasos («¿Para quién y cuándo?» con todo
// mezclado, y un paso 2 con la lista completa de ítems); Ernesto pidió que se pareciera al Flow de
// WhatsApp que ya le gusta al cliente (`integrations/whatsapp-flow/requisicion-captura.flow.json`):
// pantallas cortas, una cosa a la vez, un artículo por pantalla con "Agregar otro artículo" / "Ir al
// resumen", y un RESUMEN antes de enviar. No es una copia del Flow pantalla por pantalla —aquí "tus
// datos" tiene su propio momento—, pero la idea es la misma.
//
// El recorrido nuevo, de principio a fin:
//   1. "¿Qué vas a solicitar?" — tipo de solicitud y empresa (si el enlace no la trae fija).
//   2. "Tus datos" — nombre y teléfono opcional.
//   3. Un artículo por pantalla — descripción, cantidad, unidad, proveedor/enlace opcionales.
//   4. "¿Para cuándo?" — fecha opcional y observaciones.
//   5. "Resumen" — todo lo capturado, con la empresa por NOMBRE y los artículos numerados, y el
//      botón final "Enviar solicitud".
//
// Este archivo cubre sobre la pantalla que queda TODO lo que antes se repartía entre las dos
// versiones (escritorio y móvil): la compuerta, el selector del enlace general, el envío con
// `x-public-link-token`, las respuestas 202/503, la fecha opcional y ahora el recorrido guiado
// completo, incluyendo volver atrás y quitar un artículo desde el resumen.
const workId = "11111111-1111-4111-8111-111111111111";
const societyId = "22222222-2222-4222-8222-222222222222";
const token = "a".repeat(64);

function setHash(params: Record<string, string>) {
  window.location.hash = new URLSearchParams(params).toString();
}

const campo = (nombre: string) => document.querySelector(`[name="${nombre}"]`) as HTMLInputElement;

type Respuesta = { status: number; body?: unknown };
const POR_DEFECTO: Record<string, Respuesta> = {
  "/api/public/access": { status: 200, body: { ok: true } },
  "/api/public/companies": { status: 200, body: { companies: [] } },
  "/api/public/requisitions": { status: 202, body: { accepted: true } },
};
/**
 * Responde a los tres endpoints del portal, y LANZA ante cualquier otro.
 *
 * Lo de lanzar no es celo: es lo que habría cazado de inmediato el endpoint de obras cuando se
 * sustituyó por el de empresas. Una prueba que devuelve algo plausible a cualquier URL sigue verde
 * mientras la pantalla pide un endpoint que ya no existe.
 */
function stubFetch(sobrescrituras: Record<string, Respuesta> = {}) {
  const fn = vi.fn(async (url: string) => {
    const ruta = String(url).split("?")[0];
    const respuesta = sobrescrituras[ruta] ?? POR_DEFECTO[ruta];
    if (!respuesta) throw new Error(`El portal pidió ${url}, que ninguna prueba ha declarado`);
    return { ok: respuesta.status >= 200 && respuesta.status < 300, status: respuesta.status, json: async () => respuesta.body };
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}
const ACCESO = "/api/public/access", EMPRESAS = "/api/public/companies", RADICACION = "/api/public/requisitions";
const llamadasA = (ruta: string) => vi.mocked(fetch).mock.calls.filter(([url]) => String(url).split("?")[0] === ruta);

/**
 * Atraviesa la compuerta: desde 2026-09-11 solo pide la contraseña, y desde este cambio la
 * CONTRASEÑA SE COMPRUEBA CONTRA EL SERVIDOR antes de dejar pasar (ver `POST /api/public/access`).
 */
async function pasarCompuerta() {
  await waitFor(() => expect(screen.getByText(/Pide lo que tu obra necesita/i)).toBeInTheDocument());
  fireEvent.change(campo("access-code"), { target: { value: "clave-1234" } });
  fireEvent.click(screen.getByRole("button", { name: /Continuar/i }));
  await screen.findByText(/¿Qué vas a solicitar\?/i);
}

/** Pantalla 1: tipo (ya trae "Compra de material" por defecto) y empresa cuando hace falta elegirla. */
function pasarTipoYEmpresa({ company }: { company?: string } = {}) {
  if (company) fireEvent.change(document.querySelector('select[name="company"]') as HTMLSelectElement, { target: { value: company } });
  fireEvent.click(screen.getByRole("button", { name: /^Continuar$/i }));
}

/** Pantalla 2: nombre y teléfono opcional. */
function pasarDatos({ nombre = "Ana Solicitante", telefono = "" }: { nombre?: string; telefono?: string } = {}) {
  fireEvent.change(campo("requestor"), { target: { value: nombre } });
  if (telefono) fireEvent.change(campo("phone"), { target: { value: telefono } });
  fireEvent.click(screen.getByRole("button", { name: /Continuar a material/i }));
}

/** Llena el artículo `indice`, que ocupa su propia pantalla. */
function llenarItem(indice: number, { descripcion, cantidad, unidad }: { descripcion: string; cantidad: string; unidad: string }) {
  fireEvent.change(campo(`description-${indice}`), { target: { value: descripcion } });
  fireEvent.change(campo(`quantity-${indice}`), { target: { value: cantidad } });
  fireEvent.change(campo(`unit-${indice}`), { target: { value: unidad } });
}

/**
 * Recorre las cinco pantallas con UN artículo y llega al resumen. `conFecha` false limpia la fecha,
 * que viene precargada con hoy; `telefono` vacío deja el campo sin tocar (ya no es obligatorio).
 */
async function llegarAlResumen({ conFecha = false, telefono = "3001234567" }: { conFecha?: boolean; telefono?: string } = {}) {
  pasarDatos({ telefono });
  await screen.findByText(/^Artículo 1$/i);
  llenarItem(0, { descripcion: "Cemento gris", cantidad: "5", unidad: "bulto" });
  fireEvent.click(screen.getByRole("button", { name: /Ir al resumen/i }));
  await screen.findByText(/¿Para cuándo\?/i);
  if (!conFecha) fireEvent.change(campo("date"), { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: /Ver resumen/i }));
  await screen.findByRole("heading", { name: /^Resumen$/i });
}

async function rellenarYEnviar(opciones: { conFecha?: boolean; telefono?: string } = {}) {
  await llegarAlResumen(opciones);
  fireEvent.click(screen.getByRole("button", { name: /Enviar solicitud/i }));
}

describe("portal público guiado — enlace por obra", () => {
  beforeEach(() => {
    setHash({ obra: workId, token });
    stubFetch();
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.location.hash = ""; });

  it("la compuerta pide SOLO la contraseña, no el teléfono", async () => {
    // Ernesto había pedido «para ingresar, solo una contraseña», y la compuerta pedía además el
    // teléfono. No era un segundo control —cualquier número servía—, solo un obstáculo de más antes
    // de ver el formulario. El teléfono se pide después, en "Tus datos", donde se entiende para qué.
    render(<PublicRequestScreen demoMode={false} publicConfigured />);
    await waitFor(() => expect(screen.getByText(/Pide lo que tu obra necesita/i)).toBeInTheDocument());
    expect(campo("access-code")).toBeInTheDocument();
    expect(document.querySelector('input[name="access-phone"]')).toBeNull();

    // Sin contraseña no se pasa: la compuerta es de cliente, pero el servidor revalida al enviar.
    fireEvent.click(screen.getByRole("button", { name: /Continuar/i }));
    expect(screen.queryByText(/¿Qué vas a solicitar\?/i)).not.toBeInTheDocument();
  });

  it("una contraseña INCORRECTA se dice en la puerta, no después de llenar el formulario", async () => {
    stubFetch({ [ACCESO]: { status: 200, body: { ok: false } } });
    render(<PublicRequestScreen demoMode={false} publicConfigured />);
    await waitFor(() => expect(screen.getByText(/Pide lo que tu obra necesita/i)).toBeInTheDocument());
    fireEvent.change(campo("access-code"), { target: { value: "la-que-no-es" } });
    fireEvent.click(screen.getByRole("button", { name: /Continuar/i }));

    expect(await screen.findByText(/Contraseña incorrecta/i)).toBeInTheDocument();
    expect(screen.queryByText(/¿Qué vas a solicitar\?/i)).not.toBeInTheDocument();
    expect(llamadasA(RADICACION)).toHaveLength(0);
  });

  it("si no se puede preguntar, lo dice y tampoco pasa", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("sin red")));
    render(<PublicRequestScreen demoMode={false} publicConfigured />);
    await waitFor(() => expect(screen.getByText(/Pide lo que tu obra necesita/i)).toBeInTheDocument());
    fireEvent.change(campo("access-code"), { target: { value: "clave-1234" } });
    fireEvent.click(screen.getByRole("button", { name: /Continuar/i }));

    expect(await screen.findByText(/No pudimos comprobar la contraseña/i)).toBeInTheDocument();
    expect(screen.queryByText(/¿Qué vas a solicitar\?/i)).not.toBeInTheDocument();
  });

  it("con el portal apagado dice que no está disponible, no que la contraseña esté mal", async () => {
    stubFetch({ [ACCESO]: { status: 503, body: { error: "service_unavailable" } } });
    render(<PublicRequestScreen demoMode={false} publicConfigured />);
    await waitFor(() => expect(screen.getByText(/Pide lo que tu obra necesita/i)).toBeInTheDocument());
    fireEvent.change(campo("access-code"), { target: { value: "clave-1234" } });
    fireEvent.click(screen.getByRole("button", { name: /Continuar/i }));

    expect(await screen.findByText(/no está disponible ahora mismo/i)).toBeInTheDocument();
    expect(screen.queryByText(/Contraseña incorrecta/i)).not.toBeInTheDocument();
  });

  it("recorre las cinco pantallas y la contraseña que abrió la compuerta es la que viaja en el envío", async () => {
    render(<PublicRequestScreen demoMode={false} publicConfigured />);
    await pasarCompuerta();
    expect(JSON.parse(String(llamadasA(ACCESO)[0][1]?.body)).code).toBe("clave-1234");

    pasarTipoYEmpresa();
    await screen.findByRole("heading", { name: /^Tus datos$/i });
    await rellenarYEnviar();

    await waitFor(() => expect(llamadasA(RADICACION)).toHaveLength(1));
    expect(JSON.parse(String(llamadasA(RADICACION)[0][1]?.body)).code).toBe("clave-1234");
  });

  it("el enlace por obra NO pide empresa: ya viene firmada", async () => {
    // Pedirla otra vez dejaría elegir una empresa que el enlace no autoriza, y el endpoint rechaza
    // que viajen las dos.
    render(<PublicRequestScreen demoMode={false} publicConfigured />);
    await pasarCompuerta();
    expect(document.querySelector('select[name="company"]')).toBeNull();
  });

  it("el teléfono es OPCIONAL: sin él se radica igual y no viaja en el envío", async () => {
    render(<PublicRequestScreen demoMode={false} publicConfigured />);
    await pasarCompuerta();
    pasarTipoYEmpresa();
    await screen.findByRole("heading", { name: /^Tus datos$/i });
    const etiqueta = screen.getByText(/Tu teléfono/i);
    expect(etiqueta.closest("label")).not.toHaveTextContent("*");

    await rellenarYEnviar({ telefono: "" });
    await waitFor(() => expect(llamadasA(RADICACION)).toHaveLength(1));
    expect(JSON.parse(String(llamadasA(RADICACION)[0][1]?.body))).not.toHaveProperty("phone");
  });

  it("pero un teléfono A MEDIAS sí se rechaza, en vez de mandarse roto", async () => {
    render(<PublicRequestScreen demoMode={false} publicConfigured />);
    await pasarCompuerta();
    pasarTipoYEmpresa();
    await screen.findByRole("heading", { name: /^Tus datos$/i });
    fireEvent.change(campo("requestor"), { target: { value: "Ana Solicitante" } });
    fireEvent.change(campo("phone"), { target: { value: "300" } });
    fireEvent.click(screen.getByRole("button", { name: /Continuar a material/i }));
    expect(await screen.findByText(/teléfono está incompleto/i)).toBeInTheDocument();
    expect(screen.queryByText(/^Artículo 1$/i)).not.toBeInTheDocument();
  });

  it("la fecha no está marcada como obligatoria", async () => {
    render(<PublicRequestScreen demoMode={false} publicConfigured />);
    await pasarCompuerta();
    pasarTipoYEmpresa();
    await screen.findByRole("heading", { name: /^Tus datos$/i });
    pasarDatos();
    await screen.findByText(/^Artículo 1$/i);
    llenarItem(0, { descripcion: "Cemento gris", cantidad: "5", unidad: "bulto" });
    fireEvent.click(screen.getByRole("button", { name: /Ir al resumen/i }));
    await screen.findByText(/¿Para cuándo\?/i);

    const dateLabel = screen.getByText(/Fecha requerida/i);
    expect(dateLabel.closest("label")).not.toHaveTextContent("*");
    expect(campo("date")).not.toBeRequired();
  });

  it("envía SIN requiredDate cuando la fecha queda vacía, y con el token del enlace en la cabecera", async () => {
    render(<PublicRequestScreen demoMode={false} publicConfigured />);
    await pasarCompuerta();
    pasarTipoYEmpresa();
    await screen.findByRole("heading", { name: /^Tus datos$/i });
    await rellenarYEnviar();
    await waitFor(() => expect(llamadasA(RADICACION)).toHaveLength(1));
    const [url, init] = llamadasA(RADICACION)[0];
    expect(String(url)).toBe("/api/public/requisitions");
    expect((init?.headers as Record<string, string>)["x-public-link-token"]).toBe(token);
    const body = JSON.parse(String(init?.body));
    expect(body).not.toHaveProperty("requiredDate");
    expect(body.workId).toBe(workId);
    // Obra O empresa, nunca las dos: el endpoint rechaza el envío entero si viajan juntas.
    expect(body).not.toHaveProperty("societyId");
  });

  it("un 202 lleva a la pantalla de recibido, que NO revela consecutivo", async () => {
    render(<PublicRequestScreen demoMode={false} publicConfigured />);
    await pasarCompuerta();
    pasarTipoYEmpresa();
    await screen.findByRole("heading", { name: /^Tus datos$/i });
    await rellenarYEnviar();
    await screen.findByText(/La estamos validando/i);
    expect(document.body.textContent).not.toMatch(/REQ-\d{4}-\d{4}/);
  });

  it("un 503 dice que el servicio no está disponible, sin fingir éxito", async () => {
    stubFetch({ "/api/public/requisitions": { status: 503, body: { error: "service_unavailable" } } });
    render(<PublicRequestScreen demoMode={false} publicConfigured />);
    await pasarCompuerta();
    pasarTipoYEmpresa();
    await screen.findByRole("heading", { name: /^Tus datos$/i });
    await rellenarYEnviar();
    await screen.findByText(/no está disponible/i);
    expect(screen.queryByText(/La estamos validando/i)).not.toBeInTheDocument();
  });
});

// Ernesto, 11-sep-2026: «solo dejas agregar un ítem por form, debe permitir ir agregando más». Quien
// necesitaba cemento, arena y varilla radicaba tres requisiciones, y el revisor recibía tres pedidos
// que en la obra eran uno. Ahora cada artículo tiene su propia pantalla, y solo se puede quitar uno
// desde el resumen.
describe("portal público guiado — varios artículos, uno por pantalla", () => {
  beforeEach(() => {
    setHash({ obra: workId, token });
    stubFetch();
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.location.hash = ""; });

  async function llegarAlPrimerArticulo() {
    render(<PublicRequestScreen demoMode={false} publicConfigured />);
    await pasarCompuerta();
    pasarTipoYEmpresa();
    await screen.findByRole("heading", { name: /^Tus datos$/i });
    pasarDatos();
    await screen.findByText(/^Artículo 1$/i);
  }

  it("los tres artículos viajan en un solo envío", async () => {
    await llegarAlPrimerArticulo();
    llenarItem(0, { descripcion: "Cemento gris", cantidad: "20", unidad: "bulto" });
    fireEvent.click(screen.getByRole("button", { name: /Agregar otro artículo/i }));
    await screen.findByText(/^Artículo 2$/i);
    llenarItem(1, { descripcion: "Arena de río", cantidad: "3", unidad: "m³" });
    fireEvent.click(screen.getByRole("button", { name: /Agregar otro artículo/i }));
    await screen.findByText(/^Artículo 3$/i);
    llenarItem(2, { descripcion: "Varilla 1/2", cantidad: "40", unidad: "und" });
    fireEvent.click(screen.getByRole("button", { name: /Ir al resumen/i }));
    await screen.findByText(/¿Para cuándo\?/i);
    fireEvent.click(screen.getByRole("button", { name: /Ver resumen/i }));
    await screen.findByRole("heading", { name: /^Resumen$/i });

    // El resumen numera los tres, con cantidad y unidad.
    expect(screen.getByText(/1\. Cemento gris/i)).toBeInTheDocument();
    expect(screen.getByText(/2\. Arena de río/i)).toBeInTheDocument();
    expect(screen.getByText(/3\. Varilla 1\/2/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Enviar solicitud/i }));
    await waitFor(() => expect(llamadasA(RADICACION)).toHaveLength(1));
    const { items } = JSON.parse(String(llamadasA(RADICACION)[0][1]?.body));
    expect(items).toHaveLength(3);
    expect(items.map((item: { description: string }) => item.description)).toEqual(["Cemento gris", "Arena de río", "Varilla 1/2"]);
    // La cantidad viaja como NÚMERO, no como el texto del input: el esquema exige `z.number()`.
    expect(items[1]).toMatchObject({ quantity: 3, unit: "m³" });
  });

  it("no deja avanzar de artículo con la descripción vacía", async () => {
    await llegarAlPrimerArticulo();
    fireEvent.click(screen.getByRole("button", { name: /Agregar otro artículo/i }));
    expect(await screen.findByText(/Describe lo que necesitas\./i)).toBeInTheDocument();
    expect(screen.queryByText(/^Artículo 2$/i)).not.toBeInTheDocument();
  });

  it("«Atrás» en el artículo 2 vuelve al artículo 1 sin perder lo escrito, no a «Tus datos»", async () => {
    await llegarAlPrimerArticulo();
    llenarItem(0, { descripcion: "Cemento gris", cantidad: "20", unidad: "bulto" });
    fireEvent.click(screen.getByRole("button", { name: /Agregar otro artículo/i }));
    await screen.findByText(/^Artículo 2$/i);

    fireEvent.click(screen.getByRole("button", { name: /Atrás/i }));
    await screen.findByText(/^Artículo 1$/i);
    expect(campo("description-0")).toHaveValue("Cemento gris");
  });

  it("volver a pulsar «Agregar otro artículo» tras retroceder NO duplica la pantalla", async () => {
    await llegarAlPrimerArticulo();
    llenarItem(0, { descripcion: "Cemento gris", cantidad: "20", unidad: "bulto" });
    fireEvent.click(screen.getByRole("button", { name: /Agregar otro artículo/i }));
    await screen.findByText(/^Artículo 2$/i);
    llenarItem(1, { descripcion: "Arena de río", cantidad: "3", unidad: "m³" });

    fireEvent.click(screen.getByRole("button", { name: /Atrás/i }));
    await screen.findByText(/^Artículo 1$/i);
    fireEvent.click(screen.getByRole("button", { name: /Agregar otro artículo/i }));
    // Vuelve al artículo 2 QUE YA EXISTÍA, con lo que tenía, no a un tercero en blanco.
    await screen.findByText(/^Artículo 2$/i);
    expect(campo("description-1")).toHaveValue("Arena de río");
    fireEvent.click(screen.getByRole("button", { name: /Ir al resumen/i }));
    await screen.findByText(/¿Para cuándo\?/i);
    fireEvent.click(screen.getByRole("button", { name: /Ver resumen/i }));
    const listaArticulos = await screen.findByRole("list", { name: /Artículos de la requisición/i });
    expect(within(listaArticulos).getAllByRole("listitem")).toHaveLength(2);
  });

  it("con un solo artículo, el resumen no ofrece quitarlo: sin ítems no hay requisición", async () => {
    await llegarAlPrimerArticulo();
    llenarItem(0, { descripcion: "Cemento gris", cantidad: "20", unidad: "bulto" });
    fireEvent.click(screen.getByRole("button", { name: /Ir al resumen/i }));
    await screen.findByText(/¿Para cuándo\?/i);
    fireEvent.click(screen.getByRole("button", { name: /Ver resumen/i }));
    await screen.findByRole("heading", { name: /^Resumen$/i });
    expect(screen.queryByRole("button", { name: /Quitar/i })).toBeNull();
  });

  it("se puede quitar un artículo desde el resumen, y el envío ya no lo incluye", async () => {
    await llegarAlPrimerArticulo();
    llenarItem(0, { descripcion: "Cemento gris", cantidad: "20", unidad: "bulto" });
    fireEvent.click(screen.getByRole("button", { name: /Agregar otro artículo/i }));
    await screen.findByText(/^Artículo 2$/i);
    llenarItem(1, { descripcion: "Arena de río", cantidad: "3", unidad: "m³" });
    fireEvent.click(screen.getByRole("button", { name: /Ir al resumen/i }));
    await screen.findByText(/¿Para cuándo\?/i);
    fireEvent.click(screen.getByRole("button", { name: /Ver resumen/i }));
    await screen.findByRole("heading", { name: /^Resumen$/i });

    fireEvent.click(screen.getAllByRole("button", { name: /Quitar/i })[0]);
    expect(screen.queryByText(/Cemento gris/i)).not.toBeInTheDocument();
    expect(screen.getByText(/1\. Arena de río/i)).toBeInTheDocument();
    // Con uno solo, ya no se puede quitar.
    expect(screen.queryByRole("button", { name: /Quitar/i })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Enviar solicitud/i }));
    await waitFor(() => expect(llamadasA(RADICACION)).toHaveLength(1));
    const { items } = JSON.parse(String(llamadasA(RADICACION)[0][1]?.body));
    expect(items).toHaveLength(1);
    expect(items[0].description).toBe("Arena de río");
  });

  it("la unidad se escribe, no se elige de una lista cerrada", async () => {
    await llegarAlPrimerArticulo();
    expect(campo("unit-0").tagName).toBe("INPUT");
    expect(campo("unit-0")).toHaveAttribute("list", "portal-unidades");
    expect(document.querySelectorAll("#portal-unidades option").length).toBeGreaterThan(0);

    llenarItem(0, { descripcion: "Sellante", cantidad: "2", unidad: "cuñete" });
    fireEvent.click(screen.getByRole("button", { name: /Ir al resumen/i }));
    await screen.findByText(/¿Para cuándo\?/i);
    fireEvent.click(screen.getByRole("button", { name: /Ver resumen/i }));
    fireEvent.click(screen.getByRole("button", { name: /Enviar solicitud/i }));
    await waitFor(() => expect(llamadasA(RADICACION)).toHaveLength(1));
    expect(JSON.parse(String(llamadasA(RADICACION)[0][1]?.body)).items[0].unit).toBe("cuñete");
  });
});

// RF portal-fotos-articulo: UNA foto opcional por artículo, calcada del `PhotoPicker` del Flow de
// WhatsApp. Diseño de seguridad (ver app/api/public/requisitions/route.ts y
// lib/infrastructure/public-photos.ts): la foto viaja en la MISMA petición que radica, como
// `multipart/form-data` con el JSON de siempre intacto en el campo `payload` y cada foto en
// `foto_<índice>` — nunca un endpoint de subida previa. Aquí se prueba SOLO el cliente: selección,
// vista previa, quitar, el tope de 5 MB, y que el envío cambia a FormData nada más que cuando hace
// falta.
describe("foto opcional por artículo (RF portal-fotos-articulo)", () => {
  beforeEach(() => {
    setHash({ obra: workId, token });
    stubFetch();
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.location.hash = ""; });

  async function llegarAlPrimerArticulo() {
    render(<PublicRequestScreen demoMode={false} publicConfigured />);
    await pasarCompuerta();
    pasarTipoYEmpresa();
    await screen.findByRole("heading", { name: /^Tus datos$/i });
    pasarDatos();
    await screen.findByText(/^Artículo 1$/i);
  }

  it("se elige una foto, se ve su vista previa y su nombre, y se puede quitar", async () => {
    await llegarAlPrimerArticulo();
    expect(screen.getByText(/Agregar una foto/i)).toBeInTheDocument();
    const archivo = new File([new Uint8Array(10)], "frente-obra.jpg", { type: "image/jpeg" });
    fireEvent.change(campo("photo-0"), { target: { files: [archivo] } });

    expect(await screen.findByText("frente-obra.jpg")).toBeInTheDocument();
    // La vista previa es una miniatura de verdad, no solo el nombre del archivo.
    expect(document.querySelector("img")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Quitar foto/i }));
    expect(screen.queryByText("frente-obra.jpg")).not.toBeInTheDocument();
    expect(screen.getByText(/Agregar una foto/i)).toBeInTheDocument();
  });

  it("una foto de más de 5 MB se rechaza en el cliente, con un mensaje claro, y no se elige", async () => {
    await llegarAlPrimerArticulo();
    const grande = new File([new Uint8Array(6 * 1024 * 1024)], "grande.jpg", { type: "image/jpeg" });
    fireEvent.change(campo("photo-0"), { target: { files: [grande] } });

    expect(await screen.findByText(/máximo 5 MB/i)).toBeInTheDocument();
    expect(screen.queryByText("grande.jpg")).not.toBeInTheDocument();
    expect(screen.getByText(/Agregar una foto/i)).toBeInTheDocument();
  });

  it("un archivo que no es imagen se rechaza en el cliente", async () => {
    await llegarAlPrimerArticulo();
    const pdf = new File([new Uint8Array(10)], "cotizacion.pdf", { type: "application/pdf" });
    fireEvent.change(campo("photo-0"), { target: { files: [pdf] } });

    expect(await screen.findByText(/debe ser JPG, PNG o WebP/i)).toBeInTheDocument();
    expect(screen.queryByText("cotizacion.pdf")).not.toBeInTheDocument();
  });

  it("con foto, el envío usa FormData: el JSON de siempre viaja intacto en 'payload' y la foto en 'foto_<índice>'", async () => {
    await llegarAlPrimerArticulo();
    const archivo = new File([new Uint8Array(10)], "frente-obra.jpg", { type: "image/jpeg" });
    fireEvent.change(campo("photo-0"), { target: { files: [archivo] } });
    await screen.findByText("frente-obra.jpg");
    llenarItem(0, { descripcion: "Cemento gris", cantidad: "5", unidad: "bulto" });
    fireEvent.click(screen.getByRole("button", { name: /Ir al resumen/i }));
    await screen.findByText(/¿Para cuándo\?/i);
    fireEvent.click(screen.getByRole("button", { name: /Ver resumen/i }));
    await screen.findByRole("heading", { name: /^Resumen$/i });
    // El resumen también muestra una miniatura del artículo con foto.
    expect(document.querySelector("img")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Enviar solicitud/i }));
    await waitFor(() => expect(llamadasA(RADICACION)).toHaveLength(1));
    const [, init] = llamadasA(RADICACION)[0];
    expect(init?.body).toBeInstanceOf(FormData);
    // Nunca se fija `content-type` a mano con FormData: el navegador calcula el boundary.
    expect(init?.headers).not.toHaveProperty("content-type");
    expect((init?.headers as Record<string, string>)["x-public-link-token"]).toBe(token);

    const body = init!.body as FormData;
    const payload = JSON.parse(String(body.get("payload")));
    expect(payload.items).toHaveLength(1);
    expect(payload.items[0].description).toBe("Cemento gris");
    expect(payload).not.toHaveProperty("photo"); // la foto nunca viaja dentro del JSON

    const foto = body.get("foto_0");
    expect(foto).toBeInstanceOf(File);
    expect((foto as File).name).toBe("frente-obra.jpg");
  });

  it("el ÍNDICE de la foto es la posición del artículo, no la del que tiene foto", async () => {
    // Dos artículos, foto SOLO en el segundo (índice 1): el campo debe ser `foto_1`, no `foto_0`.
    await llegarAlPrimerArticulo();
    llenarItem(0, { descripcion: "Cemento gris", cantidad: "20", unidad: "bulto" });
    fireEvent.click(screen.getByRole("button", { name: /Agregar otro artículo/i }));
    await screen.findByText(/^Artículo 2$/i);
    llenarItem(1, { descripcion: "Arena de río", cantidad: "3", unidad: "m³" });
    const archivo = new File([new Uint8Array(10)], "arena.jpg", { type: "image/jpeg" });
    fireEvent.change(campo("photo-1"), { target: { files: [archivo] } });
    await screen.findByText("arena.jpg");

    fireEvent.click(screen.getByRole("button", { name: /Ir al resumen/i }));
    await screen.findByText(/¿Para cuándo\?/i);
    fireEvent.click(screen.getByRole("button", { name: /Ver resumen/i }));
    fireEvent.click(screen.getByRole("button", { name: /Enviar solicitud/i }));
    await waitFor(() => expect(llamadasA(RADICACION)).toHaveLength(1));

    const body = llamadasA(RADICACION)[0][1]!.body as FormData;
    expect(body.get("foto_0")).toBeNull();
    expect(body.get("foto_1")).toBeInstanceOf(File);
  });

  it("sin ninguna foto, el envío sigue siendo JSON de siempre — nunca FormData sin necesidad", async () => {
    render(<PublicRequestScreen demoMode={false} publicConfigured />);
    await pasarCompuerta();
    pasarTipoYEmpresa();
    await screen.findByRole("heading", { name: /^Tus datos$/i });
    await rellenarYEnviar();
    await waitFor(() => expect(llamadasA(RADICACION)).toHaveLength(1));
    const [, init] = llamadasA(RADICACION)[0];
    expect(typeof init?.body).toBe("string");
    expect((init?.headers as Record<string, string>)["content-type"]).toBe("application/json");
  });
});

describe("lo tecleado ANTES de hidratar no se pierde", () => {
  beforeEach(() => {
    setHash({ obra: workId, token });
    stubFetch();
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.location.hash = ""; });

  it("con los valores escritos directamente en el DOM, la compuerta se abre igual", async () => {
    render(<PublicRequestScreen demoMode={false} publicConfigured />);
    await waitFor(() => expect(screen.getByText(/Pide lo que tu obra necesita/i)).toBeInTheDocument());

    campo("access-code").value = "clave-1234";
    fireEvent.click(screen.getByRole("button", { name: /Continuar/i }));

    expect(await screen.findByText(/¿Qué vas a solicitar\?/i)).toBeInTheDocument();
  });

  it("y ese valor llega al envío, no uno vacío", async () => {
    render(<PublicRequestScreen demoMode={false} publicConfigured />);
    await waitFor(() => expect(screen.getByText(/Pide lo que tu obra necesita/i)).toBeInTheDocument());
    campo("access-code").value = "clave-1234";
    fireEvent.click(screen.getByRole("button", { name: /Continuar/i }));
    await screen.findByText(/¿Qué vas a solicitar\?/i);
    pasarTipoYEmpresa();
    await screen.findByRole("heading", { name: /^Tus datos$/i });

    await rellenarYEnviar();
    await waitFor(() => expect(llamadasA(RADICACION)).toHaveLength(1));
    const body = JSON.parse(String(llamadasA(RADICACION)[0][1]?.body));
    expect(body.code).toBe("clave-1234");
    expect(body.phone).toBe("3001234567");
  });

  it("al volver con «Cambiar datos» los campos conservan lo ya escrito", async () => {
    render(<PublicRequestScreen demoMode={false} publicConfigured />);
    await pasarCompuerta();
    fireEvent.click(screen.getByRole("button", { name: /Cambiar datos/i }));
    await waitFor(() => expect(screen.getByText(/Pide lo que tu obra necesita/i)).toBeInTheDocument());
    expect(campo("access-code").value).toBe("clave-1234");
  });
});

// Reunión 2026-08-31 y recordatorio de Ernesto el 11-sep-2026: «en el formulario público aparece
// seleccionar obra y ya dijimos era empresa». La obra es el centro de costo y la asigna el revisor,
// que es quien sabe a qué contrato cargar el gasto; el Flow de WhatsApp ya funcionaba así.
describe("portal público guiado — ruta general, se elige EMPRESA", () => {
  beforeEach(() => {
    // Sin `obra` en el fragmento: la ruta es general y la empresa se elige en el formulario.
    setHash({ token });
    stubFetch({ [EMPRESAS]: { status: 200, body: { companies: [{ id: societyId, name: "Constructora Mizar S.A.S." }] } } });
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.location.hash = ""; });

  it("pide la lista de empresas SIN contraseña, y antes incluso de pasar la compuerta", async () => {
    render(<PublicRequestScreen demoMode={false} publicConfigured />);
    await waitFor(() => expect(llamadasA(EMPRESAS)).toHaveLength(1));
    const llamada = llamadasA(EMPRESAS)[0];
    expect(llamada?.[1]).toBeUndefined(); // GET a secas: ni método, ni cuerpo, ni cabeceras
    expect(String(llamada?.[0])).toBe(EMPRESAS);

    await pasarCompuerta();
    expect(screen.getByRole("option", { name: "Constructora Mizar S.A.S." })).toBeInTheDocument();
  });

  it("ya no hay selector de obra en el formulario", async () => {
    render(<PublicRequestScreen demoMode={false} publicConfigured />);
    await pasarCompuerta();
    await screen.findByRole("option", { name: "Constructora Mizar S.A.S." });
    expect(document.querySelector('select[name="work"]')).toBeNull();
    expect(screen.getByText(/La obra la asigna quien revisa/i)).toBeInTheDocument();
  });

  it("no deja continuar sin elegir empresa, y al elegirla manda societyId (no workId); el resumen la muestra por NOMBRE", async () => {
    render(<PublicRequestScreen demoMode={false} publicConfigured />);
    await pasarCompuerta();
    await screen.findByRole("option", { name: "Constructora Mizar S.A.S." });
    fireEvent.click(screen.getByRole("button", { name: /^Continuar$/i }));
    expect(await screen.findByText("Selecciona la empresa.")).toBeInTheDocument();

    fireEvent.change(document.querySelector('select[name="company"]') as HTMLSelectElement, { target: { value: societyId } });
    fireEvent.click(screen.getByRole("button", { name: /^Continuar$/i }));
    await screen.findByRole("heading", { name: /^Tus datos$/i });
    await llegarAlResumen();

    // La empresa se muestra por NOMBRE en el resumen, no por su id.
    expect(screen.getByText("Constructora Mizar S.A.S.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Enviar solicitud/i }));
    await waitFor(() => expect(llamadasA(RADICACION)).toHaveLength(1));
    const body = JSON.parse(String(llamadasA(RADICACION)[0][1]?.body));
    expect(body.societyId).toBe(societyId);
    expect(body).not.toHaveProperty("workId");
  });
});

describe("portal público guiado — enlace inválido", () => {
  afterEach(() => { cleanup(); window.location.hash = ""; });

  it("SIN fragmento la ruta abre la compuerta: es pública", async () => {
    window.location.hash = "";
    stubFetch();
    render(<PublicRequestScreen demoMode={false} publicConfigured />);
    await waitFor(() => expect(screen.getByText(/Pide lo que tu obra necesita/i)).toBeInTheDocument());
    expect(screen.queryByText(/Este enlace no está habilitado/i)).not.toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it("un fragmento MAL FORMADO sí se rechaza, en vez de degradarse a acceso libre", async () => {
    setHash({ obra: workId, token: "no-son-64-hex" });
    render(<PublicRequestScreen demoMode={false} publicConfigured />);
    await waitFor(() => expect(screen.getByText(/Este enlace no está habilitado/i)).toBeInTheDocument());
  });

  it("el fragmento SE QUEDA en la URL, para que recargar no rompa el enlace", async () => {
    setHash({ obra: workId, token });
    const { unmount } = render(<PublicRequestScreen demoMode={false} publicConfigured />);
    await waitFor(() => expect(screen.getByText(/Pide lo que tu obra necesita/i)).toBeInTheDocument());
    expect(window.location.hash).toContain(token);

    unmount();
    render(<PublicRequestScreen demoMode={false} publicConfigured />);
    await waitFor(() => expect(screen.getByText(/Pide lo que tu obra necesita/i)).toBeInTheDocument());
    expect(screen.queryByText(/Este enlace no está habilitado/i)).not.toBeInTheDocument();
  });

  it("con el portal sin configurar tampoco se lee el fragmento", async () => {
    setHash({ obra: workId, token });
    render(<PublicRequestScreen demoMode={false} publicConfigured={false} />);
    await waitFor(() => expect(screen.getByText(/Este enlace no está habilitado/i)).toBeInTheDocument());
  });
});

// RF-108 (adenda de pagos, A12 del plan): «Solicitud de pago» abre un camino de TRES pasos —¿Quién
// cobra?, El pago, Resumen— en vez del de compra. Quien radica es el beneficiario (no hay "Tus
// datos"), la empresa se pide junto al monto (es a la que se cobra) y no hay artículos: el concepto y
// el monto son la única línea. El endpoint recibe `type: "pago"` con `beneficiary`, `amount` (número
// entero) y `concept`, sin `items` ni `name`. Antes el paso 1 ofrecía "Solicitud de pago" y los pasos
// siguientes eran los de compra: la solicitud llegaba sin monto y el 202 neutro la perdía en silencio.
describe("portal público guiado — solicitud de pago (RF-108)", () => {
  beforeEach(() => {
    setHash({ token });
    stubFetch({ [EMPRESAS]: { status: 200, body: { companies: [{ id: societyId, name: "Constructora Mizar S.A.S." }] } } });
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.location.hash = ""; });

  const radioPago = () => document.querySelector('input[name="type"][value="pago"]') as HTMLInputElement;

  /** Compuerta, lista de empresas cargada y «Solicitud de pago» elegido; se queda en "¿Qué vas a solicitar?". */
  async function elegirPago() {
    render(<PublicRequestScreen demoMode={false} publicConfigured />);
    await pasarCompuerta();
    await screen.findByRole("option", { name: "Constructora Mizar S.A.S." });
    fireEvent.click(radioPago());
  }
  async function llegarAQuienCobra() {
    await elegirPago();
    fireEvent.click(screen.getByRole("button", { name: /^Continuar$/i }));
    await screen.findByRole("heading", { name: /¿Quién cobra\?/i });
  }
  function llenarBeneficiario({ identificacion = "1020304050", nombre = "Ana Topógrafa", telefono = "3001234567" }: { identificacion?: string; nombre?: string; telefono?: string } = {}) {
    fireEvent.change(campo("identificationType"), { target: { value: "CC" } });
    fireEvent.change(campo("identification"), { target: { value: identificacion } });
    fireEvent.change(campo("beneficiaryName"), { target: { value: nombre } });
    if (telefono) fireEvent.change(campo("phone"), { target: { value: telefono } });
    fireEvent.click(screen.getByRole("button", { name: /Continuar al pago/i }));
  }
  async function llegarAlPago() {
    await llegarAQuienCobra();
    llenarBeneficiario();
    await screen.findByRole("heading", { name: /^El pago$/i });
  }
  function llenarPago({ empresa = societyId, monto = "1250000", concepto = "Levantamiento topográfico lote 3" }: { empresa?: string; monto?: string; concepto?: string } = {}) {
    if (empresa) fireEvent.change(document.querySelector('select[name="company"]') as HTMLSelectElement, { target: { value: empresa } });
    if (monto) fireEvent.change(campo("amount"), { target: { value: monto } });
    if (concepto) fireEvent.change(campo("concept"), { target: { value: concepto } });
    fireEvent.click(screen.getByRole("button", { name: /Ver resumen/i }));
  }
  async function llegarAlResumenDePago() {
    await llegarAlPago();
    llenarPago();
    await screen.findByRole("heading", { name: /^Resumen$/i });
  }

  it("elegir «Solicitud de pago» quita la empresa del primer paso y lleva a «¿Quién cobra?», no a «Tus datos»", async () => {
    await elegirPago();
    expect(radioPago()).toBeChecked();
    // La empresa se pide después, junto al monto: es a la que se cobra (A12).
    expect(document.querySelector('select[name="company"]')).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Continuar$/i }));

    expect(await screen.findByRole("heading", { name: /¿Quién cobra\?/i })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /^Tus datos$/i })).toBeNull();
    // Cuatro etapas en el indicador, no cinco: es otro camino.
    expect(within(screen.getByRole("list", { name: /Avance de la requisición/i })).getAllByRole("listitem")).toHaveLength(4);
  });

  it("no deja pasar sin identificación ni nombre, y una identificación con puntos se limpia al teclear", async () => {
    await llegarAQuienCobra();
    fireEvent.click(screen.getByRole("button", { name: /Continuar al pago/i }));

    expect(await screen.findByText(/Escribe el número de identificación/i)).toBeInTheDocument();
    expect(screen.getByText(/Escribe el nombre completo o la razón social/i)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /^El pago$/i })).toBeNull();

    // "1.020.304.050" no enlazaría con "1020304050" en el catálogo: los puntos se van al teclear.
    fireEvent.change(campo("identification"), { target: { value: "1.020.304.050" } });
    expect(campo("identification")).toHaveValue("1020304050");
  });

  it("un teléfono a medias también se rechaza en «¿Quién cobra?»", async () => {
    await llegarAQuienCobra();
    llenarBeneficiario({ telefono: "300" });
    expect(await screen.findByText(/teléfono está incompleto/i)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /^El pago$/i })).toBeNull();
  });

  it("recorre los tres pasos y envía type=pago con beneficiario, monto numérico y concepto — sin items ni name", async () => {
    await llegarAlPago();
    // La empresa se elige AQUÍ, con el mismo selector que la compra.
    expect(screen.getByRole("option", { name: "Constructora Mizar S.A.S." })).toBeInTheDocument();
    llenarPago();
    await screen.findByRole("heading", { name: /^Resumen$/i });

    expect(screen.getByText("Ana Topógrafa")).toBeInTheDocument();
    expect(screen.getByText(/CC 1020304050/)).toBeInTheDocument();
    expect(screen.getByText(/1\.250\.000/)).toBeInTheDocument();
    expect(screen.getByText("Levantamiento topográfico lote 3")).toBeInTheDocument();
    expect(screen.getByText("Constructora Mizar S.A.S.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Enviar solicitud/i }));
    await waitFor(() => expect(llamadasA(RADICACION)).toHaveLength(1));
    const [, init] = llamadasA(RADICACION)[0];
    expect((init?.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(JSON.parse(String(init?.body))).toEqual({
      societyId, code: "clave-1234", type: "pago", phone: "3001234567",
      beneficiary: { identificationType: "CC", identification: "1020304050", name: "Ana Topógrafa" },
      amount: 1250000, concept: "Levantamiento topográfico lote 3",
    });
    await screen.findByText(/La estamos validando/i);
  });

  it("sin monto no pasa al resumen; el concepto se corta a 120 caracteres en el propio campo", async () => {
    await llegarAlPago();
    expect(campo("concept")).toHaveAttribute("maxlength", "120");
    llenarPago({ monto: "" });

    expect(await screen.findByText(/Indica el monto a cobrar/i)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /^Resumen$/i })).toBeNull();
  });

  it("el monto solo admite dígitos y muestra el valor en pesos mientras se escribe", async () => {
    await llegarAlPago();
    fireEvent.change(campo("amount"), { target: { value: "1.250.000 COP" } });
    expect(campo("amount")).toHaveValue("1250000");
    expect(screen.getByText(/Se solicita .*1\.250\.000/)).toBeInTheDocument();
  });

  it("la foto de la factura viaja como foto_0 en FormData, con el JSON de pago intacto en 'payload'", async () => {
    await llegarAlPago();
    const archivo = new File([new Uint8Array(10)], "factura.jpg", { type: "image/jpeg" });
    fireEvent.change(campo("photo-0"), { target: { files: [archivo] } });
    await screen.findByText("factura.jpg");
    llenarPago();
    await screen.findByRole("heading", { name: /^Resumen$/i });
    expect(document.querySelector("img")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Enviar solicitud/i }));
    await waitFor(() => expect(llamadasA(RADICACION)).toHaveLength(1));
    const [, init] = llamadasA(RADICACION)[0];
    expect(init?.body).toBeInstanceOf(FormData);
    const body = init!.body as FormData;
    const payload = JSON.parse(String(body.get("payload")));
    expect(payload).toMatchObject({ type: "pago", amount: 1250000, concept: "Levantamiento topográfico lote 3" });
    expect(body.get("foto_0")).toBeInstanceOf(File);
    expect((body.get("foto_0") as File).name).toBe("factura.jpg");
  });

  it("un rechazo con mensaje del servidor se muestra tal cual, sin fingir éxito", async () => {
    // Desde S3 el endpoint dice por qué rechaza (p. ej. 409 por un homónimo con otra identificación).
    stubFetch({
      [EMPRESAS]: { status: 200, body: { companies: [{ id: societyId, name: "Constructora Mizar S.A.S." }] } },
      [RADICACION]: { status: 409, body: { error: "conflict", message: "Ya existe un proveedor con ese nombre y otra identificación" } },
    });
    await llegarAlResumenDePago();
    fireEvent.click(screen.getByRole("button", { name: /Enviar solicitud/i }));

    expect(await screen.findByText(/Ya existe un proveedor con ese nombre/i)).toBeInTheDocument();
    expect(screen.queryByText(/La estamos validando/i)).not.toBeInTheDocument();
  });

  it("«Atrás» desde el resumen vuelve a «El pago», y de ahí a «¿Quién cobra?», sin perder lo escrito", async () => {
    await llegarAlResumenDePago();
    fireEvent.click(screen.getByRole("button", { name: /Atrás/i }));
    await screen.findByRole("heading", { name: /^El pago$/i });
    expect(campo("amount")).toHaveValue("1250000");
    fireEvent.click(screen.getByRole("button", { name: /Atrás/i }));
    await screen.findByRole("heading", { name: /¿Quién cobra\?/i });
    expect(campo("identification")).toHaveValue("1020304050");
    expect(campo("beneficiaryName")).toHaveValue("Ana Topógrafa");
  });

  it("el camino de compra sigue intacto: «Compra de material» pide la empresa en el primer paso y va a «Tus datos»", async () => {
    render(<PublicRequestScreen demoMode={false} publicConfigured />);
    await pasarCompuerta();
    await screen.findByRole("option", { name: "Constructora Mizar S.A.S." });
    expect(document.querySelector('select[name="company"]')).not.toBeNull();
    pasarTipoYEmpresa({ company: societyId });
    await screen.findByRole("heading", { name: /^Tus datos$/i });
    expect(within(screen.getByRole("list", { name: /Avance de la requisición/i })).getAllByRole("listitem")).toHaveLength(5);
  });
});

describe("ruta heredada /requisiciones/publica-movil", () => {
  afterEach(() => { cleanup(); window.location.hash = ""; });

  it("reenvía al formulario único CONSERVANDO el fragmento", async () => {
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
