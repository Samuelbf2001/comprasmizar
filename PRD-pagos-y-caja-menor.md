# PRD — Adenda: Órdenes de Pago y gastos por caja menor

**Cliente:** Mizar · PROIM · Ictinos (Colombia)
**Proveedor:** Sixteam.pro
**Versión:** 1.0 — 15 de septiembre de 2026
**Estado:** Definición cerrada con Daniel (revisor/comprador). Pendiente de validar con Claudia y con el contador (Luis Miguel) antes de construir lo marcado con ⚠.
**Relación con el PRD maestro:** esta adenda **complementa** [PRD.md](PRD.md) v1.3. Donde se contradicen, manda esta adenda. Deroga explícitamente el módulo M8 (caja menor como formulario aparte) y la tabla `caja_menor`.

**Fuentes:**
- Reunión 11-sep-2026 (Samuel + Juliana + Daniel + Claudia + contador): validación del flujo de compra de materiales; quedaron pendientes caja menor, solicitud de pagos y centros de costo.
- **Reunión 15-sep-2026 (Samuel + Daniel, 37 min)** — fuente principal de este documento. Las referencias `[mm:ss]` apuntan a la grabación.
- Decisiones de Ernesto del 11-sep (noche): modelo de centro de costo N obras → 1 CC, predeterminado y editable; no bloquear por datos del cliente.

---

## 1. Resumen ejecutivo

**No hay un módulo nuevo de caja menor ni un módulo nuevo de pagos.** Hay **un solo flujo** (el de requisiciones, ya validado) que produce **dos documentos** distintos según el tipo de solicitud: **Orden de Compra (OC)** para materiales y **Orden de Pago (OP)** para servicios, cuentas de cobro, facturas y gastos varios. Los gastos de caja menor son órdenes normales cuyo **pago se registra con medio = caja**.

Lo que sí es nuevo y obliga a tocar el modelo:

1. **Pagos parciales**: una orden recibe uno o varios pagos; vive con saldo hasta quedar pagada.
2. **Medio de pago por pago** (caja / transferencia / otro) + **comprobante de pago adjunto** al momento de pagar.
3. **Beneficiario persona o empresa**: identificación NIT **o** cédula.
4. **Centro de costo como catálogo propio**, separado de la obra y de la empresa que factura.
5. **Formulario externo simplificado** de OP (WhatsApp / portal): identificación, empresa, monto. Sin ítems, sin fotos.

Lo que **no** entra en esta fase: ingresos, flujo de caja proyectado, estado de resultados (módulo financiero, fase 2). Daniel lo pidió, Samuel lo acotó, ambos quedaron alineados `[11:01–15:00]`.

---

## 2. Lo que Daniel necesita de verdad (análisis de la reunión)

### 2.1 El problema no es la caja: es que "todo gasto" tiene que caer en un solo cuadro

Daniel lleva **GASTOS EN OBRAS.xlsx** por obra (Juliana, Laureles, Mizar, Pedregal, Villa del Sol, Mi Lote/Cúcuta, vendedores, impuestos) `[2:23]`. Lo que Claudia quiere es que **absolutamente todo gasto, grande o chico** — caja menor, tarjetas de crédito, servicios públicos, nóminas — quede en el sistema para poder decir a fin de mes "en total se gastó tanto" `[3:30–4:10]`.

Hoy la caja menor la cierra **semanalmente** (viernes 4 pm: qué entró, qué salió) y la vuelca al Excel; al inicio de mes (primeros 5 días) "causa" esos gastos en el cuadro de obras `[5:00–5:40]`, `[7:04–7:37]`.

### 2.2 Cómo lo pensó él — y por qué esa es la solución correcta

Daniel lo propuso solo: *"hago la requisición de gastos por caja, como si fuera un pago de un proveedor... detallo cada cosa y lo subo"* `[5:40–6:12]`. Samuel puso sobre la mesa las dos opciones — reutilizar el flujo o construir un módulo de gastos separado `[6:12–7:04]` — y la conversación cerró en la primera. Es la opción correcta por tres razones:

