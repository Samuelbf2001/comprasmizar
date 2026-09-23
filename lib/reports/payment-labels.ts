import type { PaymentMethod, PaymentStatus } from "../domain";

/**
 * Textos de medio y estado de pago, SIN JSX: los usan la pantalla (components/screens/connected/
 * payment-labels.tsx los reexporta) y los archivos que arma el servidor (el Excel de Reportes,
 * lib/reports/xlsx.ts) — una sola copia, para que el Excel diga lo mismo que la pantalla.
 *
 * Adenda de pagos (docs/TASKS-pagos-y-caja.md, A1): la caja menor ES el medio `efectivo` del enum
 * `medio_pago` — el enum no cambia, cambia cómo se lee: "Caja (efectivo)".
 */
export const MEDIO_PAGO_LABELS: Record<PaymentMethod, string> = {
  efectivo: "Caja (efectivo)",
  transferencia: "Transferencia",
  cheque: "Cheque",
  tarjeta: "Tarjeta",
  otro: "Otro",
};
/** RF-508: `estado_pago` derivado (pendiente / parcial / pagada), nunca editable a mano. */
export const PAYMENT_STATUS_LABELS: Record<PaymentStatus, string> = {
  pendiente: "Sin pagar",
  parcial: "Pago parcial",
  pagada: "Pagada",
};
