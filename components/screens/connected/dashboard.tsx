"use client";

// Fase 2 (rendimiento, docs/plan-rendimiento.md, hallazgo H4): ConnectedDashboard, partido
// de components/screens/connected.tsx. Misma lógica, mismos nombres.
//
// DECISIÓN Suspense vs `loading`: se usa la opción `loading` de `next/dynamic` (en vez de
// `ssr:true` + <Suspense> manual) para los dos gráficos de dashboard-charts.tsx. Con
// `ssr:false` next/dynamic YA crea su propio límite de Suspense internamente
// (ver hasSuspenseBoundary = !opts.ssr || !!opts.loading en
// node_modules/next/dist/shared/lib/lazy-dynamic/loadable.js), así que pasar `loading`
// alcanza sin envolver nada a mano y sin duplicar el fallback en cada pantalla que use
// dynamic(). El `loading` reutiliza la clase `.skeleton-chart` (misma altura, 220px, que
// define app/globals.css) para que no haya salto de layout mientras se descarga recharts.
import dynamic from "next/dynamic";
import {
  ArrowRight,
  BarChart3,
  CheckCircle2,
  Inbox,
  RefreshCw,
  ShieldCheck,
  Truck,
} from "lucide-react";
import { SectionTitle, Tone } from "../screen-primitives";
import {
  emptyCatalogs,
  estadoLabel,
  money,
  type DashboardActivityItem,
  type DashboardBundle,
  type DashboardQueueItem,
} from "./shared";

const DashboardBarChart = dynamic(
  () => import("./dashboard-charts").then((mod) => mod.DashboardBarChart),
  { loading: () => <div className="skeleton skeleton-chart" aria-hidden="true" /> },
);
const DashboardPeriodChart = dynamic(
  () => import("./dashboard-charts").then((mod) => mod.DashboardPeriodChart),
  { loading: () => <div className="skeleton skeleton-chart" aria-hidden="true" /> },
);