- **Un solo lugar para todo gasto** (principio rector del PRD maestro: la información se captura una vez).
- Daniel ya domina ese flujo: lo validó el 11-sep.
- El módulo separado (M8 original) habría creado un segundo camino para lo mismo y un segundo origen en `gastos`.

### 2.3 El desorden de fondo: centro de costo ≠ empresa que factura

Daniel lo dijo con claridad `[10:00–11:01]`, `[14:00–15:00]`: hoy organiza por empresa, pero **debería ser por proyecto/centro de costo**. Mizar vende, hace la publicidad y tiene las redes, pero el dueño del lote puede ser Palmoc; la factura de un gasto de Juliana puede venir a nombre de PROIM. El contador **contabiliza por la razón social del recibo**, no por a quién pertenece el gasto `[18:31–19:16]`.

Consecuencia para el sistema: cada gasto necesita **dos atributos independientes**: la **empresa facturada** (lo que ve contabilidad) y el **centro de costo** (lo que ve Claudia en el reporte). Y el catálogo de centros de costo debe crecer más allá de las obras: **gastos personales de socios, gastos administrativos, gastos de PROIM** (servicios públicos de apartamentos, parqueaderos) `[20:00–20:40]`.

Samuel lo resumió y Daniel asintió: *"los sistemas generan más de lo que hay: si hay desorden, más desorden"* `[15:00]`. Ordenar los centros de costo es tarea del cliente y es previa a que el reporte sirva.

### 2.4 OC vs OP: "pensé que había más diferencia"

Al recorrer el formulario juntos `[26:46–28:33]`, la única diferencia real entre una solicitud de compra y una de pago es **qué se adjunta** (cotización vs factura/cuenta de cobro), **quién es el beneficiario** (puede ser una persona) y **el nombre del documento de salida** (OC vs OP). Todo lo demás — empresa, obra/centro de costo, aprobador, contabilización — es idéntico. Daniel: *"pensé que había más diferencia, y listo"* `[28:23]`.

Casos reales de OP dichos por Daniel `[16:00–17:38]`, `[24:23–26:46]`:

| Caso | Documento | Medio típico |
|------|-----------|--------------|
| Rollos de manguera urgentes en el Pedregal, comprados sin alcanzar a hacer la OC | **OC** (es material) | caja |
| Anticipo de $600.000 a un topógrafo | OP · servicios profesionales | caja |
| Parqueaderos, peajes, notarías | OP | caja |
| Servicios públicos de los apartamentos (son de PROIM) | OP · centro de costo PROIM | transferencia |
| Factura mensual de Sixteam | OP · la aprueba Juliana | transferencia |
| Cuenta de cobro del arquitecto Juan Camilo | OP · servicios profesionales | transferencia |
| Corte semanal de un maestro de obra ("este fin de semana le toca 4 millones") | OP · lo monta Daniel en nombre del maestro | caja o transferencia |
| Nómina de PROIM (~6 personas) | OP · **modelo pendiente** (ver P9) | transferencia |

---

## 3. Decisiones tomadas (con evidencia)

