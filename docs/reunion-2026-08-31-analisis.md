# Análisis de la reunión con Mizar — 31 de agosto de 2026

**Reunión:** "Revisión Proceso de Compras | Sixteam" · 58 min
**Participantes:** Samuel Burgos (Sixteam) · Daniel / PROIM INGENIERIA (Mizar)
**Método:** recorrido del proceso real de compras sobre los formatos Excel actuales, decidiendo campo por campo qué queda, qué se elimina y qué cambia.

Cada bloque cruza lo que se habló con el estado real del código de la plataforma, para separar **lo que ya está OK** de **lo que hay que cambiar**.

---

## Resumen ejecutivo

**Lo que la reunión cambió de fondo (3 cosas):**

1. **El solicitante ya no elige obra: elige EMPRESA.** La obra / centro de costo la asigna Daniel en la revisión. Esto rompe el modelo actual, donde `requisiciones.obra_id` es obligatorio desde la creación.
2. **Aprobación parcial por ítem.** Tanto Daniel como el aprobador (Nelson/Juliana) pueden declinar ítems sueltos o cambiar cantidades, no solo aprobar/rechazar la requisición completa. Hoy eso no existe en el modelo.
3. **El contador entra al flujo como rol operativo**, no como destinatario de un PDF impreso: entra martes y viernes, descarga órdenes + RUT del proveedor, y marca **"contabilizado"**. Falta ese estado.

**Lo que quedó confirmado sin cambios:** los tipos requisición compra/pago, la división de una requisición en varias órdenes por proveedor, el proveedor por ítem, el catálogo de ítems creable sobre la marcha, el RUT como adjunto del proveedor nuevo, el canal WhatsApp para maestros y web para profesionales.

**Pendientes de Mizar (Daniel):** lista de empresas activas · lista de ~100 materiales frecuentes.

---

## Bloque 00:00 – 02:00 · Tipos de solicitud

**Se habló de:** cómo se subdividen las requisiciones.

**Decisión:** existen **dos tipos**: `orden de compra` y `orden de pago`. Se descartó explícitamente crear un tercer tipo ("orden de servicios" / "anticipo") — *"si le damos mucha amplitud al tema… a futuro se nos vuelve más engorroso"*. Los **anticipos se registran como orden de pago** con la aclaración en observaciones.

**Estado:** ✅ **Ya está OK.** El enum `tipo_requisicion` es `('compra','pago')` y `tipo_documento` es `('REQ','OC','OP')`.

**Acción:** ninguna en código. Documentar la convención "anticipo = OP + observación" en el manual y en la capacitación, para que no se pida un tipo nuevo dentro de tres meses.

---

## Bloque 02:00 – 04:30 · El problema real: hoy nadie llena la requisición

**Se habló de:** cómo funciona hoy en la vida real.

**Confesión clave del cliente:** *"yo cuando puedo omitir los Exceles los omito… yo no monto una requisición siempre, ni monto una orden de compra siempre"*. Compra directo por WhatsApp con proveedores conocidos y pasa la cotización a contabilidad. **En teoría está mal, y él lo sabe** — no lo hace por descuido sino porque el proceso formal le cuesta más tiempo del que tiene.

**Conclusión:** el enemigo del proyecto **no es la falta de funcionalidad: es la fricción**. Si montar una requisición cuesta más que escribir un WhatsApp, el sistema se abandona y volvemos al Excel omitido.

**Riesgo declarado por el propio cliente:** los maestros de obra no van a montar requisiciones al principio (*"yo sé que muy seguramente lo voy a tener que hacer yo"*). Acepta absorber ese costo al arranque a cambio de que se empiece a construir la trazabilidad.

**Acción de diseño (transversal, no es un ticket):** cada campo que se agregue debe justificarse contra este riesgo. Toda la poda de campos de los bloques siguientes viene de aquí.

