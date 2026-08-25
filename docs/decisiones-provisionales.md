# Decisiones provisionales para preguntas abiertas

Estas decisiones permiten implementar y probar sin inventar una validación del cliente. Deben confirmarse en las sesiones del PRD antes de producción.

## P1 — Impuestos

El modelo admite base, IVA y total en pesos colombianos enteros. En esta versión se conservan esos importes; la tasa solo puede derivarse cuando los importes lo permitan y no se promete exactitud histórica de tarifa hasta el cierre P1. Retenciones y otros tributos quedan fuera hasta recibir el formato de Helisa y la decisión de contabilidad.

## P2 — Formulario público

Se adopta enlace por obra más código secreto. El código nunca se guarda en claro: solo un hash; no aparece en URL ni logs. La capacidad del enlace (`obra` + token HMAC) viaja en el fragmento `#`, que el navegador retira inmediatamente y que no se transmite al proxy ni al servidor; solo se envía después como encabezado al endpoint propio. Se mantiene una lista de solicitantes autorizados por teléfono como capacidad desactivable, y el endpoint debe aplicar rate-limit por obra e IP.

## P3 — Gastos compartidos

La v1 reparte manualmente montos enteros entre obras. La suma de líneas debe ser idéntica al total del gasto; no se permiten porcentajes implícitos, diferencias por redondeo ni una obra repetida.

## P4 — Formatos imprimibles

Se entrega una plantilla neutra con identidad Mizar y datos completos. Logos por sociedad, membrete y orden definitivo de columnas requieren los archivos reales de Claudia y Daniel.

## P5 — Propiedad de la plataforma

No se adopta una interpretación técnica ni comercial provisional. La propiedad, licencia y situación después del primer año deben quedar alineadas por Ernesto y Samuel en la propuesta/contrato antes de aceptación; el repositorio no convierte por sí mismo una promesa verbal en una condición contractual.

## P6 — Costos del canal WhatsApp

Kapso, Meta y el número de producción permanecen apagados hasta que Ernesto y Samuel confirmen plan, responsable de pago y presupuesto. El código no fija precios ni presupone que un plan comercial vigente hoy conservará sus condiciones.

## P7 — Alcance contratado

La arquitectura soporta Completo desde el inicio. Las integraciones externas se mantienen apagadas por configuración hasta confirmar contrato, credenciales y costos.
