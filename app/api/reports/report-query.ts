import { z } from "zod";
import { PAYMENT_METHOD_VALUES, PAYMENT_STATUS_VALUES } from "../../../lib/http/schemas";

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
const uuid = (label: string) => z.string().uuid(`${label} inválido`);
const period = z.string().regex(/^\d{4}-\d{2}$/, "Periodo inválido (use AAAA-MM)");

export const reportFiltersSchema = z
  .object({
    workId: z.string().uuid("Obra inválida").optional(),
    tagId: z.string().uuid("Etiqueta inválida").optional(),
    approverId: z.string().uuid("Aprobador inválido").optional(),
    // Centros de costo (UI, 2026-09-12): mismo criterio que workId/tagId/approverId — filtra por el
    // centro de costo EFECTIVO de la requisición (ver ReportFilters en lib/services/report-service.ts).
    costCenterId: uuid("Centro de costo").optional(),
    // RF-707 (adenda de pagos): empresa facturada de la requisición.
    billedCompanyId: uuid("Empresa facturada").optional(),
    period: period.optional(),
  })
  .strict();
export type ReportQueryFilters = z.infer<typeof reportFiltersSchema>;

/**
 * `GET /api/reports/export`: los filtros del reporte MÁS los dos propios del bloque "Comprometido vs
 * pagado" de la pantalla (medio y estado de pago), para que la hoja de ese bloque en el Excel salga con
 * las mismas cifras que se ven. Solo aplican a las órdenes, nunca a las filas de requisiciones.
 */
export const reportExportFiltersSchema = reportFiltersSchema.extend({
  paymentMethod: z.enum(PAYMENT_METHOD_VALUES, "Medio de pago inválido").optional(),
  paymentStatus: z.enum(PAYMENT_STATUS_VALUES, "Estado de pago inválido").optional(),
}).strict();

/** RF-707: filtros de `GET /api/reports/orders` (comprometido vs pagado). Sin aprobador ni etiqueta. */
export const orderReportFiltersSchema = z
  .object({
    workId: z.string().uuid("Obra inválida").optional(),
    costCenterId: uuid("Centro de costo").optional(),
    billedCompanyId: uuid("Empresa facturada").optional(),
    period: period.optional(),
    paymentMethod: z.enum(PAYMENT_METHOD_VALUES, "Medio de pago inválido").optional(),
    paymentStatus: z.enum(PAYMENT_STATUS_VALUES, "Estado de pago inválido").optional(),
  })
  .strict();
export type OrderReportQueryFilters = z.infer<typeof orderReportFiltersSchema>;
