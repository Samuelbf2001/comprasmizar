import { expect, test } from "@playwright/test";

const realBackend = process.env.E2E_REAL_BACKEND === "1";

function fixture(name: string) {
  const value = process.env[name];
  expect(value, `E2E_REAL_BACKEND=1 requiere ${name} de un fixture aislado.`).toBeTruthy();
  return value as string;
}

test.describe("autorización visible y límites del backend", () => {
  test("el selector de roles oculta menús no asignados", async ({ page }) => {
    await page.goto("/");
    await page.getByLabel("Cambiar rol demo").selectOption("Solicitante");

    await expect(page.getByRole("navigation", { name: "Navegación principal" }).getByText("Mis requisiciones", { exact: true })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Navegación principal" }).getByText("Revisión de Daniel", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("navigation", { name: "Navegación principal" }).getByText("Catálogos", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("navigation", { name: "Navegación principal" }).getByText("Órdenes", { exact: true })).toHaveCount(0);
  });

  test("guard de ruta: un solicitante recibe acceso denegado al cambiar de rol", async ({ page }) => {
    await page.goto("/revision");
    await page.getByLabel("Cambiar rol demo").selectOption("Solicitante");
    await expect(page.locator(".access-denied[role=alert]")).toContainText("Sin acceso con este rol");
  });

  test("ruta directa se verifica solo cuando Auth real está habilitado", async ({ page }) => {
    test.skip(!realBackend, "La UI demo inicia deliberadamente como Revisor; la negación sin sesión requiere Auth real.");
    await page.goto("/revision");
    await expect(page.getByRole("heading", { name: /iniciar sesión|sin acceso/i })).toBeVisible();
  });

  test("health, MCP y captura pública no exponen secretos sin credenciales", async ({ request }) => {
    test.skip(!realBackend, "Ejecutar contra backend aislado con E2E_REAL_BACKEND=1.");
    const health = await request.get("/api/health");
    expect([200, 503]).toContain(health.status());
    const healthBody = await health.text();
    expect(healthBody).not.toMatch(/service_role|supabase.*key|password/i);

    const mcp = await request.post("/mcp", { data: {} });
    expect([401, 503]).toContain(mcp.status());
    expect(await mcp.text()).not.toMatch(/service_role|supabase.*key|password/i);

    const publicWrite = await request.post("/api/public/requisitions", { data: {} });
    expect([202, 503]).toContain(publicWrite.status());
    expect(await publicWrite.text()).not.toMatch(/service_role|supabase.*key|password/i);
  });

  test("compra multi-proveedor requiere dos OCs y sus gastos reales", async ({ page }) => {
    test.fixme(!realBackend, "Requiere una requisición fixture persistente, dos proveedores adjudicados, dos OCs/PDFs y gastos por orden para verificar el reparto multi-proveedor.");
    const requisitionId = fixture("E2E_MULTI_SUPPLIER_REQUISITION_ID");
    await page.goto(`/requisiciones/${requisitionId}`);
    await expect(page.getByTestId("supplier-allocation")).toHaveCount(2);
    await expect(page.getByTestId("purchase-order-document")).toHaveCount(2);
    await expect(page.getByTestId("expense-by-order")).toHaveCount(2);
  });

  test("pago requiere etiqueta nómina y OP/gasto persistentes", async ({ page }) => {
    test.fixme(!realBackend, "Requiere fixture de pago aprobado con etiqueta nómina, orden de pago y gasto persistentes; la UI demo no crea ni consulta esos registros.");
    const paymentId = fixture("E2E_PAYMENT_ID");
    await page.goto(`/gastos?payment=${paymentId}`);
    await expect(page.getByTestId("payment-order")).toBeVisible();
    await expect(page.getByTestId("payment-expense")).toBeVisible();
    await expect(page.getByTestId("payment-tag")).toHaveText(/nómina/i);
  });

  test("devolución requiere motivo, reenvío y auditoría persistentes", async ({ page }) => {
    test.fixme(!realBackend, "Requiere fixture de requisición devuelta y re-enviada; debe comprobar motivo obligatorio, transición a revisión y evento de auditoría inmutable.");
    const requisitionId = fixture("E2E_RETURNED_REQUISITION_ID");
    await page.goto(`/requisiciones/${requisitionId}`);
    await expect(page.getByTestId("return-reason")).toBeVisible();
    await expect(page.getByTestId("requisition-status")).toHaveText(/en revisión/i);
    await expect(page.getByTestId("audit-event")).toContainText(/devuelta|re-enviada/i);
  });

  test("declinación requiere excluir la solicitud activa y no crear gasto", async ({ page }) => {
    test.fixme(!realBackend, "Requiere fixture de requisición declinada; debe comprobar motivo, salida de la lista activa, consulta histórica y ausencia de gasto asociado.");
    const requisitionId = fixture("E2E_DECLINED_REQUISITION_ID");
    await page.goto(`/requisiciones/${requisitionId}`);
    await expect(page.getByTestId("decline-reason")).toBeVisible();
    await expect(page.getByTestId("expense-by-order")).toHaveCount(0);
    await page.goto("/revision");
    await expect(page.getByTestId("active-requisition").filter({ hasText: requisitionId })).toHaveCount(0);
  });
});
