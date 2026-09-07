export interface ReportExpense { date: string; work: string; tag?: string; supplier?: string; origin: "requisicion" | "caja_menor"; base: number; iva: number; total: number; }

/**
 * Reunión 2026-08-31 (Fase 6): formato real de la orden, calcado de la hoja "ORDEN DE ANTICIPO"
 * podada del Excel del cliente (ver docs/reunion-2026-08-31-analisis.md). Reemplaza el
 * `OrderDocument` provisional anterior (solo consecutivo/obra-cruda/proveedor-literal/ítems sin
 * IVA-ni-descuento). `ivaRate`/`discountRate` llegan como TASA (0..1) — el generador las imprime
 * como porcentaje, nunca la fracción cruda.
 */
export interface OrderDocumentCompany { name: string; nit?: string; }
export interface OrderDocumentSupplier { name: string; nit?: string; contact?: string; address?: string; email?: string; phone?: string; }
export interface OrderDocumentItem { description: string; unit: string; quantity: number; unitPrice: number; discountRate: number; ivaRate: number; base: number; iva: number; total: number; }
export interface OrderDocument {
  consecutive: string; type: "OC" | "OP"; date: string;
  company: OrderDocumentCompany; work: string; supplier?: OrderDocumentSupplier;
  items: OrderDocumentItem[]; subtotal: number; ivaTotal: number; total: number;
  paymentTerms?: string; elaboratedBy?: string; approvedBy?: string;
  /** Presente pero NO se imprime por defecto (acuerdo explícito con el cliente, reunión
   *  2026-08-31): el generador ya sabe pintarlo si algún día se activa (ver pdf.ts). */
  observations?: string;
  /** Pie de página con la dirección administrativa de la empresa. Ninguna tabla del modelo actual
   *  (ni `sociedades` ni `configuracion`) guarda este dato — ver informe de la tarea. Opcional a
   *  propósito: si no hay valor, el pie simplemente no se imprime en vez de inventar uno. */
  administrativeAddress?: string;
}