| # | Decisión | Evidencia |
|---|----------|-----------|
| D1 | **Un solo flujo, dos documentos.** `tipo=compra` → OC; `tipo=pago` → OP. Misma revisión, misma aprobación, misma contabilización. El PDF cambia consecutivo (OP-) y rótulo. | `[26:46–28:23]` "lo mismo, pero con la palabra pago" |
| D2 | **Caja menor no es un módulo.** Un gasto pagado por caja es una requisición normal que Daniel monta, se auto-aprueba como usuario maestro, genera la orden y **registra el pago con medio = caja**. Filtrar por medio de pago = caja le da el cierre semanal/mensual. | `[19:16–22:19]` "Esa sería la forma de todos los gastos de caja. Ok, me gusta." |
| D3 | **Comprobante de pago adjunto en la orden**, al registrar el pago. Opcional pero recomendado: evita que el contador cruce extractos contra causaciones a mano. | `[22:19–24:23]` "Sí, pues sí, podría ser" |
| D4 | **Pagos parciales.** Una orden por $1.285.000 puede recibir un anticipo de $640.000 hoy y el saldo después; la orden sigue activa con saldo pendiente hasta que la suma de pagos la cubra. | `[34:52–36:02]` "Exactamente" |
| D5 | **Daniel edita montos.** Como usuario maestro corrige el valor de una solicitud antes de generar la orden (el maestro "puso 100 millones"). | `[36:02]` "Sí, tal cual" |
| D6 | **Campos de la OP:** empresa, obra/centro de costo, fecha (real, no "requerida"), observaciones, soporte = factura o cuenta de cobro, beneficiario (existente o nuevo), concepto, valor total, aprobador. | `[26:54–28:00]` |
| D7 | **Identificación NIT o cédula** en un solo campo: el beneficiario puede ser empresa (Sixteam) o persona (topógrafo, maestro, Daniel mismo). | `[32:52–34:00]` |
| D8 | **Formulario externo simplificado de OP** (WhatsApp Flow y portal): tipo, identificación, empresa, monto. Sin ítems, sin adjuntos obligatorios. | `[32:52–34:06]` "sí se puede hacer y es lo que tenemos planeado" |
| D9 | **Daniel como solicitante por cuenta de otro.** Si el maestro "no fue capaz", Daniel monta la solicitud, la enruta al aprobador y sigue el flujo. Vale para cortes de maestros y para sus propias cuentas de cobro. | `[30:29–31:30]`, `[34:11–34:52]` |
| D10 | **Módulo financiero = fase 2.** Ingresos, proyecciones, flujo de caja y estado de resultados quedan fuera; se conectarán luego al módulo de requisiciones. | `[11:01–15:00]` "estamos alineados" |
| D11 | **Centros de costo expandidos y separados de la empresa facturada.** Catálogo propio que incluye obras y también gastos personales, administrativos y de PROIM. Daniel entrega la lista. | `[10:00–11:01]`, `[18:31–19:16]`, `[20:00–20:40]` |
| D12 | Lista de proveedores de materiales: Daniel ya la envió por WhatsApp; Samuel la revisa después de la reunión. | `[0:37–0:57]` |

---

## 4. El proceso, definido

### 4.1 Un flujo, dos documentos

```
                         ┌─ tipo = compra ──► ítems + cantidades + cotización ──► OC-2026-0001
 Solicitud (requisición) ┤
                         └─ tipo = pago ────► concepto + monto + factura/cuenta de cobro ──► OP-2026-0001
```

| Aspecto | Compra (OC) | Pago (OP) |
|---------|-------------|-----------|
| Qué se pide | Ítems del catálogo, cantidades, unidades | Un concepto y un valor (sin catálogo de ítems) |
| Soporte al radicar | Foto / link del producto (opcional) | Factura o cuenta de cobro (opcional al radicar, obligatoria antes de contabilizar ⚠) |
| Soporte en revisión | Cotizaciones | La misma factura / cuenta de cobro |
| Beneficiario | Proveedor (NIT) | Proveedor o persona (NIT **o** cédula) |
| Fecha | Fecha requerida (opcional) | Fecha del gasto (real; por defecto hoy) |
| Revisión | Daniel normaliza ítems, valores, IVA, proveedor por ítem | Daniel valida beneficiario, centro de costo, valor; puede corregir el monto |
| Aprobación | Por etiqueta → aprobador | Por etiqueta → aprobador. Daniel se auto-aprueba lo de caja |
| Documento | PDF OC | PDF OP (mismo diseño, otro rótulo y consecutivo) |
| Pago | 1..N pagos con medio | 1..N pagos con medio |
| Contabilización | Contador marca contabilizada | Igual |

### 4.2 Flujo de una Orden de Pago (recorrido normal)