const shortDate = new Intl.DateTimeFormat("es-CO", {
  day: "2-digit",
  month: "short",
});
function formatShortDate(value: string): string {
  const date = new Date(value.length <= 10 ? `${value}T00:00:00` : value);
  return Number.isNaN(date.getTime()) ? value : shortDate.format(date);
}
function queueDestination(item: DashboardQueueItem): string {
  return item.kind === "requisicion" ? `/requisiciones/${item.id}` : "/ordenes";
}
function activityDestination(item: DashboardActivityItem): string {
  if (item.kind === "requisicion") return `/requisiciones/${item.id}`;
  return item.kind === "orden" ? "/ordenes" : "/gastos";
}
export function ConnectedDashboard({
  data,
  go,
}: {
  data: unknown;
  go: (path: string) => void;
}) {
  const bundle = data as Partial<DashboardBundle>;
  const metrics = bundle.metrics ?? {};
  const catalogs = bundle.catalogs ?? emptyCatalogs;
  // GRAVE 4: nunca cae al id crudo — "—"/"Sin etiqueta" son honestos, un UUID no lo es.
  const workName = (id?: string) =>
    (id && catalogs.works.find((work) => work.id === id)?.name) || "—";
  const tagName = (key: string) =>
    key
      ? (catalogs.tags.find((tag) => tag.id === key)?.name ?? "—")
      : "Sin etiqueta";
  // Centros de costo (2026-09-12): mismo criterio que tagName arriba — clave "" representa gastos sin
  // centro de costo asignado (ver groupExpenseByCostCenter en lib/domain/rules.ts).
  const costCenterName = (key: string) =>
    key
      ? ((catalogs.costCenters ?? []).find((costCenter) => costCenter.id === key)?.name ?? "—")
      : "Sin centro de costo";
  const queue = metrics.attentionQueue ?? [];
  const activity = metrics.recentActivity ?? [];
  const byWork = (metrics.expenseByWork ?? []).map((row) => ({
    label: workName(row.key),
    total: row.total,
  }));
  const byTag = (metrics.expenseByTag ?? []).map((row) => ({
    label: tagName(row.key),
    total: row.total,
  }));
  const byCostCenter = (metrics.expenseByCostCenter ?? []).map((row) => ({
    label: costCenterName(row.key),
    total: row.total,
  }));
  return (
    <>
      <SectionTitle
        eyebrow="Panel"
        title="Pulso de compras"
        description="Métricas de tu rol para el periodo actual."
      />
      <div className="stats-grid">
        <article className="stat-card stat-amber">
          <span className="stat-icon"><Inbox aria-hidden="true" size={17} /></span>
          <span className="stat-label">En revisión</span>
          <strong>{metrics.byStatus?.en_revision ?? 0}</strong>
          <span className="stat-meta">requisiciones visibles</span>
        </article>
        <article className="stat-card stat-blue">
          <span className="stat-icon"><CheckCircle2 aria-hidden="true" size={17} /></span>
          <span className="stat-label">En aprobación</span>
          <strong>{metrics.byStatus?.en_aprobacion ?? 0}</strong>
          {/* Reunión 2026-09: la fecha del gasto es la del pago — este monto es lo comprometido en
              órdenes ya generadas y aún sin pagar (calculateDashboard.inProcessValue), no el valor de
              las requisiciones en aprobación que muestra la tarjeta. */}
          <span className="stat-meta">Comprometido sin pagar: {money.format(metrics.inProcessValue ?? 0)}</span>
        </article>
        <article className="stat-card stat-orange">
          <span className="stat-icon"><Truck aria-hidden="true" size={17} /></span>
          <span className="stat-label">Compras pendientes</span>
          <strong>{metrics.pendingOrders ?? 0}</strong>
          <span className="stat-meta">generadas o no cumplidas</span>
        </article>
        <article className="stat-card stat-forest">
          <span className="stat-icon"><BarChart3 aria-hidden="true" size={17} /></span>
          <span className="stat-label">Gasto del periodo</span>
          <strong>{money.format(metrics.periodExpense ?? 0)}</strong>
          <span className="stat-meta">según alcance del rol</span>
        </article>
      </div>
      <div className="dashboard-grid">
        {/* RF-1102: cola de "qué espera algo de mí", calculada en el servicio (buildAttentionQueue)
            sobre las mismas colecciones ya filtradas por rol; esta vista solo la renderiza. */}
        <section className="panel panel-alerts">
          <div className="panel-head">
            <div>
              <div className="eyebrow">Atención requerida</div>
              <h2>Qué espera algo de ti</h2>
            </div>
            <Tone tone={queue.length ? "warning" : "muted"}>
              {queue.length} pendientes
            </Tone>
          </div>
          {queue.length === 0 ? (
            <div className="empty-state">
              <span className="empty-icon">
                <Inbox aria-hidden="true" size={20} />
              </span>
              <h3>Sin pendientes</h3>
              <p>
                No hay requisiciones ni órdenes esperando una acción tuya en
                este momento.
              </p>
            </div>
          ) : (
            queue.map((item) => (
              <button
                key={`${item.kind}-${item.id}`}
                className="alert-item"
                type="button"
                onClick={() => go(queueDestination(item))}
              >
                <span className="alert-icon amber">
                  {item.kind === "orden" ? (
                    <Truck aria-hidden="true" size={16} />
                  ) : (
                    <Inbox aria-hidden="true" size={16} />
                  )}
                </span>
                <span>
                  <strong>
                    {item.consecutive} · {item.action}
                  </strong>
                  <small>
                    {workName(item.workId)} ·{" "}
                    {estadoLabel(item.status)}
                  </small>
                </span>
                <ArrowRight aria-hidden="true" size={15} />
              </button>
            ))
          )}
        </section>
        {/* RF-1102: actividad reciente (buildRecentActivity); combina requisiciones, órdenes y gastos
            visibles por el actor, ordenados por su marca de tiempo real más reciente. */}
        <section className="panel recent-panel">
          <div className="panel-head">
            <div>
              <div className="eyebrow">Actividad reciente</div>
              <h2>Últimos movimientos</h2>
            </div>
          </div>
          {activity.length === 0 ? (
            <div className="empty-state">
              <span className="empty-icon">
                <RefreshCw aria-hidden="true" size={20} />
              </span>
              <h3>Sin movimientos</h3>
              <p>Todavía no hay actividad reciente visible para tu rol.</p>
            </div>
          ) : (
            <ul className="activity-list">
              {activity.map((item) => (
                <li key={`${item.kind}-${item.id}`}>
                  <button
                    type="button"
                    onClick={() => go(activityDestination(item))}
                  >
                    <span>
                      <strong>{item.consecutive}</strong>
                      <small>
                        {workName(item.workId)} ·{" "}
                        {estadoLabel(item.status)}
                      </small>
                    </span>
                    <time dateTime={item.at}>{formatShortDate(item.at)}</time>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
      {/* RF-706/RF-1103: gráficos ejecutivos de gasto por obra, por etiqueta, por centro de costo
          (2026-09-12) y por periodo. */}
      <div className="chart-grid">
        <DashboardBarChart
          title="Gasto por obra"
          emptyHint="No hay gastos registrados en el periodo visible para tu rol."
          rows={byWork}
        />
        <DashboardBarChart
          title="Gasto por centro de costo"
          emptyHint="No hay gastos con centro de costo asignado en el periodo visible."
          rows={byCostCenter}
        />
        <DashboardBarChart
          title="Gasto por etiqueta"
          emptyHint="No hay gastos con etiqueta asignada en el periodo visible."
          rows={byTag}
        />
        <DashboardPeriodChart rows={metrics.expenseByPeriod ?? []} />
      </div>
      <div className="panel integration-evidence">
        <ShieldCheck aria-hidden="true" size={18} />
        <div>
          <b>Sin cifras de demostración</b>
          <p>
            Esta vista solo renderiza la respuesta autenticada de
            `/api/dashboard`.
          </p>
        </div>
      </div>
    </>
  );
}