**Acción de proyecto:** medir en la primera semana **cuántas requisiciones monta Daniel vs. cuántas montan otros**. Es el indicador temprano de si el sistema está siendo adoptado o solo está trasladando el trabajo a una persona.

---

## Bloque 04:30 – 08:00 · Encabezado: código interno y NIT

**Se habló de:** los campos del encabezado del formato Excel actual.

**Decisiones:**
- **Código interno de obra → se elimina.** Era un sistema heredado que nadie entiende (*"yo nunca lo entendí"*).
- **NIT en el encabezado → se elimina del formulario**, pero la relación se conserva: es un dato derivado de la empresa, no un campo que alguien escriba.

**Estado:** ✅ **Ya está OK.** El NIT vive en `sociedades` y en `proveedores.nit`, no en la requisición. No hay campo "código interno" en el modelo.

**Acción:** confirmar que el formulario web y el Flow no piden ninguno de los dos.

---

## Bloque 08:00 – 13:00 · ⚠️ EL CAMBIO MÁS GRANDE: empresa vs. obra

**Se habló de:** cómo el solicitante identifica a dónde va el gasto.

Daniel mostró su cuadro interno de control (`GASTOS EN OBRAS`), que es el corazón de su operación: por él le cobra a los socios y controla cuánto lleva gastado cada contrato. Explicó la complejidad real: Mizar factura a Ictinus, Palmoc es dueño de "Miradores de Cantalta" pero Mizar es el vendedor, Juliana tiene su propio centro de costos dentro de Misar, etc.

**Decisión:**
- El **solicitante elige EMPRESA** (Misar, Ictinus, Villa del Sol, Proim, Palmoc…), **no obra**.
- La **obra / centro de costo la asigna Daniel** en la revisión: *"es mejor que ellos no definan a quién se va a cargar… que eso yo sea el que lo decida"*.
- La obra se asigna **a la requisición completa**, no por ítem (confirmado explícitamente en el minuto 34:50 tras una confusión).

**Estado:** ❌ **Requiere cambio de modelo de datos.** Hoy `requisiciones.obra_id` es `not null` y se exige desde la creación (`supabase/migrations/202608240001_core_compras.sql`), y `createRequisition` recibe `workId` obligatorio (`lib/services/procurement-service.ts`).

**Cambios concretos:**
1. Agregar `requisiciones.sociedad_id`, obligatorio en la creación.
2. Hacer `requisiciones.obra_id` **nullable**, y exigirlo solo para pasar a `en_aprobacion`.
3. La bandeja de revisión debe permitir a Daniel **fijar la obra**, filtrando obras por la sociedad elegida.
4. El WhatsApp Flow y el formulario web cambian el selector "obra" por "empresa".

**⚠️ Consecuencia que nadie detectó en la llamada:** la lista blanca de teléfonos autorizados (`obra_solicitantes_autorizados`) está atada a la **obra**. Si el solicitante ya no elige obra, esa validación se queda sin sujeto. **Hay que decidir**: ¿la autorización pasa a ser por **sociedad**, o global con rol? Es bloqueante para el canal WhatsApp — llevarlo a la próxima reunión.

**Objeción sana que planteó Samuel y quedó resuelta:** *"¿y si mañana entra un ayudante para ti?"* — Daniel aceptó que es conocimiento aprendible y que la empresa **sí debe capturarse**, en vez de dejar la requisición sin ninguna referencia. Buena resolución: se evitó un sistema que dependa de una sola persona.

---

## Bloque 13:00 – 17:30 · Empresas y centros de costo

**Se habló de:** validar que el eslabón débil (el maestro) pueda dar ese dato.

**Decisión:** sí, con capacitación. La lista mostrada es de **empresas activas**, cerrada, no texto libre.

**Pendiente del cliente:** 📌 **Daniel debe enviar la lista de empresas activas.**

**Estado:** ✅ La tabla `sociedades` ya existe y `obras` ya apunta a `sociedad_id`. Solo falta cargar los datos reales (ya estaba listado en `docs/ESTADO-Y-PENDIENTES.md` §3.2).

