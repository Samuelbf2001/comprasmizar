# Plan de pruebas humanas — todos los procesos de la plataforma

**Fecha:** 21 de septiembre de 2026 · **Base:** `PRD.md` §11.2, adenda `PRD-pagos-y-caja-menor.md`, `docs/plan-salida-produccion.md` §4 (UAT), `docs/qa/QA-pagos-y-caja.md` y el código de `main` (permisos de `lib/domain/rules.ts`, menú de `components/layout/app-shell.tsx`).

Este plan **amplía el UAT de la §4 del plan de salida**: allí hay ~30 recorridos por rol; aquí están todos los procesos, con los casos negativos y de borde. Los recorridos de extremo a extremo (§4) son lo que firma Daniel; los casos por módulo (§5) son la lista de chequeo detallada.

---

## 1. Cómo se ejecuta

### 1.1 Rondas

| Ronda | Quién | Dónde | Qué | Duración |
|---|---|---|---|---|
| **0. Ensayo** | Sixteam (Ernesto/Samuel) | Local con backend real (`scripts/dev-db.ts` + `NEXT_PUBLIC_DEMO_MODE=false`) | Todos los casos técnicos (§5.16–5.19) y un pase de cada recorrido E2E. Todo lo que falle aquí no se le muestra a Mizar. | 3–4 h |
| **1. Sesión operativa** | Daniel, Nelson, Juliana, Claudia + un maestro de obra | Producción tras el despliegue B3, celulares reales + PC | E2E-1 a E2E-4, E2E-6, E2E-9, E2E-10 y los módulos §5.1–5.6, 5.12 y 5.13 | ~2 h |
| **2. Sesión financiera** | Daniel, Luis Miguel (contador) | Producción | E2E-2, E2E-5, E2E-8, E2E-11 (paridad) y §5.7–5.11 | ~1,5 h |
| **3. Sesión de administración** | Ernesto o Samuel | Producción | §5.14–5.19 | ~1 h |
| **4. Re-prueba** | Quien reportó cada falla | Producción | Lo arreglado + todos los casos prioridad **A** (regresión) | ~1 h |
| **Humo** | Sixteam | Producción | Lista de la §6, tras **cada** despliegue | 20 min |

Las rondas 1–3 se hacen **después** del despliegue (B3) y **antes** del día cero (B4): todo lo que se cree se borra al recrear la base. Después del día cero no se hacen pruebas que creen documentos (consumirían consecutivos y quedarían en la auditoría, que es inmutable): solo lectura y la primera solicitud real.

### 1.2 Reglas

1. **Prefijo `PRUEBA-`** en todo texto libre (concepto, ítem propuesto, nombre de proveedor, observaciones), para reconocerlo y depurarlo.
2. **Solo teléfonos del equipo de pruebas.** Cada notificación de estado sale por WhatsApp de verdad: nada de números de maestros de obra reales hasta el día cero.
3. **Cada caso termina en `OK`, `FALLA`, `DUDA` o `N/A`**, con captura (y URL) cuando no es `OK`. `DUDA` = el sistema hizo algo razonable pero no es lo que se esperaba: se convierte en decisión, no en falla.
4. **⚠ = nunca se ha recorrido en un navegador contra el backend real.** Es donde más probable es que aparezca algo.
5. Una persona ejecuta, otra anota. Nadie prueba su propio rol con la cuenta de otro.
6. Si algo falla, no se «arregla» a mano en la base: se anota y se sigue.

### 1.3 Severidad de una falla

| Severidad | Criterio | Efecto |
|---|---|---|
| **Crítica** | Pérdida de datos, dinero mal calculado o mal asignado, acceso indebido a datos ajenos, un proceso no se puede completar | Bloquea la salida |
| **Alta** | Un proceso se completa, pero con rodeo o riesgo de error humano; un aviso no llega | Bloquea la salida |
| **Media** | Confuso, feo, lento, mensaje incorrecto | Se arregla en el segundo despliegue |
| **Baja** | Cosmético, texto, ortografía | Lista de mejoras |

**Criterio de salida** (igual al del plan de salida): todos los casos **A** en `OK`, ninguna falla Crítica o Alta abierta, y acta firmada por Daniel y Ernesto.

---

## 2. Preparación (antes de la ronda 1)

| # | Qué debe existir | Nota |
|---|---|---|
| P1 | **Un usuario por rol:** Solicitante, Revisor (Daniel, también aprobador = usuario maestro), Aprobador ×3 (Nelson, Claudia, Juliana), Contabilidad (Luis Miguel), Admin Mizar, Admin Sixteam | Con correo real del equipo de pruebas, no `*.demo@mizar.test` |
| P2 | **Catálogos mínimos:** 2 obras (una compartiendo centro de costo con otra), 4 centros de costo (uno de cada tipo: obra, administrativo, personal, empresa), 2 empresas facturadas (PROIM y otra), 3 etiquetas (materiales → Nelson, nómina → Claudia, general → Juliana) | Sin `seed.sql` de demo |
| P3 | **Proveedores:** A y B con NIT y datos bancarios, C sin RUT, y una persona natural con cédula. Ítems: ≥ 10 en el catálogo, 3 «frecuentes» | |
| P4 | **Teléfonos autorizados** (`solicitantes_autorizados`) de 2 celulares del equipo, uno por obra distinta; un tercer número **no** autorizado | Sin esto el Flow rechaza todo |
| P5 | **Dos celulares:** un Android y un iPhone, con WhatsApp y datos móviles; uno de ellos también en el Wi-Fi de la oficina | |
| P6 | **Archivos de prueba:** JPG 1 MB (foto real de cámara), PNG, PDF 2 MB, XLSX, DOCX, CSV; **negativos:** un `.txt` renombrado a `.pdf`, un `.exe` renombrado a `.jpg`, un PDF de 11 MB, un JPG de 9,5 MB | |
| P7 | **Contraseña del portal** conocida, enlace y número de WhatsApp | La contraseña **nueva**, no la que circuló |
| P8 | **Flows publicados y variables cargadas:** `WHATSAPP_FLOW_ID=2180911365805386`, `WHATSAPP_FLOW_PAGO_ID=4695777257373991` | Plan de salida B3 |
| P9 | **Un mes real de `GASTOS EN OBRAS.xlsx`** (Contabilidad) para la paridad | Bloqueante de PRD §15 |
| P10 | Plantilla de registro de resultados (§7) abierta y compartida | |

