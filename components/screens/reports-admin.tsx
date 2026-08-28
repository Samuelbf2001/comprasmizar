import {
  ArrowDownToLine,
  ArrowRight,
  Database,
  Download,
  Lock,
  MoreHorizontal,
  ShieldCheck,
} from "lucide-react";
import { items, type Role } from "../../lib/demo-data";
import { SectionTitle } from "./screen-primitives";

export function ReportsScreen({ go }: { go: (href: string) => void }) {
  return (
    <>
      <SectionTitle
        eyebrow="Lectura ejecutiva"
        title="Reportes"
        description="Una vista confiable para decidir y presentar a socios."
        action={
          <div className="title-actions">
            <button
              className="button button-secondary"
              type="button"
              disabled
              aria-disabled="true"
              title="Disponible al conectar el servicio"
            >
              <Download aria-hidden="true" size={15} /> Descargar PDF
            </button>
            <button
              className="button button-dark"
              type="button"
              disabled
              aria-disabled="true"
              title="Disponible al conectar el servicio"
            >
              <ArrowDownToLine aria-hidden="true" size={15} /> Exportar Excel
            </button>
          </div>
        }
      />
      <div className="report-kpis">
        <div>
          <span>Gasto total</span>
          <strong>$ 42,8 M</strong>
          <small>dato demo</small>
        </div>
        <div>
          <span>Requisiciones cerradas</span>
          <strong>31</strong>
          <small>de 38 recibidas</small>
        </div>
        <div>
          <span>Tiempo aprobación</span>
          <strong>1,8 días</strong>
          <small>dato demo</small>
        </div>
        <div>
          <span>Órdenes cumplidas</span>
          <strong>87%</strong>
          <small>21 de 24</small>
        </div>
      </div>
      <div className="report-grid">
        <section className="panel report-chart">
          <div className="panel-head">
            <div>
              <div className="eyebrow">Distribución</div>
              <h2>Gasto por tipo</h2>
            </div>
            <button
              className="icon-button"
              type="button"
              aria-label="Más opciones de gasto"
              disabled
              aria-disabled="true"
              title="Disponible al conectar el servicio"
            >
              <MoreHorizontal aria-hidden="true" size={17} />
            </button>
          </div>
          <div className="donut-layout">
            <div className="donut">
              <div>
                <b>$ 42,8 M</b>
                <span>demo</span>
              </div>
            </div>
            <div className="legend">
              <span>
                <i className="legend-materials" />
                Materiales <b>71%</b>
              </span>
              <span>
                <i className="legend-services" />
                Servicios <b>18%</b>
              </span>
              <span>
                <i className="legend-payroll" />
                Nómina <b>7%</b>
              </span>
            </div>
          </div>
        </section>
        <section className="panel report-chart">
          <div className="panel-head">
            <div>
              <div className="eyebrow">Flujo operativo</div>
              <h2>Estado de requisiciones</h2>
            </div>
            <button
              className="text-link"
              type="button"
              onClick={() => go("/revision")}
            >
              Ver bandeja <ArrowRight aria-hidden="true" size={14} />
            </button>
          </div>
          <div className="horizontal-bars">
            <div>
              <span>Recibidas</span>
              <i>
                <b style={{ width: "100%" }} />
              </i>
              <strong>38</strong>
            </div>
            <div>
              <span>En revisión</span>
              <i>
                <b style={{ width: "58%" }} />
              </i>
              <strong>12</strong>
            </div>
            <div>
              <span>Aprobadas</span>
              <i>
                <b className="green" style={{ width: "71%" }} />
              </i>
              <strong>31</strong>
            </div>
          </div>
        </section>
      </div>
    </>
  );
}
export function AdminScreen({
  role = "Administrador Sixteam",
}: {
  role?: Role;
}) {
  const [tab, setTab] = React.useState("Ítems");
  if (role === "Administrador Mizar") {
    return (
      <div className="state-panel panel access-denied" role="alert">
        <span className="empty-icon">
          <Lock aria-hidden="true" size={21} />
        </span>
        <h3>Catálogos bloqueados en Básico</h3>
        <p>
          El autoservicio de Administrador Mizar requiere habilitar el módulo de
          catálogos. No se muestran ni modifican datos sintéticos.
        </p>
        <p className="gate-copy">
          <b>Gate de autoservicio:</b> solicita habilitación a Administrador
          Sixteam.
        </p>
      </div>
    );
  }
  return (
    <>
      <SectionTitle
        eyebrow="Administración"
        title="Catálogos"
        description="Administra maestros compartidos. El autoservicio Mizar está bloqueado en Básico."
        action={<span className="badge badge-warning">Gate: solo Sixteam</span>}
      />
      <div className="catalog-layout">
        <aside
          className="catalog-nav"
          role="tablist"
          aria-label="Catálogos administrables"
        >
          {["Ítems", "Obras", "Etiquetas", "Usuarios"].map((label) => (
            <button
              className={tab === label ? "is-active" : ""}
              type="button"
              role="tab"
              aria-selected={tab === label}
              key={label}
              onClick={() => setTab(label)}
            >
              <Database aria-hidden="true" size={16} />
              {label}
              <ArrowRight aria-hidden="true" size={14} />
            </button>
          ))}
          <div className="catalog-note">
            <ShieldCheck aria-hidden="true" size={16} />
            <span>
              <b>Autoservicio Mizar</b>
              <small>
                Disponible en fase Completo; Daniel normaliza ítems.
              </small>
            </span>
          </div>
        </aside>
        <section className="panel catalog-content">
          <div className="panel-head">
            <div>
              <h2>{tab}</h2>
              <p className="panel-sub">Cambios demo, sin persistencia</p>
            </div>
            <button
              className="icon-button"
              type="button"
              aria-label="Más opciones de catálogo"
              disabled
              aria-disabled="true"
              title="Disponible al conectar el servicio"
            >
              <MoreHorizontal aria-hidden="true" size={16} />
            </button>
          </div>
          {tab === "Ítems" ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Nombre</th>
                    <th>Categoría</th>
                    <th>Unidad</th>
                    <th>Estado</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <tr key={item.name}>
                      <td>{item.name}</td>
                      <td>{item.category}</td>
                      <td>{item.unit}</td>
                      <td>{item.state}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="empty-state">
              <span className="empty-icon">
                <Database aria-hidden="true" size={21} />
              </span>
              <h3>Catálogo listo para administrar</h3>
              <p>
                El formulario de alta se habilita para Sixteam cuando el backend
                esté conectado.
              </p>
            </div>
          )}
        </section>
      </div>
    </>
  );
}
import * as React from "react";
