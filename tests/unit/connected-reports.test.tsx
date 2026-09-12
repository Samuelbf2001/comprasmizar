// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ConnectedReports } from "../../components/screens/connected";
import type { ReportBundle } from "../../components/screens/connected/shared";

afterEach(() => cleanup());

const catalogs: ReportBundle["catalogs"] = {
  works: [
    { id: "work-1", name: "Altos de La Pradera" },
    { id: "work-2", name: "Bodega Industrial Norte" },
  ],
  tags: [
    { id: "tag-1", name: "Materiales" },
    { id: "tag-2", name: "Servicios" },
  ],
  suppliers: [],
  items: [],
  features: {},
  users: [
    { id: "juliana", name: "Juliana Rojas" },
    { id: "nelson", name: "Nelson Ríos" },
  ],
  approvers: [
    { id: "juliana", name: "Juliana Rojas" },
    { id: "nelson", name: "Nelson Ríos" },
  ],
};

const rows: ReportBundle["rows"] = [
  {
    id: "req-1", consecutive: "REQ-2026-0001", date: "2026-08-15T00:00:00.000Z",
    workId: "work-1", tagId: "tag-1", approverIds: ["juliana"], status: "aprobada",
    supplierIds: [], base: 100_000, iva: 19_000, total: 119_000, items: [],
  },
  {
    id: "req-2", consecutive: "REQ-2026-0002", date: "2026-09-05T00:00:00.000Z",
    workId: "work-2", tagId: "tag-2", approverIds: ["nelson"], status: "en_aprobacion",
    supplierIds: [], base: 50_000, iva: 9_500, total: 59_500, items: [],
  },
  {
    id: "req-3", consecutive: "REQ-2026-0003", date: "2026-09-20T00:00:00.000Z",
    workId: "work-1", tagId: "tag-1", approverIds: ["juliana"], status: "en_aprobacion",
    supplierIds: [], base: 30_000, iva: 5_700, total: 35_700, items: [],
  },
];

function exportHref(): string {
  return screen.getByRole("link", { name: /descargar excel/i }).getAttribute("href") ?? "";
}

describe("RF-1301: filtros de Reportes mandan los parámetros correctos (pantalla + descarga)", () => {
  it("filtra por obra ocultando filas de otras obras, y el enlace de descarga lleva workId", () => {
    render(<ConnectedReports data={{ rows, catalogs }} role="Contabilidad" />);
    expect(screen.getByText("REQ-2026-0001")).toBeInTheDocument();
    expect(screen.getByText("REQ-2026-0002")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Obra"), { target: { value: "work-1" } });

    expect(screen.getByText("REQ-2026-0001")).toBeInTheDocument();
    expect(screen.getByText("REQ-2026-0003")).toBeInTheDocument();
    expect(screen.queryByText("REQ-2026-0002")).toBeNull();
    expect(exportHref()).toContain("workId=work-1");
  });

  it("filtra por mes (periodo) y el enlace de descarga lleva period", () => {
    render(<ConnectedReports data={{ rows, catalogs }} role="Contabilidad" />);
    fireEvent.change(screen.getByLabelText("Mes"), { target: { value: "2026-09" } });
    expect(screen.queryByText("REQ-2026-0001")).toBeNull();
    expect(screen.getByText("REQ-2026-0002")).toBeInTheDocument();
    expect(screen.getByText("REQ-2026-0003")).toBeInTheDocument();
    expect(exportHref()).toContain("period=2026-09");
  });

  it("filtra por aprobador y por etiqueta, combinados, con el enlace de descarga llevando ambos", () => {
    render(<ConnectedReports data={{ rows, catalogs }} role="Contabilidad" />);
    fireEvent.change(screen.getByLabelText("Aprobador"), { target: { value: "juliana" } });
    fireEvent.change(screen.getByLabelText("Etiqueta"), { target: { value: "tag-1" } });
    expect(screen.getByText("REQ-2026-0001")).toBeInTheDocument();
    expect(screen.getByText("REQ-2026-0003")).toBeInTheDocument();
    expect(screen.queryByText("REQ-2026-0002")).toBeNull();
    const href = exportHref();
    expect(href).toContain("approverId=juliana");
    expect(href).toContain("tagId=tag-1");
  });

  // RF-1301 punto 3: Juliana (aprobadora) entra viendo por defecto solo lo que ya aprobó.
  it("un Aprobador ve 'Aprobadas por mí' marcado por defecto y solo requisiciones aprobadas", () => {
    render(<ConnectedReports data={{ rows, catalogs }} role="Aprobador" />);
    const toggle = screen.getByLabelText(/aprobadas por mí/i) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    expect(screen.getByText("REQ-2026-0001")).toBeInTheDocument();
    expect(screen.queryByText("REQ-2026-0002")).toBeNull();
    expect(screen.queryByText("REQ-2026-0003")).toBeNull();

    fireEvent.click(toggle);
    expect(screen.getByText("REQ-2026-0003")).toBeInTheDocument();
  });

  it("un rol Contabilidad no ve el toggle 'Aprobadas por mí' (es exclusivo del Aprobador)", () => {
    render(<ConnectedReports data={{ rows, catalogs }} role="Contabilidad" />);
    expect(screen.queryByLabelText(/aprobadas por mí/i)).toBeNull();
  });

  it("Revisor ve la pantalla pero SIN botón de descarga (report:read, no report:export)", () => {
    render(<ConnectedReports data={{ rows, catalogs }} role="Revisor" />);
    expect(screen.getByText("REQ-2026-0001")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /descargar excel/i })).toBeNull();
  });

  it("el compilado mensual (con mes elegido) muestra subtotales por obra", () => {
    render(<ConnectedReports data={{ rows, catalogs }} role="Contabilidad" />);
    expect(screen.queryByTestId("report-work-subtotals")).toBeNull();
    fireEvent.change(screen.getByLabelText("Mes"), { target: { value: "2026-09" } });
    const subtotals = screen.getByTestId("report-work-subtotals");
    expect(subtotals).toBeInTheDocument();
    expect(subtotals.textContent).toContain("Altos de La Pradera");
    expect(subtotals.textContent).toContain("Bodega Industrial Norte");
  });
});