---

## Bloque 21:00 – 23:30 · Poda de campos del encabezado

**Se habló de:** los campos restantes del formato de requisición.

**Decisiones — se eliminan:**
- `dependencia / obra` (era el nombre largo del contrato de obra pública, ya no se trabaja así)
- `frente / actividad`

**Se conservan:**
- **Fecha de solicitud** → automática, interna. ✅ Ya está (`created_at`).
- **Fecha en que se requiere** → **se vuelve OPCIONAL.** Daniel primero quiso eliminarla, Samuel propuso dejarla opcional y quedó así.

**Estado:** ⚠️ **Parcialmente OK.** La columna `requisiciones.fecha_requerida` **ya es nullable en la base**, pero el **servicio la exige**: `createRequisition` hace `Number(input.requiredDate.slice(0,4))` para calcular el año del consecutivo y falla si no es válida (`lib/services/procurement-service.ts`).

**Cambio concreto:** el año del consecutivo debe salir de `now()`, no de la fecha requerida. Sin esto, "opcional" es imposible.

---

## Bloque 23:30 – 25:00 · Poda de campos de ítem

**Se habló de:** las columnas de la tabla de ítems del Excel.

**Decisiones — se eliminan:** `talla`, `valor cotizado`, `valor presupuestado`, `diferencia`. Eran de la época de obra pública, cuando cada obra tenía su propia persona de compras que cotizaba en paralelo. **Ese proceso ya no existe.**

**Se conserva en la captura:** `descripción del ítem`, `cantidad`, `unidad de medida`.

**Adicional:** si el solicitante conoce un proveedor, **adjunta la cotización o lo escribe en observaciones** — no en un campo estructurado.

**Estado:** ✅ **Ya está OK.** `requisicion_items` tiene `posible_proveedor_texto` y `link_producto` como texto libre, y no tiene talla ni valor presupuestado.

**Acción menor:** revisar el campo `requisiciones.destino` — venía del Excel viejo y **no se mencionó** en la poda. Preguntar si se queda o se va.

---

## Bloque 25:00 – 29:00 · Catálogo de ítems

**Se habló de:** de dónde sale la lista base de materiales (petición previa de Claudia: que el usuario elija de una lista, no escriba libre).

**Decisión:** Daniel arma él mismo la lista con ayuda de IA y la depura — *"unas 100 cosas: cemento, varilla, arena, triturados, tuberías…"*. Se descartó extraerla de los Excel de gastos porque no tienen el detalle (*"conectores concéntricos, pero no dice cuántos ni de qué cantidad"*).

**Decisión complementaria:** debe poderse **crear un ítem nuevo sobre la marcha**.

**Estado:** ✅ **Ya está OK.** `items` tiene `estado: pendiente_normalizacion` y `item_canonico_id` para fusionar duplicados, y existe el importador `scripts/import-master-data.ts`.

**Pendiente del cliente:** 📌 **Daniel debe enviar la lista de ~100 materiales frecuentes.**

---

## Bloque 29:00 – 31:00 · Quién puede radicar

**Se habló de:** control de acceso a la creación de requisiciones.

**Decisión:**
- **Profesionales (ingenieros civiles):** acceso por **link/web con credenciales** — tienen "un grado más de confianza".
- **Maestros:** por **WhatsApp**, con lista blanca de números.
- Samuel propuso **una sola contraseña para el link**; lo acordado es que **no puede quedar abierto** a cualquier número o a cualquiera que entre al link.

**Estado:** ⚠️ **Divergencia con lo implementado.** Hoy el acceso público es **un código por obra** (`obras.public_code_hash`), no una contraseña única. Y la lista blanca es por obra — ver la alerta del bloque 08:00.

**Cambio a decidir:** unificar el modelo de autorización ahora que el eje es la empresa y no la obra. **Llevarlo a la próxima reunión como decisión abierta.**

---

