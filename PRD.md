# PRD — Plataforma de Requisiciones y Pagos de Obra

**Cliente:** Mizar · Ictinos — Diseño y Construcción (Colombia)
**Proveedor:** Sixteam.pro
**Versión:** 1.2 — 24 de agosto de 2026 (v1.1: WhatsApp vía Kapso, servidor MCP propio, dashboard, plan por subagente · v1.2: bandeja de Kapso incrustada en la plataforma; datos en Supabase, app en VPS Hostinger)
**Estado:** Borrador final para validación interna (Samuel + Ernesto) antes de arrancar construcción

**Fuentes de este documento:**
- Reunión 12-ago-2026 (Samuel + Juliana + Daniel): definición del flujo y del "corazón" del sistema.
- Reunión 19-ago-2026 (Ernesto + Juliana): presentación de propuesta, dos alcances, precios.
- Reunión demo 21-ago-2026 (Ernesto + Claudia + Daniel + Samuel): **último alcance validado** — catálogo de ítems, declinación, caja menor, impuestos, reportes imprimibles.
- Propuesta comercial "Mizar — Dos Alcances" (agosto 2026).
- Demo HTML (`mizar_demo.html`): módulos dashboard, requisiciones, revisión, aprobaciones, gastos, formulario público, WhatsApp, etiquetas.

---

## 1. Contexto y problema

Mizar e Ictinos operan **17 obras activas** repartidas en **distintas sociedades**. Todo el ciclo de compras y pagos depende hoy de una sola persona (Daniel):

1. Las solicitudes llegan sueltas por WhatsApp a su celular personal.
2. Él las transcribe a mano al formato Excel **CC2-02** (requisición).
3. Cotiza con proveedores, reparte la compra entre varios proveedores cuando aplica.
4. Persigue aprobaciones que hoy viven en papel (Revisó / Aprobó / Entregó).
5. Cada gasto aprobado se vuelve a digitar en la pestaña de su obra en **GASTOS EN OBRAS.xlsx**.
6. Contabilidad re-digita todo en **Helisa** (sistema contable, no se toca).

**Principio rector del proyecto:** la información se captura **una sola vez** y avanza sola hasta el cierre contable. Daniel pasa de digitar a decidir.

**Restricción explícita:** es una plataforma para **una sola empresa** (single-tenant). No se sobredimensiona: sin multiempresa genérica, sin microservicios, sin infraestructura que requiera un equipo de operaciones. Debe ser **simple de administrar** tanto para Sixteam como para Mizar. A la vez, la base debe permitir **agregar módulos y tablas más adelante** hasta convertirse en el ERP del cliente (caja menor ya entró; luego podrían venir tesorería, facturación, inventario, etc.).

---

## 2. Objetivos y métricas de éxito

| # | Objetivo | Métrica de éxito (medible al mes 1 en producción) |
|---|----------|---------------------------------------------------|
| O1 | Eliminar la transcripción manual de requisiciones | ≥ 90% de requisiciones nacen en la plataforma (web o WhatsApp), 0 transcritas por Daniel |
| O2 | Trazabilidad completa de aprobaciones | 100% de requisiciones con historial de quién aprobó/denegó, cuándo y con qué comentario |
| O3 | Reemplazar GASTOS EN OBRAS.xlsx | El cuadro de gastos por obra se genera solo; paridad 100% contra el Excel en el mes de prueba paralela |
| O4 | Contabilidad sin re-digitación | Export a Excel compatible con la carga a Helisa, descargable por obra y periodo |
| O5 | Ninguna compra pendiente perdida | Toda OC tiene estado (cumplida / no cumplida / no necesario) y las pendientes son visibles en un filtro |
| O6 | Adopción real (el mayor riesgo, dicho por Samuel el 12-ago) | Los maestros de obra y solicitantes usan el canal (WhatsApp/web) sin volver al chat personal de Daniel |

---

## 3. Decisiones de alcance

### 3.1 Qué construimos

Se construye **una sola plataforma** cuyo plan de entrega cubre los dos alcances comerciales:

- **Fases 1–3 (semanas 1–6)** = Alcance Básico: ciclo completo con una OC por requisición.
- **Fase 4 (semanas 7–8)** = Alcance Completo: división de OC por proveedor, WhatsApp, autoservicio, reportes ejecutivos y notificaciones.

**Decisión de arquitectura clave (punto medio):** aunque la división por proveedor y el autoservicio son comercialmente "Completo", el **modelo de datos los soporta desde el día 1**:

- `requisicion_item.proveedor_final_id` existe desde Fase 2. En Básico el generador crea 1 OC por requisición; en Completo agrupa por proveedor. Es un cambio de estrategia de generación, no un re-diseño.
- Las pantallas de administración de catálogos (obras, etiquetas, proveedores, ítems, usuarios) se construyen una sola vez como CRUD del núcleo. "Autoservicio" es simplemente habilitar el rol administrador de Mizar sobre esas pantallas; mientras esté en Básico, solo el rol Sixteam las ve. **Nada se construye dos veces.**

### 3.2 Novedades del último alcance (reunión 21-ago) — obligatorias

| Origen | Requisito nuevo |
|--------|-----------------|
| Claudia + Daniel | **Catálogo maestro de ítems**: el solicitante selecciona de un desplegable, no escribe libre. Carga inicial masiva desde los Excel existentes. **Solo Daniel edita el catálogo**; editar un ítem lo actualiza para todos. El solicitante puede proponer un ítem nuevo, que queda pendiente de normalización por Daniel. |
| Daniel | **Declinar requisiciones**: no se eliminan; pasan a estado "declinada", salen de la vista activa y quedan consultables. |
| Daniel | **Impuestos**: los valores cotizados deben poder desglosarse (base, IVA, total). Formato exacto se valida con contabilidad en Fase 1. |
| Daniel | **Caja menor**: módulo liviano para registrar gastos por caja que no pasan por requisición, para que el cuadro de gastos por obra quede completo. |
| Claudia | **Reporte imprimible**: el informe de gastos por obra y periodo debe poder visualizarse en plataforma e imprimirse/exportarse a PDF con formato de presentación (para socios; cada obra es de una sociedad distinta, corte mensual del 1 al 30). |
| Claudia | **Sin límite de requisiciones** por obra ni por año. Numeración con consecutivo. |
| Claudia | **Backups** de toda la información y posibilidad de exportarla completa. |
| Daniel (12-ago, confirmado 21) | **Gastos compartidos** entre obras: existen gastos que pertenecen a varias obras. Solución v1: el revisor puede dividir el gasto en líneas por obra con montos manuales. (Ver pregunta abierta P3.) |

### 3.3 Fuera de alcance (acordado, no negociable en esta versión)

- Agente de IA / captura por nota de voz (se evalúa después de tener datos reales).
- Sistema contable: **Helisa no se toca ni se integra por API**; la frontera es el archivo de exportación.
- Flujo de caja y tesorería.
- Umbral por monto para segundo aprobador (se cotiza aparte si se necesita; el modelo de etiquetas lo permitirá a futuro).
- Multiempresa / multi-tenant genérico. La "sociedad" es un atributo de la obra, no un tenant.
- Apps móviles nativas (la web es responsive; el canal móvil es WhatsApp).

### 3.4 Decisiones internas v1.1–v1.2 (24-ago, Samuel)

