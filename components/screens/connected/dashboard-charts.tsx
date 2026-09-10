"use client";

// Fase 2 (rendimiento, docs/plan-rendimiento.md, hallazgo H4): ÚNICO módulo de
// components/screens/connected/ que importa `recharts` (~150 KB gzip). Antes vivía dentro
// de components/screens/connected.tsx y lo descargaba cualquier rol en cualquier ruta;
// dashboard.tsx lo carga con next/dynamic + ssr:false para que solo llegue al navegador
// cuando de verdad se ve el dashboard. Mismos dos componentes, misma lógica, exportados
// con nombre (ver "Importing Named Exports" en node_modules/next/dist/docs/01-app/02-guides/lazy-loading.md).
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { BarChart3 } from "lucide-react";
import { Tone } from "../screen-primitives";
import { money, type DashboardAmountByKey } from "./shared";

// RF-706/RF-1103: gráfico ejecutivo horizontal (recharts) con su tabla equivalente como alternativa
// textual accesible; `role="img"` + `aria-label` en el contenedor visual describe el mismo resumen
// para lectores de pantalla, y la tabla queda siempre visible con las cifras exactas.
export function DashboardBarChart({
  title,
  emptyHint,
  rows,
}: {
  title: string;
  emptyHint: string;
  rows: Array<{ label: string; total: number }>;
}) {
  const total = rows.reduce((sum, row) => sum + row.total, 0);
  return (
    <section className="panel chart-panel">
      <div className="panel-head">
        <div>
          <div className="eyebrow">Gráfico ejecutivo</div>
          <h2>{title}</h2>
        </div>
        {rows.length > 0 && <Tone tone="muted">{money.format(total)}</Tone>}
      </div>
      {rows.length === 0 ? (
        <div className="empty-state">
          <span className="empty-icon">
            <BarChart3 aria-hidden="true" size={20} />
          </span>
          <h3>Sin datos</h3>
          <p>{emptyHint}</p>
        </div>
      ) : (
        <>
          <div
            className="chart-visual"
            role="img"
            aria-label={`${title}: ${rows.map((row) => `${row.label}, ${money.format(row.total)}`).join("; ")}`}
          >
            <ResponsiveContainer
              width="100%"
              height={Math.max(150, rows.length * 36)}
            >
              <BarChart
                data={rows}
                layout="vertical"
                margin={{ top: 4, right: 24, left: 4, bottom: 4 }}
              >
                <XAxis type="number" hide />
                <YAxis
                  type="category"
                  dataKey="label"
                  width={116}
                  tick={{ fontSize: 11 }}
                  tickLine={false}
                  axisLine={false}
                />
                <Tooltip formatter={(value) => money.format(Number(value ?? 0))} />
                <Bar dataKey="total" fill="var(--green)" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="table-wrap chart-table">
            <table>
              <thead>
                <tr>
                  <th>Concepto</th>
                  <th className="align-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.label}>
                    <td>{row.label}</td>
                    <td className="align-right money">
                      {money.format(row.total)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
export function DashboardPeriodChart({ rows }: { rows: DashboardAmountByKey[] }) {
  const points = rows.map((row) => ({ period: row.key, total: row.total }));
  return (
    <section className="panel chart-panel">
      <div className="panel-head">
        <div>
          <div className="eyebrow">Gráfico ejecutivo</div>
          <h2>Gasto por periodo</h2>
        </div>
      </div>
      {points.length === 0 ? (
        <div className="empty-state">
          <span className="empty-icon">
            <BarChart3 aria-hidden="true" size={20} />
          </span>
          <h3>Sin datos</h3>
          <p>No hay gastos registrados en los últimos periodos.</p>
        </div>
      ) : (
        <>
          <div
            className="chart-visual"
            role="img"
            aria-label={`Gasto por periodo: ${points.map((point) => `${point.period}, ${money.format(point.total)}`).join("; ")}`}
          >
            <ResponsiveContainer width="100%" height={200}>
              <BarChart
                data={points}
                margin={{ top: 8, right: 12, left: 0, bottom: 4 }}
              >
                <CartesianGrid
                  strokeDasharray="3 3"
                  vertical={false}
                  stroke="var(--line)"
                />
                <XAxis dataKey="period" tick={{ fontSize: 11 }} />
                <YAxis hide />
                <Tooltip formatter={(value) => money.format(Number(value ?? 0))} />
                <Bar dataKey="total" fill="var(--blue)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="table-wrap chart-table">
            <table>
              <thead>
                <tr>
                  <th>Periodo</th>
                  <th className="align-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {points.map((point) => (
                  <tr key={point.period}>
                    <td>{point.period}</td>
                    <td className="align-right money">
                      {money.format(point.total)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
