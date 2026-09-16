import type { PaymentMethod, PaymentStatus } from "../../../lib/domain";

/**
 * Adenda de pagos (docs/TASKS-pagos-y-caja.md, A1): la caja menor ES el medio `efectivo` del enum
 * `medio_pago` — el enum no cambia, cambia cómo se lee: "Caja (efectivo)". Vive aparte de `shared.tsx`
 * para que las superficies de la ola 2 (órdenes, cierre de caja, reportes) importen de aquí sin tocar
 * ese archivo compartido. `paymentMethodLabel` de shared.tsx sigue diciendo "Efectivo" para lo que ya
 * lo usa (gastos directos de caja, ingresos); las pantallas de pagos de orden usan ESTE mapa.
 */
export const MEDIO_PAGO_LABELS: Record<PaymentMethod, string> = {
  efectivo: "Caja (efectivo)",
  transferencia: "Transferencia",
  cheque: "Cheque",
  tarjeta: "Tarjeta",
  otro: "Otro",
};
export const MEDIO_PAGO_OPTIONS: readonly { value: PaymentMethod; label: string }[] = (Object.keys(MEDIO_PAGO_LABELS) as PaymentMethod[]).map((value) => ({ value, label: MEDIO_PAGO_LABELS[value] }));
export function medioPagoLabel(method: string): string {
  return (MEDIO_PAGO_LABELS as Record<string, string>)[method] ?? method;
}

/** RF-508: `estado_pago` derivado (pendiente / parcial / pagada), nunca editable a mano. */
export const PAYMENT_STATUS_LABELS: Record<PaymentStatus, string> = {
  pendiente: "Sin pagar",
  parcial: "Pago parcial",
  pagada: "Pagada",
};
const PAYMENT_STATUS_TONE: Record<PaymentStatus, string> = { pendiente: "muted", parcial: "warning", pagada: "success" };
export function paymentStatusLabel(status: string): string {
  return (PAYMENT_STATUS_LABELS as Record<string, string>)[status] ?? status;
}
/**
 * Misma clase `.badge badge-<tono>` que el resto de insignias de estado (app/globals.css), con
 * `badge-outline` para que el estado de PAGO no se confunda con el eje administrativo
 * (pendiente/contabilizada/pagada) que ya se pinta relleno en la misma fila — son dos ejes distintos.
 */
export function PaymentStatusBadge({ status, className }: { status: PaymentStatus | undefined; className?: string }) {
  if (!status) return null;
  return (
    <span className={`badge badge-outline badge-${PAYMENT_STATUS_TONE[status]}${className ? ` ${className}` : ""}`} data-payment-status={status}>
      <span className="badge-dot" aria-hidden="true" />
      {PAYMENT_STATUS_LABELS[status]}
    </span>
  );
}
