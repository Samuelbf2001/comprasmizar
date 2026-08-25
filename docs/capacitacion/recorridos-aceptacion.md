# Recorridos de capacitación y aceptación

Estos recorridos son el guion de pruebas de usuario basado en PRD §11.2. Ejecutar con fixtures primero y luego con datos UAT autorizados.

## 1. Compra multi-proveedor

Solicitante público crea 3 ítems → Daniel normaliza y asigna 2 proveedores → envía a aprobación → Nelson aprueba → se generan 2 OCs con consecutivo/PDF → Daniel marca una cumplida y otra no cumplida → gasto aparece por obra y etiqueta → Contabilidad exporta.

**Resultado esperado:** no hay re-digitación, la no cumplida permanece pendiente, y el export cuadra. Bloqueos: P1, maestros reales, paridad y Kapso si el origen es WhatsApp.

## 2. Pago / cuenta de cobro

Solicitante crea tipo pago → Daniel revisa etiqueta nómina → Claudia aprueba → se genera OP → gasto queda en la obra.

**Resultado esperado:** OP separada de OC, aprobador correcto, gasto auditado.

## 3. Devolución

Aprobador devuelve con comentario → la requisición vuelve a Daniel → Daniel corrige → reenvía → aprobador aprueba.

**Resultado esperado:** comentario obligatorio, historial completo y sin duplicar requisición.

## 4. Declinación

Daniel declina con motivo → desaparece de vistas activas → se consulta en filtro de declinadas → no genera gasto.

**Resultado esperado:** registro terminal, motivo visible, cero OC y cero gasto.

## Checklist transversal

- [ ] Cada rol ve solo su bandeja y capacidad.
- [ ] Un acceso directo a una ruta no autorizada muestra rechazo, no solo menú oculto.
- [ ] Cada transición registra usuario, timestamp, comentario y origen.
- [ ] Los adjuntos respetan control de acceso.
- [ ] El formulario público está limitado a crear y protegido por el gate P2.
- [ ] El MCP puede leer/administrar lo permitido, pero no aprobar.
- [ ] Demo y UAT se reportan por separado.
