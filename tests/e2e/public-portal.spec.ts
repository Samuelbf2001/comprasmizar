import { expect, test, type Page } from "@playwright/test";

// Portal público GUIADO (11-sep-2026). Ernesto pidió que se pareciera al Flow de WhatsApp que ya le
// gusta al cliente (`integrations/whatsapp-flow/requisicion-captura.flow.json`): pantallas cortas,
// una cosa a la vez, un artículo por pantalla con "Agregar otro artículo" / "Ir al resumen", y un
// RESUMEN antes de enviar. No es una copia del Flow pantalla por pantalla —aquí "Tus datos" tiene su
// propio momento, distinto del Flow—, pero la idea es la misma: nunca más de una decisión por
// pantalla.
//
// El recorrido, de principio a fin: "¿Qué vas a solicitar?" (tipo + empresa) → "Tus datos" (nombre +
// teléfono opcional) → un artículo por pantalla → "¿Para cuándo?" (fecha + observaciones) →
// "Resumen" (todo lo capturado, empresa por NOMBRE, artículos numerados) → "Enviar solicitud".
//
// El recorrido se corre en los DOS proyectos de Playwright —desktop y mobile—, que es justamente lo
// que la unificación anterior tenía que demostrar y este cambio no toca: sigue siendo una sola
// pantalla responsive. Lo único acotado al proyecto móvil es la ergonomía táctil.
//
// El servidor se levanta con NEXT_PUBLIC_DEMO_MODE=true (playwright.config.ts), así que lo que
// recorre el navegador es la pantalla de demostración. Va a la par del formulario real a propósito
// —comparten el mismo `AsistenteFormulario`, estado y validación—, y por eso estos recorridos
// prueban el mismo asistente guiado que existe en el portal real.

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

/** Pantalla "¿Qué vas a solicitar?": tipo (ya trae "Compra de material" por defecto) y empresa. */
async function pasarTipoYEmpresa(page: Page, { empresa = "Ictinos" }: { empresa?: string } = {}) {
  await page.locator('select[name="company"]').selectOption({ label: empresa });
  await page.getByRole("button", { name: "Continuar", exact: true }).click();
}

/** Pantalla "Tus datos": nombre y teléfono opcional. El teléfono se deja vacío a propósito — es
 *  opcional desde 2026-09-11, y el recorrido normal tiene que pasar sin él. */
async function pasarDatos(page: Page, nombre: string, { telefono = "" }: { telefono?: string } = {}) {
  if (telefono) await page.getByLabel("Tu teléfono").fill(telefono);
  await page.getByLabel("Tu nombre").fill(nombre);
  await page.getByRole("button", { name: "Continuar a material" }).click();
}

/** Llena el artículo `indice`, que ocupa su propia pantalla. */
async function llenarItem(page: Page, indice: number, descripcion: string, cantidad: string, unidad: string) {
  await page.locator(`[name="description-${indice}"]`).fill(descripcion);
  await page.locator(`[name="quantity-${indice}"]`).fill(cantidad);
  await page.locator(`[name="unit-${indice}"]`).fill(unidad);
}

/** Del artículo en pantalla hasta el resumen, con un solo artículo. El botón dice "Ir al resumen"
 *  pero la pantalla que sigue es "¿Para cuándo?" — la última pregunta antes del resumen de verdad. */