---

## 3. Mapa: qué proceso prueba cada rol

| Proceso | Ext. | Solic. | Daniel | Aprob. | Contab. | Admin |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| Radicar por portal / WhatsApp | ● | | | | | |
| Radicar por web interna, «Mis requisiciones» | | ● | ● | | | |
| Revisar, cotizar, enrutar, declinar | | | ● | | | |
| Aprobar / devolver | | | ●¹ | ● | | |
| Generar OC/OP, cumplimiento, PDF | | | ● | | ○ | |
| Contabilizar | | | | | ● | |
| Pagos (parcial, saldo, anular), caja | | | ● | | ○ | ● |
| Reportes, Excel, PDF socios, paridad | | | ○ | ●² | ● | ● |
| Proveedores y documentos | | | ● | | ○ | ● |
| Catálogos, usuarios, permisos, portal | | | ●³ | | | ● |
| Mensajes de WhatsApp, pantalla, MCP | | | ● | | | ● |

● hace · ○ solo consulta · ¹ como usuario maestro · ² Juliana: «lo aprobado por mí» · ³ ítems, proveedores, centros de costo.

---

## 4. Recorridos de extremo a extremo (los que se firman)

Cada recorrido se ejecuta completo, en orden, con las personas indicadas. **Un recorrido solo está `OK` si en el paso final las cifras cuadran a mano.**

### E2E-1 · Compra multi-proveedor (PRD §11.2.1) — *A*
1. **Maestro de obra (celular, portal):** contraseña → empresa → 3 ítems (uno con foto de cámara, uno propuesto que no está en el catálogo) → enviar. Recibe el acuse por WhatsApp.
2. **Daniel:** ve la solicitud en Revisión con canal «público»; normaliza el ítem propuesto sin duplicar; etiqueta «materiales»; proveedor final A para dos ítems y B para uno; base, IVA y descuento; centro de costo (el de la obra viene por defecto); envía a aprobación.
3. **Nelson:** el aviso le llega por WhatsApp; en la plataforma aprueba dos ítems y **declina uno con motivo**.
4. **Daniel:** «Generar órdenes» → **una OC por proveedor** con solo los ítems aprobados; descarga los PDF; marca una **cumplida** y otra **no cumplida**.
5. **Luis Miguel:** contabiliza ambas.
6. **Reportes:** el gasto aparece en la obra con **subtotal por etiqueta**; el Excel se descarga.
- **Esperado:** nadie re-digitó nada; la no cumplida sigue en pendientes; lo declinado no suma; los totales del Excel = suma a mano de la cotización aprobada.

### E2E-2 · Pago / cuenta de cobro (PRD §11.2.2 + adenda) — *A*
1. **Maestro (portal, «Solicitud de pago»):** beneficiario con cédula **nueva**, empresa, monto, concepto, soporte en **PDF**.
2. **Daniel:** aparece con beneficiario **pendiente de completar** → «Completar ficha»; asigna centro de costo y empresa facturada; **edita el monto** (se ve «Valor original»); etiqueta nómina.
3. **Claudia:** aprueba (web o WhatsApp).
4. **Daniel:** «Generar órdenes» → **OP-AAAA-NNNN** con PDF; registra un pago **parcial** (transferencia, referencia) + comprobante.
5. **Luis Miguel:** contabiliza con saldo pendiente.
6. **Daniel:** «Pagar saldo» → orden **Pagada**.
- **Esperado:** OP separada de OC (rótulo y consecutivo), estado de pago pendiente → parcial → pagada, gasto en el centro de costo con la empresa facturada, historial completo.

### E2E-3 · Devolución (PRD §11.2.3) — *A*
Nelson **devuelve con comentario** (sin comentario no debe dejar) → la requisición vuelve a Daniel con el motivo → Daniel corrige → reenvía → Nelson aprueba.
- **Esperado:** sin requisición duplicada, historial con las 5 transiciones (usuario, fecha/hora, comentario), el solicitante recibió el aviso «devuelta».

### E2E-4 · Declinación (PRD §11.2.4) — *A*
Daniel declina con motivo → desaparece de activas → aparece en el filtro **declinadas** con su motivo → **cero** órdenes y **cero** gasto → el solicitante recibe el aviso.

### E2E-5 · Caja menor del viernes (adenda §4.3) — *A*
1. **Daniel** radica una compra pequeña (o pago) para sí mismo.
2. **«Aprobar yo mismo»** ⚠ → el historial muestra dos eventos (enviada a aprobación, aprobada), ambos de Daniel.
3. Genera la orden; registra el pago con medio **Caja (efectivo)**, referencia y comprobante.
4. Repite con un segundo gasto por **transferencia** (no debe entrar al cierre).
5. **Cierre de caja** con el rango de la semana: total pagado por caja, n.º de pagos, «con comprobante x de y»; descarga el Excel.
- **Esperado:** el cierre muestra solo los pagos de caja vigentes; cuadra contra los recibos físicos.

### E2E-6 · Compra completa por WhatsApp (RF-902) — *A*
Celular autorizado: «hola» → menú → **«Montar requisición»** → Flow v4 (tipo y obra/empresa, un artículo por pantalla ×3, foto de cámara y de galería, detalles, resumen con nombre de empresa) → enviar → aparece en Revisión con canal **WhatsApp** y el solicitante identificado por su número → Daniel revisa → aprobador aprueba **desde WhatsApp** → orden.

### E2E-7 · Solicitud de pago por WhatsApp — *A*
«Solicitar un pago» → Flow de 3 pantallas (identificación, empresa + monto solo dígitos + concepto, resumen) → llega como OP con beneficiario enlazado o **pendiente** → Daniel completa la ficha → sigue E2E-2.

### E2E-8 · Error de digitación en un pago — *M*
Daniel registra un pago con el valor equivocado → **Anular** con motivo (el botón no debe dejar sin motivo) → queda **tachado** con quién, cuándo y por qué → el estado de pago retrocede (y si la orden estaba «pagada» vuelve a «contabilizada») → registra el correcto → el cierre de caja **excluye** el anulado.

