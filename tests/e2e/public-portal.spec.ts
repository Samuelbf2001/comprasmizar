import { expect, test } from "@playwright/test";

test.describe("portal público de requisiciones", () => {
  test("no muestra shell interno y exige código y teléfono antes del formulario", async ({ page }) => {
    await page.goto("/requisiciones/publica");

    await expect(page.locator(".public-frame")).toBeVisible();
    await expect(page.locator(".app-shell")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Solicita lo que tu obra necesita." })).toBeVisible();

    await page.getByRole("button", { name: "Continuar" }).click();
    await expect(page.locator("#public-access-error")).toHaveText("Ingresa el código de obra y un teléfono válido para continuar.");

    await page.getByLabel("Código de obra").fill("MIZAR-PRADERA");
    await page.getByLabel("Teléfono autorizado").fill("300 555 0101");
    await page.getByRole("button", { name: "Continuar" }).click();

    await expect(page.getByRole("heading", { name: "Solicitar una compra" })).toBeVisible();
    await expect(page.getByText("Formato validado en demo · validación real pendiente · MIZAR-PRADERA")).toBeVisible();
  });

  test("valida campos esenciales y deja claro que el éxito es demostrativo", async ({ page }) => {
    await page.goto("/requisiciones/publica");
    await page.getByLabel("Código de obra").fill("MIZAR-PRADERA");
    await page.getByLabel("Teléfono autorizado").fill("300 555 0101");
    await page.getByRole("button", { name: "Continuar" }).click();

    const work = page.locator('select[name="work"]');
    const requestor = page.locator('input[name="requestor"]');
    const item = page.locator('select[name="item"]');
    await expect(work).toHaveAttribute("required", "");
    await expect(requestor).toHaveAttribute("required", "");
    await expect(item).toHaveAttribute("required", "");

    await work.selectOption({ label: "Altos de La Pradera" });
    await requestor.fill("Usuario QA local");
    await item.selectOption({ label: "Cemento gris uso general" });
    await page.getByRole("button", { name: "Enviar requisición" }).click();

    await expect(page.getByRole("heading", { name: "Recorrido completado." })).toBeVisible();
    await expect(page.getByText("REQ-DEMO-0148")).toBeVisible();
    await expect(page.locator(".demo-success-notice").getByText("Modo demostración")).toBeVisible();
    await expect(page.locator(".app-shell")).toHaveCount(0);
  });

  test("no presenta overflow horizontal crítico en móvil", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "La aserción de viewport corresponde a móvil.");
    await page.goto("/requisiciones/publica");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