## Bloque 31:00 – 35:00 · Revisión: proveedor y valores por ítem

**Se habló de:** qué hace Daniel cuando le llega una requisición.

**Decisiones:**
- La plataforma le muestra el listado de lo solicitado para cotizar.
- **Proveedor por ítem**, no por requisición: *"esto lo voy a comprar a tanto, esto que va a tanto"*.
- **Etiqueta (ruta de aprobación) y obra: por requisición completa.**

**Estado:** ✅ **Ya está OK.** `requisicion_items.proveedor_final_id` es por ítem; `etiqueta_id` y `obra_id` son de cabecera; `review()` exige etiqueta y deriva el aprobador de ella.

**⚠️ Matiz a resolver:** Daniel dijo *"puedo colocar también la persona que aprueba"* y *"decidir si aprobar directamente o enviar a revisión"*. Hoy el aprobador **se deriva automáticamente de la etiqueta** (`tags.getApproverId`) y **no hay ruta de auto-aprobación**: `sendForApproval` siempre exige un aprobador. **Decisión pendiente:** ¿Daniel elige aprobador libremente, o la etiqueta lo determina? Son dos diseños distintos de control interno; conviene resolverlo con Claudia presente, porque afecta la segregación de funciones.

---

## Bloque 36:00 – 39:00 · Valores, IVA y cotizaciones

**Se habló de:** cómo se capturan los montos.

**Decisiones:**
- Por ítem: **cantidad aprobada, proveedor, valor base (sin IVA), IVA y total.**
- **IVA se captura como PORCENTAJE**, no como monto — *"¿cuánto es el IVA? el cinco, el 10…"*. Se descartó fijar 19 % por defecto porque hay ítems con otras tarifas.
- El **total se calcula solo** (Daniel lo verificó en la demo y lo aprobó: *"no, así está perfecto, no caí en cuenta"*).
- **Adjuntar cotizaciones a nivel de REQUISICIÓN**, no por proveedor. Razón textual: puede haber cotizado 9 veces para 3 ítems, y quiere poder justificar por qué eligió a un proveedor que no era el más barato (*"ellos me entregaban en la obra, los otros no"*).

**Estado:** ⚠️ **Cambio necesario en el IVA.** Hoy `requisicion_items.iva` es un **monto** (`numeric(16,2)`), no un porcentaje.

**Cambios concretos:**
1. Agregar `iva_porcentaje` al ítem y derivar el monto (conservar el monto almacenado para que el reporte contable no cambie).
2. La UI captura porcentaje; el total se sigue calculando.
3. ✅ Adjuntos a nivel requisición: **ya está OK**, la tabla `adjuntos` es genérica por entidad.

**Acción de UI:** separar visualmente los adjuntos del **solicitante** (soportes/fotos) de las **cotizaciones de Daniel** — son dos cosas distintas para el aprobador.

---

## Bloque 40:00 – 43:30 · ⚠️ Aprobación parcial por ítem

**Se habló de:** declinar y aprobar.

**Decisiones:**
- Declinar la requisición completa **con motivo escrito libre** (se descartó una lista de motivos predefinidos: *"eso no va a ser una cuestión de dos palabras, yo lo puedo colocar"*).
- **No siempre se compra todo.** Daniel puede **cambiar cantidades** y **declinar ítems individuales**: *"no le voy a mandar 2 m y 1 m, le voy a mandar 3 m de arena de río, y lávela"*.
- Puede declinar ítems **de entrada**, antes de cotizar.
- **El aprobador (Nelson/Juliana) tiene la misma facultad**: aprobar unos ítems y otros no, incluso a nivel de proveedor (*"voy a aprobar lo de Google, pero lo de X no"*) — bloque 45:00.

**Estado:** ❌ **No existe en el modelo.** Es la segunda brecha grande.
- `estado_requisicion` solo tiene estados de cabecera; no hay estado por ítem.
- `sendForApproval` exige que **todos** los ítems tengan proveedor y valor > 0 — hoy la única forma de "declinar un ítem" es **borrarlo**, lo que destruye la trazabilidad de lo que se pidió y no se compró.
- `approve()` es todo-o-nada.

