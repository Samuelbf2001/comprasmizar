import { expect, test } from "@playwright/test";

test.describe("operación demo visible", () => {
  test("captura soportes de requisición con validación cliente", async ({ page }) => {
    await page.goto("/requisiciones/nueva");
    await expect(page.getByRole("heading", { name: "Nueva requisición" })).toBeVisible();
    await page.getByLabel("Soporte general (opcional)").setInputFiles({
      name: "orden.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("pdf"),
    });
    await page.getByLabel("Foto del ítem (opcional)").setInputFiles({
      name: "frente.webp",
      mimeType: "image/webp",
      buffer: Buffer.from("webp"),
    });
    await page.getByRole("button", { name: "Guardar borrador" }).click();
    await expect(page.getByRole("status")).toContainText("archivos cumplen");
    await expect(page.locator("body")).not.toContainText("signed.invalid");
  });

  test("no ofrece adjuntos de caja menor a Contabilidad", async ({ page }) => {
    await page.goto("/gastos");
    await page.getByLabel("Cambiar rol demo").selectOption("Contabilidad");
    await expect(page.getByRole("button", { name: "Registrar caja menor" })).toHaveCount(0);
    await expect(page.getByLabel("Recibo o soporte (opcional)")).toHaveCount(0);
  });

  test("la bandeja soporta loading, error, vacío/retry y kanban", async ({ page }) => {
    await page.goto("/revision");
    await expect(page.getByRole("heading", { name: "Bandeja de revisión" })).toBeVisible();

    await page.getByRole("button", { name: "Probar carga" }).click();
    await expect(page.getByRole("status")).toContainText("Cargando datos de demo");
    await page.getByRole("button", { name: "Volver a datos" }).click();
    await expect(page.getByRole("heading", { name: "Por gestionar" })).toBeVisible();

    await page.getByRole("button", { name: "Probar error/vacío" }).click();
    await expect(page.locator(".state-error[role=alert]")).toContainText("No pudimos cargar esta vista");
    await page.getByRole("button", { name: "Reintentar" }).click();
    await expect(page.getByRole("heading", { name: "Por gestionar" })).toBeVisible();

    await page.getByRole("button", { name: "Probar error/vacío" }).click();
    await page.getByRole("button", { name: "Probar error/vacío" }).click();
    await expect(page.getByRole("heading", { name: "No hay resultados" })).toBeVisible();
    await page.getByRole("button", { name: "Limpiar filtros" }).click();
    await expect(page.getByRole("heading", { name: "Por gestionar" })).toBeVisible();

    await page.getByRole("button", { name: "Kanban" }).click();
    for (const column of ["Recibida", "En revisión", "En aprobación", "Aprobada"]) {
      await expect(page.locator(".kanban-column").filter({ hasText: column })).toBeVisible();
    }
    await page.locator(".kanban-card").first().click();
    await expect(page).toHaveURL(/\/requisiciones\//);
    await expect(page.getByText("Historial de trazabilidad")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Cada paso, visible" })).toBeVisible();
  });

  test("mensajes no monta iframe sin configuración de Kapso", async ({ page }) => {
    await page.goto("/mensajes");
    const inbox = page.locator('iframe[title="Bandeja de mensajes Kapso"]');
    test.skip(await inbox.count() > 0, "El servidor bajo prueba tiene Kapso configurado; esta aserción corresponde únicamente a ausencia de env.");
    await expect(page.getByRole("heading", { name: "La bandeja está lista para conectarse" })).toBeVisible();
    await expect(inbox).toHaveCount(0);
    await expect(page.getByText("NEXT_PUBLIC_KAPSO_INBOX_URL")).toBeVisible();
  });

  test("no presenta overflow horizontal crítico en móvil para kanban", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "La aserción de viewport corresponde a móvil.");
    await page.goto("/revision");
    await page.getByRole("button", { name: "Kanban" }).click();
    const documentOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(documentOverflow).toBeLessThanOrEqual(1);
    await expect(page.locator(".kanban")).toHaveCSS("overflow-x", "auto");
  });

  test("la captura de requisición no desborda el encabezado en móvil", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "La aserción corresponde al viewport móvil.");
    await page.goto("/requisiciones/nueva");
    const widths = await page.evaluate(() => ({
      documentWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
      viewport: window.innerWidth,
    }));
    expect(widths.documentWidth).toBeLessThanOrEqual(widths.viewport);
    expect(widths.bodyWidth).toBeLessThanOrEqual(widths.viewport);
    const profile = page.getByRole("button", { name: /Perfil de/ });
    if (await profile.count()) {
      const box = await profile.boundingBox();
      expect(box?.width ?? 0).toBeGreaterThan(20);
      expect(box?.height ?? 0).toBeGreaterThan(20);
    }
  });
});
