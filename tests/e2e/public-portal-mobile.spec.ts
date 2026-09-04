import { expect, test } from "@playwright/test";

test.describe("versión móvil del portal público de requisiciones", () => {
  test("mantiene un recorrido simple de dos pasos y conserva el modo demostración", async ({ page }) => {
    await page.goto("/requisiciones/publica-movil");

    await expect(page.getByText("Versión móvil")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Pide lo que tu obra necesita." })).toBeVisible();
    await page.getByRole("button", { name: "Continuar" }).click();
    await expect(page.locator("#mobile-access-error")).toContainText("Ingresa el código de obra");

    await page.getByLabel("Código de obra").fill("MIZAR-PRADERA");
    await page.getByLabel("Teléfono autorizado").fill("300 555 0101");
    await page.getByRole("button", { name: "Continuar" }).click();
    await expect(page.getByRole("heading", { name: "¿Para quién y cuándo?" })).toBeVisible();
    await expect(page.getByRole("list", { name: "Avance de la requisición" })).toBeVisible();

    await page.locator('select[name="work"]').selectOption({ label: "Altos de La Pradera" });
    await page.getByLabel("Tu nombre").fill("Usuario QA móvil");
    await page.getByRole("button", { name: "Continuar a material" }).click();
    await expect(page.getByRole("heading", { name: "¿Qué material necesitas?" })).toBeVisible();

    await page.getByLabel("Material").selectOption({ label: "Cemento gris uso general" });
    await page.getByRole("button", { name: "Enviar requisición" }).click();
    await expect(page.getByRole("heading", { name: "Recorrido completado." })).toBeVisible();
    await expect(page.getByText("REQ-DEMO-0148")).toBeVisible();
    await expect(page.getByText("Modo demostración")).toBeVisible();
  });

  test("a 390 por 844 no se desborda y los controles táctiles son de al menos 48 px", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "La inspección de tamaño corresponde al proyecto móvil.");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/requisiciones/publica-movil");

    const layout = await page.evaluate(() => ({ viewport: window.innerWidth, documentWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth }));
    expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewport);
    expect(layout.bodyWidth).toBeLessThanOrEqual(layout.viewport);

    const expectTouchTarget = async (locator: ReturnType<typeof page.getByLabel>) => {
      const box = await locator.boundingBox();
      expect(box, "el control debe estar visible").not.toBeNull();
      expect(box!.height).toBeGreaterThanOrEqual(48);
    };

    for (const locator of [page.getByLabel("Código de obra"), page.getByLabel("Teléfono autorizado"), page.getByRole("button", { name: "Continuar" })]) {
      await expectTouchTarget(locator);
    }

    await page.getByLabel("Código de obra").focus();
    const focusStyle = await page.getByLabel("Código de obra").evaluate((element) => getComputedStyle(element).outlineStyle);
    expect(focusStyle).not.toBe("none");

    await page.getByLabel("Código de obra").fill("MIZAR-PRADERA");
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
});