```
 Solicitante            Daniel (revisión)         Aprobador           Sistema              Daniel (pagos)        Contabilidad
     │                        │                       │                  │                     │                     │
     │ 1. Radica solicitud    │                       │                  │                     │                     │
     │  tipo=pago:            │                       │                  │                     │                     │
     │  identificación,       │                       │                  │                     │                     │
     │  empresa, monto,       │                       │                  │                     │                     │
     │  (concepto, factura)   │                       │                  │                     │                     │
     ├───────────────────────►│                       │                  │                     │                     │
     │                        │ 2. Valida/crea el     │                  │                     │                     │
     │                        │ beneficiario, asigna  │                  │                     │                     │
     │                        │ centro de costo y     │                  │                     │                     │
     │                        │ empresa facturada,    │                  │                     │                     │
     │                        │ corrige el monto si   │                  │                     │                     │
     │                        │ hace falta, etiqueta  │                  │                     │                     │
     │                        │ (o DECLINA)           │                  │                     │                     │
     │                        ├──────────────────────►│                  │                     │                     │
     │                        │                       │ 3. Aprueba o     │                     │                     │
     │                        │                       │ devuelve (WhatsApp│                    │                     │
     │                        │                       │ o plataforma)    │                     │                     │
     │                        │                       ├─────────────────►│                     │                     │
     │                        │                       │                  │ 4. Genera OP con    │                     │
     │                        │                       │                  │ consecutivo y PDF;  │                     │
     │                        │                       │                  │ gasto comprometido  │                     │
     │                        │                       │                  ├────────────────────►│                     │
     │                        │                       │                  │                     │ 5. Registra 1..N    │
     │                        │                       │                  │                     │ pagos: fecha, valor,│
     │                        │                       │                  │                     │ medio (caja/transf),│
     │                        │                       │                  │                     │ comprobante         │
     │                        │                       │                  │                     ├────────────────────►│
     │                        │                       │                  │                     │                     │ 6. Revisa OP +
     │                        │                       │                  │                     │                     │ comprobantes,
     │                        │                       │                  │                     │                     │ marca contabilizada
```

Estados de la requisición: **sin cambios** (`enviada → en_revision → en_aprobacion → aprobada | devuelta | declinada`).

### 4.3 Atajo de caja menor (usuario maestro)

Cuando Daniel pagó algo por caja en la inmediatez (manguera urgente, anticipo al topógrafo) y lo registra después:

```
 Daniel radica (tipo compra o pago) ──► Daniel revisa ──► Daniel se auto-aprueba ──► OC/OP generada ──► Daniel registra el pago: medio = caja, fecha real, comprobante (recibo o foto)
```

- No hay pantalla distinta: es el mismo flujo con el mismo usuario en los tres roles. El sistema **no bloquea** que solicitante, revisor y aprobador sean la misma persona cuando esa persona es usuario maestro.
- Filtro **medio de pago = caja** en el panel de órdenes/pagos → es el cierre de caja. Filtro por rango de fechas → cierre semanal (viernes) o mensual.
- El contador entra a la plataforma, ve las OC/OP pagadas por caja con sus comprobantes y **no necesita el sobre de recibos** de fin de mes `[22:19–22:47]`.

### 4.4 Pagos parciales y estado de pago de la orden

```
 valor_orden = Σ ítems aprobados (OC)  |  valor aprobado (OP)
 valor_pagado = Σ pagos registrados
 saldo = valor_orden − valor_pagado

 estado_pago:  pendiente (0 pagos)  →  parcial (0 < pagado < valor)  →  pagada (pagado ≥ valor)
```

- Cada pago es un registro propio: fecha, valor, medio, referencia (nº de transferencia), comprobante, quién lo registró.
- `estado_pago` es **derivado**, no editable a mano. Daniel no "marca pagada": registra pagos y la orden se marca sola.
- "Marcar contabilizada" (contador) es independiente del estado de pago: puede contabilizar una orden con saldo.
- El estado de **cumplimiento** de la OC (cumplida / no cumplida / no necesario) sigue existiendo aparte: una OC puede estar pagada y no cumplida (pagué el anticipo, no ha llegado el material).

### 4.5 Canales de entrada para una OP

| Canal | Quién | Qué captura | Nota |
|-------|-------|-------------|------|
| Web interna | Daniel, Juliana, personal | Formulario completo D6 | Daniel radica por cuenta de maestros (D9) |
| Portal público (enlace + contraseña) | Profesionales y proveedores externos | Formulario simplificado D8 + adjunto opcional | Sixteam sube su factura por aquí |
| **WhatsApp Flow de pago** (nuevo, aparte del de compra) | Maestros, topógrafos, proveedores | tipo=pago, identificación, empresa, monto. Sin adjuntos | Daniel: "si no es por ahí, no es por ningún otro lado" `[31:30–32:52]` |

