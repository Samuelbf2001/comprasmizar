"use client";

// RF-1105 (percepción de carga): esqueletos por tipo de ruta para ConnectedScreen
// (components/screens/connected.tsx). Cada uno REPLICA el layout real de su pantalla
// (mismas clases estructurales, mismas alturas de tarjeta/tabla) para que al llegar
// los datos no haya salto de layout.
//
// Contrato de clases (también usado por el CSS del proyecto, no inventar nombres nuevos):
//   .skeleton            bloque base con animación de brillo (shimmer)
//   .skeleton-text       línea de texto (altura de una línea)
//   .skeleton-text.is-short   variante al 55% de ancho
//   .skeleton-title      título grande
//   .skeleton-number     cifra grande de tarjeta de métrica
//   .skeleton-card       tarjeta completa, misma altura que .stat-card (139px)
//   .skeleton-row        fila de tabla
//   .skeleton-chart      área de gráfico
// Estas son SIEMPRE formas vacías: ningún esqueleto de este archivo contiene una cifra,
// una fecha o un texto que pudiera confundirse con datos reales (hay pruebas que lo
// verifican en tests/unit/percepcion-carga.test.tsx).

import { SectionTitle } from "./screen-primitives";

export type RouteKind =
  | "dashboard"
  | "new"
  | "detail"
  | "requisitions"
  | "orders"
  | "expenses"
  | "catalogs";

function SkeletonPiece({
  variant,
  short = false,
}: {
  variant: "text" | "title" | "number";
  short?: boolean;
}) {
  const variantClass =
    variant === "title"
      ? "skeleton-title"
      : variant === "number"
        ? "skeleton-number"
        : "skeleton-text";
  return (
    <span
      className={`skeleton ${variantClass}${short ? " is-short" : ""}`}
      aria-hidden="true"
    />
  );
}

// Único texto que un lector de pantalla anuncia mientras carga: cada pieza visual del
// esqueleto lleva aria-hidden, así que sin esto la carga sería invisible para lectores
// de pantalla (regla dura del encargo, no es solo adorno).
function LoadingStatus({ label }: { label: string }) {
  return (
    <span className="sr-only" role="status">
      {label}
    </span>
  );
}

// .skeleton-card solo define alto/borde/radio (misma altura que .stat-card, 139px); el
// brillo lo aporta la clase base .skeleton, igual que en .skeleton-text/.skeleton-chart.
function StatCardSkeleton() {
  return <div className="skeleton skeleton-card" aria-hidden="true" />;
}

function PanelHeadSkeleton({ withBadge = true }: { withBadge?: boolean }) {
  return (
    <div className="panel-head">
      <div>
        <SkeletonPiece variant="title" />
      </div>
      {withBadge && <SkeletonPiece variant="text" short />}
    </div>
  );
}

// Igual que .skeleton-card: .skeleton-row solo define alto/margen/radio de una fila
// fantasma completa; una sola celda que ocupa todas las columnas la mantiene alineada
// bajo la cabecera real sin fingir columnas que todavía no existen.
function SkeletonTableRows({
  columns,
  rows = 6,
}: {
  columns: number;
  rows?: number;
}) {
  return (
    <>
      {Array.from({ length: rows }, (_, rowIndex) => (
        <tr key={rowIndex}>
          <td colSpan={columns}>
            <div className="skeleton skeleton-row" aria-hidden="true" />
          </td>
        </tr>
      ))}
    </>
  );
}

