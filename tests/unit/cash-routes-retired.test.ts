import { describe, expect, it } from "vitest";
import { GET as listPettyCash, POST as registerPettyCash } from "../../app/api/petty-cash/route";
import { GET as listIncomes, POST as registerIncome } from "../../app/api/incomes/route";
import { GET as cashCloseSummary, POST as closeCashPeriod } from "../../app/api/cash-closes/route";

/**
 * Adenda de pagos (A10): el módulo «Gastos y caja» del 12-sep se retira del API. El gasto directo,
 * los ingresos y el cierre mensual por caja responden 410 con un mensaje que apunta al camino nuevo
 * (pago con medio Caja sobre la orden + Cierre de caja). Sin autenticación previa a propósito: la
 * respuesta no revela nada y así un cliente viejo entiende el retiro aunque su sesión haya caducado.
 */
const RETIRED = { error: "RETIRADO", message: "Los gastos de caja se registran como pagos con medio Caja sobre la orden. Ver Cierre de caja." };

describe("rutas retiradas de «Gastos y caja» (A10)", () => {
  it("POST /api/petty-cash responde 410 con el mensaje de retiro", async () => {
    const response = await registerPettyCash();
    expect(response.status).toBe(410);
    expect(await response.json()).toEqual(RETIRED);
  });

  it("GET /api/petty-cash sigue existiendo (histórico de caja_menor) y falla cerrado sin credenciales", async () => {
    const response = await listPettyCash(new Request("http://localhost/api/petty-cash"));
    expect(response.status).not.toBe(410);
    expect([401, 403, 503]).toContain(response.status);
  });

  it("GET y POST /api/incomes responden 410", async () => {
    expect((await listIncomes()).status).toBe(410);
    const response = await registerIncome();
    expect(response.status).toBe(410);
    expect(await response.json()).toEqual(RETIRED);
  });

  it("GET y POST /api/cash-closes responden 410", async () => {
    expect((await cashCloseSummary()).status).toBe(410);
    const response = await closeCashPeriod();
    expect(response.status).toBe(410);
    expect(await response.json()).toEqual(RETIRED);
  });
});