Para todos los canales el punto de llegada es **la misma bandeja de revisión** de Daniel.

---

## 5. Requisitos funcionales (delta sobre el PRD maestro)

Convención: **NUEVO** agrega; **MODIFICA** cambia un RF existente (se indica cuál); **DEROGA** elimina.

### M0 — Núcleo administrable

- **RF-007 NUEVO — Catálogo de centros de costo.** CRUD: nombre, tipo (`obra` / `administrativo` / `personal` / `empresa`), sociedad asociada (opcional), activo. Administrable por Daniel (autoservicio, como los demás catálogos).
- **RF-008 NUEVO — Obra → centro de costo por defecto.** Cada obra apunta a un centro de costo (N obras → 1 CC). En la requisición el CC sale **predeterminado** por la obra y **se puede cambiar**. Un CC de tipo `administrativo` o `personal` no requiere obra.
- **RF-009 NUEVO — Empresa facturada.** Toda requisición registra la **sociedad a cuyo nombre viene el soporte** (lo que contabiliza el contador), independiente del centro de costo. Por defecto = sociedad del centro de costo; editable.

### M1 — Captura

- **RF-107 NUEVO — Formulario de solicitud de pago** (`tipo=pago`): empresa facturada, centro de costo (con obra opcional), fecha del gasto (defecto hoy), beneficiario (buscar por identificación o crear: identificación NIT/CC, nombre, teléfono, email opcional), concepto, valor total, soporte (factura / cuenta de cobro / recibo), observaciones. Sin líneas de ítems.
- **RF-108 NUEVO — Formulario público simplificado de pago**: identificación, nombre, empresa a la que cobra, monto, concepto corto (opcional), adjunto (opcional). Mobile-first. Crea la solicitud con `canal=publico` y beneficiario `pendiente_normalizacion` si la identificación no existe.
- **RF-101 MODIFICA** — El campo "soporte general" se rotula según el tipo: *cotización / foto* en compra; *factura o cuenta de cobro* en pago.

### M3 — Bandeja de revisión

- **RF-307 NUEVO — Revisión de solicitud de pago.** Daniel valida o crea el beneficiario (fusiona si ya existía por identificación), asigna centro de costo y empresa facturada, **edita el valor** (D5) dejando el valor original en auditoría, etiqueta y elige aprobador.
- **RF-308 NUEVO — Auto-aprobación de usuario maestro.** Un usuario con rol revisor **y** aprobador puede enviar a aprobación y aprobar en un solo paso su propia solicitud. Queda auditado como dos eventos.
- **RF-304 MODIFICA** — "Enviar a aprobación" en `tipo=pago` exige: beneficiario con identificación, centro de costo, empresa facturada, valor > 0, aprobador. **No** exige soporte (el maestro no lo va a subir).

### M5 — Órdenes (OC y OP)

- **RF-501 MODIFICA** — La OP se genera **una por solicitud** (una OP no se divide por proveedor: tiene un solo beneficiario).
- **RF-503 MODIFICA** — El PDF de OP usa la misma plantilla que la OC con rótulo "Orden de Pago", consecutivo `OP-`, beneficiario con su identificación, concepto y valor. Sin tabla de ítems.
- **RF-507 NUEVO — Registro de pagos.** Sobre una orden (OC u OP) Daniel registra 1..N pagos: fecha, valor, **medio** (`caja` / `transferencia` / `tarjeta` / `otro`), referencia, comprobante adjunto (opcional), nota. Cada pago queda auditado.
- **RF-508 NUEVO — Estado de pago derivado**: `pendiente` / `parcial` / `pagada` según Σ pagos vs valor de la orden. Visible en el panel de órdenes y en la ficha de la orden con el saldo. No se edita a mano.
- **RF-509 NUEVO — Filtros del panel de órdenes**: medio de pago, estado de pago, centro de costo, empresa facturada, rango de fecha de pago. La combinación *medio = caja + rango de fechas* es el **cierre de caja**.
- **RF-510 NUEVO — Corrección de un pago.** Un pago registrado se puede anular (no borrar) con motivo; queda visible tachado en la ficha.
- **RF-505 (cumplimiento)** — sin cambios; es independiente del estado de pago.

