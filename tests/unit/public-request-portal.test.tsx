// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PublicRequestRedirect, PublicRequestScreen } from "../../components/screens/public-request";

// Portal público UNIFICADO (2026-09-11). Hasta ahora había dos formularios —escritorio y móvil— con
// dos árboles de componentes y dos URLs; sobrevive uno solo, responsive, sobre la base móvil (mejor
// validación por campo y CSS aislado). Este archivo cubre sobre la pantalla que queda TODO lo que
// antes se repartía entre las dos: la compuerta, el selector del enlace general, el envío con
// `x-public-link-token`, las respuestas 202/503 y la fecha opcional.
//
// Lo de la fecha viene de la reunión: el esquema HTTP (lib/http/schemas.ts, `z.string().date()
// .optional()`) ya la aceptaba opcional en los tres canales, pero el portal la marcaba `required` y,
// peor, mandaba '' cuando quedaba vacía. Una fecha VÁLIDA no es lo mismo que AUSENTE, y como el
// endpoint público responde 202 neutro incluso cuando el esquema rechaza, el fallo nunca se veía.
//
// Y desde el 11-sep-2026 cubre además los cuatro cambios que Ernesto pidió probando el portal:
// EMPRESA en vez de obra, teléfono OPCIONAL, VARIOS ítems por requisición y unidad de texto libre.
const workId = "11111111-1111-4111-8111-111111111111";
const societyId = "22222222-2222-4222-8222-222222222222";
const token = "a".repeat(64);

function setHash(params: Record<string, string>) {
  window.location.hash = new URLSearchParams(params).toString();
}

const campo = (nombre: string) => document.querySelector(`[name="${nombre}"]`) as HTMLInputElement;

/** Atraviesa la compuerta: desde 2026-09-11 solo pide la contraseña. */
async function pasarCompuerta() {
  await waitFor(() => expect(screen.getByText(/Pide lo que tu obra necesita/i)).toBeInTheDocument());
  fireEvent.change(campo("access-code"), { target: { value: "clave-1234" } });
  fireEvent.click(screen.getByRole("button", { name: /Continuar/i }));
  await screen.findByText(/¿Para quién y cuándo\?/i);
}

/** Llena el ítem `indice` del paso 2. Las claves llevan el índice desde que hay varios. */
function llenarItem(indice: number, { descripcion, cantidad, unidad }: { descripcion: string; cantidad: string; unidad: string }) {
  fireEvent.change(campo(`description-${indice}`), { target: { value: descripcion } });
  fireEvent.change(campo(`quantity-${indice}`), { target: { value: cantidad } });
  fireEvent.change(campo(`unit-${indice}`), { target: { value: unidad } });
}

/**
 * Completa los dos pasos y envía. `conFecha` false limpia la fecha, que viene precargada con hoy;
 * `telefono` vacío deja el campo sin tocar, que es el caso nuevo (ya no es obligatorio).
 */
async function rellenarYEnviar({ conFecha = false, telefono = "3001234567" }: { conFecha?: boolean; telefono?: string } = {}) {
  if (!conFecha) fireEvent.change(campo("date"), { target: { value: "" } });
  fireEvent.change(campo("requestor"), { target: { value: "Ana Solicitante" } });
  // El teléfono se pide AQUÍ desde 2026-09-11, no en la compuerta.
  if (telefono) fireEvent.change(campo("phone"), { target: { value: telefono } });
  fireEvent.click(screen.getByRole("button", { name: /Continuar a material/i }));
  await screen.findByText(/Describe lo que necesitas\./i);
  llenarItem(0, { descripcion: "Cemento gris", cantidad: "5", unidad: "bulto" });
  fireEvent.click(screen.getByRole("button", { name: /Enviar requisición/i }));
}