### E2E-9 · Daniel aprueba por encima de un aprobador — *A ⚠*
La etiqueta apunta a Juliana; Daniel (usuario maestro) aprueba antes que ella → no se bloquea → el historial dice **a quién se saltó** → la requisición deja de aparecer en la bandeja de Juliana.

### E2E-10 · Autonomía del cliente (sin Sixteam) — *A*
Daniel crea un **centro de costo**, una **obra**, un **ítem** y un **proveedor con documentos**; edita los **teléfonos autorizados**. El Administrador cambia el **aprobador de una etiqueta** → una requisición nueva con esa etiqueta se enruta al aprobador nuevo, sin desarrollo. El Administrador ajusta un **permiso** en la matriz y el efecto se ve en pantalla.

### E2E-11 · Mes completo y paridad contable — *A (bloqueante PRD §15)*
Cargar un mes real de `GASTOS EN OBRAS.xlsx` en la plataforma (por la vía normal: requisiciones y pagos) y cuadrar **al peso**: total por obra, total general y subtotal por etiqueta contra el Excel de Contabilidad. Luis Miguel confirma si el Excel exportado sirve para cargar a Helisa (P1).

### E2E-12 · Gasto compartido entre obras (RF-305) — *M*
Daniel reparte una compra entre 2 obras con montos manuales → la suma debe cuadrar (si no, no deja) → cada obra muestra su parte en reportes → el total general no se duplica.

---

## 5. Casos por módulo

**Prioridad:** **A** imprescindible para salir · **M** importante · **B** deseable. **⚠** = nunca recorrido en navegador contra backend real.

### 5.1 Acceso y sesión

| ID | Rol | Acción | Esperado | P |
|---|---|---|---|---|
| ACC-01 | Cada rol | Iniciar sesión con usuario y clave correctos | Llega a Inicio; el menú muestra **solo** lo de su rol (Solicitante: Inicio, Nueva, Mis requisiciones; Aprobador: Aprobaciones, Reportes; Contabilidad: Órdenes, Cierre de caja, Proveedores, Reportes; etc.) | A |
| ACC-02 | Cualquiera | Clave equivocada | «No pudimos iniciar sesión con esos datos.» — sin decir si el usuario existe | A |
| ACC-03 | Cualquiera | Correo o clave vacíos | «Escribe tu correo y contraseña.» | B |
| ACC-04 | Técnico | 11+ intentos en 1 minuto | «Demasiados intentos seguidos. Espera un minuto…»; se libera solo | M |
| ACC-05 | Admin | Alta de usuario → clave temporal → el usuario entra | Entra y puede cambiarla en `/cambiar-clave`. **DUDA de producto:** el código **no obliga** el cambio al primer ingreso (no hay marca de clave temporal), pero el plan de salida B4 lo da por hecho. Anotar si se construye | A |
| ACC-06 | Usuario | «¿Olvidaste tu clave?» | Texto que manda a pedirla a un administrador (no hay correo automático); el administrador asigna una temporal y **se cierran las sesiones** de esa cuenta | A |
| ACC-07 | Admin | Desactivar un usuario | «Tu cuenta no tiene acceso vigente. Contacta al administrador.» (mensaje distinto al de clave mala); sus sesiones abiertas dejan de servir | A |
| ACC-08 | Cualquiera | Cerrar sesión; pulsar «atrás» | Vuelve a login; el botón atrás no muestra datos | M |
| ACC-09 | Cualquiera | Abrir una URL interna sin sesión | Redirige a login y, al entrar, vuelve a esa URL | M |
| ACC-10 | Cualquiera | Dejar la sesión abierta más de 12 h sin uso / más de 7 días | Pide iniciar sesión de nuevo, sin error técnico | B |

### 5.2 Portal público (solicitante externo, en el celular)

| ID | Rol | Acción | Esperado | P |
|---|---|---|---|---|
| POR-01 | Ext. | Abrir el enlace; contraseña mala, luego buena | «Contraseña incorrecta»; con la buena avanza | A |
| POR-02 | Ext. | **Compra** por empresa: 3 ítems (1 con foto de cámara), con teléfono → enviar | Resumen claro; confirmación «La estamos validando» con consecutivo; **acuse por WhatsApp** | A |
| POR-03 | Ext. | Enviar **sin teléfono** (es opcional) | Se radica; el resumen avisa «Sin teléfono (sin aviso por WhatsApp)». No 503 (QA H2) | A |
| POR-04 | Ext. | Dejar campos obligatorios vacíos | Mensajes por campo, sin perder lo ya escrito | A |
| POR-05 | Ext. | Ítem del catálogo vs. ítem propuesto | El propuesto llega a Daniel como «pendiente de normalización» | A |
| POR-06 | Ext. | Subir foto: JPG de cámara, PNG; luego `.exe` renombrado a `.jpg` y JPG de 9,5 MB / PDF de 11 MB | Válidas se aceptan; la falsa se rechaza (se valida el **contenido**); la que excede el tope se rechaza con mensaje claro | A |
| POR-07 | Ext. | **Pago**, beneficiario con cédula **nueva**, soporte **PDF** ⚠; repetir con **Excel**, con imagen y **sin** soporte | Los tres tipos llegan y **se pueden descargar** desde el detalle; sin soporte también pasa | A ⚠ |
| POR-08 | Ext. | Pago con NIT de un proveedor existente | Se enlaza al proveedor existente (no crea otro) | A |
| POR-09 | Ext. | Pago con el mismo nombre que otro beneficiario pero cédula distinta (homónimo) | Conviven; con la **misma** cédula se detecta | M |
| POR-10 | Ext. | Monto con puntos de miles, con 0, negativo, letras; concepto de más de 120 caracteres | Rechazo con motivo por campo; los puntos de miles se tratan bien | M |
| POR-11 | Ext. | Doble toque en «Enviar» | Se crea **una** solicitud | A |
| POR-12 | Ext. | 10+ contraseñas malas seguidas | Bloqueo temporal; se libera | M |
| POR-13 | Ext. | Desde el portal, escribir a mano `/revision` o `/ordenes` | Login; el portal **solo puede crear** | A |
| POR-14 | Ext. | Recorrer todo en Android/Chrome e iPhone/Safari a 375 px; en datos móviles **y** en el Wi-Fi de la oficina | Sin scroll horizontal; carga en el Wi-Fi de Claro (si no, capturar el mensaje exacto — plan de salida §7) | A |
| POR-15 | Daniel | Ver la solicitud del portal en el detalle | Foto/soporte bajo «Adjuntos del solicitante» y **descargables** ⚠ (fallaba con 500 en producción) | A ⚠ |

