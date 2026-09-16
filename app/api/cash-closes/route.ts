export const runtime = "nodejs";
// Adenda de pagos (A10, RF-708): el cierre de caja se lee de `pagos_orden` con medio efectivo
// (GET /api/reports/cash-close); el cierre mensual por caja (`cierres_caja`) queda dormido, sin DROP.
function retired() {
  return Response.json(
    { error: "RETIRADO", message: "Los gastos de caja se registran como pagos con medio Caja sobre la orden. Ver Cierre de caja." },
    { status: 410, headers: { "Cache-Control": "no-store" } },
  );
}
export function GET() { return retired(); }
export function POST() { return retired(); }
