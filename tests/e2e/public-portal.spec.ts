import { expect, test } from "@playwright/test";

// Portal público UNIFICADO (2026-09-11). Antes había dos formularios con dos URLs y dos specs
// (`public-portal.spec.ts` para escritorio y `public-portal-mobile.spec.ts` para móvil). Ahora es
// una sola pantalla responsive sobre la base móvil, así que también es un solo spec: el recorrido se
// corre en los DOS proyectos de Playwright —desktop y mobile— que es justamente lo que la
// unificación tenía que demostrar. Lo único acotado al proyecto móvil es la ergonomía táctil.
test.describe("portal público de requisiciones", () => {
  test("no muestra shell interno y exige contraseña y teléfono antes del formulario", async ({ page }) => {
    await page.goto("/requisiciones/publica");

    await expect(page.locator(".app-shell")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Pide lo que tu obra necesita." })).toBeVisible();

    await page.getByRole("button", { name: "Continuar" }).click();
    await expect(page.locator("#portal-access-error")).toContainText("Ingresa la contraseña del portal");

    await page.getByLabel("Contraseña del portal").fill("MIZAR-PRADERA");
    await page.getByLabel("Teléfono autorizado").fill("300 555 0101");
    await page.getByRole("button", { name: "Continuar" }).click();
    await expect(page.getByRole("heading", { name: "¿Para quién y cuándo?" })).toBeVisible();
  });

  test("mantiene el recorrido de dos pasos y deja claro que el éxito es demostrativo", async ({ page }) => {
    await page.goto("/requisiciones/publica");

    await page.getByLabel("Contraseña del portal").fill("MIZAR-PRADERA");
    await page.getByLabel("Teléfono autorizado").fill("300 555 0101");
    await page.getByRole("button", { name: "Continuar" }).click();
    await expect(page.getByRole("heading", { name: "¿Para quién y cuándo?" })).toBeVisible();
    await expect(page.getByRole("list", { name: "Avance de la requisición" })).toBeVisible();

    await page.locator('select[name="work"]').selectOption({ label: "Altos de La Pradera" });
    await page.getByLabel("Tu nombre").fill("Usuario QA");
    await page.getByRole("button", { name: "Continuar a material" }).click();
    await expect(page.getByRole("heading", { name: "¿Qué material necesitas?" })).toBeVisible();

    await page.getByLabel("Material").selectOption({ label: "Cemento gris uso general" });
    await page.getByRole("button", { name: "Enviar requisición" }).click();
    await expect(page.getByRole("heading", { name: "Recorrido completado." })).toBeVisible();
    await expect(page.getByText("REQ-DEMO-0148")).toBeVisible();
    await expect(page.getByText("Modo demostración")).toBeVisible();
    await expect(page.locator(".app-shell")).toHaveCount(0);
  });

  test("no desborda horizontalmente, ni en escritorio ni en móvil", async ({ page }) => {
    // Se corre en los dos proyectos a propósito: la promesa de la unificación es que la MISMA
    // pantalla sirva en las dos anchuras, y el desbordamiento es la forma más barata de detectar
    // que una de las dos se rompió.
    await page.goto("/requisiciones/publica");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test("a 390 por 844 los controles táctiles son de al menos 48 px", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "La inspección de tamaño corresponde al proyecto móvil.");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/requisiciones/publica");

    const layout = await page.evaluate(() => ({ viewport: window.innerWidth, documentWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth }));
    expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewport);
    expect(layout.bodyWidth).toBeLessThanOrEqual(layout.viewport);

    const expectTouchTarget = async (locator: ReturnType<typeof page.getByLabel>) => {
      const box = await locator.boundingBox();
      expect(box, "el control debe estar visible").not.toBeNull();
      expect(box!.height).toBeGreaterThanOrEqual(48);
    };

    for (const locator of [page.getByLabel("Contraseña del portal"), page.getByLabel("Teléfono autorizado"), page.getByRole("button", { name: "Continuar" })]) {
      await expectTouchTarget(locator);
    }

    await page.getByLabel("Contraseña del portal").focus();
    const focusStyle = await page.getByLabel("Contraseña del portal").evaluate((element) => getComputedStyle(element).outlineStyle);
    expect(focusStyle).not.toBe("none");

    await page.getByLabel("Contraseña del portal").fill("MIZAR-PRADERA");
    await page.getByLabel("Teléfono autorizado").fill("300 555 0101");
    await page.getByRole("button", { name: "Continuar" }).click();
    for (const locator of [page.getByLabel("Obra"), page.getByLabel("Fecha requerida"), page.getByLabel("Tu nombre"), page.getByRole("button", { name: "Continuar a material" })]) {
      await expectTouchTarget(locator);
    }

    await page.getByLabel("Obra").selectOption({ label: "Altos de La Pradera" });
    await page.getByLabel("Tu nombre").fill("Usuario QA móvil");
    await page.getByRole("button", { name: "Continuar a material" }).click();
    for (const locator of [page.getByLabel("Material"), page.getByLabel("Cantidad"), page.getByLabel("Unidad"), page.getByRole("button", { name: "Agregar una nota o foto" }), page.getByRole("button", { name: "Enviar requisición" })]) {
      await expectTouchTarget(locator);
    }
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