### M6 — Proveedores y beneficiarios

- **RF-601 MODIFICA** — La entidad pasa a admitir **persona natural o jurídica**: `tipo_identificacion` (`NIT` / `CC` / `CE` / `pasaporte`), `identificacion`, `nombre` (razón social o nombre de la persona), datos bancarios opcionales. Se mantiene una sola tabla (`proveedores`) para no duplicar catálogos.
- **RF-606 NUEVO — Búsqueda por identificación** en todos los formularios (interno, público, Flow): si existe, se enlaza; si no, se crea como `pendiente_normalizacion` para que Daniel complete la ficha.
- **RF-602** (documentos) — el RUT sigue **no obligatorio** (decisión del 11-sep). ⚠ Contabilidad puede pedir que lo sea para beneficiarios con NIT.

### M7 — Gastos y reportes

- **RF-701 MODIFICA** — El gasto se registra en el **centro de costo** (no en la obra a secas) al aprobarse. La obra queda como atributo del gasto cuando existe.
- **RF-707 NUEVO** — Filtros de reporte: centro de costo, empresa facturada, tipo de documento (OC/OP), medio de pago, estado de pago. Totales de **comprometido** (aprobado) vs **pagado** por periodo.
- **RF-708 NUEVO** — Vista de cierre de caja: por rango de fechas, lista de pagos con medio = caja, total, y acceso a cada comprobante. Exportable a Excel.
- **RF-802 DEROGA** — Ya no existe un "origen caja_menor" en `gastos`: todo gasto nace de una orden.

### M8 — Caja menor **[DEROGADO como módulo]**

- **RF-801 / RF-802 / RF-803 DEROGAN.** La caja menor **no** es un formulario aparte sin aprobación. Es el atajo de §4.3 sobre el flujo existente, con `medio_pago = caja` en el registro de pago (RF-507). El "piloto del patrón de módulo nuevo" (§9.5 del PRD maestro) pasa a ser el **módulo financiero de fase 2**.

### M9 — WhatsApp

- **RF-908 NUEVO — WhatsApp Flow de pago.** Flow independiente del de compra (RF-902), de 3 pantallas: (1) identificación + nombre, (2) empresa a la que cobra + monto + concepto corto, (3) resumen y enviar. Sin PhotoPicker. Llega a la bandeja con `tipo=pago`, `canal=whatsapp`.
- **RF-902 MODIFICA** — El menú inicial del bot ofrece "Montar requisición" **y** "Solicitar un pago".
- **RF-904** — la plantilla de "aprobada" para `tipo=pago` incluye el consecutivo OP y el valor aprobado; la de "pagada" (nueva) avisa al beneficiario cuando Σ pagos cubre la orden. ⚠ Confirmar con Daniel si quiere notificar pagos a externos.

### M10 — Seguridad y auditoría

- **RF-1003 MODIFICA** — Auditar además: edición de monto por Daniel (valor antes/después), auto-aprobación (dos eventos), registro y anulación de pagos, cambio de centro de costo o empresa facturada.

### M12 — MCP

- **RF-1204 MODIFICA** — Herramientas de escritura: agregar `registrar_pago` y CRUD de centros de costo. **Aprobar sigue excluido** (RF-1205); auto-aprobación tampoco es accesible por MCP.

---

## 6. Cambios al modelo de datos (delta sobre §7 del PRD maestro)

**Núcleo:**

| Tabla | Cambio |
|-------|--------|
| `centros_costo` | **NUEVA**: id, nombre, tipo (`obra`/`administrativo`/`personal`/`empresa`), sociedad_id (nullable), activo |
| `obras` | + `centro_costo_id` (default para requisiciones) |
| `proveedores` | `nit` → `tipo_identificacion` + `identificacion`; `razon_social` → `nombre`; + `es_persona_natural` (derivado de tipo); + `estado` admite `pendiente_normalizacion`. Índice único por (`tipo_identificacion`, `identificacion`) |

