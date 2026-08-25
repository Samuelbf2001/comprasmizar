import { expect, test } from "@playwright/test";

test.describe("catálogo de proveedores", () => {
  test("recorre directorio, ficha, bancos, documentos e historial", async ({ page }) => {
    await page.goto("/proveedores");
    await expect(page.getByRole("heading", { name: "Proveedores" })).toBeVisible();
    await expect(page.getByText("El listado nunca expone datos bancarios.")).toBeVisible();

    await page.getByRole("button", { name: /Abrir ficha de Cementos del Oriente/i }).click();
    await expect(page.getByRole("dialog", { name: /Cementos del Oriente/i })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Datos bancarios" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Documentos" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Historial de órdenes" })).toBeVisible();
    await expect(page.getByText("Total comprado")).toBeVisible();
    await page.getByRole("button", { name: "Cerrar ficha" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("permite alta y mantiene la interfaz usable en móvil", async ({ page }, testInfo) => {
    await page.goto("/proveedores");
    await page.getByRole("button", { name: "Nuevo proveedor" }).click();
    await expect(page.getByRole("dialog", { name: "Nuevo proveedor" })).toBeVisible();
    await page.getByRole("textbox", { name: "Razón social" }).fill("Proveedor E2E Mizar");
    await page.getByRole("button", { name: "Crear proveedor" }).click();
    await expect(page.getByRole("status")).toContainText("Proveedor creado correctamente");
    await expect(page.getByText("Proveedor E2E Mizar")).toBeVisible();

    if (testInfo.project.name === "mobile") {
      const documentOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(documentOverflow).toBeLessThanOrEqual(1);
    }
  });
});