### 5.3 WhatsApp (entrante)

| ID | Rol | Acción | Esperado | P |
|---|---|---|---|---|
| WA-01 | Ext. autorizado | Escribir «hola» a la línea | Menú de **3 botones**: «Montar requisición», «Solicitar un pago», «Mis requisiciones» | A |
| WA-02 | Ext. | Flow de captura v4 completo con fotos (cámara y galería) | Llega a Revisión con canal **WhatsApp**; solicitante identificado por su número; sin datos de solicitante que escribir | A |
| WA-03 | Ext. | «Mis requisiciones» | Lista con estado de las suyas; sin solicitudes → mensaje amable | A |
| WA-04 | Ext. | Flow de pago (3 pantallas) | Llega como OP; beneficiario enlazado o pendiente; el monto solo admite dígitos | A |
| WA-05 | Ext. | Número **no autorizado** intenta usar el Flow | Hoy la persona **no ve nada** (riesgo 8 del ESTADO). Registrar qué ve y anotar **DUDA**: ¿es aceptable o se le responde algo? | A |
| WA-06 | Ext. | Cerrar el Flow a la mitad | No se crea nada | M |
| WA-07 | Ext. | Enviar el Flow y reintentar (mala señal) | **No duplica** (idempotencia por id de mensaje) | A |
| WA-08 | Ext. | Ver el Flow en iPhone y Android | Textos sin cortar (los rótulos ≤ 20 caracteres) | M |
| WA-09 | Técnico | Revisar `whatsapp_eventos` tras las pruebas | Toda entrada y salida registrada, incluido el rechazo | M |
| WA-10 | Ext. | Escribir texto libre fuera del menú | Responde algo útil o el menú; no queda mudo | B |

### 5.4 Captura interna y «Mis requisiciones»

| ID | Rol | Acción | Esperado | P |
|---|---|---|---|---|
| REQ-01 | Solic. | **Nueva requisición** de compra: obra, fecha requerida, destino, ítems del catálogo (frecuentes primero), cantidad, unidad, proveedor sugerido, enlace, foto | Totales calculados solos; consecutivo `REQ-AAAA-NNNN` | A |
| REQ-02 | Solic./Daniel | Tipo **pago**: fecha del gasto, beneficiario por identificación (cédula o NIT) con alta rápida, soporte opcional | Se radica; beneficiario creado marcado pendiente si es nuevo | A |
| REQ-03 | Solic. | Proponer un ítem nuevo | Queda pendiente de normalización | A |
| REQ-04 | Solic. | Campos obligatorios vacíos, cantidad 0 o negativa | Mensajes por campo | A |
| REQ-05 | Solic. | **Mis requisiciones** | Solo las suyas, con su estado; abrir una muestra el historial | A |
| REQ-06 | Solic. | Una suya fue devuelta / declinada | Se ve el estado y el **motivo** | A |
| REQ-07 | Solic. | Cambiar el id en la URL por el de una requisición ajena | Rechazo, no muestra datos | A |
| REQ-08 | Solic. | Intentar editar una ya enviada | No se puede (solo Daniel la modifica) | M |
| REQ-09 | Solic. | Adjuntar soporte general + foto por ítem (PDF/JPG/PNG) | Se ven y se descargan | A ⚠ |
| REQ-10 | Solic. | Crear desde el celular | Cabecera y formulario sin desbordar (QA lo detectó a 390 px) | M |

### 5.5 Revisión (Daniel)

| ID | Rol | Acción | Esperado | P |
|---|---|---|---|---|
| REV-01 | Daniel | Abrir **Revisión de Daniel** | Ve las de **todos** los canales, con indicador de canal, orden cronológico; el contador cuadra | A |
| REV-02 | Daniel | Filtros: obra, estado, canal, fecha, etiqueta | Cada filtro reduce la lista correctamente; combinados también | A |
| REV-03 | Daniel | Alternar lista y **Kanban** | Mismas requisiciones; las columnas corresponden a los estados | M |
| REV-04 | Daniel | Iniciar revisión; normalizar un ítem propuesto | Se vincula a uno del catálogo o se crea **sin duplicar**; el catálogo se actualiza para lo futuro | A |
| REV-05 | Daniel | Asignar etiqueta | El aprobador sugerido es el de la etiqueta (materiales → Nelson, nómina → Claudia, resto → Juliana) | A |
| REV-06 | Daniel | Proveedor final por ítem distinto del sugerido; **alta rápida** de proveedor nuevo sin salir de la pantalla | Se conserva todo lo ya digitado | A |
| REV-07 | Daniel | Cotización: base, IVA, descuento, total en 3 ítems | Cálculo correcto (verificar a mano, redondeos incluidos) | A |
| REV-08 | Daniel | Centro de costo (viene el de la obra) y **empresa facturada** | Cambiables de forma independiente; la empresa facturada no altera el centro de costo | A |
| REV-09 | Daniel | En un pago, **editar el monto** | Aparece «Valor original»; queda auditado antes/después | A |
| REV-10 | Daniel | Guardar parcial, salir, volver | Recupera lo guardado | M |
| REV-11 | Daniel | Enviar a aprobación con un ítem con cotización 0; luego con un ítem sin proveedor final | Cotización 0: **bloquea** con mensaje claro. Sin proveedor: **se permite** (decisión 31-ago, confirmada 25-sep); el proveedor se exige al generar la orden | A |
| REV-12 | Daniel | **Declinar** con y sin motivo | Sin motivo no deja; con motivo pasa a declinada, sale de activas | A |
| REV-13 | Daniel | Filtro «declinadas» | La encuentra con su motivo; no tiene orden ni gasto | A |
| REV-14 | Daniel | Beneficiario **pendiente de completar** → «Completar ficha» ⚠ | La marca se ve en la bandeja, el detalle y Proveedores (QA H5, corregido: confirmar en navegador); al completar desaparece | A ⚠ |
| REV-15 | Daniel | **«Aprobar yo mismo»** ⚠ | El botón aparece; dos eventos en el historial; si el aprobador asignado es otra persona, mensaje claro (no error técnico) | A ⚠ |
| REV-16 | Daniel | Aprobar por encima del aprobador asignado ⚠ | No se bloquea; el historial dice a quién se saltó | A ⚠ |
| REV-17 | Daniel | Reparto por ítem con distinto aprobador + «Aprobar yo mismo» | Rechazo **antes** de mover nada, o aviso al otro aprobador; nunca una requisición `en_aprobacion` que nadie sabe que espera (QA H4, corregido: confirmar) | A ⚠ |
| REV-18 | Daniel | Ver adjuntos y cotizaciones; descargarlos | Descarga correcta ⚠ | A ⚠ |
| REV-19 | Daniel | **Historial de trazabilidad** de una requisición con varios pasos | Cada transición: usuario, fecha/hora, comentario, **origen** (web, público, WhatsApp) | A |
| REV-20 | Daniel | Requisición devuelta reaparece | Con el motivo del aprobador; se corrige y reenvía sin duplicarse | A |

