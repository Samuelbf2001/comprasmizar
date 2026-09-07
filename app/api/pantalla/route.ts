import { calculateDashboard, colombiaDateParts, groupExpenseByPeriod, groupExpenseByTag, groupExpenseByWork } from "../../../lib/domain";
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
    // GRAVE 3 (QA reasignación, reunión 2026-09): `new Date().toISOString().slice(0,7)` toma componentes
    // UTC — mismo bug que colombiaDateParts ya arregló en el servicio (procurement-service.ts): el último
    // día del mes, después de las 19:00 hora Colombia, esto calculaba el mes SIGUIENTE. La pantalla de
    // oficina corre en el servidor (TZ de proceso desconocido, a menudo UTC), no en el navegador del
    // usuario, así que no puede fiarse de los getters locales de `Date` — reutiliza la misma función que
    // ya vive en el dominio en vez de reimplementarla por tercera vez.
    const period = colombiaDateParts(new Date()).period;
    // Reunión 2026-09: inProcessValue ya lo calcula calculateDashboard (suma de gastos sin fecha de
    // pago, "comprometido sin pagar") — esta ruta ya no lo recalcula aparte a partir de requisiciones
    // en revisión/aprobación.
    const dashboard = calculateDashboard(expenses, orders, requisitions.map((requisition) => requisition.status), period);

    return Response.json(
      {
        sessionName: principal.sessionName,
        period,
        metrics: {
          byStatus: dashboard.byStatus,
          inProcessValue: dashboard.inProcessValue,
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
