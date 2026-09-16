import { describe, expect, it } from "vitest";
import { GET as orderPayments, POST as registerOrderPayment } from "../../app/api/orders/[id]/payments/route";
import { PATCH as annulOrderPayment } from "../../app/api/orders/[id]/payments/[paymentId]/route";
import { orderPaymentAnnulSchema, orderPaymentSchema } from "../../lib/http/schemas";

const orderId = "11111111-1111-4111-8111-111111111111";
const paymentId = "22222222-2222-4222-8222-222222222222";

// Adenda de pagos (N1): las rutas de pagos de orden — historial, registro y anulación — fallan
// cerradas sin credenciales de ejecución (mismo contrato que tests/integration/routes.test.ts) y
// validan su cuerpo en la frontera HTTP con los esquemas de lib/http/schemas.ts.
describe("rutas de pagos de orden", () => {
  it("fallan cerradas (503) sin dependencias de ejecución, incluida la anulación", async () => {
    expect((await orderPayments(new Request(`http://localhost/api/orders/${orderId}/payments`), { params: Promise.resolve({ id: orderId }) })).status).toBe(503);
    expect((await registerOrderPayment(new Request(`http://localhost/api/orders/${orderId}/payments`, { method: "POST", body: "{}" }), { params: Promise.resolve({ id: orderId }) })).status).toBe(503);
    expect((await annulOrderPayment(new Request(`http://localhost/api/orders/${orderId}/payments/${paymentId}`, { method: "PATCH", body: "{}" }), { params: Promise.resolve({ id: orderId, paymentId }) })).status).toBe(503);
  });

  it("registrar un pago admite nota opcional (RF-507) y sigue exigiendo fecha, valor entero positivo y un medio del enum", () => {
    expect(orderPaymentSchema.safeParse({ date: "2026-09-15", amount: 640_000, method: "efectivo", note: "  Anticipo topógrafo " })).toMatchObject({ success: true, data: { note: "Anticipo topógrafo" } });
    expect(orderPaymentSchema.safeParse({ date: "2026-09-15", amount: 640_000, method: "efectivo" }).success).toBe(true);
    expect(orderPaymentSchema.safeParse({ date: "2026-09-15", amount: 640_000, method: "caja" }).success).toBe(false);
    expect(orderPaymentSchema.safeParse({ date: "2026-09-15", amount: 640_000.5, method: "efectivo" }).success).toBe(false);
    expect(orderPaymentSchema.safeParse({ date: "2026-09-15", amount: 640_000, method: "efectivo", note: "" }).success).toBe(false);
    // El comprobante NO viaja en el cuerpo del pago: se sube después contra el id del pago (adjunto pago_orden).
    expect(orderPaymentSchema.safeParse({ date: "2026-09-15", amount: 640_000, method: "efectivo", attachmentId: paymentId }).success).toBe(false);
  });

  it("anular exige action 'annul' y un motivo no vacío (RF-510: anular ≠ borrar)", () => {
    expect(orderPaymentAnnulSchema.safeParse({ action: "annul", reason: " Transferencia rebotó " })).toMatchObject({ success: true, data: { reason: "Transferencia rebotó" } });
    expect(orderPaymentAnnulSchema.safeParse({ action: "annul", reason: "   " }).success).toBe(false);
    expect(orderPaymentAnnulSchema.safeParse({ action: "annul" }).success).toBe(false);
    expect(orderPaymentAnnulSchema.safeParse({ action: "delete", reason: "x" }).success).toBe(false);
  });
});