// Cabecera de tabla REAL (los mismos <th> que la pantalla final) con filas fantasma
// debajo: así ni una columna se corre cuando llegan los datos.
function TableSkeleton({
  headers,
  rows = 6,
}: {
  headers: string[];
  rows?: number;
}) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {headers.map((header, index) => (
              <th key={header || `col-${index}`}>{header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          <SkeletonTableRows columns={headers.length} rows={rows} />
        </tbody>
      </table>
    </div>
  );
}

export function bandejaTitle(pathname: string): string {
  if (pathname.startsWith("/revision")) return "Bandeja de revisión";
  if (pathname.startsWith("/aprobaciones")) return "Mis aprobaciones";
  return "Mis requisiciones";
}

export function expensesTitle(pathname: string): string {
  return pathname.startsWith("/reportes") ? "Reporte operativo" : "Gastos por obra";
}

function DashboardSkeleton() {
  return (
    <div aria-busy="true" data-testid="dashboard-skeleton">
      <SectionTitle
        eyebrow="Datos conectados"
        title="Pulso de compras"
        description="Métricas calculadas por el servicio para tu rol y el periodo actual."
      />
      <div className="stats-grid">
        <StatCardSkeleton />
        <StatCardSkeleton />
        <StatCardSkeleton />
        <StatCardSkeleton />
      </div>
      <div className="dashboard-grid">
        <section className="panel panel-alerts">
          <PanelHeadSkeleton withBadge={false} />
          {Array.from({ length: 3 }, (_, index) => (
            <div className="alert-item" aria-hidden="true" key={index}>
              <span className="alert-icon amber" />
              <span>
                <SkeletonPiece variant="text" />
                <SkeletonPiece variant="text" short />
              </span>
            </div>
          ))}
        </section>
        <section className="panel recent-panel">
          <PanelHeadSkeleton withBadge={false} />
          <ul className="activity-list" aria-hidden="true">
            {Array.from({ length: 3 }, (_, index) => (
              <li key={index}>
                <span>
                  <SkeletonPiece variant="text" />
                  <SkeletonPiece variant="text" short />
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>
      <div className="chart-grid">
        <div className="skeleton skeleton-chart" aria-hidden="true" />
        <div className="skeleton skeleton-chart" aria-hidden="true" />
        <div className="skeleton skeleton-chart" aria-hidden="true" />
      </div>
      <LoadingStatus label="Cargando panel de indicadores…" />
    </div>
  );
}

function RequisitionsSkeleton({ pathname }: { pathname: string }) {
  return (
    <div aria-busy="true" data-testid="requisitions-skeleton">
      <SectionTitle
        eyebrow="Datos conectados"
        title={bandejaTitle(pathname)}
        description="La API aplica alcance por actor antes de devolver cada fila."
      />
      <section className="panel">
        <PanelHeadSkeleton />
        <TableSkeleton
          headers={[
            "Requisición",
            "Obra",
            "Tipo",
            "Canal",
            "Etiqueta",
            "Fecha requerida",
            "Estado",
            "",
          ]}
        />
      </section>
      <LoadingStatus label="Cargando bandeja de requisiciones…" />
    </div>
  );
}

function OrdersSkeleton() {
  return (
    <div aria-busy="true" data-testid="orders-skeleton">
      <SectionTitle
        eyebrow="Datos conectados"
        title="Órdenes"
        description="OC y OP visibles según el rol autenticado; cada estado pertenece a su propia orden."
      />
      <section className="panel">
        <TableSkeleton
          headers={[
            "Orden",
            "Tipo",
            "Obra",
            "Requisición",
            "Fecha requerida",
            "Proveedor",
            "Estado",
            "",
          ]}
        />
      </section>
      <LoadingStatus label="Cargando órdenes…" />
    </div>
  );
}

function ExpensesSkeleton({ pathname }: { pathname: string }) {
  return (
    <div aria-busy="true" data-testid="expenses-skeleton">
      <SectionTitle
        eyebrow="Datos conectados"
        title={expensesTitle(pathname)}
        description="Lectura autorizada del libro común de gastos, incluidas las entradas de caja menor."
      />
      <div className="connected-detail-grid">
        <section className="panel">
          <div className="panel-head">
            <div>
              <SkeletonPiece variant="number" />
              <SkeletonPiece variant="text" short />
            </div>
          </div>
          <TableSkeleton
            headers={["Fecha", "Obra", "Origen", "Periodo", "Total"]}
          />
        </section>
        <section className="panel connected-summary">
          <PanelHeadSkeleton withBadge={false} />
          <TableSkeleton headers={["Obra", "Etiqueta", "Subtotal"]} rows={4} />
        </section>
      </div>
      <LoadingStatus label="Cargando gastos…" />
    </div>
  );
}

// Las columnas del catalogo dependen del tipo, y el tipo sale del pathname exactamente
// igual que en ConnectedCatalogAdmin (catalog-admin.tsx): si el esqueleto usara una
// cabecera fija, la tabla se ensancharia al llegar los datos, que es justo el salto
// que estos esqueletos existen para evitar.
const COLUMNAS_CATALOGO: Record<string, string[]> = {
  works: ["Nombre", "Sociedad", "Estado", "Acciones"],
  tags: ["Nombre", "Aprobador", "Estado", "Acciones"],
  items: ["Nombre", "Unidad", "Categoría", "Estado", "Acciones"],
  suppliers: ["Nombre", "NIT", "Contacto", "Estado", "Acciones"],
  societies: ["Nombre", "NIT", "Estado", "Acciones"],
  users: ["Nombre", "Correo", "Roles", "Estado", "Acciones"],
};
function columnasDesdeRuta(pathname: string): string[] {
  if (pathname.startsWith("/proveedores")) return COLUMNAS_CATALOGO.suppliers;
  if (pathname.startsWith("/catalogos/obras")) return COLUMNAS_CATALOGO.works;
  if (pathname.startsWith("/catalogos/etiquetas")) return COLUMNAS_CATALOGO.tags;
  if (pathname.startsWith("/catalogos/items")) return COLUMNAS_CATALOGO.items;
  if (pathname.startsWith("/catalogos/sociedades")) return COLUMNAS_CATALOGO.societies;
  if (pathname.startsWith("/catalogos/usuarios")) return COLUMNAS_CATALOGO.users;
  // Sin tipo en la ruta la pantalla real abre la primera pestana permitida (Obras
  // para los roles que la ven); es la aproximacion mas cercana disponible.
  return COLUMNAS_CATALOGO.works;
}

function CatalogsSkeleton({ pathname }: { pathname: string }) {
  const tabs = [
    "Obras",
    "Etiquetas",
    "Ítems",
    "Proveedores",
    "Sociedades",
    "Usuarios",
  ];
  return (
    <div aria-busy="true" data-testid="catalogs-skeleton">
      <SectionTitle
        eyebrow="Administración conectada"
        title="Catálogos"
        description="Altas, edición y desactivación reversible mediante el servicio autenticado."
      />
      <div
        className="catalog-admin-tabs"
        role="tablist"
        aria-label="Catálogos administrables"
      >
        {tabs.map((tab) => (
          <button type="button" disabled aria-hidden="true" key={tab}>
            {tab}
          </button>
        ))}
      </div>
      <section className="panel">
        <TableSkeleton headers={columnasDesdeRuta(pathname)} rows={5} />
      </section>
      <LoadingStatus label="Cargando catálogos…" />
    </div>
  );
}

function NewRequisitionSkeleton() {
  const fields = [
    "Tipo",
    "Obra",
    "Fecha requerida",
    "Frente o actividad",
    "Observaciones",
    "Soporte general (opcional)",
  ];
  return (
    <div aria-busy="true" data-testid="new-requisition-skeleton">
      <SectionTitle
        eyebrow="Captura interna conectada"
        title="Nueva requisición"
        description="Los datos se validan y guardan en una sola transacción; los ítems nuevos quedan pendientes de normalización."
      />
      <div className="panel connected-form">
        <div className="form-section">
          <div className="field-grid">
            {fields.map((label) => (
              <label className="field" key={label}>
                <span>{label}</span>
                <SkeletonPiece variant="text" />
              </label>
            ))}
          </div>
        </div>
      </div>
      <LoadingStatus label="Cargando formulario de requisición…" />
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div aria-busy="true" data-testid="detail-skeleton">
      <div className="section-title">
        <div>
          <div className="eyebrow">Detalle conectado</div>
          <h1>
            <SkeletonPiece variant="title" />
          </h1>
          <p>
            <SkeletonPiece variant="text" short />
          </p>
        </div>
      </div>
      <div className="connected-detail-grid">
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>Ítems y cotización</h2>
              <p className="panel-sub">
                <SkeletonPiece variant="text" short />
              </p>
            </div>
          </div>
          {Array.from({ length: 3 }, (_, index) => (
            <fieldset className="review-line" aria-hidden="true" key={index}>
              <SkeletonPiece variant="text" />
              <SkeletonPiece variant="text" short />
            </fieldset>
          ))}
        </section>
        <section className="panel connected-summary">
          <h3>Control</h3>
          <SkeletonPiece variant="text" />
          <SkeletonPiece variant="text" short />
        </section>
        <section className="panel connected-summary">
          <h3>Soportes y fotos</h3>
          <SkeletonPiece variant="text" short />
        </section>
        <section className="panel connected-summary">
          <h3>Historial de trazabilidad</h3>
          <SkeletonPiece variant="text" />
          <SkeletonPiece variant="text" short />
        </section>
      </div>
      <LoadingStatus label="Cargando detalle de la requisición…" />
    </div>
  );
}

export function RouteSkeleton({
  kind,
  pathname,
}: {
  kind: RouteKind;
  pathname: string;
}) {
  if (kind === "dashboard") return <DashboardSkeleton />;
  if (kind === "requisitions") return <RequisitionsSkeleton pathname={pathname} />;
  if (kind === "orders") return <OrdersSkeleton />;
  if (kind === "expenses") return <ExpensesSkeleton pathname={pathname} />;
  if (kind === "catalogs") return <CatalogsSkeleton pathname={pathname} />;
  if (kind === "new") return <NewRequisitionSkeleton />;
  return <DetailSkeleton />;
}