| Decisión | Detalle |
|----------|---------|
| **WhatsApp vía Kapso** | No se integra Meta Cloud API a mano: se usa [Kapso](https://kapso.com) como capa de infraestructura WhatsApp (onboarding del número, Flows, plantillas, webhooks, SDK TypeScript). |
| **Bandeja de mensajes: la de Kapso, incrustada** (v1.2) | Kapso soporta oficialmente **embeber su inbox por iframe** dentro de otra app, con tiempo real por WebSocket. La plataforma tendrá una sección "Mensajes" que incrusta esa bandeja — no se construye bandeja propia. Se mantiene el log propio `whatsapp_eventos` ligado a requisiciones (ver M9). |
| **App en VPS Hostinger + datos en Supabase** (v1.2) | La aplicación (Next.js) vive en el VPS de Hostinger; la base de datos, autenticación, storage y backups viven en **Supabase gestionado**. Con el volumen esperado de Mizar, el plan de Supabase es bajo y elimina la operación de BD (justificación completa en §9.2). |
| **Servidor MCP propio** | La plataforma expone un MCP (módulo M12) para administrar "casi todo" desde Claude: consultas, catálogos, estados, reportes. Reutiliza la misma capa de servicio y permisos que la web. |
| **Dashboard** | Módulo de inicio con métricas del embudo (ya estaba en la demo) + **modo pantalla**: una sesión de solo lectura que puede quedar abierta permanentemente (TV/monitor de oficina) con auto-refresco. |

---

## 4. Usuarios y roles

| Rol | Personas hoy | Qué hace en el sistema |
|-----|--------------|------------------------|
| **Solicitante** | Maestros de obra, Juliana, personal interno, externos autorizados | Crea requisiciones (web pública o WhatsApp), consulta el estado de las suyas. No edita catálogos. |
| **Revisor / Comprador** | Daniel | Dueño de la bandeja de revisión: normaliza ítems, etiqueta, asigna proveedor final por ítem, ingresa valores cotizados e impuestos, envía a aprobación, declina. Administra el catálogo de ítems y proveedores. Registra caja menor. |
| **Aprobador** | Nelson (materiales), Claudia (nómina), Juliana (resto), Daniel (casos menores) | Ve solo su bandeja personal. Aprueba o devuelve con comentario obligatorio al devolver. |
| **Contabilidad** | Equipo contable | Filtra por obra y periodo, descarga el Excel para Helisa y los soportes/documentos de proveedor. Solo lectura + exportación. |
| **Administrador Mizar** | Claudia / Juliana (en Completo) | CRUD de obras, etiquetas, usuarios, sociedades. Ve reportes ejecutivos. |
| **Administrador Sixteam** | Samuel / equipo | Todo lo anterior + configuración técnica, respaldo, soporte. |

Reglas transversales:
- Todo usuario entra con usuario + contraseña. Sin usuario verificado no hay acceso (dicho textual de Ernesto el 21-ago).
- Cada persona ve y modifica **únicamente lo que le compete** (bandejas personales, RLS por rol).
- La regla "la etiqueta define quién aprueba" vive en datos (`etiqueta.aprobador_id`), no en código: cambiar el aprobador de una etiqueta es una edición de catálogo, no un desarrollo.

---

## 5. Flujo de negocio y estados

### 5.1 Ciclo principal

```
 Solicitante                Daniel (revisión)            Aprobador               Sistema                  Contabilidad
     │                            │                          │                      │                         │
     │ 1. Crea requisición        │                          │                      │                         │
     │ (web interna / pública /   │                          │                      │                         │
     │  WhatsApp Flow)            │                          │                      │                         │
     ├───────────────────────────►│                          │                      │                         │
     │                            │ 2. Normaliza ítems,      │                      │                         │
     │                            │ etiqueta, proveedor      │                      │                         │
     │                            │ final por ítem, valores  │                      │                         │
     │                            │ e impuestos              │                      │                         │
     │                            │ (o DECLINA)              │                      │                         │
     │                            ├─────────────────────────►│                      │                         │
     │                            │                          │ 3. Aprueba o         │                         │
     │                            │                          │ devuelve con motivo  │                         │
     │                            │                          ├─────────────────────►│                         │
     │                            │                          │                      │ 4. Genera OC            │
     │                            │                          │                      │ (1 por requisición en   │
     │                            │                          │                      │  Básico; N por proveedor│
     │                            │                          │                      │  en Completo) y registra│
     │                            │                          │                      │ el gasto en su obra     │
     │                            │                          │                      ├────────────────────────►│
     │                            │ 5. Marca cumplimiento    │                      │                         │ 6. Filtra, descarga
     │                            │ de cada OC               │                      │                         │ Excel → Helisa
```

### 5.2 Estados de la requisición

`enviada → en_revision → en_aprobacion → aprobada | devuelta | declinada`

- `devuelta` regresa a la bandeja de Daniel con el motivo del aprobador; puede corregirse y reenviarse.
- `declinada` es terminal, consultable en su propio filtro. **Nunca se elimina.**
- Tipos de requisición: `compra` | `pago` (cuentas de cobro, servicios). Mismo flujo, formato de salida distinto (Orden de Compra vs Orden de Pago).

### 5.3 Estados de la Orden de Compra

`generada → cumplida | no_cumplida | no_necesario`

Las `no_cumplida` alimentan la vista de "compras pendientes" para que nada se pierda de vista (pedido textual de Daniel).

---

## 6. Requisitos funcionales por módulo

Prioridad: **[F1..F4]** = fase donde se entrega. Los RF sin nota de alcance aplican a ambos alcances.

### M0 — Núcleo administrable (catálogos) [F1]

- **RF-001** CRUD de **obras**: nombre, sociedad propietaria, estado (activa/cerrada). Carga inicial de las 17 obras.
- **RF-002** CRUD de **sociedades** (las empresas dueñas de cada obra; determinan el corte de reportes a socios).
- **RF-003** CRUD de **etiquetas** de gasto: nombre, aprobador asignado, activa/inactiva. La demo ya incluye el gestor de etiquetas.
- **RF-004** CRUD de **usuarios**: datos, rol(es), estado. Alta/baja sin tocar código.
- **RF-005** Carga masiva inicial desde Excel (ítems, proveedores, obras) provista por Mizar — importador simple usado por Sixteam en implementación, no una pantalla del cliente.
- **RF-006** Toda pantalla de catálogo es la misma para rol Sixteam y rol Admin-Mizar; la diferencia es qué rol la tiene habilitada (Básico: solo Sixteam; Completo: también Mizar).

### M1 — Captura de requisiciones [F1]

- **RF-101** Formulario web interno que replica el **CC2-02**: obra, fecha requerida, solicitante, tipo (compra/pago), categoría de uso, destino (frente/actividad), observaciones, soporte adjunto (foto/PDF).
- **RF-102** Ítems múltiples por requisición: ítem (desplegable del catálogo M2 o propuesta de ítem nuevo), cantidad, unidad (desplegable), **posible proveedor** (sugerencia, no decisión), link del producto (opcional), foto por ítem (opcional).
- **RF-103** Cálculos automáticos que hoy se hacen a mano en el Excel (totales por línea, total requisición, diferencia).
- **RF-104** **Formulario público** (sin login completo) para solicitantes externos/maestros de obra: mismos campos esenciales. Control de acceso: enlace + código por obra y lista de solicitantes autorizados (ver P2).
- **RF-105** El solicitante puede consultar el estado de sus requisiciones (recibida, en revisión, aprobada, devuelta, declinada).
- **RF-106** Consecutivo automático por requisición (secuencia única global con prefijo, p. ej. `REQ-2026-0001`).

### M2 — Catálogo maestro de ítems [F1] *(nuevo, 21-ago)*

- **RF-201** Entidad ítem: nombre normalizado, descripción/especificación, unidad por defecto, categoría, estado.
- **RF-202** El solicitante **selecciona** ítems del catálogo; si no existe, propone uno nuevo (queda marcado `pendiente_normalizacion`).
- **RF-203** **Solo Daniel (rol Revisor)** crea, edita y fusiona ítems. Editar un ítem lo actualiza en el catálogo para todas las solicitudes futuras.
- **RF-204** Los ítems usados quedan como "frecuentes" y aparecen primero en los desplegables (web y WhatsApp).
- **RF-205** Importación inicial del histórico de ítems desde los Excel de Mizar.

### M3 — Bandeja de revisión [F2]

- **RF-301** Bandeja única para Daniel con todas las requisiciones entrantes, sin importar el canal (web interna, pública, WhatsApp), con indicador de canal y orden cronológico.
- **RF-302** Filtros: obra, estado, canal, fecha, etiqueta.
- **RF-303** Por requisición: editar/normalizar ítems, asignar etiqueta, asignar **proveedor final por ítem** (independiente del posible proveedor sugerido), ingresar valor cotizado con desglose de impuestos (base, IVA, total — formato final validado con contabilidad).
- **RF-304** Acciones: enviar a aprobación (el sistema enruta según etiqueta), declinar (con motivo), guardar parcial.
- **RF-305** División de gastos compartidos: repartir una requisición/gasto entre varias obras con montos manuales (v1 simple; ver P3).
- **RF-306** Tablero tipo pipeline (vista kanban del embudo) como en la demo: recibida → revisión → aprobación → aprobada.

### M4 — Aprobación enrutada [F2]

- **RF-401** Enrutamiento automático por etiqueta: materiales → Nelson, nómina → Claudia, resto → Juliana, casos menores → Daniel. Regla en datos, editable en catálogo.
- **RF-402** Bandeja personal por aprobador: **solo ve lo suyo**.
- **RF-403** Acciones: aprobar / devolver. Devolver exige comentario. Lo devuelto regresa a Daniel.
- **RF-404** Vista de detalle con todos los datos: solicitante, obra, ítems, proveedor asignado, valores, soportes/cotizaciones adjuntas.
- **RF-405** Historial de trazabilidad visible por requisición: cada transición con usuario, fecha/hora y comentario.
- **RF-406 [Completo]** Notificación automática al aprobador (WhatsApp plantilla) cuando algo entra a su bandeja, y recordatorio si lleva N días sin gestión.

### M5 — Órdenes de compra y pago [F2 base, F4 división]

- **RF-501** Al aprobar, el sistema genera automáticamente la **Orden de Compra** (o de Pago según el tipo) desde los datos de la requisición: nada se re-digita.
- **RF-502** Consecutivo propio por tipo de documento (`OC-2026-0001`, `OP-2026-0001`).
- **RF-503** PDF imprimible/descargable de cada OC con el formato interno de Mizar (reemplaza el "formato antiguo").
- **RF-504 [Completo]** **División por proveedor** (el corazón del pedido de Daniel): si los ítems aprobados tienen proveedores finales distintos, se genera **una OC por proveedor**, cada una con su consecutivo y su estado propio.
- **RF-505** Estado de cumplimiento por OC: cumplida / no cumplida / no necesario, editable por Daniel. Filtro de pendientes.
- **RF-506** Panel de órdenes con filtros por obra, estado, fecha y (Completo) proveedor.

### M6 — Proveedores [F2 base, F4 autoservicio]

- **RF-601** Entidad proveedor: razón social, NIT, contacto, datos bancarios, estado.
- **RF-602** Documentos adjuntos por proveedor: RUT, Cámara de Comercio, certificación bancaria, certificados de calidad (contabilidad los necesita para crear el tercero en Helisa).
- **RF-603** Alta rápida de proveedor nuevo desde la revisión (Daniel no sale del flujo para crear "Arenera Chicamocha").
- **RF-604** Ficha de proveedor con historial de OCs y compras.
- **RF-605 [Completo]** Autoservicio: Mizar administra proveedores sin pedirle a Sixteam.

### M7 — Gastos por obra y salida contable [F3]

- **RF-701** El gasto se registra **automáticamente** en su obra al aprobarse la requisición (reemplazo directo de GASTOS EN OBRAS.xlsx), con la misma cabecera del archivo actual.
- **RF-702** **Subtotal por tipo de gasto (etiqueta)** dentro de cada obra — lo que el Excel actual no tiene.
- **RF-703** Filtros por obra y por periodo (corte mensual 1–30) y totalizado general.
- **RF-704** Exportación a Excel en el formato que contabilidad necesita para cargar a Helisa (formato validado con el equipo contable en Fase 3).
- **RF-705** Reporte visualizable en plataforma e **imprimible a PDF con formato de presentación** para socios, por obra/sociedad y periodo.
- **RF-706 [Completo]** Reportes ejecutivos: resumen por periodo y tipo de gasto, gráficos, vista de flujo de trabajo (cuántas requisiciones hay en cada estado).

### M8 — Caja menor [F3] *(nuevo, 21-ago)*

- **RF-801** Registro manual de gastos de caja menor: obra, fecha, concepto, etiqueta, valor, soporte adjunto. No pasa por el flujo de aprobación de requisiciones.
- **RF-802** Los gastos de caja menor se integran al cuadro de gastos por obra (RF-701) y a sus exportaciones, marcados con su origen.
- **RF-803** Permisos: registra Daniel (y quien defina Mizar); consulta según rol.
- Mantenerlo deliberadamente mínimo: es una tabla + un formulario + su inclusión en reportes. Es también el **piloto del patrón "agregar un módulo nuevo"** (ver §9.5).

### M9 — Canal WhatsApp vía Kapso [F4, Completo]

Kapso es la capa de infraestructura: onboarding del número (embedded signup de Meta), envío/recepción, Flows, plantillas, webhooks y bandeja de conversaciones. La plataforma consume Kapso por SDK/webhooks; no habla con Meta directamente.

- **RF-901** Línea de WhatsApp Business **dedicada** conectada vía Kapso (nunca el celular de Daniel; Kapso ofrece número pre-verificado sin costo para pruebas y embedded signup para el número de producción).
- **RF-902** **WhatsApp Flow** (enviado vía Kapso): formulario estructurado dentro del chat — tipo de solicitud (compra/pago), obra, ítems (frecuentes primero, opción de proponer nuevo), cantidades, posible proveedor, link, foto tomada con la cámara o adjunta.
- **RF-903** Webhook de Kapso → endpoint de la plataforma: toda solicitud capturada por WhatsApp cae en la **misma bandeja de revisión** (M3) con canal = WhatsApp. Los adjuntos recibidos se copian al storage propio.
- **RF-904** Notificaciones de estado al solicitante (recibida / aprobada / devuelta) por plantilla vía Kapso.
- **RF-905** Notificaciones a aprobadores (RF-406) por plantilla vía Kapso.
- **RF-906** **Bandeja de conversaciones: la de Kapso, incrustada en la plataforma.** Kapso soporta oficialmente el modo *embedded inbox* (iframe con tiempo real por WebSocket, filtros por asignado/estado/número, notificaciones). La plataforma tendrá una sección **"Mensajes"** (visible para Daniel y quien defina Mizar) que incrusta esa bandeja — cero desarrollo de mensajería propia, cero mantenimiento. La plataforma solo mantiene el **log de mensajes vinculado a cada requisición** (tabla `whatsapp_eventos`): qué se recibió, qué plantilla se envió, a quién, cuándo y con qué resultado de entrega. Plan B si el modo embebido queda corto (p. ej. saltar de una conversación a su requisición): la bandeja open-source [whatsapp-cloud-inbox](https://github.com/gokapso/whatsapp-cloud-inbox) de Kapso (MIT, Next.js + TypeScript — nuestro mismo stack) se adopta como módulo interno siguiendo el patrón §9.5. Decisión diferida; el iframe es el alcance de esta versión.
- **RF-907** Configuración del onboarding Kapso (cuenta, número, plantillas pre-aprobadas) se inicia en la **semana 0** — con Kapso el trámite es más corto que ir directo a Meta, pero las plantillas siguen requiriendo aprobación.

### M10 — Administración, seguridad y trazabilidad [F1–F3, transversal]

- **RF-1001** Autenticación con usuario/contraseña; sesiones seguras; recuperación de contraseña.
- **RF-1002** Autorización por rol en servidor (RLS): cada rol ve/edita solo lo suyo. El formulario público es la única superficie sin login y solo puede crear requisiciones.
- **RF-1003** Auditoría inmutable: toda transición de estado y toda edición de catálogo registra usuario, timestamp y datos del cambio.
- **RF-1004** Backups automáticos diarios + exportación completa de datos de Mizar bajo demanda (compromiso contractual: los datos son de Mizar).
- **RF-1005** Almacenamiento de adjuntos (fotos, PDFs, documentos de proveedor) con control de acceso por rol.

### M11 — Dashboard (inicio) [F3 base, F4 ejecutivo]

- **RF-1101** Vista de inicio por rol con métricas del embudo (ya presente en la demo): requisiciones en revisión, en aprobación, valor en trámite, gasto del periodo.
- **RF-1102** Cola de atención ("qué espera algo de mí") + actividad reciente.
- **RF-1103 [Completo]** Gráficos ejecutivos: gasto por obra, por etiqueta, por periodo; distribución del trabajo.
- **RF-1104** **Modo pantalla**: sesión de solo lectura de larga duración (token dedicado, sin permisos de escritura) para dejar el dashboard abierto en un monitor con auto-refresco. Revocable desde administración.

### M12 — Servidor MCP de la plataforma [F3 núcleo, F4 completo]

Objetivo: administrar "casi todo" desde Claude (u otro cliente MCP) sin abrir la web — y dejar la puerta lista para automatizaciones futuras.

- **RF-1201** Endpoint MCP (HTTP streamable) montado en la misma app (`/mcp`), reutilizando **la misma capa de servicio y permisos** que la UI web. El MCP no tiene lógica propia: si una regla cambia, cambia en un solo lugar.
- **RF-1202** Autenticación por API key ligada a un usuario real; las herramientas ejecutan con los permisos del rol de ese usuario y **todo queda en `auditoria`** con origen = mcp.
- **RF-1203** Herramientas de lectura (F3): consultar requisiciones/órdenes/gastos con filtros, estado del embudo, gastos por obra y periodo, ficha de proveedor, exportar reportes.
- **RF-1204** Herramientas de escritura (F4): CRUD de catálogos (obras, etiquetas, ítems, proveedores, usuarios), crear requisiciones, cambiar estado de cumplimiento de OC, registrar caja menor, reenviar notificaciones.
- **RF-1205** **Aprobar/denegar requisiciones queda EXCLUIDO del MCP a propósito**: la aprobación es el acto de control interno de Mizar y debe ocurrir en la interfaz con la persona autenticada, no delegable a un agente.
- **RF-1206** Complemento operativo: el equipo Sixteam usa además el [MCP propio de Kapso](https://docs.kapso.ai/docs/whatsapp/mcp) (`https://api.kapso.ai/mcp`) para diagnóstico del canal WhatsApp (conversaciones, entregas, plantillas, salud de webhooks). No se desarrolla nada para esto; es configuración.

---

## 7. Modelo de datos (resumen)

Convención: núcleo compartido (reutilizable por módulos futuros del ERP) + tablas del dominio compras. Un solo Postgres, un solo esquema, prefijos claros.

**Núcleo (`core`):**

| Tabla | Campos clave |
|-------|--------------|
| `sociedades` | id, nombre, nit |
| `obras` | id, nombre, sociedad_id, estado |
| `usuarios` | id, nombre, email, telefono, estado |
| `usuario_roles` | usuario_id, rol (solicitante/revisor/aprobador/contabilidad/admin_mizar/admin_sixteam) |
| `etiquetas` | id, nombre, aprobador_id → usuarios, activa |
| `proveedores` | id, razon_social, nit, contacto, datos_bancarios, estado |
| `items` | id, nombre, especificacion, unidad_defecto, categoria, estado (activo/pendiente_normalizacion) |
| `consecutivos` | tipo_documento (REQ/OC/OP/…), año, siguiente — genérica para cualquier documento futuro |
| `adjuntos` | id, entidad, entidad_id, url_storage, tipo, subido_por, fecha — polimórfica |
| `auditoria` | id, entidad, entidad_id, evento, usuario_id, fecha, datos_json — inmutable |

**Dominio compras:**

| Tabla | Campos clave |
|-------|--------------|
| `requisiciones` | id, consecutivo, tipo (compra/pago), obra_id, solicitante (usuario_id o nombre externo + teléfono), canal (web/publico/whatsapp), fecha_requerida, destino, observaciones, etiqueta_id, estado, motivo_declinacion |
| `requisicion_items` | id, requisicion_id, item_id, descripcion_libre (si propuesto), cantidad, unidad, posible_proveedor_texto, **proveedor_final_id**, link_producto, valor_base, iva, valor_total |
| `ordenes` | id, consecutivo, tipo (OC/OP), requisicion_id, proveedor_id, estado_cumplimiento, pdf_url, fecha_generacion |
| `orden_items` | orden_id, requisicion_item_id |
| `gastos` | id, obra_id, origen (requisicion/caja_menor), referencia_id, etiqueta_id, proveedor_id, fecha, valor_base, iva, valor_total, periodo |
| `gastos_reparto` | gasto_id, obra_id, valor — para gastos compartidos entre obras |
| `caja_menor` | id, obra_id, fecha, concepto, etiqueta_id, valor, registrado_por |
| `notificaciones` | id, usuario_id, canal, plantilla, payload, estado_envio, fecha |
| `whatsapp_eventos` | id, direccion (entrada/salida), telefono, requisicion_id (nullable), tipo (flow/plantilla/mensaje), payload_json, estado_entrega, kapso_message_id, fecha — log del canal, no bandeja |
| `mcp_api_keys` | id, usuario_id, nombre, key_hash, activa, ultima_vez_usada, fecha_creacion |
| `sesiones_pantalla` | id, nombre (p.ej. "TV oficina"), token_hash, activa, creada_por — para el modo pantalla del dashboard |

Notas de diseño:
- `proveedor_final_id` a nivel de **ítem** desde Fase 2 es lo que hace que la división por proveedor (F4) sea solo un cambio en el generador de órdenes.
- `gastos` es la tabla que alimenta reportes y exportaciones; se puebla desde requisiciones aprobadas **y** desde caja menor — cualquier módulo futuro que genere gasto (p. ej. nómina de obra) escribe ahí y los reportes lo absorben sin cambios.
- `consecutivos`, `adjuntos` y `auditoria` son genéricas a propósito: cada módulo nuevo las reutiliza en lugar de inventar las suyas.

---

## 8. Requisitos no funcionales

| Área | Requisito |
|------|-----------|
| Idioma / localización | Español (Colombia). Moneda COP con separadores locales. Zona horaria America/Bogota. Fechas DD/MM/AAAA. |
| Volumen esperado | ~17 obras, < 30 usuarios, decenas de requisiciones/semana. Dimensionar para 10× eso sin cambios (200 obras, 300 usuarios) — más es sobredimensionar. |
| Disponibilidad | Nube gestionada, objetivo razonable 99.5%. SLA de soporte: respuesta ≤ 4 h ante incidencias (compromiso comercial). |
| Seguridad | Autorización en servidor (nunca solo en UI). Contraseñas hasheadas. Adjuntos con URLs firmadas. Formulario público con rate-limit y validación. Sin datos sensibles en URLs. |
| Respaldo | Backup diario automático de BD y storage; retención ≥ 30 días; export completo bajo demanda. |
| Auditoría | Todo cambio de estado y catálogo queda registrado (RF-1003). |
| Usabilidad | Mobile-first en formulario público y WhatsApp (los solicitantes están en obra, con celular). Las bandejas de Daniel y aprobadores optimizadas para escritorio. |
| Mantenibilidad | Un solo repositorio, un solo despliegue, migraciones versionadas, seeds reproducibles. Cualquier desarrollador de Sixteam debe poder levantar el entorno en < 30 min. |
| Costo operativo | Infraestructura mensual acorde a la mensualidad cobrada ($250–350 mil COP): capa gratuita/baja de servicios gestionados. |

---

## 9. Arquitectura

### 9.1 Decisión de hosting (v1.2): app en VPS Hostinger, datos en Supabase

La **aplicación** (Next.js) vive en un VPS de Hostinger administrado por Sixteam; la **capa de datos** (Postgres, Auth, Storage, backups) vive en **Supabase gestionado**. Se descartaron microservicios (sobredimensionado para 1 empresa y decenas de transacciones/semana) y low-code/SaaS vertical (es justo lo que Mizar rechazó del SAO: perder la personalización). La forma sigue siendo **monolito modular**: un solo repo, un solo despliegue, módulos como carpetas + tablas.

### 9.2 ¿Por qué Supabase y no Postgres autoalojado?

Primero lo importante: **Supabase ES Postgres** — el mismo motor, las mismas migraciones SQL, empaquetado como servicio gestionado. La pregunta real nunca fue "qué base de datos" sino "quién opera las piezas alrededor". Comparación honesta de lo que está en juego:

| Pieza | Con Supabase (elegido) | Autoalojado en el VPS (descartado) |
|-------|------------------------|-------------------------------------|
| Postgres | Gestionado, actualizaciones y monitoreo incluidos | Contenedor Docker que Sixteam parcha y vigila |
| Backups | **Automáticos diarios, restauración con un clic** (plan Pro) | Cron de `pg_dump` + verificación mensual de restore, responsabilidad nuestra |
| Auth (login, sesiones, reset de contraseña) | **Supabase Auth ya construido** | Better Auth: ~2–3 días de implementación + mantenimiento |
| Storage de adjuntos con URLs firmadas | **Supabase Storage ya construido** | Volumen del VPS + código propio de URLs firmadas |
| Panel de administración de BD | Incluido (Table Editor, SQL Editor, logs) | Adminer por túnel SSH |
| RLS integrada con el usuario autenticado | Disponible como segunda barrera | A mano |
| Costo | Plan Pro ≈ USD 25/mes — cabe en la mensualidad de soporte | "Gratis" en dinero, caro en horas de operación |
| Riesgo operativo | Del lado de Supabase (SLA de ellos) | Del lado de Sixteam (disco lleno, backup corrupto, parche pendiente) |

**Decisión:** con el volumen esperado de Mizar (decenas de requisiciones/semana, < 30 usuarios — "tampoco el volumen será una locura"), el plan de Supabase queda sobrado y elimina de raíz la operación de base de datos: backups, auth y storage llegan **ya construidos**. El VPS queda haciendo lo único que necesita hacer: servir la aplicación. Ese es el punto medio correcto entre "todo gestionado" y "todo en casa".

Dos salvaguardas para que esta comodidad no se convierta en dependencia:
- **Región**: crear el proyecto Supabase en `sa-east-1` (São Paulo), la más cercana a Colombia, y medir latencia desde el VPS en S0.
- **Salida siempre abierta**: es Postgres estándar — `pg_dump` semanal automatizado hacia el VPS como copia fría propia. Si algún día conviene autoalojar (o el cliente exige sus datos en su servidor), se restaura el dump y se cambia la cadena de conexión; el código no cambia.

### 9.3 Arquitectura

```
  Solicitantes                    ┌── VPS Hostinger (Docker) ───────────────────┐
  ┌───────────────┐   HTTPS      │                                              │
  │ Web interna   ├─────────────►│  Caddy (TLS automático, reverse proxy)       │
  │ Form. público │              │    │                                         │
  │ (mobile-first)│              │    ▼                                         │
  └───────────────┘              │  Next.js (App Router, TypeScript)            │
                                 │   /app          UI por módulo (M0–M12)       │
  ┌───────────────┐  Webhook     │   /app/mensajes bandeja Kapso EMBEBIDA       │
  │ WhatsApp      ├─────────────►│   /api          rutas de negocio            │
  │ vía KAPSO     │◄─────────────┤   /api/kapso    webhook entrada (Flows)      │
  │ (Flows,       │  SDK: envío  │   /mcp          servidor MCP (M12)           │
  │  plantillas,  │  plantillas  │   lib/domain    reglas puras                 │
  │  inbox        │              │   lib/services  capa de servicio única       │
  │  embebible)   │              │                 (permisos por rol)           │
  └───────────────┘              └───────┬──────────────────────────────────────┘
                                         │ conexión segura (región sa-east-1)
  Claude / clientes MCP ────────►┌───────▼──────────────────────────────────────┐
       (API key)                 │  Supabase (gestionado)                       │
                                 │  · Postgres (núcleo + dominio compras)       │
                                 │  · Auth (usuarios, sesiones, reset)          │
                                 │  · Storage (soportes, docs proveedor, PDFs)  │
                                 │  · Backups automáticos diarios              │
                                 └──────────────────────────────────────────────┘
  Salidas: XLSX Helisa (exceljs) · PDF OC/OP y reporte socios (HTML→PDF)
  Copia fría propia: pg_dump semanal → VPS
```

Decisiones acompañantes:
- **TypeScript de punta a punta**; tipos de BD generados desde el esquema (`supabase gen types`); migraciones SQL versionadas en el repo con la CLI de Supabase — nunca cambios manuales en producción.
- **Capa de servicio única** (`lib/services`): UI web, webhook de Kapso y MCP entran por las mismas funciones, que aplican los mismos permisos por rol y escriben la misma auditoría. La autorización de negocio vive ahí (un solo lugar, compartido por web y MCP); **RLS se activa además como segunda barrera** en las tablas sensibles, integrada con Supabase Auth.
- **Reglas de negocio como funciones puras** en `lib/domain/` — enrutamiento por etiqueta, división de OC, consecutivos, impuestos — con pruebas unitarias directas.
- **PDF**: plantilla HTML + generación server-side. **XLSX**: exceljs. Sin servicios externos adicionales.
- **WhatsApp**: todo por Kapso (SDK TypeScript oficial) detrás de un adaptador (`lib/services/whatsapp`); la bandeja se incrusta por iframe en `/app/mensajes`. Si algún día se cambia de proveedor, se toca el adaptador, no el dominio.
- **Entornos**: `dev` (Supabase local por CLI + Next.js local) y `prod` (VPS + proyecto Supabase). Deploy por GitHub Actions → SSH → contenedor con imagen versionada. Rollback = volver a la imagen anterior.

### 9.4 Por qué esto es el "punto medio"

- Menos que esto (una hoja de cálculo mejorada, un low-code) repite el fracaso anterior de Mizar: un visor que no elimina la doble digitación.
- Más que esto (microservicios, k8s, colas, o autoalojar también la base de datos) crea carga operativa que nadie va a pagar ni mantener.
- Un monolito modular sobre Postgres gestionado es la arquitectura con mejor historial para "sistema interno que crece hasta ERP": cada módulo nuevo es un conjunto de tablas + una carpeta de UI + reglas puras, dentro del mismo despliegue. Y la copia fría semanal en el VPS mantiene simple la conversación de propiedad con el cliente (P5): los datos de Mizar son exportables siempre.

### 9.5 Patrón de crecimiento a ERP (contrato para módulos futuros)

Todo módulo futuro (tesorería, facturación, inventario, nómina de obra…) debe:
1. Reutilizar el núcleo: `obras`, `sociedades`, `usuarios`, `proveedores`, `etiquetas`, `consecutivos`, `adjuntos`, `auditoria`. Prohibido duplicar catálogos.
2. Vivir en su carpeta (`app/(modulos)/tesoreria/`, `lib/domain/tesoreria/`) con sus tablas prefijadas.
3. Si genera gasto, escribir en `gastos` para que reportes y exportaciones lo absorban sin cambios.
4. Declararse en la tabla `modulos` (nombre, activo, roles con acceso) — el menú se construye desde ahí; activar un módulo para el cliente es un flag, no un deploy especial.
5. Traer sus migraciones versionadas y sus pruebas.

**Caja menor (M8) se construye deliberadamente como el primer ejercicio de este patrón** — si agrega tablas limpias, reutiliza núcleo y aparece en reportes sin tocar M7, el patrón queda probado.

---

## 10. Plan de trabajo a detalle

8 semanas = 4 fases de 2 semanas. Las Fases 1–3 entregan el Alcance Básico en producción; la Fase 4 entrega el Completo. Cada fase cierra con **sesión de validación con Mizar (~1 h)** — única dependencia del cliente.

### Semana 0 (arranque, en paralelo con la venta final)
- Crear cuenta **Kapso**, conectar número de pruebas (pre-verificado, sin costo) e iniciar el embedded signup del número de producción + redacción de plantillas para aprobación de Meta.
- Solicitar a Mizar: CC2-02 real, GASTOS EN OBRAS.xlsx completo, listado de ítems/proveedores en Excel, listado de usuarios y aprobadores, formato de carga de Helisa.
- Aprovisionar el **VPS Hostinger** (solo app): Docker, Caddy (TLS), firewall, acceso SSH por llaves. Crear **proyectos Supabase** (dev + prod, región sa-east-1) y medir latencia VPS↔Supabase. Crear repo y CI (lint + tests en cada PR, build de imagen). Configurar copia fría: `pg_dump` semanal → VPS.

### Fase 1 (S1–S2) — Núcleo y captura
| Semana | Trabajo |
|--------|---------|
| S1 | Migraciones del núcleo completo (§7) + capa de servicio con permisos por rol y su suite de pruebas + seeds (17 obras, sociedades, etiquetas, usuarios reales). Importador de ítems/proveedores desde Excel. Autenticación (Supabase Auth) y esqueleto de la app con menú por rol. Primer deploy al VPS: el pipeline funciona desde la semana 1. |
| S2 | Formulario interno CC2-02 (RF-101/102/103/106) + formulario público con su control de acceso (RF-104) + catálogo de ítems con desplegables y propuesta de ítem nuevo (M2) + vista "mis requisiciones" (RF-105). |

**Entregable:** portal en línea capturando requisiciones con datos reales.
**Sesión de validación:** Daniel crea 3 requisiciones reales (compra y pago); Claudia revisa el catálogo de ítems importado; se valida el desglose de impuestos con contabilidad (cierra P1).
**Criterio de salida:** una requisición real de cada tipo creada por cada canal web, con adjuntos, visible en BD con su consecutivo y auditoría.

### Fase 2 (S3–S4) — Revisión, aprobación y órdenes
| Semana | Trabajo |
|--------|---------|
| S3 | Bandeja de revisión completa (M3): normalización, etiqueta, proveedor final por ítem, valores+impuestos, declinar, enviar a aprobación. Alta rápida de proveedor con documentos (RF-601/602/603). Enrutamiento por etiqueta y bandejas personales (RF-401/402). |
| S4 | Aprobar/devolver con trazabilidad (RF-403/404/405). Generación automática de OC/OP con consecutivo y PDF (RF-501/502/503). Estados de cumplimiento y panel de órdenes (RF-505/506). Vista kanban (RF-306). |

**Entregable:** ciclo completo requisición → aprobación → OC, validado con el equipo.
**Sesión de validación:** Nelson, Claudia y Juliana aprueban desde sus bandejas; Daniel revisa el PDF de OC contra su formato; se valida el reparto de gastos compartidos (cierra P3).
**Criterio de salida:** flujo E2E verde en pruebas automatizadas; una compra real recorrió el ciclo completo sin tocar Excel.

### Fase 3 (S5–S6) — Gastos, salida contable, caja menor y puesta en marcha
| Semana | Trabajo |
|--------|---------|
| S5 | Gastos por obra automáticos con subtotales por etiqueta y filtros por periodo (RF-701/702/703). Export Excel formato Helisa (RF-704). Reporte imprimible PDF para socios (RF-705). Módulo caja menor (M8). Dashboard de inicio con métricas y modo pantalla (M11 base). |
| S6 | **Prueba de paridad**: replicar un mes real de GASTOS EN OBRAS.xlsx en la plataforma y cuadrar 100% contra el Excel. Ajustes. Servidor MCP con herramientas de lectura (RF-1201/1202/1203). Usuarios y roles definitivos. Capacitación por rol. Salida a producción. Arranca acompañamiento (1 semana) y garantía correctiva (30 días). |

**Entregable:** **Alcance Básico en producción**, equipo operando.
**Criterio de salida:** paridad contable del mes de prueba = 100%; contabilidad descargó y cargó a Helisa sin re-digitar; capacitación dictada a los 4 roles.

### Fase 4 (S7–S8) — Completo: división por proveedor, WhatsApp y autoservicio
| Semana | Trabajo |
|--------|---------|
| S7 | División automática de OC por proveedor con estados individuales (RF-504). WhatsApp Flow vía Kapso conectado a la bandeja (RF-901/902/903) — el número de producción y las plantillas ya deben estar aprobados (el trámite arrancó en S0). |
| S8 | Notificaciones automáticas a aprobadores y solicitantes (RF-406/904/905) vía Kapso. Habilitar autoservicio para rol Admin-Mizar (RF-006/605). Reportes ejecutivos y dashboard ejecutivo (RF-706/1103). Herramientas de escritura del MCP (RF-1204). Capacitación del canal WhatsApp a maestros de obra. |

**Entregable:** plataforma Completa: WhatsApp activo y Mizar administrando sus catálogos sin depender de Sixteam.
**Criterio de salida:** una requisición real creada 100% por WhatsApp llegó a OC dividida entre 2+ proveedores; Claudia dio de alta un proveedor y una obra sin ayuda.

---

## 11. Estrategia de pruebas

### 11.1 Pirámide

| Nivel | Qué cubre | Herramienta | Cuándo corre |
|-------|-----------|-------------|--------------|
| Unitarias (base) | Reglas puras de `lib/domain`: enrutamiento por etiqueta, división de OC por proveedor, consecutivos, subtotales, impuestos, reparto de gastos compartidos, transiciones de estado válidas | Vitest | Cada commit (CI) |
| Permisos por rol | Cada rol ve exactamente lo suyo (suite sobre la capa de servicio); el formulario público solo puede insertar requisiciones; contabilidad es solo-lectura; cada herramienta MCP respeta el rol de su API key | Vitest sobre `lib/services` con BD efímera | Cada PR que toque permisos o migraciones |
| Integración API | Endpoints de negocio: crear requisición por cada canal, revisar, aprobar, generar OC, exportar | Vitest + BD efímera | Cada PR |
| E2E | Los 4 recorridos críticos (11.2) en navegador | Playwright | Cada PR a main + antes de cada release |
| Paridad contable (UAT) | Un mes real de GASTOS EN OBRAS.xlsx reproducido en plataforma; el export debe cuadrar al peso | Manual asistido + script de comparación | Fase 3, S6 — bloqueante para producción |
| WhatsApp | Flow completo contra el número de pruebas de Kapso; webhook con payloads reales grabados como fixtures; plantillas aprobadas; log en `whatsapp_eventos` | Número de pruebas Kapso + fixtures | Fase 4 |
| Seguridad | Acceso al formulario público (rate-limit, código de obra), URLs firmadas de adjuntos, escalación de privilegios entre roles | Revisión dedicada (security-review) | Fase 2 y previo a producción |

### 11.2 Recorridos E2E obligatorios

1. **Compra multi-proveedor:** solicitante público crea requisición con 3 ítems → Daniel normaliza, asigna 2 proveedores, envía → Nelson aprueba → se generan 2 OCs con consecutivos y PDFs → Daniel marca una cumplida y una no cumplida → el gasto aparece en la obra con subtotal por etiqueta → contabilidad exporta el Excel.
2. **Pago (cuenta de cobro):** requisición tipo pago → etiqueta nómina → Claudia aprueba → OP generada → gasto registrado.
3. **Devolución:** aprobador devuelve con motivo → vuelve a Daniel → corrige → reenvía → aprobada.
4. **Declinación:** Daniel declina → desaparece de vistas activas → aparece en filtro declinadas con motivo → nunca genera gasto.

### 11.3 Datos de prueba

- Seeds reproducibles: 17 obras reales, etiquetas reales, usuarios reales (contraseñas de prueba), 30+ ítems del catálogo importado, 5 proveedores.
- Fixtures de payloads de WhatsApp grabados del sandbox.
- El mes histórico de GASTOS EN OBRAS.xlsx como dataset dorado de la prueba de paridad.

### 11.4 Definición de Hecho (por tarea)

Una tarea está hecha cuando: (1) sus pruebas existen y pasan en CI, (2) los permisos por rol cubren la superficie nueva (incluido el MCP si expone la función), (3) la auditoría registra los eventos nuevos, (4) QA la verificó adversarialmente, (5) el ingeniero revisó el código, y (6) producto validó contra el criterio de aceptación del ticket. No hay "hecho" con pruebas pendientes.

---

## 12. Equipo de ejecución: subagentes + supervisión experta

### 12.1 Supervisión humana (obligatoria en cada gate)

| Rol | Quién | Responsabilidad |
|-----|-------|-----------------|
| **Ingeniero líder** | Samuel | Aprueba arquitectura y migraciones, revisa todo PR antes de merge, decide trade-offs técnicos, opera despliegues a producción. Nada llega a `main` sin su revisión. |
| **Desarrollador de producto** | Ernesto | Dueño del backlog y de los criterios de aceptación; valida cada pantalla contra los formatos reales (CC2-02, GASTOS EN OBRAS.xlsx) y contra lo hablado con Mizar; prepara y conduce las sesiones de validación de fase; decide qué es Básico vs Completo ante ambigüedad. |

### 12.2 Roster de subagentes

| # | Agente | Tipo sugerido (Claude Code) | Misión | Se despliega | Se retira |
|---|--------|------------------------------|--------|--------------|-----------|
| A1 | **Arquitecto de datos** | `general-purpose` (+ `deep-reasoner` revisa el diseño del esquema antes de la primera migración) | Dueño del esquema, migraciones, seeds e importadores | S1 | S8 (desde F2 solo por demanda) |
| A2 | **Backend / reglas de negocio** | `general-purpose` | Dueño de `lib/domain`, `lib/services`, `/api` y el servidor MCP (M12) | S1 | S8 |
| A3 | **Frontend** | `general-purpose` (pantallas con lógica) + `fast-worker` (CRUD y formularios repetitivos) | Dueño de toda la UI | S2 | S8 |
| A4 | **Canal WhatsApp (Kapso)** | `general-purpose` | Dueño de la integración Kapso: Flow, webhook, plantillas, notificaciones | S0 (trámites) → activo S7 | S8 |
| A5 | **Reportes y documentos** | `fast-worker` | Dueño de las salidas: XLSX Helisa, PDFs, paridad | S4 | S6 (vuelve en S8 para reportes ejecutivos) |
| A6 | **QA adversarial** | `general-purpose` + skills `/review` y `/security-review` | Romper lo que los demás construyen; dueño de Playwright y de la prueba de paridad | S1 | S8 (el último en salir) |
| A7 | **Docs y capacitación** | `fast-worker` | Manuales por rol, guía WhatsApp, runbook de operación | S5 | S8 |
| A8 | **Infraestructura (VPS + Supabase)** | `general-purpose` (usa los MCP de Hostinger y Supabase ya conectados) | Dueño de la infra: VPS de la app, proyectos Supabase, CI/CD, copia fría, monitoreo | S0 | S1 (vuelve en S6 para hardening de producción) |

Notas:
- El **orquestador** es la sesión principal de Claude Code operada por Samuel: reparte tickets, integra resultados y es el único que hace merge.
- Para decisiones difíciles (modelado del reparto de gastos compartidos, diseño del Flow, diseño de herramientas MCP) se consulta a `deep-reasoner` o `Plan` **antes** de implementar.
- Trabajo paralelo en archivos compartidos → aislamiento por **worktree** por agente. A1 tiene prioridad en migraciones: nadie toca el esquema salvo A1, y los demás se re-basan sobre sus tipos generados.

### 12.3 Flujo de trabajo por ticket (quality gates)

```
Ernesto define ticket ──► Agente implementa ──► A6 (QA) verifica ──► Samuel revisa ──► Ernesto valida ──► merge + deploy
(criterio de aceptación    (en worktree,           (adversarial:         (código, permisos,   (contra formato
 escrito y verificable)     con pruebas)            intenta refutar)      migraciones)         real de Mizar)
```

- Ticket sin criterio de aceptación verificable → no se implementa; se devuelve a producto.
- QA rechaza → vuelve al agente implementador con el hallazgo concreto; ni Samuel ni Ernesto revisan trabajo que QA no aprobó.
- Cada cierre de fase: los E2E completos verdes + demo interna antes de la sesión con Mizar.

### 12.4 Cronograma de despliegue de agentes

`░` en espera · `▶` se despliega · `█` trabajo pleno · `▪` por demanda

| Agente | S0 | S1 | S2 | S3 | S4 | S5 | S6 | S7 | S8 |
|--------|----|----|----|----|----|----|----|----|----|
| A8 infra | ▶█ | █ | ▪ | ▪ | ▪ | ▪ | █ | ▪ | ▪ |
| A1 datos | ░ | ▶█ | █ | ▪ | ▪ | ▪ | ▪ | ▪ | ▪ |
| A2 backend | ░ | ▶█ | █ | █ | █ | █ | █ | █ | █ |
| A3 frontend | ░ | ░ | ▶█ | █ | █ | █ | ▪ | █ | █ |
| A4 WhatsApp | ▶▪ | ░ | ░ | ░ | ░ | ▪ | ▪ | █ | █ |
| A5 reportes | ░ | ░ | ░ | ░ | ▶█ | █ | █ | ░ | ▪ |
| A6 QA | ░ | ▶▪ | █ | █ | █ | █ | █ | █ | █ |
| A7 docs | ░ | ░ | ░ | ░ | ░ | ▶█ | █ | ▪ | █ |

### 12.5 Plan de trabajo detallado por subagente

#### A8 — Infraestructura (VPS Hostinger + Supabase)
- **Se despliega:** Semana 0, el primero de todos.
- **Recibe:** acceso al VPS (vía MCP de Hostinger), acceso a Supabase (MCP ya conectado), dominio/subdominio, repo vacío.
- **S0:** aprovisionar VPS para la app (Docker, firewall, SSH por llaves, fail2ban), Caddy con TLS automático sobre el subdominio; crear proyectos **Supabase dev y prod** (región sa-east-1) y medir latencia VPS↔Supabase; pipeline CI/CD (GitHub Actions: lint + tests + build de imagen + deploy por SSH); cron de **`pg_dump` semanal → VPS** (copia fría propia además de los backups automáticos de Supabase); entorno `dev` local documentado (Supabase CLI + Next.js, levantable en < 5 min).
- **S1:** acompaña el primer deploy real de A2; deja monitoreo básico (uptime de la app + alerta de fallo del pg_dump semanal + alertas del proyecto Supabase).
- **S6 (regresa):** hardening pre-producción — **restore de prueba** desde un backup de Supabase y desde la copia fría (bloqueante), revisión de headers/TLS, límites de tasa en formulario público y `/mcp`, rotación de secretos.
- **Entrega:** VPS + Supabase operativos + runbook técnico (que A7 convierte en documento) + pipeline que cualquiera dispara con un merge.
- **Cierre:** un restore completo ejecutado con éxito por ambas vías y documentado.

#### A1 — Arquitecto de datos
- **Se despliega:** Semana 1, tras validación del diseño §7 por `deep-reasoner` + Samuel.
- **Recibe:** PRD §7, Exceles reales de Mizar (CC2-02, GASTOS EN OBRAS, listados de ítems/proveedores).
- **S1:** migraciones completas del núcleo y dominio compras (todas las tablas §7, incluidas `whatsapp_eventos`, `mcp_api_keys`, `sesiones_pantalla`), tipos TypeScript generados, seeds reproducibles (17 obras, sociedades, etiquetas, usuarios), importador de ítems/proveedores desde Excel con reporte de duplicados/errores para la sesión de limpieza con Daniel.
- **S2:** ajustes tras la primera carga real; índices para los filtros de bandejas y gastos; fixtures de datos de prueba para A6.
- **S3–S8 (por demanda):** toda alteración de esquema pasa por A1 (nadie más migra). Cambios esperables: P1 impuestos (S2–S3), P3 gastos compartidos (S4).
- **Entrega a:** A2 (tipos + esquema), A6 (seeds/fixtures).
- **Cierre:** esquema estable sin migraciones pendientes + documento de modelo actualizado en el repo.

#### A2 — Backend / reglas de negocio (incluye el MCP)
- **Se despliega:** Semana 1, en paralelo con A1 (arranca por las reglas puras, que no dependen del esquema final).
- **Recibe:** PRD §5–§7, tipos de A1, decisiones de P1/P3 cuando se cierren.
- **S1:** autenticación (Supabase Auth), esqueleto de la capa de servicio con autorización por rol + suite de pruebas de permisos (y RLS como segunda barrera en tablas sensibles); reglas puras iniciales: consecutivos, transiciones de estado, cálculos del CC2-02.
- **S2:** servicios de captura (crear requisición por canal web interno y público, adjuntos con URLs firmadas, propuesta de ítem nuevo).
- **S3:** servicios de revisión (normalizar, etiquetar, proveedor final por ítem, valores+impuestos según P1, declinar, enviar a aprobación) + enrutamiento por etiqueta + alta rápida de proveedor.
- **S4:** aprobar/devolver con trazabilidad; generador de OC/OP (estrategia single) + consecutivos por tipo; registro automático del gasto; reparto de gastos compartidos según P3.
- **S5:** servicios de gastos por obra (subtotales, filtros por periodo), caja menor, datos del dashboard.
- **S6:** **servidor MCP** (endpoint `/mcp`, API keys, herramientas de lectura RF-1203) montado sobre la capa de servicio existente; soporte a la prueba de paridad (correcciones que surjan).
- **S7:** división de OC por proveedor (cambio de estrategia del generador) + estados individuales.
- **S8:** notificaciones (disparadores de eventos → A4), herramientas de escritura del MCP (RF-1204), endpoints de reportes ejecutivos.
- **Entrega a:** A3 (contratos de servicios), A4 (eventos de notificación), A5 (consultas de reportes), A6 (todo).
- **Cierre:** cobertura de pruebas unitarias en `lib/domain` ≥ 90% y cero lógica de negocio fuera de la capa de servicio.

#### A3 — Frontend
- **Se despliega:** Semana 2, cuando A2 tiene los primeros contratos de servicio.
- **Recibe:** demo HTML como referencia visual, formatos reales de Mizar, contratos de A2.
- **S2:** formulario interno CC2-02 (ítems múltiples, cálculos en vivo, adjuntos), formulario público mobile-first con su control de acceso (P2), vista "mis requisiciones", pantallas de catálogo (obras, etiquetas, ítems, proveedores, usuarios) — los CRUD repetitivos van al `fast-worker`.
- **S3:** bandeja de revisión completa de Daniel (la pantalla más importante del sistema: probarla con él en mente — teclado, rapidez, edición en línea) + vista kanban del embudo.
- **S4:** bandejas personales de aprobadores (desktop y móvil), detalle con historial de trazabilidad, panel de órdenes con filtros y estados de cumplimiento.
- **S5:** pantallas de gastos por obra (subtotales por etiqueta, filtros por periodo), caja menor, dashboard de inicio + modo pantalla (RF-1104).
- **S6 (por demanda):** ajustes de la capacitación y la prueba de paridad.
- **S7:** UI de órdenes divididas por proveedor (agrupación visual por proveedor dentro de la requisición).
- **S8:** habilitar autoservicio para rol Admin-Mizar (visibilidad de pantallas ya construidas), dashboard ejecutivo con gráficos (RF-1103).
- **Entrega a:** A6 (pantallas listas para E2E), A7 (pantallas finales para manuales con capturas).
- **Cierre:** los 4 recorridos E2E pasan en desktop y móvil; Daniel procesa una requisición real en < 2 minutos.

#### A4 — Canal WhatsApp (Kapso)
- **Se despliega:** Semana 0 solo para trámites; trabajo pleno en S7.
- **Recibe:** cuenta Kapso, número de producción, acceso al diseño del Flow.
- **S0 (trámites, ~medio día):** crear cuenta Kapso, conectar número de pruebas pre-verificado, iniciar embedded signup del número de producción, redactar y someter a aprobación las plantillas (recibida/aprobada/devuelta/pendiente-aprobador).
- **S5–S6 (por demanda, corto):** verificar estado de aprobaciones de Meta; diseñar el Flow en papel con Ernesto y validarlo contra el formulario público (misma información, menos fricción).
- **S7:** construir el Flow definitivo; endpoint `/api/kapso` (webhook firmado → crear requisición canal WhatsApp → copiar adjuntos al storage propio → log en `whatsapp_eventos`); fixtures de payloads reales grabados para A6.
- **S8:** notificaciones por plantilla (consumiendo los eventos de A2), reintentos y registro de estado de entrega; **incrustar la bandeja embebida de Kapso** en la sección "Mensajes" de la plataforma (iframe + autenticación del modo embedded, con A3); configurar el MCP de Kapso para el equipo Sixteam (observabilidad del canal); guía express de la sección Mensajes para Daniel.
- **Entrega a:** A6 (fixtures + número de pruebas), A7 (material para la guía de maestros de obra).
- **Cierre:** una requisición real creada 100% por WhatsApp completó el ciclo hasta OC, y las 4 plantillas están aprobadas y enviándose.

#### A5 — Reportes y documentos
- **Se despliega:** Semana 4, cuando existe la primera OC aprobada de verdad.
- **Recibe:** formato de carga de Helisa (pedido en S0), formato actual de OC de Mizar, GASTOS EN OBRAS.xlsx histórico.
- **S4:** PDF de OC/OP (plantilla HTML→PDF, validar contra el formato de Daniel en la sesión de F2).
- **S5:** export XLSX formato Helisa; reporte PDF para socios por sociedad/obra/periodo (validar con Claudia); **script de comparación de paridad** (Excel histórico vs export de la plataforma, diferencia a cero).
- **S6:** ejecutar la prueba de paridad con A6, iterar hasta cuadrar al peso.
- **S8 (regresa, corto):** exportaciones de los reportes ejecutivos.
- **Entrega a:** A6 (script de paridad), contabilidad de Mizar (formatos validados).
- **Cierre:** paridad 100% firmada y contabilidad cargó a Helisa sin retrabajo.

#### A6 — QA adversarial
- **Se despliega:** Semana 1 (CI y esqueleto de pruebas), presión plena desde S2.
- **Recibe:** criterios de aceptación de cada ticket, seeds de A1, este PRD como oráculo.
- **S1:** armar el arnés: Playwright configurado, BD efímera para integración, convención de fixtures; revisar la suite de permisos de A2.
- **S2:** E2E del recorrido de captura (interno y público); ataques al formulario público (acceso sin código, inyección, adjuntos maliciosos, rate-limit).
- **S3–S4:** E2E de los 4 recorridos obligatorios (§11.2); pruebas de permisos entre roles (aprobador que intenta ver bandeja ajena, contabilidad que intenta escribir); verificación adversarial de cada ticket de F2.
- **S5:** pruebas de exactitud de subtotales y filtros de gastos; caja menor incluida en reportes; dashboard consistente con la BD.
- **S6:** **prueba de paridad** (con A5) — bloqueante para producción; `/security-review` completo pre-lanzamiento (con A8); smoke de producción post-deploy.
- **S7:** E2E de división por proveedor (2 y 3 proveedores, ítems sin proveedor, proveedor nuevo en línea); E2E WhatsApp con fixtures de A4.
- **S8:** E2E de notificaciones y autoservicio; pruebas del MCP (permisos por API key, herramientas de escritura auditadas, verificación de que aprobar NO existe como herramienta); regresión completa final.
- **Entrega a:** Samuel (reporte de verificación por ticket y por fase).
- **Cierre:** regresión completa verde en producción + cero hallazgos críticos abiertos.

#### A7 — Documentación y capacitación
- **Se despliega:** Semana 5, cuando las pantallas de F1–F3 están estables.
- **Recibe:** pantallas finales (A3), runbook técnico de A8, guion comercial de Ernesto.
- **S5:** manuales por rol con capturas reales: solicitante (web), Daniel (revisión + catálogos + caja menor), aprobadores (bandeja, también en móvil), contabilidad (filtros + export).
- **S6:** guion y material de la capacitación del Básico (la dicta Ernesto con soporte de Samuel); runbook de operación en limpio (backups, restore, alta de usuarios, soporte de primera línea, SLA 4h).
- **S8:** guía del canal WhatsApp para maestros de obra (1 página, visual, tono simple), manual de autoservicio para Admin-Mizar, material de la capacitación del Completo, y guía de uso del MCP para el equipo Sixteam.
- **Entrega a:** Ernesto (materiales de capacitación), Mizar (manuales), Sixteam (runbook).
- **Cierre:** las dos capacitaciones dictadas y los manuales entregados dentro de la plataforma (enlace en el menú de ayuda).

---

## 13. Riesgos y mitigaciones

| # | Riesgo | Prob. | Impacto | Mitigación |
|---|--------|-------|---------|------------|
| R1 | **Adopción**: los maestros de obra siguen escribiendo al celular de Daniel (el propio Samuel lo marcó como el reto #1) | Alta | Alto | WhatsApp Flow lo más simple posible (ítems frecuentes primero); regla interna de Mizar: "lo que no entra por el canal, no se compra"; Daniel puede registrar en nombre de otros durante la transición; medir O6 desde la semana 1 en producción |
| R2 | Aprobación del número de producción o de las plantillas por Meta se demora y bloquea la Fase 4 | Baja-media (Kapso reduce el trámite: embedded signup + número de pruebas inmediato) | Medio | Trámites arrancan en S0 (A4); desarrollo y pruebas corren contra el número de pruebas de Kapso; la Fase 4 tiene trabajo no-WhatsApp (división OC, autoservicio, MCP) para reordenar si Meta se atrasa |
| R3 | El formato de export no cuadra con lo que Helisa necesita | Media | Alto | Pedir el formato de carga real en S0; validarlo con contabilidad en F1; prueba de paridad bloqueante en S6 |
| R4 | Scope creep (cada reunión agrega ideas: IA, tesorería, facturación…) | Alta | Medio | Este PRD es el contrato de alcance; todo lo nuevo entra al backlog post-v1 con cotización separada (así se acordó con Mizar); Ernesto es el guardián |
| R5 | Datos maestros sucios (ítems duplicados, proveedores incompletos en los Excel) | Alta | Medio | Importador con reporte de duplicados/errores; sesión de limpieza con Daniel en F1; estado `pendiente_normalizacion` |
| R6 | Gastos compartidos más complejos de lo previsto (porcentajes, prorrateos) | Media | Medio | v1 = reparto manual por montos; validar con Daniel en la sesión de F2 antes de sofisticar |
| R7 | Expectativas tipo "el desarrollo anterior que fue solo un visor" (trauma de Claudia) | Media | Alto | La prueba de paridad y la puesta en marcha con datos reales demuestran que aquí no hay doble digitación; demo con datos reales en cada cierre de fase |
| R8 | Operación de la app en el VPS: caída, certificado vencido, disco lleno (la BD ya no es riesgo nuestro: backups y operación de Postgres son de Supabase) | Baja-media | Medio | A8 deja monitoreo con alertas (uptime, disco, fallo del pg_dump semanal), TLS automático con Caddy, snapshots del VPS, y un **restore de prueba obligatorio en S6 y luego trimestral** por ambas vías (Supabase y copia fría) |
| R9 | Dependencia de Kapso como intermediario del canal WhatsApp (cambio de precios, caída del servicio) | Baja | Medio | Integración aislada en un adaptador (`lib/services/whatsapp`); Kapso usa la Cloud API oficial de Meta, así que migrar a integración directa u otro proveedor no toca el dominio; el log `whatsapp_eventos` es propio |

---

## 14. Preguntas abiertas (resolver en las sesiones marcadas)

| # | Pregunta | Dueño | Cuándo se cierra |
|---|----------|-------|------------------|
| P1 | Desglose exacto de impuestos en valores cotizados (¿solo IVA? ¿retenciones? ¿formato del export a Helisa?) | Ernesto + contabilidad Mizar | Sesión F1 |
| P2 | Control de acceso del formulario público: ¿enlace+código por obra basta, o lista blanca de teléfonos? | Ernesto + Daniel | Sesión F1 |
| P3 | Gastos compartidos: ¿el reparto manual por montos es suficiente o necesitan porcentajes predefinidos? | Ernesto + Daniel | Sesión F2 |
| P4 | Formato visual definitivo del PDF de OC y del reporte para socios (membrete, logos por sociedad) | Ernesto + Claudia | F2 (OC) / F3 (socios) |
| P5 | Propiedad de la plataforma: la propuesta escrita dice "propiedad de Sixteam, uso por suscripción", pero en la demo del 21-ago Ernesto dijo "después del año la plataforma es suya". **Hay que alinear el discurso comercial antes de firmar.** | Ernesto + Samuel | Antes de aceptación de propuesta |
| P6 | Costos del canal WhatsApp: plan de Kapso (Free = 2.000 mensajes/mes y 1 número — probablemente suficiente para el volumen interno de Mizar; Pro = USD 25/mes) + tarifas de conversación de Meta. Confirmar plan elegido y quién asume cada costo (la propuesta lo deja como nota) | Ernesto + Samuel | Antes de firmar Completo |
| P7 | Alcance contratado: ¿Mizar firma Básico o Completo? (el plan funciona igual; define si la Fase 4 se ejecuta de una vez) | Juliana/Claudia | Aceptación de propuesta |

---

## 15. Criterios de aceptación del proyecto (resumen ejecutivo)

**El Alcance Básico está terminado cuando:**
1. Una requisición de compra y una de pago recorren el ciclo completo (captura → revisión → aprobación → OC/OP en PDF → gasto en su obra) sin que nadie re-digite nada.
2. La prueba de paridad contra un mes real de GASTOS EN OBRAS.xlsx cuadra al 100%.
3. Contabilidad descarga el Excel y lo carga a Helisa sin retrabajo.
4. Cada aprobador solo ve su bandeja y toda decisión queda auditada.
5. Los 4 roles recibieron capacitación y el acompañamiento de la primera semana ocurrió.

**El Alcance Completo está terminado cuando, además:**
6. Una requisición con ítems de 2+ proveedores genera automáticamente una OC por proveedor, cada una con consecutivo y estado propio.
7. Una requisición creada 100% por WhatsApp Flow llega a la bandeja de revisión y completa el ciclo.
8. Los aprobadores reciben notificación automática al entrar algo a su bandeja.
9. Claudia (o quien Mizar designe) da de alta una obra, una etiqueta y un proveedor con sus documentos, sin ayuda de Sixteam.
10. Los reportes ejecutivos por periodo y tipo de gasto están disponibles e imprimibles, y el dashboard puede quedar abierto en modo pantalla.
11. Desde Claude (vía el MCP de la plataforma) se puede consultar el embudo, los gastos por obra y administrar catálogos — y **no** se puede aprobar.
12. El log `whatsapp_eventos` registra toda entrada/salida del canal, y la conversación libre se gestiona en la bandeja de Kapso **embebida dentro de la plataforma** (sección Mensajes), sin desarrollo de mensajería propio.
