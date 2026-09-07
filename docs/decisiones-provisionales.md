# Decisiones provisionales para preguntas abiertas

Estas decisiones permiten implementar y probar sin inventar una validación del cliente. Deben confirmarse en las sesiones del PRD antes de producción.

## P1 — Impuestos

El modelo admite base, IVA y total en pesos colombianos enteros. En esta versión se conservan esos importes; la tasa solo puede derivarse cuando los importes lo permitan y no se promete exactitud histórica de tarifa hasta el cierre P1. Retenciones y otros tributos quedan fuera hasta recibir el formato de Helisa y la decisión de contabilidad.

## P2 — Formulario público

Se adopta enlace por obra más contraseña secreta. **Actualización 2026-09-07 (decisión del cliente, literal de la reunión: "yo digo que sea solamente una contraseña para todo el mundo"):** la contraseña dejó de ser por obra y pasó a ser **GLOBAL** — una sola clave para todas las obras que tengan el portal habilitado. El enlace **sigue siendo por obra** (`obra` + token HMAC sobre `PUBLIC_FORM_CODE_PEPPER`, en el fragmento `#`, que el navegador retira inmediatamente y no se transmite al proxy ni al servidor; solo se envía después como encabezado al endpoint propio) y `obras.public_submission_enabled` sigue decidiendo qué obras aceptan el portal; lo único que cambió es contra qué se valida la contraseña. El hash global vive en la tabla singleton `acceso_publico` (migración `202609070002_acceso_publico_global.sql`, función `public.verificar_codigo_publico`) y se administra desde la plataforma (pestaña "Acceso público" en Catálogos, `PATCH /api/public-access`, solo admin_mizar/admin_sixteam) — nunca en claro ni en URL ni en logs. **Corrección 2026-09-07 (QA Postgres real, GRAVE):** la afirmación original decía también "ni en auditoría", y era falsa mientras el hash vivió dentro de `configuracion.valor` — esa columna no estaba en la lista de campos sensibles de `auditoria_campo_sensible` (que redacta por nombre de columna), así que el trigger genérico `escribir_auditoria` copiaba el bcrypt en claro a `auditoria` en cada cambio de contraseña, legible por revisor/contabilidad (policy `auditoria_lectura`). El arreglo (misma migración) fue mover el hash a su propia tabla con columna `public_code_hash`, que sí está en esa lista desde la migración base: ahora la auditoría de esa tabla la redacta como `{redactado:true}`, y `docs/modelo-datos.md` documenta el mecanismo. Verificado contra Postgres real: `select count(*) from auditoria where datos_cambio::text like '%$2a$%'` es 0 tras fijar una contraseña. La columna `obras.public_code_hash` queda obsoleta (comentada, no se lee ni se escribe; no se dropeó por ser una operación no aditiva). Se mantiene una lista de solicitantes autorizados por teléfono como capacidad desactivable, y el endpoint debe aplicar rate-limit por obra e IP.

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
