import { expect, test, type Page } from "@playwright/test";

// Portal público UNIFICADO (2026-09-11). Antes había dos formularios con dos URLs y dos specs
// (`public-portal.spec.ts` para escritorio y `public-portal-mobile.spec.ts` para móvil). Ahora es
// una sola pantalla responsive sobre la base móvil, así que también es un solo spec: el recorrido se
// corre en los DOS proyectos de Playwright —desktop y mobile— que es justamente lo que la
// unificación tenía que demostrar. Lo único acotado al proyecto móvil es la ergonomía táctil.
//
// El servidor se levanta con NEXT_PUBLIC_DEMO_MODE=true (playwright.config.ts), así que lo que
// recorre el navegador es la pantalla de demostración. Va a la par del formulario real a propósito
// —comparten estado, validación y el bloque de ítems—, y por eso estos recorridos sí prueban los
// cuatro cambios que Ernesto pidió el 11-sep-2026: empresa en vez de obra, teléfono opcional, varios
// ítems y unidad de texto libre.

/**
 * Abre el portal y teclea INMEDIATAMENTE, sin esperar a nada.
 *
 * Esto es la prueba del arreglo de la compuerta, no una comodidad. Cuando los campos eran
 * controlados, un `fill()` justo después de `goto()` escribía en el DOM previo a la hidratación y el
 * primer render de cliente lo descartaba: el recorrido moría dos pasos más adelante, en un sitio que
 * no tenía nada que ver. Traducido a la obra, el maestro que abre el enlace y teclea sin esperar
 * entraba media contraseña y recibía un error incomprensible.
 *
 * Con la compuerta no controlada, lo tecleado se conserva y esto pasa sin ninguna espera previa. Si
 * alguien vuelve a hacerla controlada, este recorrido falla — que es justo lo que queremos.
 */
async function abrirPortalHidratado(page: Page) {
  await page.goto("/requisiciones/publica");
}

async function pasarCompuerta(page: Page) {
  await page.getByLabel("Contraseña del portal").fill("MIZAR-PRADERA");
  await page.getByRole("button", { name: "Continuar" }).click();
}

/**
 * Paso 1: EMPRESA y nombre. El teléfono se deja vacío a propósito — es opcional desde 2026-09-11, y
 * el recorrido normal tiene que pasar sin él.
 */
async function pasarDatos(page: Page, nombre: string, { telefono = "" }: { telefono?: string } = {}) {
  await page.locator('select[name="company"]').selectOption({ label: "Ictinos" });
  if (telefono) await page.getByLabel("Tu teléfono").fill(telefono);
  await page.getByLabel("Tu nombre").fill(nombre);
  await page.getByRole("button", { name: "Continuar a material" }).click();
}

/** Llena el ítem `indice` del paso 2. Los campos llevan el índice desde que se puede pedir varios. */
async function llenarItem(page: Page, indice: number, descripcion: string, cantidad: string, unidad: string) {
  await page.locator(`[name="description-${indice}"]`).fill(descripcion);
  await page.locator(`[name="quantity-${indice}"]`).fill(cantidad);
  await page.locator(`[name="unit-${indice}"]`).fill(unidad);
}