describe("portal público unificado — enlace por obra", () => {
  beforeEach(() => {
    setHash({ obra: workId, token });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 202, json: async () => ({ accepted: true }) }));
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.location.hash = ""; });

  it("la compuerta pide SOLO la contraseña, no el teléfono", async () => {
    // Ernesto había pedido «para ingresar, solo una contraseña», y la compuerta pedía además el
    // teléfono. No era un segundo control —cualquier número servía—, solo un obstáculo de más antes
    // de ver el formulario. El teléfono se pide después, en el paso 1, donde se entiende para qué es.
    render(<PublicRequestScreen demoMode={false} publicConfigured />);
    await waitFor(() => expect(screen.getByText(/Pide lo que tu obra necesita/i)).toBeInTheDocument());
    expect(campo("access-code")).toBeInTheDocument();
    expect(document.querySelector('input[name="access-phone"]')).toBeNull();

    // Sin contraseña no se pasa: la compuerta es de cliente, pero el servidor revalida al enviar.
    fireEvent.click(screen.getByRole("button", { name: /Continuar/i }));
    expect(screen.queryByText(/¿Para quién y cuándo\?/i)).not.toBeInTheDocument();
  });

  it("el enlace por obra NO pide empresa: ya viene firmada", async () => {
    // Pedirla otra vez dejaría elegir una empresa que el enlace no autoriza, y el endpoint rechaza
    // que viajen las dos.
    render(<PublicRequestScreen demoMode={false} publicConfigured />);
    await pasarCompuerta();
    expect(document.querySelector('select[name="company"]')).toBeNull();
  });

  it("el teléfono es OPCIONAL: sin él se radica igual y no viaja en el envío", async () => {
    // Ernesto, 11-sep-2026: «el teléfono no lo hagas obligatorio». Quien no lo da se queda sin acuse
    // por WhatsApp, que es el precio y se dice en el formulario; lo que no puede es quedarse sin
    // radicar. Y el campo NO puede viajar vacío: `phone: ''` lo rechaza el esquema (min 7) y, con el
    // 202 neutro, ese rechazo se vería igual que un envío correcto.
    render(<PublicRequestScreen demoMode={false} publicConfigured />);
    await pasarCompuerta();
    const etiqueta = screen.getByText(/Tu teléfono/i);
    expect(etiqueta.closest("label")).not.toHaveTextContent("*");

    await rellenarYEnviar({ telefono: "" });
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))).not.toHaveProperty("phone");
  });

  it("pero un teléfono A MEDIAS sí se rechaza, en vez de mandarse roto", async () => {
    // Opcional no es "cualquier cosa": un número incompleto es peor que ninguno, porque el aviso se
    // encola contra un destinatario que no existe y nadie se entera de que no llegó.
    render(<PublicRequestScreen demoMode={false} publicConfigured />);
    await pasarCompuerta();
    fireEvent.change(campo("requestor"), { target: { value: "Ana Solicitante" } });
    fireEvent.change(campo("phone"), { target: { value: "300" } });
    fireEvent.click(screen.getByRole("button", { name: /Continuar a material/i }));
    expect(await screen.findByText(/teléfono está incompleto/i)).toBeInTheDocument();
    expect(screen.queryByText(/Describe lo que necesitas\./i)).not.toBeInTheDocument();
  });

  it("el teléfono escrito en el paso 1 viaja en el envío", async () => {
    render(<PublicRequestScreen demoMode={false} publicConfigured />);
    await pasarCompuerta();
    await rellenarYEnviar();
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body)).phone).toBe("3001234567");
  });

  it("la fecha no está marcada como obligatoria", async () => {
    render(<PublicRequestScreen demoMode={false} publicConfigured />);
    await pasarCompuerta();
    const dateLabel = screen.getByText(/Fecha requerida/i);
    expect(dateLabel.closest("label")).not.toHaveTextContent("*");
    expect(campo("date")).not.toBeRequired();
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
    // Obra O empresa, nunca las dos: el endpoint rechaza el envío entero si viajan juntas.
    expect(body).not.toHaveProperty("societyId");
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

// Ernesto, 11-sep-2026: «solo dejas agregar un ítem por form, debe permitir ir agregando más». Quien
// necesitaba cemento, arena y varilla radicaba tres requisiciones, y el revisor recibía tres pedidos
// que en la obra eran uno.
describe("portal público — varios ítems en una requisición", () => {
  beforeEach(() => {
    setHash({ obra: workId, token });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 202, json: async () => ({ accepted: true }) }));
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.location.hash = ""; });

  async function llegarAlPaso2() {
    render(<PublicRequestScreen demoMode={false} publicConfigured />);
    await pasarCompuerta();
    fireEvent.change(campo("date"), { target: { value: "" } });
    fireEvent.change(campo("requestor"), { target: { value: "Ana Solicitante" } });
    fireEvent.click(screen.getByRole("button", { name: /Continuar a material/i }));
    await screen.findByText(/Describe lo que necesitas\./i);
  }

  it("los tres ítems viajan en un solo envío", async () => {
    await llegarAlPaso2();
    llenarItem(0, { descripcion: "Cemento gris", cantidad: "20", unidad: "bulto" });
    fireEvent.click(screen.getByRole("button", { name: /Agregar otro ítem/i }));
    llenarItem(1, { descripcion: "Arena de río", cantidad: "3", unidad: "m³" });
    fireEvent.click(screen.getByRole("button", { name: /Agregar otro ítem/i }));
    llenarItem(2, { descripcion: "Varilla 1/2", cantidad: "40", unidad: "und" });
    fireEvent.click(screen.getByRole("button", { name: /Enviar requisición/i }));

    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1));
    const { items } = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body));
    expect(items).toHaveLength(3);
    expect(items.map((item: { description: string }) => item.description)).toEqual(["Cemento gris", "Arena de río", "Varilla 1/2"]);
    // La cantidad viaja como NÚMERO, no como el texto del input: el esquema exige `z.number()`.
    expect(items[1]).toMatchObject({ quantity: 3, unit: "m³" });
  });

  it("el error señala el ítem que falla, no siempre el primero", async () => {
    // Las claves de error llevan el índice y coinciden con el `name` del campo, que es como el foco
    // encuentra el que falta. Sin índice, quien se equivocara en el tercero vería el aviso sobre el
    // primero, que está bien lleno.
    await llegarAlPaso2();
    llenarItem(0, { descripcion: "Cemento gris", cantidad: "20", unidad: "bulto" });
    fireEvent.click(screen.getByRole("button", { name: /Agregar otro ítem/i }));
    fireEvent.change(campo("quantity-1"), { target: { value: "3" } });
    fireEvent.change(campo("unit-1"), { target: { value: "m³" } });
    fireEvent.click(screen.getByRole("button", { name: /Enviar requisición/i }));

    await waitFor(() => expect(campo("description-1")).toHaveAttribute("aria-invalid", "true"));
    expect(campo("description-0")).not.toHaveAttribute("aria-invalid", "true");
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("quitar un ítem se lleva su error, no lo hereda el que ocupa su lugar", async () => {
    // Los índices no son identidades: si los errores no se recorren con las líneas, quitar el ítem 1
    // deja el aviso rojo sobre el 2 —que nadie ha tocado— y el formulario acusa de lo que no es.
    await llegarAlPaso2();
    fireEvent.click(screen.getByRole("button", { name: /Agregar otro ítem/i }));
    llenarItem(1, { descripcion: "Arena de río", cantidad: "3", unidad: "m³" });
    fireEvent.click(screen.getByRole("button", { name: /Enviar requisición/i }));
    await waitFor(() => expect(campo("description-0")).toHaveAttribute("aria-invalid", "true"));

    fireEvent.click(screen.getAllByRole("button", { name: /Quitar/i })[0]);
    await waitFor(() => expect(campo("description-0")).toHaveValue("Arena de río"));
    expect(campo("description-0")).not.toHaveAttribute("aria-invalid", "true");
  });

  it("con un solo ítem no se puede quitar: sin ítems no hay requisición", async () => {
    // El esquema exige `items.min(1)`; un paso 2 vacío daría 202 neutro sin requisición, que es el
    // peor final posible porque parece que sí se envió.
    await llegarAlPaso2();
    expect(screen.queryByRole("button", { name: /Quitar/i })).toBeNull();
  });

  it("la unidad se escribe, no se elige de una lista cerrada", async () => {
    // Ernesto: «las unidades no son un desplegable». El `datalist` sugiere las habituales y deja
    // escribir "cuñete" a quien lo necesite; un `select` habría dejado ese pedido sin unidad.
    await llegarAlPaso2();
    expect(campo("unit-0").tagName).toBe("INPUT");
    expect(campo("unit-0")).toHaveAttribute("list", "portal-unidades");
    expect(document.querySelectorAll("#portal-unidades option").length).toBeGreaterThan(0);

    llenarItem(0, { descripcion: "Sellante", cantidad: "2", unidad: "cuñete" });
    fireEvent.click(screen.getByRole("button", { name: /Enviar requisición/i }));
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body)).items[0].unit).toBe("cuñete");
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

    campo("access-code").value = "clave-1234";
    fireEvent.click(screen.getByRole("button", { name: /Continuar/i }));

    expect(await screen.findByText(/¿Para quién y cuándo\?/i)).toBeInTheDocument();
  });

  it("y ese valor llega al envío, no uno vacío", async () => {
    // No basta con que la compuerta se abra: la contraseña viaja en el cuerpo del POST y el servidor
    // la valida. Si se hubiera perdido, el portal respondería 202 neutro y la requisición no se
    // crearía — el fallo más caro de todos, porque no se ve por ninguna parte.
    render(<PublicRequestScreen demoMode={false} publicConfigured />);
    await waitFor(() => expect(screen.getByText(/Pide lo que tu obra necesita/i)).toBeInTheDocument());
    campo("access-code").value = "clave-1234";
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
    expect(campo("access-code").value).toBe("clave-1234");
  });
});