**Cambios concretos:**
1. Agregar a `requisicion_items`: `estado` (`pendiente` / `aprobado` / `declinado`), `cantidad_aprobada` y `motivo_declinacion_item`.
2. `sendForApproval` valida solo los ítems **no declinados**.
3. `approve()` acepta el conjunto de ítems aprobados y genera órdenes solo con esos.
4. El ítem declinado **se conserva visible** en la requisición — es justamente el dato que hoy se pierde en el Excel.

---

## Bloque 43:30 – 45:00 · Proveedores

**Se habló de:** cuándo se crea el proveedor.

**Decisiones:**
- Daniel crea el proveedor **durante la revisión**, no antes.
- Campos: **razón social, NIT, contacto, correo**.
- **El RUT se adjunta** para proveedores nuevos, porque el contador lo necesita para crearlo en el sistema contable (Helisa).

**Estado:** ✅ **Ya está OK.** `proveedores` tiene razón social, NIT normalizado con unicidad, contacto y datos bancarios; y existe la migración `202608240002_proveedor_expediente_privado.sql` con los documentos del proveedor y sus endpoints de subida/descarga.

**Acción menor:** evaluar hacer el RUT **obligatorio** para que un proveedor nuevo pueda usarse en una orden — hoy es un documento más del expediente, no un requisito bloqueante.

---

## Bloque 46:00 – 50:00 · Orden de compra

**Se habló de:** el formato de la orden generada.

**Decisiones:**
- **Una orden por proveedor**, generada automáticamente al aprobar. ✅ **Ya está OK** — `groupOrderItems` agrupa por proveedor en `lib/services/procurement-service.ts`.
- ⚠️ Ese comportamiento está detrás del *feature flag* `ordenes_multi_proveedor`. Como ahora es **el comportamiento normal**, el flag debe quedar activo por defecto (o eliminarse).
- **Fecha de la orden = fecha de aprobación**, automática. ✅ `fecha_generacion` ya lo hace.
- **Consecutivo:** empieza **desde cero**, no hay que continuar ninguna serie previa. ✅ La tabla `consecutivos` ya lo soporta.
- **Se eliminan del formato:** el bloque repetido de empresa/obra, el campo de versión interna, **condiciones comerciales**, **tiempo de entrega** y el mensaje predefinido ("presentar su cuenta…"). Razón: *"lo que hacemos es alargar más las cosas"*.
- **Se conservan:** proveedor (con NIT, contacto, dirección, correo, teléfono), ítems aprobados de ese proveedor, totales, y **elaborado por / aprobado por**.
- **Observaciones por ítem en la orden: se descartaron** (Samuel las propuso, Daniel dijo que no).
- **Forma de pago:** se captura **en la revisión de la requisición**, no en la orden — porque si se pidiera en la orden, después de que aprueba Juliana habría que devolverle el documento a Daniel (*"mucha vuelta"*). En la práctica **casi todo es anticipado**.

**Acción:** dejar un campo `observaciones` de orden **oculto** en el formato, listo para activar. Acordado explícitamente en la llamada.

---

## Bloque 51:30 – 56:30 · El contador entra al flujo

**Se habló de:** qué pasa después de generada la orden.

**Proceso actual (manual):** Daniel **imprime y entrega** las órdenes; el contador contabiliza, aplica retenciones, detecta novedades (*"el RUT que aparece es un facturador, entonces páseme la factura"*) y devuelve un comprobante de egreso generado por Helisa; luego Daniel paga y le regresa el comprobante de pago.