### 5.6 Aprobación

| ID | Rol | Acción | Esperado | P |
|---|---|---|---|---|
| APR-01 | Nelson / Claudia | **Aprobaciones**: bandeja personal | Solo ve **lo suyo**; probar con dos aprobadores y una requisición de cada uno | A |
| APR-02 | Aprobador | Abrir el detalle | Solicitante, obra, ítems, proveedor, valores, soportes, historial | A |
| APR-03 | Aprobador | Aprobar todo | Pasa a aprobada; genera aviso al solicitante | A |
| APR-04 | Aprobador | Aprobar unos ítems y **declinar otros con motivo** | «2 aprobados, 1 declinado»; la orden solo lleva los aprobados | A |
| APR-05 | Juliana | **Selección múltiple** desde la lista, aprobar varios | Todos pasan; el resumen dice cuántos | M |
| APR-06 | Aprobador | **Devolver** sin comentario y con comentario | Sin comentario no deja; con comentario vuelve a Daniel | A |
| APR-07 | Aprobador | Buscar botones de generar orden, editar montos, proveedor | No existen | A |
| APR-08 | Aprobador | Le llega el aviso por **WhatsApp** (plantilla con botón → Flow de aprobación) → aprueba desde ahí | La plataforma lo refleja; historial con origen WhatsApp | A |
| APR-09 | Aprobador | Aprobar por WhatsApp y luego intentar por web la misma | Segunda acción rechazada con mensaje claro, sin duplicar | A |
| APR-10 | Aprobador | Ítems repartidos entre dos aprobadores | Cada uno ve **solo sus ítems** (riesgo colateral que dejó el QA H3) | A ⚠ |
| APR-11 | Aprobador | Aprobación con la ventana de 24 h de WhatsApp vencida | Recibe la plantilla (no el Flow directo); el flujo sigue funcionando | M |
| APR-12 | Aprobador | Reportes → «lo aprobado por mí» del mes | Solo lo suyo; exporta a Excel | A |

*El recordatorio a aprobadores rezagados (parte de RF-406) no se encontró en el código: no se prueba; se anota si Mizar lo espera.*

### 5.7 Órdenes de compra y de pago

| ID | Rol | Acción | Esperado | P |
|---|---|---|---|---|
| ORD-01 | Daniel | «Generar órdenes» sobre una aprobada con 2 proveedores | **2 OC**, cada una con su consecutivo `OC-AAAA-NNNN`, proveedor y estado propios | A |
| ORD-02 | Daniel | Ídem sobre un pago | **OP** `OP-AAAA-NNNN`, con rótulo «ORDEN DE PAGO» y beneficiario | A |
| ORD-03 | Daniel | Intentar generar dos veces las órdenes de la misma requisición | No duplica | A |
| ORD-04 | Daniel / Contab. | Descargar el **PDF** de una OC y de una OP | Contenido correcto (empresa, proveedor/beneficiario, ítems, valores, elaborado/aprobado). Preguntar: ¿este formato le sirve a un proveedor? (logos y membrete: P4 pendiente; qué empresa encabeza la OP: QA H10) | A |
| ORD-05 | Daniel | Cumplimiento: **cumplida / no cumplida / no necesario** | Cambia y queda auditado; las **no cumplidas** siguen en pendientes | A |
| ORD-06 | Contab. | **Contabilizar** una OC y una OP | Pasa a contabilizada; el gasto queda en la obra | A |
| ORD-07 | Cualquiera | Generar 3 órdenes seguidas | Consecutivos correlativos, sin saltos ni repetidos | A |
| ORD-08 | Daniel | La lista muestra los ejes **Entrega / Contabilidad / Pago** | Cada uno con su estado; independientes | M |
| ORD-09 | Daniel / Contab. | Filtros: obra, estado, fecha, proveedor, medio de pago, estado de pago, centro de costo, empresa facturada, fecha de pago | Cada uno filtra bien; combinados también | A |
| ORD-10 | Aprobador | Abrir `/ordenes` | «Sin acceso con este rol» | A |
| ORD-11 | Daniel | Orden `no necesario` | No suma a comprometido ni gasto | M |

### 5.8 Pagos

| ID | Rol | Acción | Esperado | P |
|---|---|---|---|---|
| PAG-01 | Daniel | **Registrar pago** total por transferencia con referencia | Estado de pago **Pagada** | A |
| PAG-02 | Daniel | Pago **parcial** y luego un segundo | «Pago parcial» con el saldo correcto en cada paso | A |
| PAG-03 | Daniel | Pago mayor al saldo | Rechazo con mensaje claro | A |
| PAG-04 | Daniel | Valor vacío, 0, negativo, decimal, medio vacío | Mensaje por campo en el diálogo | A |
| PAG-05 | Daniel | Comprobante en el segundo paso; descargarlo ⚠ | Se adjunta y se descarga | A ⚠ |
| PAG-06 | Daniel | **Anular** con y sin motivo | Sin motivo el botón está deshabilitado; con motivo queda **tachado** con quién/cuándo/motivo; el estado retrocede | A |
| PAG-07 | Daniel | Anular el pago que cerraba una orden «pagada» | Vuelve a «contabilizada» y se borra la fecha de pago del gasto | A |
| PAG-08 | Daniel | **«Pagar saldo»** | Diálogo con el saldo prellenado; al guardar la orden queda **Pagada** | A |
| PAG-09 | Daniel | «Marcar pagada» con saldo pendiente | Rechazo «saldo pendiente» | A |
| PAG-10 | Contab. | Buscar «Registrar pago» / «Anular» ⚠ | **No aparecen** (decisión de Ernesto 17-sep); ve pagos y comprobantes | A ⚠ |
| PAG-11 | Admin | En Configuración → Permisos por rol, devolverle `payment:register` a Contabilidad ⚠ | Los botones **aparecen** para Contabilidad sin redeploy | A ⚠ |
| PAG-12 | Daniel | Medio **Caja (efectivo)** | Aparece así en la lista y en el cierre de caja | A |