// Reunión 2026-08-31 y recordatorio de Ernesto el 11-sep-2026: «en el formulario público aparece
// seleccionar obra y ya dijimos era empresa». La obra es el centro de costo y la asigna el revisor,
// que es quien sabe a qué contrato cargar el gasto; el Flow de WhatsApp ya funcionaba así.
describe("portal público unificado — ruta general, se elige EMPRESA", () => {
  beforeEach(() => {
    // Sin `obra` en el fragmento: la ruta es general y la empresa se elige en el formulario.
    setHash({ token });
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      String(url) === "/api/public/companies"
        ? { ok: true, status: 200, json: async () => ({ companies: [{ id: societyId, name: "Constructora Mizar S.A.S." }] }) }
        : { status: 202, json: async () => ({ accepted: true }) }));
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.location.hash = ""; });

  it("pide la lista de empresas CON LA CONTRASEÑA y la ofrece en el selector", async () => {
    // La lista se pide con la contraseña, no con el token: la compuerta ya la exigió y es lo único
    // que /api/public/companies acepta. Por eso el efecto espera a haber pasado la compuerta.
    render(<PublicRequestScreen demoMode={false} publicConfigured />);
    await pasarCompuerta();
    await waitFor(() => expect(screen.getByRole("option", { name: "Constructora Mizar S.A.S." })).toBeInTheDocument());
    const llamada = vi.mocked(fetch).mock.calls.find(([url]) => String(url) === "/api/public/companies");
    expect(llamada?.[1]?.method).toBe("POST");
    expect(JSON.parse(String(llamada?.[1]?.body)).code).toBe("clave-1234");
  });

  it("ya no hay selector de obra en el formulario", async () => {
    // La obra la asigna el revisor. Dejar el selector viejo haría que el solicitante eligiera el
    // centro de costo, que es justo lo que la reunión quitó de su lado.
    render(<PublicRequestScreen demoMode={false} publicConfigured />);
    await pasarCompuerta();
    await screen.findByRole("option", { name: "Constructora Mizar S.A.S." });
    expect(document.querySelector('select[name="work"]')).toBeNull();
    expect(screen.getByText(/La obra la asigna quien revisa/i)).toBeInTheDocument();
  });

  it("no deja continuar sin elegir empresa, y al elegirla manda societyId (no workId)", async () => {
    render(<PublicRequestScreen demoMode={false} publicConfigured />);
    await pasarCompuerta();
    await screen.findByRole("option", { name: "Constructora Mizar S.A.S." });
    fireEvent.change(campo("requestor"), { target: { value: "Ana Solicitante" } });
    fireEvent.click(screen.getByRole("button", { name: /Continuar a material/i }));
    expect(await screen.findByText("Selecciona la empresa.")).toBeInTheDocument();

    fireEvent.change(document.querySelector('select[name="company"]') as HTMLSelectElement, { target: { value: societyId } });
    await rellenarYEnviar();
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url) === "/api/public/requisitions")).toBe(true));
    const envio = vi.mocked(fetch).mock.calls.find(([url]) => String(url) === "/api/public/requisitions");
    const body = JSON.parse(String(envio?.[1]?.body));
    expect(body.societyId).toBe(societyId);
    expect(body).not.toHaveProperty("workId");
  });
});