**Decisiones:**
- **Se crea usuario para el contador.**
- **No se le notifica** cada orden: **entra por su cuenta los martes y viernes** (el ciclo de pagos) y descarga todo lo pendiente.
- Debe poder **descargar la orden y los documentos del proveedor** (RUT) desde la plataforma.
- Marca un **check de "contabilizado"** para saber qué ya bajó y qué no.
- **Fuera de alcance por ahora:** el comprobante de egreso de Helisa y el comprobante de pago **no vuelven a la plataforma**. Daniel lo dejó explícito: *"eso ya es más interno de contabilidad… a futuro la idea es que todo quede ahí"*.
- Integración con Helisa: **a futuro**, no ahora.

**Estado:** ⚠️ **Falta el estado.** El rol `contabilidad` ya existe, pero `estado_orden` es `('generada','cumplida','no_cumplida','no_necesario')` — **no hay `contabilizada`**, y `updateOrderStatus` solo permite esas tres transiciones.

**Cambios concretos:**
1. Registrar "contabilizada" — probablemente mejor como campos aparte (`contabilizada_en`, `contabilizada_por`) que como estado, porque es ortogonal a "cumplida".
2. Bandeja de contabilidad: órdenes pendientes de contabilizar, con descarga de la orden y del expediente del proveedor.
3. **No** implementar notificación al contador (decisión explícita).

**Nota de riesgo:** dejar el comprobante de egreso fuera significa que la plataforma **sabe qué se aprobó pero no qué se pagó**. El cuadro de control de Daniel — que fue el motivo declarado de todo el proyecto — se alimentaría de lo aprobado, no de lo pagado. Vale la pena advertirlo explícitamente antes de la prueba de paridad contable.

---

## Cierre · Compromisos

| # | Compromiso | Responsable |
|---|-----------|-------------|
| 1 | Lista de **empresas activas** | Daniel (Mizar) |
| 2 | Lista de **~100 materiales frecuentes** | Daniel (Mizar) |
| 3 | Saludo al número de WhatsApp de la plataforma para probar el flujo | Daniel (Mizar) |
| 4 | Ajustar la plataforma con lo acordado | Samuel (Sixteam) |
| 5 | Próxima reunión (~viernes): revisar **la vista final** y **la vista del usuario externo** | Ambos |

---

## Backlog derivado de esta reunión

Ordenado por impacto. Los tres primeros son cambios de modelo de datos y bloquean el resto.

### Bloqueantes (cambian el esquema)

1. **Empresa en la captura, obra en la revisión** — `sociedad_id` nuevo, `obra_id` nullable, exigido antes de aprobación. Actualizar formulario web y WhatsApp Flow.
2. **Aprobación parcial por ítem** — `estado`, `cantidad_aprobada` y `motivo_declinacion_item` en `requisicion_items`; ajustar `sendForApproval` y `approve`.
3. **Autorización de solicitantes sin obra** — decidir si la lista blanca pasa a sociedad o a rol. **Bloquea el canal WhatsApp.**

### Cambios acotados

4. **Fecha requerida realmente opcional** — el año del consecutivo debe salir de `now()`.
5. **IVA como porcentaje** — `iva_porcentaje` en el ítem, monto derivado.
6. **Registro de "contabilizada"** en órdenes + bandeja de contabilidad con descarga de orden y RUT.
7. **RUT obligatorio** al crear proveedor nuevo (a confirmar).
8. **Activar por defecto** `ordenes_multi_proveedor`.
9. **Poda del formato de orden de compra:** fuera condiciones comerciales, tiempo de entrega, mensaje predefinido y bloque de empresa duplicado; observaciones ocultas.
10. **Forma de pago** capturada en la revisión de la requisición.
11. **Separar en la UI** los adjuntos del solicitante de las cotizaciones de Daniel.

### Decisiones abiertas para la próxima reunión

- ¿El aprobador lo elige Daniel o lo determina la etiqueta? ¿Existe auto-aprobación?
- ¿Contraseña única para el link público, o código por empresa?
- ¿Se conserva el campo `destino` del ítem?
- Confirmar que el comprobante de egreso/pago queda fuera de alcance en la v1, y sus consecuencias sobre el control de gastos.