### 5.9 Cierre de caja

| ID | Rol | Acción | Esperado | P |
|---|---|---|---|---|
| CAJ-01 | Daniel | **Cierre de caja** con el rango de la semana | Total pagado por caja, n.º de pagos, «con comprobante x de y» | A |
| CAJ-02 | Daniel | Filtrar por centro de costo | Recalcula | A |
| CAJ-03 | Daniel | Pagos por transferencia y **anulados** | No entran al cierre | A |
| CAJ-04 | Daniel | Excel del cierre | Coincide fila a fila con la pantalla | A |
| CAJ-05 | Daniel | Rango invertido / sin pagos | Mensaje claro / estado vacío, no error | M |
| CAJ-06 | Aprobador | Abrir `/gastos` | Rechazo claro (no tiene `expense:read`), no pantalla vacía | A |
| CAJ-07 | Daniel | Descargar un comprobante desde el cierre ⚠ | Descarga correcta | A ⚠ |

### 5.10 Reportes y contabilidad

| ID | Rol | Acción | Esperado | P |
|---|---|---|---|---|
| REP-01 | Contab. | Gastos por obra / centro de costo y periodo (corte 1–30) | Totales correctos | A |
| REP-02 | Contab. | **Subtotal por etiqueta** dentro de cada obra | Suma = total de la obra | A |
| REP-03 | Contab. | **Comprometido vs pagado** por centro de costo y por mes | Comprometido − pagado = pendiente; excluye `no necesario` | A |
| REP-04 | Contab. | Filtros: obra, centro, sociedad, periodo, aprobador, etiqueta, medio, estado de pago, empresa facturada | Cada uno afecta totales y tabla | A |
| REP-05 | Contab. | **Excel** (provisional Helisa) | Abre en Excel; columnas claras; incluye empresa facturada y estado de pago. Preguntar a Luis Miguel: ¿carga a Helisa sin retrabajo? (P1) | A |
| REP-06 | Admin | **PDF para socios** por sociedad y periodo | Se imprime con formato de presentación, sin cortes | M |
| REP-07 | Contab. | Un gasto de una requisición **declinada** o devuelta | No suma | A |
| REP-08 | Contab. | Buscar cualquier botón de editar/aprobar/pagar | No hay (solo lectura + exportación) | A |
| REP-09 | Todos | Reporte de un periodo sin datos | Estado vacío, no error ni cifras de demo | M |
| REP-10 | Contab. | **Paridad** (E2E-11) | Cuadra al peso | A |
| REP-11 | Contab. | Descargar comprobantes y documentos de proveedor ⚠ | Descarga correcta | A ⚠ |
| REP-12 | Admin Mizar | Ver reportes ejecutivos y gráficos | Gasto por obra/etiqueta/periodo, coherentes con la tabla | M |

### 5.11 Proveedores

| ID | Rol | Acción | Esperado | P |
|---|---|---|---|---|
| PRV-01 | Daniel | Directorio: buscar, filtrar | Encuentra por razón social e identificación (con tildes y mayúsculas) | A |
| PRV-02 | Daniel | **Alta** de proveedor sin RUT | Se crea (RUT no obligatorio) | A |
| PRV-03 | Daniel | Alta con NIT ya existente | Rechazo o advertencia, no duplica | A |
| PRV-04 | Daniel | **Ficha**: contacto, datos bancarios, historial de OC/OP | Historial correcto; datos bancarios **no** aparecen en el listado y solo los ve quien gestiona proveedores o Contabilidad | A |
| PRV-05 | Daniel | Subir RUT, Cámara de Comercio, certificación bancaria; descargar ⚠ | Se guardan y se descargan; archivo inválido rechazado | A ⚠ |
| PRV-06 | Daniel | Desactivar un proveedor | No se puede asignar en revisiones nuevas; el historial se conserva | M |
| PRV-07 | Daniel | «Completar ficha» de un beneficiario pendiente | Desaparece la marca «Pendiente de completar» | A |
| PRV-08 | Contab. | Abrir Proveedores y una ficha | Solo lectura (ve datos bancarios, no puede editar) | A |
| PRV-09 | Admin Mizar | Abrir Proveedores | Carga (antes daba 403; QA H11) | M |
| PRV-10 | Daniel | Revisar la lista real cargada | Sin duplicados; NIT/cédula correctos; nombres con tildes | A |

### 5.12 Catálogos y datos maestros

| ID | Rol | Acción | Esperado | P |
|---|---|---|---|---|
| CAT-01 | Daniel/Admin | Crear, editar, desactivar un **centro de costo** de cada tipo | Aparece en revisión y reportes; el inactivo ya no se ofrece | A |
| CAT-02 | Daniel/Admin | Crear una **obra** (sociedad, centro de costo) y desactivarla | La inactiva no sale al radicar; el historial no se rompe | A |
| CAT-03 | Admin | **Etiquetas** con aprobador; cambiar el aprobador | Las requisiciones **nuevas** se enrutan al nuevo; las viejas no cambian | A |
| CAT-04 | Daniel | **Ítems**: crear, editar, fusionar duplicados | Los frecuentes salen primero; editar afecta solo lo futuro | A |
| CAT-05 | Admin Mizar | Intentar editar **ítems** en modo Básico | No puede (solo Daniel) | M |
| CAT-06 | Daniel/Admin | **Teléfonos autorizados**: agregar y quitar | Un número quitado ya no puede usar el Flow ni el portal | A |
| CAT-07 | Admin | Sociedades / empresas facturadas | Se ofrecen en la revisión de compra y de pago | A |
| CAT-08 | Cualquiera | Buscar UUID o códigos internos en pantalla | No aparecen (solo nombres) | M |
| CAT-09 | Daniel | Importar/cargar la lista real de proveedores y de centros de costo | Sin duplicados, tipos correctos | A |

