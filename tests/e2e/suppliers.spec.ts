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
    // Nombre propio de cada proyecto: "desktop" y "mobile" corren EN PARALELO contra el mismo
    // servidor (fullyParallel), y dos pruebas creando el mismo registro es una trampa latente.
    // AVISO: esto NO arregla la intermitencia que se ve en local. Medido el 2026-09-11, esa
    // intermitencia viene del servidor de desarrollo compilando rutas bajo demanda mientras los dos
    // navegadores golpean a la vez: falla el clic que abre un diálogo o el que avanza el portal, en
    // cualquiera de los dos proyectos. En CI no muerde porque el servidor arranca limpio y
    // playwright.config.ts reintenta 2 veces.
    const razonSocial = `Proveedor E2E ${testInfo.project.name}`;
    await page.getByRole("textbox", { name: "Razón social" }).fill(razonSocial);
    await page.getByRole("button", { name: "Crear proveedor" }).click();
    await expect(page.getByRole("status")).toContainText("Proveedor creado correctamente");
    await expect(page.getByText(razonSocial)).toBeVisible();

    if (testInfo.project.name === "mobile") {
      const documentOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(documentOverflow).toBeLessThanOrEqual(1);
    }
  });
});
