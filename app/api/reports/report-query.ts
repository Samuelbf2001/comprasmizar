import { z } from "zod";

/**
 * RF-1301 (Reportes, reunión 2026-09-11): filtros por obra, periodo (mes completo), aprobador y
 * etiqueta — mismo contrato de query params en `GET /api/reports` (JSON, pantalla) y
 * `GET /api/reports/export` (Excel), a propósito: la pantalla arma la URL de descarga añadiendo
 * `/export` al mismo `search` que ya usa para pedir los datos, sin traducir nada.
 *
 * Se define aparte de ambas rutas (y no dentro de una de las dos) por la misma razón que
 * `expensesReportFiltersSchema` vive en `app/api/reports/expenses-report.ts`: un único punto de verdad
 * para la validación evita que las dos rutas acepten combinaciones ligeramente distintas de filtros.
 */
export const reportFiltersSchema = z
  .object({
    workId: z.string().uuid("Obra inválida").optional(),
    tagId: z.string().uuid("Etiqueta inválida").optional(),
    approverId: z.string().uuid("Aprobador inválido").optional(),
    period: z.string().regex(/^\d{4}-\d{2}$/, "Periodo inválido (use AAAA-MM)").optional(),
  })
  .strict();
export type ReportQueryFilters = z.infer<typeof reportFiltersSchema>;