describe("portal público unificado — enlace inválido", () => {
  afterEach(() => { cleanup(); window.location.hash = ""; });

  it("SIN fragmento la ruta abre la compuerta: es pública", async () => {
    // Decisión de Ernesto (2026-09-11): «que el enlace no necesite un token, sea ruta pública».
    // Entrar a /requisiciones/publica a secas tiene que llevar a la contraseña, no al aviso.
    window.location.hash = "";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ companies: [] }) }));
    render(<PublicRequestScreen demoMode={false} publicConfigured />);
    await waitFor(() => expect(screen.getByText(/Pide lo que tu obra necesita/i)).toBeInTheDocument());
    expect(screen.queryByText(/Este enlace no está habilitado/i)).not.toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it("un fragmento MAL FORMADO sí se rechaza, en vez de degradarse a acceso libre", async () => {
    // La distinción importa: "sin enlace" es entrada normal, pero un enlace roto es un error de quien
    // lo repartió. Tratarlo como acceso libre escondería ese error.
    setHash({ obra: workId, token: "no-son-64-hex" });
    render(<PublicRequestScreen demoMode={false} publicConfigured />);
    await waitFor(() => expect(screen.getByText(/Este enlace no está habilitado/i)).toBeInTheDocument());
  });

  it("el fragmento SE QUEDA en la URL, para que recargar no rompa el enlace", async () => {
    // Ernesto recargó la página y le salió "Este enlace no está habilitado": el portal borraba el
    // fragmento con `history.replaceState` nada más leerlo, así que al recargar ya no quedaba token.
    // Lo mismo pasaba con "atrás" y con guardar en favoritos — justo lo que hace quien se queda a
    // medias y vuelve luego.
    //
    // La precaución estaba mal dirigida: lo que nunca puede ir en la URL es la CONTRASEÑA, y nunca
    // ha ido. El token ES el enlace que se reparte.
    setHash({ obra: workId, token });
    const { unmount } = render(<PublicRequestScreen demoMode={false} publicConfigured />);
    await waitFor(() => expect(screen.getByText(/Pide lo que tu obra necesita/i)).toBeInTheDocument());
    expect(window.location.hash).toContain(token);

    // Segundo montaje = recargar: con el fragmento intacto, vuelve a la compuerta y no al aviso.
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