**Dominio compras y pagos:**

| Tabla | Cambio |
|-------|--------|
| `requisiciones` | + `centro_costo_id` (obligatorio), + `empresa_facturada_id` → sociedades (obligatorio), + `beneficiario_id` → proveedores (tipo=pago), + `concepto` (tipo=pago), + `valor_solicitado` y `valor_aprobado` (tipo=pago; el original queda para auditoría), `fecha_requerida` → semántica "fecha del gasto" en tipo=pago |
| `ordenes` | + `valor_total` (materializado al generar), + `beneficiario_id` (alias de proveedor_id para OP). `estado_pago` **no** se guarda: se calcula. |
| `pagos_orden` (ya existe desde el 12-sep) | + `nota`, `anulado` (bool), `motivo_anulacion`, `anulado_por`, `anulado_en`; comprobante = adjunto con entidad `pago_orden`. **Medio "Caja" = valor `efectivo`** del enum existente, reetiquetado en UI (no se altera el enum). |
| `gastos` | `obra_id` → nullable; + `centro_costo_id` (obligatorio), + `empresa_facturada_id`; `origen` queda solo `requisicion` |
| `caja_menor`, `cajas`, `ingresos`, `cierres_caja` (12-sep) | **Quedan dormidas**: no se escriben más desde la UI, el API ni el MCP (la convención del repo prohíbe `DROP`). Se reactivan en la fase 2 financiera. |

Vistas / consultas derivadas: `orden_saldos` (valor_total, pagado, saldo, estado_pago) y `cierre_caja(desde, hasta)`.

---

## 7. Fuera de alcance de esta adenda

| Qué | Por qué | Cuándo |
|-----|---------|--------|
| Ingresos, flujo de caja proyectado, estado de resultados, dashboard financiero | Daniel lo mostró con su app personal y Claudia lo quiere; Samuel lo acotó como **módulo financiero, fase 2**, que se conecta después a requisiciones `[11:01–15:00]` | Cotización aparte tras estabilizar esta fase |
| Registrar **ingresos** del cierre de caja semanal | Es parte del módulo financiero. En esta fase el cierre de caja solo muestra **salidas** | Fase 2 |
| Umbral por monto para exigir aprobación o segundo aprobador | Ya estaba fuera en el PRD maestro §3.3; nada en la reunión lo reabre | — |
| Nómina como documento multi-beneficiario | Sin definición (ver P9). Mientras tanto: una OP por persona | Cuando Daniel defina |
| Integración con Helisa | Sigue siendo el archivo de exportación | — |

---

## 8. Preguntas abiertas nuevas

| # | Pregunta | Dueño | Cuándo |
|---|----------|-------|--------|
| P8 | **Contador:** ¿le basta ver en plataforma las OC/OP pagadas por caja con comprobantes para no pedir el sobre físico de recibos? ¿La separación *empresa facturada* vs *centro de costo* cubre cómo contabiliza en Helisa? Ojo: Daniel dijo que por ahora **mantiene su cruce mensual físico** de comprobantes contra extractos `[22:47–23:28]`; el comprobante en plataforma (D3) es opcional hasta que el contador lo adopte. | Ernesto + Luis Miguel | Próxima sesión con contabilidad |
| P9 | **Nómina de PROIM (~6 personas):** ¿una OP por persona, o un documento "nómina" con varias líneas y un solo aprobador (Claudia)? Daniel: "hay que mirarlo" `[28:43]`. El resumen automático de Fathom lo dio por decidido como "una única OP con múltiples beneficiarios": es la preferencia que Daniel dejó entrever, no un acuerdo. Regla interina: una OP por persona. | Ernesto + Daniel + Claudia | Antes de construir RF-107 en producción |
| P10 | **¿Notificar al beneficiario externo cuando se le paga?** Útil para proveedores; puede ser ruido para maestros | Daniel | Sesión de validación |
| P11 | **Soporte obligatorio antes de contabilizar** una OP (factura o cuenta de cobro): ¿lo exige el contador o lo controla Daniel como el RUT? | Luis Miguel | Próxima sesión con contabilidad |
| P12 | **Claudia:** ¿acepta que el reporte de esta fase muestre solo gastos (comprometido y pagado) y que los ingresos lleguen en fase 2? | Ernesto + Claudia | Antes de cerrar alcance |

