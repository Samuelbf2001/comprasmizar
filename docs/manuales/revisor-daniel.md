# Manual del revisor / Daniel

## Propósito

Convertir una solicitud entrante en una compra o pago listo para aprobación, manteniendo la trazabilidad y evitando re-digitación.

## Bandeja de revisión

1. Abre **Revisión de Daniel**; la lista conectada reúne canales y estados activos. Los filtros avanzados por obra, canal, fecha y etiqueta todavía deben completarse y validarse.
2. Revisa el origen: web interna, formulario público o WhatsApp.
3. Normaliza el ítem contra el catálogo maestro. Si es nuevo, déjalo pendiente de normalización; no crees duplicados.
4. Asigna etiqueta. La etiqueta determina el aprobador en datos, no en una regla personal.
5. Asigna proveedor final por ítem, independiente del proveedor sugerido por el solicitante.
6. Registra cotización y desglose base, IVA y total cuando el formato de contabilidad esté confirmado.
7. Inicia la revisión, guarda etiqueta/ítems/cotización y luego envía a aprobación. El servidor no permite enviar líneas sin proveedor final o con cotización cero. Para declinar, registra el motivo; declinar no elimina.

La vista Kanban ayuda a ordenar recibida → revisión → aprobación → aprobada. El historial debe conservar usuario, fecha, transición y comentario.

## Órdenes y gastos

Una aprobación debe generar OC u OP con consecutivo y registrar el gasto en la obra. En Completo, los proveedores finales distintos deben generar una OC por proveedor. Marca cada OC como cumplida, no cumplida o no necesario; las no cumplidas alimentan pendientes.

## Caja menor

Registra obra, fecha, concepto, etiqueta, valor y soporte. Caja menor no pasa por aprobación de requisición, pero debe aparecer en gastos y exportaciones con su origen.

## Disponible y gates

La demo navegable muestra `/revision`, estados y Kanban sin persistencia. En modo conectado, el detalle permite iniciar/revisar/enviar/declinar, consulta catálogos autenticados, registra cotización, actualiza cumplimiento y registra caja menor mediante APIs. Quedan por aceptar filtros avanzados, adjuntos, P1 (impuestos/Helisa), P3 (reparto compartido), datos maestros reales, migraciones/RLS, auditoría en BD y UAT.

## Checklist de Daniel

- [ ] Normalización no crea duplicados y solo Daniel puede editar el catálogo de ítems.
- [ ] El enrutamiento por etiqueta llega al aprobador correcto.
- [ ] Devolver y declinar exigen el comportamiento del PRD.
- [ ] Una compra con dos proveedores produce dos OCs en el recorrido E2E.
- [ ] Una OC no cumplida permanece visible hasta su actualización.
- [ ] Caja menor aparece en el reporte de la obra.
