import { calculateDashboard, groupExpenseByPeriod, groupExpenseByTag, groupExpenseByWork, sumLines } from "../../../lib/domain";
import { apiError } from "../../../lib/http/api";
import { createPostgresDependencies } from "../../../lib/infrastructure/postgres-repositories";
import { createScreenSessionServiceDependencies } from "../../../lib/infrastructure/screen-session-repository";
import { ScreenSessionService } from "../../../lib/services/screen-session-service";

export const runtime = "nodejs";
const noStore = { "Cache-Control": "no-store" };
/** RF-1104: token ausente, con formato inválido o de una sesión revocada/expirada responden EXACTAMENTE
 *  igual — 404 neutro — para que un observador externo no pueda distinguir cuál de esos casos ocurrió. */
const screenNotAuthorized = () => Response.json({ error: "not_found" }, { status: 404, headers: noStore });

/**
 * RF-1104: único endpoint HTTP que un monitor de oficina puede llamar. El token viaja por el header
 * `x-pantalla-token` (nunca por query string, para no quedar en logs HTTP); lo pone ahí el cliente tras
 * leerlo una sola vez del fragmento de la URL (ver app/pantalla/pantalla-client.tsx).
 *
 * Deliberadamente NO reutiliza `ProcurementService.dashboard()`: ese método exige un `Actor` con permiso
 * `dashboard:read` (lib/services/procurement-service.ts) y `ScreenSessionService.authenticate()` devuelve
 * un `ScreenSessionPrincipal` que es estructuralmente distinto de `Actor` a propósito (sin `roles`) — esa
 * separación es la garantía de seguridad que prueba tests/unit/screen-session.test.ts y esta ruta no la
 * rompe fabricando un Actor falso. En su lugar agrega aquí, sin ningún Actor de por medio, las mismas
 * colecciones que ese método usa, leídas por los métodos `.list()` de los repositorios (org-wide, sin
 * alcance de rol — ya expuestos en lib/services/contracts.ts, hoy usados también para reportería), y solo
 * les aplica las funciones puras de agregación del dominio (conteos y montos). Nunca llama
 * `buildAttentionQueue` ni `buildRecentActivity`: esas dos exponen ids y consecutivos de documentos
 * individuales, y el modo pantalla tiene prohibido mostrar detalle de requisiciones individuales (solo
 * conteos y montos agregados).
 */
export async function GET(request: Request) {
  try {
    const token = request.headers.get("x-pantalla-token");
    if (!token) return screenNotAuthorized();
    const principal = await new ScreenSessionService(createScreenSessionServiceDependencies()).authenticate(token);
    if (!principal) return screenNotAuthorized();

    const deps = createPostgresDependencies();
    const [requisitions, expenses, orders] = await Promise.all([deps.requisitions.list(), deps.expenses.list(), deps.orders.list()]);
    const period = new Date().toISOString().slice(0, 7);
    const dashboard = calculateDashboard(expenses, orders, requisitions.map((requisition) => requisition.status), period);
    const inProcessValue = requisitions
      .filter((requisition) => requisition.status === "en_revision" || requisition.status === "en_aprobacion")
      .reduce((sum, requisition) => sum + sumLines(requisition.items), 0);

    return Response.json(
      {
        sessionName: principal.sessionName,
        period,
        metrics: {
          byStatus: dashboard.byStatus,
          inProcessValue,
          periodExpense: dashboard.periodExpense,
          pendingOrders: dashboard.pendingOrders,
          expenseByWork: groupExpenseByWork(expenses),
          expenseByTag: groupExpenseByTag(expenses),
          expenseByPeriod: groupExpenseByPeriod(expenses),
        },
      },
      { status: 200, headers: noStore },
    );
  } catch (error) {
    return apiError(error);
  }
}
