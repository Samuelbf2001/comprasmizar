# Manual del aprobador

## Propósito

Tomar una decisión de control interno sobre la bandeja personal asignada por etiqueta.

## Flujo

1. Entra con usuario y contraseña; abre **Aprobaciones**.
2. Revisa solo las requisiciones enrutadas a tu bandeja: obra, solicitante, ítems, proveedor, valores, impuestos y soportes.
3. Si todo es correcto, aprueba. La aprobación debe registrar quién y cuándo.
4. Si falta información, devuelve con comentario obligatorio. La requisición regresa a Daniel para corregir y reenviar.

No apruebes desde un enlace público, desde la bandeja de Kapso ni desde el MCP. El PRD reserva este acto a la interfaz autenticada.

## Roles y alcance

Nelson gestiona materiales, Claudia nómina, Juliana el resto y Daniel casos menores, según la etiqueta configurada. La regla debe vivir en el catálogo; si cambia el aprobador, debe auditarse la edición.

## Estado actual

`/aprobaciones` usa datos sintéticos únicamente en demo. Fuera de demo consulta la bandeja autorizada y el detalle permite aprobar o devolver con comentario; la aprobación genera órdenes/gastos en la misma transacción. La separación por rol tiene pruebas locales de servicio, pero aún requiere migraciones/RLS y un recorrido con usuarios reales antes de aceptación.

## Checklist

- [ ] Solo veo mi bandeja personal.
- [ ] Puedo distinguir compra de pago y revisar soportes.
- [ ] Devolver exige comentario y regresa a Daniel.
- [ ] Aprobar genera OC/OP y gasto en el recorrido conectado.
- [ ] No existe una herramienta MCP para aprobar o denegar.
