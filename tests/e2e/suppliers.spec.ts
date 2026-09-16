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
    // Sobre la intermitencia de este clic, medida el 2026-09-11 con --workers=1 y servidor
    // caliente: NO era la compilación en paralelo. La pantalla de proveedores se carga con
    // next/dynamic, y con SSR el botón llegaba en el HTML antes que su chunk; un clic en esa
    // ventana (~100 ms tras el load) se perdía sin reproducirse. Se arregló con ssr:false en
    // mizar-app.tsx; el tercer test de este archivo lo fija retrasando el chunk a propósito.
    const razonSocial = `Proveedor E2E ${testInfo.project.name}`;
    await page.getByRole("textbox", { name: "Razón social" }).fill(razonSocial);
    await page.getByRole("button", { name: "Crear proveedor" }).click();
    await expect(page.getByRole("status")).toContainText("Proveedor creado correctamente");
    // Crear abre la ficha, así que el nombre sale en la tabla, el título y los datos de la ficha:
    // `getByText` resolvía varios elementos y el modo estricto la tumbaba (QA H6).
    await expect(page.getByRole("dialog", { name: razonSocial })).toBeVisible();

    if (testInfo.project.name === "mobile") {
      const documentOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(documentOverflow).toBeLessThanOrEqual(1);
    }
  });

  // Regresión del defecto real de 2026-09-11. Retrasa el chunk diferido de la pantalla para que el
  // clic llegue seguro antes de que el módulo ejecute. Con SSR (el HTML traía el botón) este clic
  // se tragaba en silencio: dialogoTras=-1 aunque el botón terminara hidratado. Con ssr:false el
  // botón no existe hasta que puede responder, así que el clic espera y el diálogo abre.
  test("sigue abriendo el diálogo aunque el chunk de la pantalla llegue tarde", async ({ page }) => {
    await page.route(/components_screens_suppliers/i, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      await route.continue();
    });
    await page.goto("/proveedores");
    await page.getByRole("button", { name: "Nuevo proveedor" }).click();
    await expect(page.getByRole("dialog", { name: "Nuevo proveedor" })).toBeVisible();
  });
});