test.describe("portal público de requisiciones", () => {
  test("no muestra shell interno y exige SOLO la contraseña antes del formulario", async ({ page }) => {
    await page.goto("/requisiciones/publica");

    await expect(page.locator(".app-shell")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Pide lo que tu obra necesita." })).toBeVisible();

    await page.getByRole("button", { name: "Continuar" }).click();
    await expect(page.locator("#portal-access-error")).toContainText("Escribe la contraseña del portal");
    await expect(page.getByLabel("Teléfono autorizado")).toHaveCount(0);

    await pasarCompuerta(page);
    await expect(page.getByRole("heading", { name: "¿Para quién y cuándo?" })).toBeVisible();
  });

  test("mantiene el recorrido de dos pasos y deja claro que el éxito es demostrativo", async ({ page }) => {
    await abrirPortalHidratado(page);
    await pasarCompuerta(page);

    await expect(page.getByRole("heading", { name: "¿Para quién y cuándo?" })).toBeVisible();
    await expect(page.getByRole("list", { name: "Avance de la requisición" })).toBeVisible();

    await pasarDatos(page, "Usuario QA");
    await expect(page.getByRole("heading", { name: "Describe lo que necesitas." })).toBeVisible();

    await llenarItem(page, 0, "Cemento gris uso general", "20", "bulto");
    await page.getByRole("button", { name: "Enviar requisición" }).click();
    await expect(page.getByRole("heading", { name: "Recorrido completado." })).toBeVisible();
    await expect(page.getByText("REQ-DEMO-0148")).toBeVisible();
    await expect(page.getByText("Modo demostración")).toBeVisible();
    await expect(page.locator(".app-shell")).toHaveCount(0);
  });

  test("se elige EMPRESA, no obra", async ({ page }) => {
    // Reunión 2026-08-31 y recordatorio de Ernesto el 11-sep-2026: «en el formulario público aparece
    // seleccionar obra y ya dijimos era empresa». La obra es el centro de costo y la asigna el
    // revisor, que es quien sabe a qué contrato cargar el gasto.
    await abrirPortalHidratado(page);
    await pasarCompuerta(page);

    await expect(page.locator('select[name="work"]')).toHaveCount(0);
    await expect(page.locator('select[name="company"]')).toBeVisible();
    await expect(page.getByText("La obra la asigna quien revisa tu solicitud.")).toBeVisible();

    await page.getByLabel("Tu nombre").fill("Usuario QA");
    await page.getByRole("button", { name: "Continuar a material" }).click();
    await expect(page.locator("#portal-company-error")).toContainText("Selecciona la empresa.");
  });

  test("el teléfono es opcional, pero uno a medias no pasa", async ({ page }) => {
    // Ernesto, 11-sep-2026: «el teléfono no lo hagas obligatorio». Quien no lo da se queda sin acuse
    // por WhatsApp; lo que no puede es quedarse sin radicar. Un número incompleto sí se rechaza: el
    // aviso se encolaría contra alguien que no existe y nadie se enteraría de que no llegó.
    await abrirPortalHidratado(page);
    await pasarCompuerta(page);

    await expect(page.getByLabel("Tu teléfono")).toBeVisible();
    await page.locator('select[name="company"]').selectOption({ label: "Ictinos" });
    await page.getByLabel("Tu nombre").fill("Usuario QA");
    await page.getByLabel("Tu teléfono").fill("300");
    await page.getByRole("button", { name: "Continuar a material" }).click();
    await expect(page.locator("#portal-phone-error")).toContainText("incompleto");

    // Vaciarlo del todo sí deja seguir: eso es lo que significa opcional.
    await page.getByLabel("Tu teléfono").fill("");
    await page.getByRole("button", { name: "Continuar a material" }).click();
    await expect(page.getByRole("heading", { name: "Describe lo que necesitas." })).toBeVisible();
  });

  test("se pueden pedir varios ítems en una sola requisición, y quitar los que sobren", async ({ page }) => {
    // Ernesto: «solo dejas agregar un ítem por form, debe permitir ir agregando más». Quien
    // necesitaba cemento, arena y varilla radicaba tres requisiciones, y el revisor recibía tres
    // pedidos que en la obra eran uno.
    await abrirPortalHidratado(page);
    await pasarCompuerta(page);
    await pasarDatos(page, "Usuario QA");

    // Con un solo ítem no hay nada que quitar: sin ítems no habría requisición.
    await expect(page.getByRole("button", { name: "Quitar" })).toHaveCount(0);

    await llenarItem(page, 0, "Cemento gris", "20", "bulto");
    await page.getByRole("button", { name: "Agregar otro ítem" }).click();
    await llenarItem(page, 1, "Arena de río", "3", "m³");
    await page.getByRole("button", { name: "Agregar otro ítem" }).click();
    await llenarItem(page, 2, "Varilla 1/2", "40", "und");
    await expect(page.locator("fieldset legend", { hasText: "Ítem" })).toHaveCount(3);

    await page.getByRole("button", { name: "Quitar" }).nth(1).click();
    await expect(page.locator("fieldset legend", { hasText: "Ítem" })).toHaveCount(2);
    // El que ocupa el hueco es el TERCERO, con su contenido intacto: los campos son controlados y el
    // valor lo pone el estado, no el DOM que dejó el que se fue.
    await expect(page.locator('[name="description-1"]')).toHaveValue("Varilla 1/2");

    await page.getByRole("button", { name: "Enviar requisición" }).click();
    await expect(page.getByRole("heading", { name: "Recorrido completado." })).toBeVisible();
  });

  test("la unidad se escribe libre, con sugerencias que no restringen", async ({ page }) => {
    // Ernesto: «las unidades no son un desplegable». El `datalist` sugiere las habituales y deja
    // escribir "cuñete" a quien lo necesite; un `select` habría dejado ese pedido sin unidad.
    await abrirPortalHidratado(page);
    await pasarCompuerta(page);
    await pasarDatos(page, "Usuario QA");

    const unidad = page.locator('[name="unit-0"]');
    await expect(unidad).toHaveAttribute("list", "portal-unidades");
    await expect(page.locator("#portal-unidades option").first()).toHaveCount(1);
    await llenarItem(page, 0, "Sellante de poliuretano", "2", "cuñete");
    await expect(unidad).toHaveValue("cuñete");

    await page.getByRole("button", { name: "Enviar requisición" }).click();
    await expect(page.getByRole("heading", { name: "Recorrido completado." })).toBeVisible();
  });

  test("no desborda horizontalmente, ni en escritorio ni en móvil", async ({ page }) => {
    // Se corre en los dos proyectos a propósito: la promesa de la unificación es que la MISMA
    // pantalla sirva en las dos anchuras, y el desbordamiento es la forma más barata de detectar
    // que una de las dos se rompió.
    await page.goto("/requisiciones/publica");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test("con tres ítems tampoco desborda: es donde el paso 2 se hace largo", async ({ page }) => {
    await abrirPortalHidratado(page);
    await pasarCompuerta(page);
    await pasarDatos(page, "Usuario QA");
    await llenarItem(page, 0, "Cemento gris", "20", "bulto");
    await page.getByRole("button", { name: "Agregar otro ítem" }).click();
    await page.getByRole("button", { name: "Agregar otro ítem" }).click();

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test("a 390 por 844 los controles táctiles son de al menos 48 px", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "La inspección de tamaño corresponde al proyecto móvil.");
    await page.setViewportSize({ width: 390, height: 844 });
    await abrirPortalHidratado(page);

    const layout = await page.evaluate(() => ({ viewport: window.innerWidth, documentWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth }));
    expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewport);
    expect(layout.bodyWidth).toBeLessThanOrEqual(layout.viewport);

    const expectTouchTarget = async (locator: ReturnType<typeof page.getByLabel>) => {
      const box = await locator.boundingBox();
      expect(box, "el control debe estar visible").not.toBeNull();
      expect(box!.height).toBeGreaterThanOrEqual(48);
    };

    for (const locator of [page.getByLabel("Contraseña del portal"), page.getByRole("button", { name: "Continuar" })]) {
      await expectTouchTarget(locator);
    }

    await page.getByLabel("Contraseña del portal").focus();
    const focusStyle = await page.getByLabel("Contraseña del portal").evaluate((element) => getComputedStyle(element).outlineStyle);
    expect(focusStyle).not.toBe("none");

    await pasarCompuerta(page);
    for (const locator of [page.getByLabel("Empresa"), page.getByLabel("Fecha requerida"), page.getByLabel("Tu teléfono"), page.getByLabel("Tu nombre"), page.getByRole("button", { name: "Continuar a material" })]) {
      await expectTouchTarget(locator);
    }

    await pasarDatos(page, "Usuario QA móvil");
    // "Agregar otro ítem" entra en la lista: es un control nuevo y de los que más se pulsan en el
    // móvil, que es donde se radica de verdad.
    for (const locator of [page.locator('[name="description-0"]'), page.locator('[name="quantity-0"]'), page.locator('[name="unit-0"]'), page.getByRole("button", { name: "Agregar detalles" }), page.getByRole("button", { name: "Agregar otro ítem" }), page.getByRole("button", { name: "Enviar requisición" })]) {
      await expectTouchTarget(locator);
    }

    // Y con dos ítems, el botón de quitar también tiene que ser pulsable con el pulgar.
    await page.getByRole("button", { name: "Agregar otro ítem" }).click();
    const quitar = await page.getByRole("button", { name: "Quitar" }).first().boundingBox();
    expect(quitar).not.toBeNull();
    expect(quitar!.height).toBeGreaterThanOrEqual(32);
  });

  test("recargar con el enlace abierto NO rompe el acceso", async ({ page }) => {
    // Ernesto recargó y le salió "Este enlace no está habilitado": el portal borraba el fragmento de
    // la barra nada más leerlo, así que al recargar ya no quedaba token. Roto también "atrás" y
    // guardar en favoritos, que es lo que hace quien se queda a medias y vuelve luego.
    const fragmento = "#obra=11111111-1111-4111-8111-111111111111&token=" + "a".repeat(64);
    await page.goto(`/requisiciones/publica${fragmento}`);
    await expect(page.getByRole("heading", { name: "Pide lo que tu obra necesita." })).toBeVisible();
    expect(page.url()).toContain(fragmento);

    await page.reload();
    await expect(page.getByRole("heading", { name: "Pide lo que tu obra necesita." })).toBeVisible();
    await expect(page.getByText("Este enlace no está habilitado")).toHaveCount(0);
  });

  test("la URL móvil heredada sigue viva y reenvía conservando el fragmento", async ({ page }) => {
    // El archivo de enlaces que se repartió lleva las dos URLs. El reenvío es de cliente porque el
    // fragmento nunca viaja al servidor: uno de servidor llegaría sin token y el portal diría
    // "este enlace no está habilitado", rompiendo en silencio lo ya repartido.
    const fragmento = "#obra=11111111-1111-4111-8111-111111111111&token=" + "a".repeat(64);
    await page.goto(`/requisiciones/publica-movil${fragmento}`);
    await page.waitForURL((url) => url.pathname === "/requisiciones/publica");
    expect(page.url()).toContain(fragmento);
  });
});
