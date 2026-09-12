/**
 * Reunión 2026-09: "la fecha del gasto es la del pago" — `orderDate` (nace con el registro) siempre
 * viaja; `date` (fecha de pago) falta mientras la orden no se ha pagado. El reporte filtrado por
 * periodo solo puede incluir filas con `date` (ver buildExpensesReport): un reporte sin filtro de
 * periodo sí puede traer filas sin pagar, así que todo consumidor de este tipo debe tolerar `date`
 * ausente.
 */
export interface ReportExpense { orderDate: string; date?: string; work: string; tag?: string; supplier?: string; origin: "requisicion" | "caja_menor"; base: number; iva: number; total: number; }

/**
 * Reunión 2026-08-31 (Fase 6): formato real de la orden, calcado de la hoja "ORDEN DE ANTICIPO"
 * podada del Excel del cliente (ver docs/reunion-2026-08-31-analisis.md). Reemplaza el
 * `OrderDocument` provisional anterior (solo consecutivo/obra-cruda/proveedor-literal/ítems sin
 * IVA-ni-descuento). `ivaRate`/`discountRate` llegan como TASA (0..1) — el generador las imprime
 * como porcentaje, nunca la fracción cruda.
 */
export interface OrderDocumentCompany { name: string; nit?: string; }
/**
 * Solicitud de pago (feat/solicitud-de-pago): `bankDetails` solo se puebla (y solo se imprime,
 * ver pdf.ts) para una OP — los datos bancarios del proveedor (`proveedores.datos_bancarios`) hoy
 * nunca salían de su ficha (components/screens/suppliers.tsx); una orden de pago es la primera
 * superficie que los necesita impresos, para que el beneficiario sepa a qué cuenta se le pagó.
 */
export interface OrderDocumentBankDetails { bankName?: string; accountType?: "ahorros" | "corriente"; accountNumber?: string; accountHolder?: string; accountHolderNit?: string; }
export interface OrderDocumentSupplier { name: string; nit?: string; contact?: string; address?: string; email?: string; phone?: string; bankDetails?: OrderDocumentBankDetails; }
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
