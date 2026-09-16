export const runtime = "nodejs";
// Adenda de pagos (A10, §7): los ingresos son parte del módulo financiero de fase 2. La tabla
// `ingresos` queda dormida (sin DROP); esta ruta responde 410 hasta que esa fase la reactive.
function retired() {
  return Response.json(
    { error: "RETIRADO", message: "Los gastos de caja se registran como pagos con medio Caja sobre la orden. Ver Cierre de caja." },
    { status: 410, headers: { "Cache-Control": "no-store" } },
  );
}
export function GET() { return retired(); }
export function POST() { return retired(); }
