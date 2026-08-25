# Manual de contabilidad

## Propósito

Consultar gastos por obra y periodo, revisar soportes y descargar el archivo que se cargará en Helisa.

## Flujo mensual

1. Abre **Gastos y caja menor**.
2. Filtra por obra, sociedad y periodo del corte (1–30 según el PRD).
3. Revisa subtotales por etiqueta y separa el origen de requisición frente a caja menor.
4. Descarga la exportación compatible con Helisa y verifica totales contra el reporte imprimible.
5. Conserva los soportes de proveedor conforme a los permisos de acceso.

Contabilidad es solo lectura + exportación. No debe editar catálogos, aprobar, normalizar ítems ni registrar caja menor.

## Estado y gates

La demo muestra gastos y reportes sintéticos de forma explícita. Fuera de demo, las vistas leen el libro común de gastos según el rol y no habilitan escrituras a Contabilidad. La salida XLSX disponible en código permanece marcada `PROVISIONAL`; la carga de Helisa no está validada. P1 sigue abierto para definir retenciones, IVA y formato exacto, y la paridad contra un mes real de GASTOS EN OBRAS.xlsx es bloqueante (PRD §11.1 y §15).

## Checklist

- [ ] El total por obra y periodo cuadra al peso con el dataset dorado.
- [ ] Caja menor está incluida y marcada por origen.
- [ ] El archivo exportado carga en Helisa sin retrabajo.
- [ ] El usuario contable no puede escribir ni aprobar, incluso llamando un endpoint.