### 5.13 Notificaciones y Mensajes de WhatsApp

| ID | Rol | Acción | Esperado | P |
|---|---|---|---|---|
| NOT-01 | Ext. | Radicar con teléfono | Llega `requisicion_recibida` con el consecutivo | A |
| NOT-02 | Ext. | Aprobada / devuelta / declinada | Llega el aviso correspondiente | A |
| NOT-03 | Aprobador | Daniel envía a aprobación | Recibe el aviso (Flow o plantilla con botón; el texto simple es el último recurso) | A |
| NOT-04 | Técnico | Estado de cada mensaje | Llega a **entregado** (no solo «enviado») | A |
| NOT-05 | Ext. | Radicar sin teléfono | No falla ni bloquea; simplemente no hay aviso | A |
| NOT-06 | Daniel | **Mensajes de WhatsApp** con el dominio de producción ⚠ | Carga el inbox; solo la línea MIZAR. Si no carga: crear un embed con el origen actual (plan de salida B3) | A ⚠ |
| NOT-07 | Daniel | Contestar una conversación desde el inbox | Sale por la línea MIZAR | M |
| NOT-08 | Otros roles | Abrir Mensajes con Solicitante, Aprobador, Contabilidad | **DUDA a decidir:** el menú se lo muestra a esos roles; ¿deben ver las conversaciones de todos? | A |
| NOT-09 | Técnico | La URL del embed | No aparece en el código de la página ni en el historial del navegador (es credencial portadora) | A |
| NOT-10 | Técnico | Cola de notificaciones | Sin `fallido` acumulados; el despachador corre | A |

### 5.14 Inicio, dashboard y modo pantalla

| ID | Rol | Acción | Esperado | P |
|---|---|---|---|---|
| DSH-01 | Cada rol | **Inicio** | Métricas propias del rol (en revisión, en aprobación, valor en trámite, gasto del periodo) que **cuadran con las listas** | A |
| DSH-02 | Cada rol | «Cola de atención» y actividad reciente | Solo lo que espera algo de esa persona | A |
| DSH-03 | Admin | Gráficos ejecutivos | Coinciden con Reportes | M |
| DSH-04 | Técnico | Consola del navegador en Inicio con órdenes generadas | Sin errores de React (regresión de QA H7: claves duplicadas) | M |
| DSH-05 | Admin | Crear **sesión de pantalla**, abrir `/pantalla` en una TV | Se ve el dashboard, se **refresca solo**, sin botones de escritura | M |
| DSH-06 | Admin | Revocar la sesión de pantalla | La TV deja de mostrar datos | M |

### 5.15 Administración y configuración

| ID | Rol | Acción | Esperado | P |
|---|---|---|---|---|
| ADM-01 | Admin | Alta de usuario con rol | Aparece en la lista; entra con su clave | A |
| ADM-02 | Admin Mizar | Intentar crear un Admin Sixteam | Rechazado | A |
| ADM-03 | Admin | **Matriz de permisos** ⚠: quitar uno, dar otro | El efecto se ve en pantalla (botones, rutas); auditoría con antes/después | A ⚠ |
| ADM-04 | Admin Sixteam | Quitarle `config:manage` a su propio rol | Imposible | A |
| ADM-05 | Admin | Cambiar la **contraseña del portal** | La anterior deja de servir; la nueva funciona | A |
| ADM-06 | Admin Sixteam | **«Ver como»** otro rol | Solo cambia lo que se pinta; los permisos reales no cambian (no puede hacer lo que no podría) | A |
| ADM-07 | Admin | Configuración: estado de WhatsApp, Flows, catálogos | Coherente con lo desplegado | M |
| ADM-08 | Admin | Revisar la **auditoría** tras varias acciones | Cada cambio de catálogo, permiso, usuario y estado: quién, cuándo, qué, origen | A |
| ADM-09 | Admin | Restablecer la clave de un usuario | Se le cierran las sesiones abiertas | A |

### 5.16 Seguridad (pruebas en negativo)

| ID | Rol | Acción | Esperado | P |
|---|---|---|---|---|
| SEG-01 | Cada rol | Escribir a mano cada ruta que **no** tiene en el menú | Rechazo claro (no pantalla vacía ni error técnico) | A |
| SEG-02 | Solic. | Ver requisición ajena por URL | Rechazo | A |
| SEG-03 | Aprobador | Ver una no asignada por URL | Rechazo | A |
| SEG-04 | Técnico | Contabilidad llama a la API para aprobar/pagar/editar | 403 | A |
| SEG-05 | Técnico | Descargar un adjunto sin sesión y con un rol sin permiso | Bloqueado | A |
| SEG-06 | Técnico | Subir `.html`/`.svg` con script y `.exe` disfrazados | Rechazados por contenido; lo permitido se sirve como **descarga**, nunca se abre en el navegador | A |
| SEG-07 | Técnico | Rotar `X-Real-IP` con muchas contraseñas malas (paso 6.4 de `docs/despliegue.md`) | El limitador **sigue** frenando | A |
| SEG-08 | Técnico | Cabecera HSTS; `POST` sin sesión | HSTS presente; 401, nunca 503 | A |
| SEG-09 | Admin | Cédulas y datos bancarios | No en listados ni en la auditoría | A |
| SEG-10 | Técnico | La sesión de pantalla intenta escribir | Rechazado | M |
| SEG-11 | Técnico | Credenciales que circularon (Kapso, EasyPanel, portal, secretos internos) | Rotadas (plan de salida B2) | A |

### 5.17 Servidor MCP (Sixteam)