async function irAlResumen(page: Page) {
  await page.getByRole("button", { name: "Ir al resumen" }).click();
  await expect(page.getByRole("heading", { name: "¿Para cuándo?" })).toBeVisible();
  await page.getByRole("button", { name: "Ver resumen" }).click();
  await expect(page.getByRole("heading", { name: "Resumen" })).toBeVisible();
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
    await expect(page.getByRole("heading", { name: "¿Qué vas a solicitar?" })).toBeVisible();
  });

  test("recorre las cinco pantallas del asistente y deja claro que el éxito es demostrativo", async ({ page }) => {
    await abrirPortalHidratado(page);
    await pasarCompuerta(page);

    await expect(page.getByRole("heading", { name: "¿Qué vas a solicitar?" })).toBeVisible();
    await expect(page.getByRole("list", { name: "Avance de la requisición" })).toBeVisible();
    await pasarTipoYEmpresa(page);

    await expect(page.getByRole("heading", { name: "Tus datos" })).toBeVisible();
    await pasarDatos(page, "Usuario QA");

    await expect(page.getByRole("heading", { name: "Artículo 1" })).toBeVisible();
    await llenarItem(page, 0, "Cemento gris uso general", "20", "bulto");
    await irAlResumen(page);

    // El resumen muestra la empresa por NOMBRE y el artículo numerado con cantidad y unidad. Se busca en
    // el resumen (`dd`) porque la cabecera «Acceso para:» también la nombra desde QA H14.
    await expect(page.locator("dd").filter({ hasText: "Ictinos" })).toBeVisible();
    await expect(page.getByText("1. Cemento gris uso general")).toBeVisible();
    await expect(page.getByText("20 bulto")).toBeVisible();

    await page.getByRole("button", { name: "Enviar solicitud" }).click();
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

    await page.getByRole("button", { name: "Continuar", exact: true }).click();
    await expect(page.locator("#portal-company-error")).toContainText("Selecciona la empresa.");
  });

  test("el teléfono es opcional, pero uno a medias no pasa", async ({ page }) => {
    // Ernesto, 11-sep-2026: «el teléfono no lo hagas obligatorio». Quien no lo da se queda sin acuse
    // por WhatsApp; lo que no puede es quedarse sin radicar. Un número incompleto sí se rechaza: el
    // aviso se encolaría contra alguien que no existe y nadie se enteraría de que no llegó.
    await abrirPortalHidratado(page);
    await pasarCompuerta(page);
    await pasarTipoYEmpresa(page);

    await expect(page.getByLabel("Tu teléfono")).toBeVisible();
    await page.getByLabel("Tu nombre").fill("Usuario QA");
    await page.getByLabel("Tu teléfono").fill("300");
    await page.getByRole("button", { name: "Continuar a material" }).click();
    await expect(page.locator("#portal-phone-error")).toContainText("incompleto");

    // Vaciarlo del todo sí deja seguir: eso es lo que significa opcional.
    await page.getByLabel("Tu teléfono").fill("");
    await page.getByRole("button", { name: "Continuar a material" }).click();
    await expect(page.getByRole("heading", { name: "Artículo 1" })).toBeVisible();
  });

  test("se pueden pedir varios artículos, volver atrás sin perderlos y quitar uno desde el resumen", async ({ page }) => {
    // Ernesto: «solo dejas agregar un ítem por form, debe permitir ir agregando más». Quien
    // necesitaba cemento, arena y varilla radicaba tres requisiciones, y el revisor recibía tres
    // pedidos que en la obra eran uno.
    await abrirPortalHidratado(page);
    await pasarCompuerta(page);
    await pasarTipoYEmpresa(page);
    await pasarDatos(page, "Usuario QA");

    await llenarItem(page, 0, "Cemento gris", "20", "bulto");
    await page.getByRole("button", { name: "Agregar otro artículo" }).click();
    await expect(page.getByRole("heading", { name: "Artículo 2" })).toBeVisible();
    await llenarItem(page, 1, "Arena de río", "3", "m³");
    await page.getByRole("button", { name: "Agregar otro artículo" }).click();
    await expect(page.getByRole("heading", { name: "Artículo 3" })).toBeVisible();
    await llenarItem(page, 2, "Varilla 1/2", "40", "und");

    // "Atrás" vuelve al artículo anterior, con lo ya escrito intacto — no se pierde por navegar.
    await page.getByRole("button", { name: "Atrás" }).click();
    await expect(page.getByRole("heading", { name: "Artículo 2" })).toBeVisible();
    await expect(page.locator('[name="description-1"]')).toHaveValue("Arena de río");

    await irAlResumen(page);
    await expect(page.getByText("1. Cemento gris")).toBeVisible();
    await expect(page.getByText("2. Arena de río")).toBeVisible();
    await expect(page.getByText("3. Varilla 1/2")).toBeVisible();

    await page.getByRole("button", { name: "Quitar" }).nth(1).click();
    await expect(page.getByText("Arena de río")).toHaveCount(0);
    // El que ocupa el número 2 ahora es Varilla, con su contenido intacto.
    await expect(page.getByText("2. Varilla 1/2")).toBeVisible();

    await page.getByRole("button", { name: "Enviar solicitud" }).click();
    await expect(page.getByRole("heading", { name: "Recorrido completado." })).toBeVisible();
  });

  // RF portal-fotos-articulo: UNA foto opcional por artículo, calcada del `PhotoPicker` del Flow de
  // WhatsApp. Corre en los DOS proyectos (desktop y mobile) como el resto de este archivo — la
  // demostración es cliente puro, así que esto prueba selección, vista previa y miniatura en el
  // resumen sin depender de ningún backend.
  test("se elige una foto opcional, se ve su vista previa y llega hasta el resumen", async ({ page }) => {
    // PNG 1x1 real y mínimo — mismos bytes que validaría el servidor de verdad (ver
    // tests/integration/public-photos.test.ts), aunque aquí (modo demo) nadie los sube.
    const fotoMinima = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    await abrirPortalHidratado(page);
    await pasarCompuerta(page);
    await pasarTipoYEmpresa(page);
    await pasarDatos(page, "Usuario QA");

    await expect(page.getByText("Agregar una foto")).toBeVisible();
    await page.getByLabel("Foto (opcional)").setInputFiles({ name: "frente-obra.png", mimeType: "image/png", buffer: fotoMinima });
    await expect(page.getByText("frente-obra.png")).toBeVisible();
    await expect(page.locator("img")).toBeVisible();

    await llenarItem(page, 0, "Cemento gris", "20", "bulto");
    await irAlResumen(page);
    // El resumen también muestra la miniatura junto al artículo.
    await expect(page.locator("img")).toBeVisible();

    await page.getByRole("button", { name: "Enviar solicitud" }).click();
    await expect(page.getByRole("heading", { name: "Recorrido completado." })).toBeVisible();
  });

  test("una foto que pesa de más se rechaza con un mensaje claro, sin romper el resto del formulario", async ({ page }) => {
    const grande = Buffer.alloc(6 * 1024 * 1024, 1);
    await abrirPortalHidratado(page);
    await pasarCompuerta(page);
    await pasarTipoYEmpresa(page);
    await pasarDatos(page, "Usuario QA");

    await page.getByLabel("Foto (opcional)").setInputFiles({ name: "grande.jpg", mimeType: "image/jpeg", buffer: grande });
    await expect(page.getByText(/máximo 5 MB/)).toBeVisible();
    await expect(page.getByText("Agregar una foto")).toBeVisible();

    // El resto del artículo sigue funcionando: una foto rechazada no bloquea nada más.
    await llenarItem(page, 0, "Cemento gris", "20", "bulto");
    await irAlResumen(page);
    await page.getByRole("button", { name: "Enviar solicitud" }).click();
    await expect(page.getByRole("heading", { name: "Recorrido completado." })).toBeVisible();
  });

  test("con un solo artículo el resumen no ofrece quitarlo", async ({ page }) => {
    await abrirPortalHidratado(page);
    await pasarCompuerta(page);
    await pasarTipoYEmpresa(page);
    await pasarDatos(page, "Usuario QA");
    await llenarItem(page, 0, "Cemento gris", "20", "bulto");
    await irAlResumen(page);
    await expect(page.getByRole("button", { name: "Quitar" })).toHaveCount(0);
  });

  test("la unidad se escribe libre, con sugerencias que no restringen", async ({ page }) => {
    // Ernesto: «las unidades no son un desplegable». El `datalist` sugiere las habituales y deja
    // escribir "cuñete" a quien lo necesite; un `select` habría dejado ese pedido sin unidad.
    await abrirPortalHidratado(page);
    await pasarCompuerta(page);
    await pasarTipoYEmpresa(page);
    await pasarDatos(page, "Usuario QA");

    const unidad = page.locator('[name="unit-0"]');
    await expect(unidad).toHaveAttribute("list", "portal-unidades");
    await expect(page.locator("#portal-unidades option").first()).toHaveCount(1);
    await llenarItem(page, 0, "Sellante de poliuretano", "2", "cuñete");
    await expect(unidad).toHaveValue("cuñete");

    await irAlResumen(page);
    await page.getByRole("button", { name: "Enviar solicitud" }).click();
    await expect(page.getByRole("heading", { name: "Recorrido completado." })).toBeVisible();
  });

  // RF-108 (adenda de pagos, A12): «Solicitud de pago» abre un camino de TRES pasos —¿Quién cobra?,
  // El pago, Resumen—. Quien radica es el beneficiario (no hay "Tus datos"), la empresa se pide junto
  // al monto (es a la que se cobra) y no hay artículos. Corre en los dos proyectos, como el resto.
  /** Elige «Solicitud de pago» en "¿Qué vas a solicitar?". Espera el encabezado ANTES de pulsar: el
   *  radio va oculto bajo su etiqueta (`.choice`) y se pulsa el texto, como haría el pulgar. */
  async function elegirPago(page: Page) {
    await expect(page.getByRole("heading", { name: "¿Qué vas a solicitar?" })).toBeVisible();
    await page.getByText("Solicitud de pago", { exact: true }).click();
    await expect(page.getByLabel("Solicitud de pago")).toBeChecked();
  }

  test("solicitud de pago: quién cobra, el pago y resumen, y llega al final", async ({ page }) => {
    await abrirPortalHidratado(page);
    await pasarCompuerta(page);
    await elegirPago(page);
    // La empresa ya no está en el primer paso: se pide junto al monto.
    await expect(page.locator('select[name="company"]')).toHaveCount(0);
    await page.getByRole("button", { name: "Continuar", exact: true }).click();

    await expect(page.getByRole("heading", { name: "¿Quién cobra?" })).toBeVisible();
    await page.getByLabel("Tipo de identificación").selectOption("CC");
    await page.getByLabel("Número de identificación").fill("1020304050");
    await page.getByLabel("Nombre completo o razón social").fill("Ana Topógrafa");
    await page.getByRole("button", { name: "Continuar al pago" }).click();

    await expect(page.getByRole("heading", { name: "El pago" })).toBeVisible();
    await page.locator('select[name="company"]').selectOption({ label: "Ictinos" });
    await page.getByLabel("Monto a cobrar").fill("1250000");
    await expect(page.getByText(/Se solicita .*1\.250\.000/)).toBeVisible();
    await page.getByLabel("Concepto").fill("Levantamiento topográfico lote 3");
    await page.getByRole("button", { name: "Ver resumen" }).click();

    await expect(page.getByRole("heading", { name: "Resumen" })).toBeVisible();
    await expect(page.getByText("Ana Topógrafa")).toBeVisible();
    await expect(page.getByText("CC 1020304050")).toBeVisible();
    await expect(page.getByText(/1\.250\.000/)).toBeVisible();
    await expect(page.getByText("Levantamiento topográfico lote 3")).toBeVisible();
    await expect(page.locator("dd").filter({ hasText: "Ictinos" })).toBeVisible();

    await page.getByRole("button", { name: "Enviar solicitud" }).click();
    await expect(page.getByRole("heading", { name: "Recorrido completado." })).toBeVisible();
  });

  test("solicitud de pago: sin identificación no se avanza, y sin monto no hay resumen", async ({ page }) => {
    await abrirPortalHidratado(page);
    await pasarCompuerta(page);
    await elegirPago(page);
    await page.getByRole("button", { name: "Continuar", exact: true }).click();
    await expect(page.getByRole("heading", { name: "¿Quién cobra?" })).toBeVisible();

    await page.getByRole("button", { name: "Continuar al pago" }).click();
    await expect(page.locator("#portal-identification-error")).toContainText("número de identificación");
    await expect(page.locator("#portal-beneficiary-name-error")).toContainText("nombre completo");

    await page.getByLabel("Número de identificación").fill("900123456-7");
    await page.getByLabel("Nombre completo o razón social").fill("Topografía del Valle S.A.S.");
    await page.getByRole("button", { name: "Continuar al pago" }).click();
    await expect(page.getByRole("heading", { name: "El pago" })).toBeVisible();

    await page.locator('select[name="company"]').selectOption({ label: "Ictinos" });
    await page.getByLabel("Concepto").fill("Anticipo topografía");
    await page.getByRole("button", { name: "Ver resumen" }).click();
    await expect(page.locator("#portal-amount-error")).toContainText("monto");
    await expect(page.getByRole("heading", { name: "Resumen" })).toHaveCount(0);
  });

  test("no desborda horizontalmente, ni en escritorio ni en móvil", async ({ page }) => {
    // Se corre en los dos proyectos a propósito: la promesa de la unificación es que la MISMA
    // pantalla sirva en las dos anchuras, y el desbordamiento es la forma más barata de detectar
    // que una de las dos se rompió.
    await page.goto("/requisiciones/publica");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test("con tres artículos, el resumen y el asistente tampoco desbordan", async ({ page }) => {
    // Es donde el indicador de avance de cinco fases y las tarjetas del resumen se hacen largas.
    await abrirPortalHidratado(page);
    await pasarCompuerta(page);
    await pasarTipoYEmpresa(page);
    await pasarDatos(page, "Usuario QA");
    await llenarItem(page, 0, "Cemento gris", "20", "bulto");
    await page.getByRole("button", { name: "Agregar otro artículo" }).click();
    await llenarItem(page, 1, "Arena de río", "3", "m³");
    await page.getByRole("button", { name: "Agregar otro artículo" }).click();
    await llenarItem(page, 2, "Varilla 1/2", "40", "und");
    await irAlResumen(page);

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
    for (const locator of [page.getByLabel("Empresa"), page.getByRole("button", { name: "Continuar", exact: true })]) {
      await expectTouchTarget(locator);
    }
    await pasarTipoYEmpresa(page);

    for (const locator of [page.getByLabel("Tu teléfono"), page.getByLabel("Tu nombre"), page.getByRole("button", { name: "Continuar a material" })]) {
      await expectTouchTarget(locator);
    }
    await pasarDatos(page, "Usuario QA móvil");

    // "Agregar otro artículo" entra en la lista: es un control nuevo y de los que más se pulsan en
    // el móvil, que es donde se radica de verdad.
    for (const locator of [page.locator('[name="description-0"]'), page.locator('[name="quantity-0"]'), page.locator('[name="unit-0"]'), page.getByRole("button", { name: "Agregar detalles" }), page.getByRole("button", { name: "Agregar otro artículo" }), page.getByRole("button", { name: "Ir al resumen" })]) {
      await expectTouchTarget(locator);
    }

    // Y con dos artículos, el botón de "Atrás" también tiene que ser pulsable con el pulgar.
    await page.getByRole("button", { name: "Agregar otro artículo" }).click();
    await expectTouchTarget(page.getByRole("button", { name: "Atrás" }));
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