---

## 9. Pendientes del cliente (no bloquean el desarrollo: se avanza con datos demo)

| Pendiente | Quién | Estado |
|-----------|-------|--------|
| Lista **expandida** de centros de costo (obras + administrativo + personales + PROIM) | Daniel | Pedido en la reunión; sin fecha |
| Lista de proveedores de materiales | Daniel | **Entregada** por WhatsApp el 15-sep; Samuel la revisa |
| Lista de beneficiarios recurrentes de OP (profesionales, maestros, servicios) con identificación | Daniel | Nuevo; pedir |
| Definición de nómina (P9) | Daniel + Claudia | Abierto |
| Confirmación del flujo de caja con el contador (P8, P11) | Luis Miguel | Abierto |
| Fecha de la sesión de verificación cuando esto esté construido | Daniel | "déjame ver cuándo lo puedo tener listo" `[36:20]` |

---

## 10. Impacto en pruebas (delta sobre §11.2 del PRD maestro)

Recorrido E2E **#2 (Pago)** se reescribe y se agregan tres:

2. **OP por cuenta de cobro:** profesional radica por portal público (identificación + empresa + monto + adjunto) → Daniel enlaza al beneficiario existente, asigna centro de costo y empresa facturada, corrige el monto → Juliana aprueba desde WhatsApp → OP generada con PDF → Daniel registra un pago por transferencia con comprobante → estado `pagada` → contador marca contabilizada → el gasto aparece en el centro de costo con comprometido = pagado.
5. **Gasto por caja (atajo maestro):** Daniel radica tipo=compra (manguera), se auto-aprueba, OC generada, registra pago medio=caja con foto del recibo → aparece en el cierre de caja del rango → la auditoría muestra dos eventos (envío y aprobación) con el mismo usuario.
6. **Pagos parciales:** OP por $1.285.000 → pago 1 de $640.000 (`parcial`, saldo $645.000) → pago 2 de $645.000 (`pagada`) → anular el pago 2 con motivo → vuelve a `parcial` → la OC de cumplimiento no se afecta.
7. **OP por WhatsApp Flow de pago:** maestro envía identificación + empresa + monto sin adjunto → llega a la bandeja con beneficiario `pendiente_normalizacion` → Daniel completa la ficha → sigue el recorrido #2.

Pruebas unitarias nuevas en `lib/domain`: cálculo de `estado_pago` y saldo (incluyendo anulaciones), validaciones de "enviar a aprobación" por tipo, regla de auto-aprobación, resolución de centro de costo por defecto desde la obra.

---

## 11. Criterios de aceptación de esta adenda

Esta adenda está terminada cuando:

1. Una solicitud de pago radicada por el **portal público** y otra por el **WhatsApp Flow de pago** llegan a la bandeja de Daniel, se aprueban y generan una **OP en PDF** con consecutivo propio, sin re-digitar nada.
2. Daniel registra un gasto pagado por caja de principio a fin **sin salir del flujo de requisiciones** y lo encuentra en la vista de **cierre de caja** filtrando por medio = caja y rango de fechas.
3. Una orden con **dos pagos parciales** muestra saldo y pasa sola a `pagada`; anular un pago la devuelve a `parcial`.
4. El contador abre una OP pagada por caja y ve su **comprobante** sin pedir nada por fuera.
5. El reporte de gastos filtra por **centro de costo** y por **empresa facturada** por separado, con totales de comprometido y pagado por periodo.
6. Todo cambio de monto, auto-aprobación y pago queda en `auditoria` con usuario y valores antes/después.
7. Ni por la web ni por el MCP se puede aprobar una solicitud ajena; la auto-aprobación solo existe para usuario maestro y queda registrada como dos eventos.