| ID | Acción | Esperado | P |
|---|---|---|---|
| MCP-01 | Conectar Claude con la llave de un usuario; listar herramientas | Lectura (`estado_embudo`, `consultar_*`, `ficha_proveedor`, `exportar_reporte`) y escritura acotada (`registrar_pago`, `actualizar_estado_orden`, centros de costo) | A |
| MCP-02 | Usar la llave de Contabilidad para registrar un pago | Rechazado (mismos permisos que la web) | A |
| MCP-03 | Buscar cualquier herramienta de **aprobar, devolver o declinar** | **No existe** (RF-1205) | A |
| MCP-04 | Ver la auditoría de lo hecho por MCP | Origen = mcp, con el usuario de la llave | A |
| MCP-05 | Revocar la llave | Deja de funcionar | M |

### 5.18 Robustez, dispositivos y errores

| ID | Acción | Esperado | P |
|---|---|---|---|
| ROB-01 | Daniel edita una requisición mientras Nelson la aprueba (dos personas, misma requisición) | La segunda acción recibe mensaje claro; sin datos corruptos | A |
| ROB-02 | Modo avión a mitad de enviar; volver a conectar | Mensaje amable con «reintentar»; **no duplica** | A |
| ROB-03 | Conexión lenta (3G simulado) | Estados de carga visibles, sin pantalla en blanco | M |
| ROB-04 | Doble clic en Guardar / Aprobar / Registrar pago / Generar órdenes | Una sola operación | A |
| ROB-05 | Refrescar con F5 y «atrás» en medio de un formulario | Comportamiento sensato, sin errores técnicos | M |
| ROB-06 | Sesión vencida en medio de un formulario | «Iniciar sesión», no código de error | M |
| ROB-07 | Provocar errores (permiso, red, servidor) | Mensajes en lenguaje llano; **nunca** `forbidden`, `internal_error` ni stack | A |
| ROB-08 | Chrome, Edge, Safari iOS, Chrome Android; 375 px, tablet, 1366 px | Sin scroll horizontal; todo usable | A |
| ROB-09 | 30+ requisiciones y 30+ órdenes en las bandejas | Carga en < 3 s; listas navegables | M |
| ROB-10 | Textos con tildes, ñ, comillas, emojis, mayúsculas en nombres e ítems | Se guardan, se buscan y se ven bien | M |
| ROB-11 | Adjunto de 9,9 MB y varios adjuntos a la vez | Sube; no se cuelga | M |
| ROB-12 | Leer cada pantalla sin esfuerzo (contraste de grises, tamaño de letra en celular) | Legible sin acercar | M |

*ROB-03, 05, 06 y 07 dependen del trabajo de estados de carga y errores amigables que hoy está **sin commitear**: solo se prueban si entra al despliegue.*

### 5.19 Operación (técnico Sixteam)

| ID | Acción | Esperado | P |
|---|---|---|---|
| OPS-01 | `/api/health` | `ok`, `origin:true`, `commit` = SHA desplegado, 0 WhatsApp fallidos en 24 h | A |
| OPS-02 | Cron de respaldo | Marca `ultimo-exito` de hoy; archivos en Drive | A |
| OPS-03 | **Restauración**: bajar el respaldo, restaurar en base desechable **y desempaquetar el `.tar` de soportes** | Cuentan las mismas filas; los adjuntos abren (el ensayo del 18-sep solo restauró la base) | A |
| OPS-04 | Apagar la app unos minutos | Better Stack avisa; al volver, se recupera | A |
| OPS-05 | Provocar un 500 controlado | Queda en `docker logs` y en Better Stack | M |
| OPS-06 | Detener el cron de respaldo un día (simulado) | La ausencia del latido dispara alerta | M |
| OPS-07 | Migraciones aplicadas; variables `WHATSAPP_FLOW_ID` y `WHATSAPP_FLOW_PAGO_ID` | Coinciden con P8 | A |
| OPS-08 | Descarga de comprobante y de documento de proveedor **detrás del proxy** (Traefik) ⚠ | Descarga correcta (era el 500 crítico H1) | A ⚠ |
| OPS-09 | Exportación completa de los datos de Mizar «bajo demanda» (RF-1004) | Existe una vía documentada y probada. **DUDA:** qué significa «entregar los backups» al cliente (plan de salida B1) | A |
| OPS-10 | Ensayo del **día cero** en local: base vacía + migraciones + maestros, sin `seed.sql` de demo | Consecutivos desde 0001; sin usuarios `*.demo@mizar.test` activos | A |

---

## 6. Prueba de humo (20 min, tras cada despliegue)

Ejecuta Sixteam en este orden: OPS-01 → ACC-01 (un rol) → POR-02 → POR-15 (descargar el adjunto) → REV-01 → APR-03 → ORD-01 → ORD-04 (PDF) → PAG-01 → PAG-05 (descargar comprobante) → CAJ-01 → REP-01 → NOT-04 (entregado) → NOT-06 (inbox) → SEG-07 → SEG-08. Si cualquiera falla, no se anuncia el despliegue.

---

## 7. Registro de resultados

Copiar por cada caso que **no** sea `OK`:

| Caso | Resultado | Severidad | Rol / dispositivo / navegador | Qué pasó (esperado vs. real) | Captura / URL | Quién · cuándo | Estado (abierta / arreglada / re-probada) |
|---|---|---|---|---|---|---|---|

**Decisiones que van saliendo de los `DUDA`** (para que no se pierdan): ACC-05 (¿cambio de clave obligatorio?), WA-05 (¿qué ve un número no autorizado?), ORD-04 (formato del PDF y qué empresa encabeza la OP), NOT-08 (¿quién ve Mensajes?), OPS-09 (qué se le entrega a Mizar como «backup»).

**Acta de aceptación:** al cierre de la ronda 4, una hoja con: casos totales por prioridad, `OK` / `FALLA` / `DUDA` / `N/A` de cada uno, fallas abiertas (deben ser 0 Críticas y 0 Altas), decisiones pendientes con responsable, y firma de Daniel (Mizar) y Ernesto (Sixteam).

---

## 8. Fuera del alcance de estas pruebas (a conciencia)

Nómina multi-beneficiario (P9), ingresos y estado de resultados (fase 2), cruce bancario (adenda §12), bloqueo de cierres de caja, inventario en obra, recordatorio automático a aprobadores rezagados (RF-406, no encontrado en el código) y el módulo «Gastos y caja» retirado el 15-sep (sus rutas responden 410: basta comprobar que `/api/petty-cash`, `/api/incomes` y `/api/cash-closes` dan 410).
