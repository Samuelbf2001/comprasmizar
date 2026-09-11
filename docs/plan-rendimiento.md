# Evaluación de rendimiento y plan de optimización

Fecha: 2026-09-07 · Rama: `feat/reunion-agosto-empresa-items-ordenes` · Next.js 16.3.2 (Turbopack), React 19.2, Supabase JS 2.112.

## Resumen ejecutivo

En local la plataforma se siente razonable porque la base es pequeña y el servidor está al lado. En producción (VPS Hostinger + Supabase en `sa-east-1`) los tres problemas que van a dominar la experiencia son otros y ninguno se ve en la máquina de desarrollo:

1. **Cada llamada a `/api/*` vuelve a autenticar contra Supabase** (3 viajes: `auth.getUser()` + 2 consultas PostgREST), y una pantalla dispara entre 2 y 7+N llamadas. El detalle de una requisición con 10 ítems son 16 peticiones y 48 viajes a Supabase solo para saber quién pregunta.
2. **Todo el JS de la app viaja en un solo bloque de 610 KB (158 KB gzip)**: todas las pantallas, la demo, los catálogos de administración y la librería de gráficos. Cualquier rol lo descarga y lo evalúa antes de que un botón responda. Total por ruta: 1,18 MB sin comprimir, 334 KB gzip.
3. **Ninguna lista tiene límite ni paginación** y el dashboard carga todas las requisiciones, órdenes y gastos en memoria para sumar. Funciona con cientos de filas; se degrada linealmente con el histórico.

Lo que ya está bien y hay que conservar: SSR del shell, esqueletos por ruta (RF-1105), caché SWR por ruta, fuente DM Sans autohospedada con `display: swap`, iconos importados por nombre (chunks de 2–16 KB), sin imágenes en el bundle, Docker `standalone` + Caddy con zstd/gzip y HTTP/3, índices en las consultas principales, carga de ítems por lote (`any($ids)`), consultas de auth en paralelo en `getAuthSnapshot`, CLS 0.

## Cómo se midió

- `next build` real, dos veces (producción y modo demo), y peso de cada chunk con gzip.
- `next start` local del build demo y trazas de Chrome DevTools en escritorio (sin throttling) y en móvil emulado (CPU 4× más lenta, red Slow 4G, 390×844).
- Lectura de la ruta completa de datos: `app/auth-guard.ts`, `lib/infrastructure/auth.ts`, `loadRoute` en `components/screens/connected.tsx`, repositorios Postgres, migraciones e índices, Dockerfile, `compose.yaml` y `ops/Caddyfile`.
- Documentación de Next 16 en `node_modules/next/dist/docs` para validar las recomendaciones (`next/dynamic`, `optimizePackageImports`, `staleTimes`, `reactCompiler`, analizador de Turbopack).

No fue posible en esta sesión:

- Advisors de rendimiento, conteo de filas reales ni `pg_stat_statements` de Supabase: el token del MCP pertenece a otra organización y el proyecto `dwigztjoiulltlbocpjw` niega el acceso.
- Latencia real VPS↔Supabase: no hay VPS desplegado todavía (ver `docs/ESTADO-Y-PENDIENTES.md`).

## Cifras base

### Bundle de producción (lo que descarga cualquier ruta autenticada)

| Recurso | Sin comprimir | gzip |
|---|---:|---:|
| JS total que carga `/` (10 archivos) | 1 179 KB | 334 KB |
| Chunk de pantallas + recharts | 610 KB | 158 KB |
| React / Next runtime (3 archivos) | 499 KB | 153 KB |
| CSS global (`globals.css`) | 87 KB | 15 KB |
| Fuente DM Sans (woff2) | 36 KB | — |
| HTML de `/` | 30 KB | 5,7 KB |

### Trazas de Chrome (build demo, servidor local, sin Supabase)

| Escenario | LCP | TTFB | Retraso de render | Layout más largo | CLS |
|---|---:|---:|---:|---:|---:|
| Escritorio, sin throttling | 271 ms | 9 ms | 262 ms | 138 ms (499 nodos) | 0 |
| Móvil emulado, CPU 4×, Slow 4G | 977 ms | 4 ms | 973 ms | 200 ms (480 nodos) | 0 |

Lectura: el LCP es texto del SSR y sale pronto. Lo caro viene después: descargar y evaluar 334 KB de JS antes de que la app sea interactiva y, en producción, la cascada de llamadas al backend que estas trazas no incluyen.

### Peticiones por pantalla (`loadRoute`, `components/screens/connected.tsx:469-624`)

| Ruta | Llamadas a `/api` | Rondas de red | Viajes a Supabase solo por auth |
|---|---:|---:|---:|
| Dashboard | 2 | 1 | 6 |
| Bandeja / aprobaciones / mis requisiciones | 3 | 1 | 9 |
| Detalle con N ítems | 6 + N | 2 | 18 + 3N |
| Órdenes | 3 | 1 | 9 |
| Gastos con M cajas menores | 3 + M | 2 | 9 + 3M |
| Catálogos / proveedores | 1 | 1 | 3 |

Además, cada clic en el menú hace `router.push`, que vuelve a ejecutar el server component (`getAuthSnapshot`: `getUser` + 2 consultas) y remonta `MizarApp` completo.

## Hallazgos, ordenados por impacto

### H1 · Autenticación repetida en cada petición — Crítico

- **Dónde:** `lib/infrastructure/auth.ts:4-9` (`requireServerActor`) y `app/auth-guard.ts:29-45` (`getAuthSnapshot`).
- **Qué pasa:** `auth.getUser()` es una llamada HTTP a Supabase Auth; después van dos consultas PostgREST **secuenciales** (`usuarios`, luego `usuario_roles`). Se repite en cada `/api/*` y en cada página.
- **Por qué importa:** la latencia VPS↔Supabase se multiplica por 3 en cada llamada y por el número de llamadas de la pantalla. Es el factor dominante en producción y es invisible en local.
- **Acción:**
  1. Una sola consulta por el pool `postgres` (`usuarios` join `usuario_roles`) en vez de dos PostgREST.
  2. Caché en proceso por `user.id` con TTL de 60 s, invalidada al hacer PATCH de `users` en `/api/catalogs`.
  3. Compartir el resultado entre `getAuthSnapshot` y `requireServerActor` dentro del mismo request con `React.cache`.
  4. Cuando el proyecto Supabase tenga llaves JWT asimétricas activas, usar `auth.getClaims()` (ya existe en auth-js 2.112) para validar el token localmente y eliminar el viaje a Auth.
- **Meta:** 0–1 viajes a Supabase por llamada (hoy 3).

### H2 · Cascadas y N+1 en la carga de pantallas — Crítico

- **Dónde:** `components/screens/connected.tsx:469-624`.
- **Detalle de requisición:** 5 llamadas en paralelo y luego una segunda ronda de 1+N (adjuntos por ítem). Trae **todas** las órdenes y **todos** los gastos para filtrarlos en el navegador, cuando `orders.listByRequisition` y `expenses.listByReference` ya existen en `lib/infrastructure/postgres-repositories.ts:150,179`.
- **Gastos:** una llamada de adjuntos por cada fila de caja menor (crece con el histórico).
- **Órdenes:** descarga todas las requisiciones solo para resolver consecutivos.
- **Catálogos:** `/api/catalogs` (7 consultas SQL) se pide en cada ruta con `cache: "no-store"`.
- **Acción:**
  1. `GET /api/requisitions/:id` devuelve `{ requisition, orders, expenses, history, attachments }` en una sola transacción.
  2. `GET /api/attachments/:entity?ids=a,b,c` por lote (elimina N+1 en detalle y caja menor).
  3. `/api/orders?requisitionId=` y `/api/expenses?referenceId=`.
  4. Catálogos con caché de sesión: no se borran en `clearRouteCache()` salvo mutación de catálogos; opcionalmente `Cache-Control: private, max-age=60`.
- **Meta:** ≤ 2 llamadas por pantalla, una sola ronda.

### H3 · Listas sin límite y dashboard en memoria — Alto

- **Dónde:** `lib/infrastructure/postgres-repositories.ts:121,148-149,177-178,181` y `lib/services/procurement-service.ts:365-377`.
- **Qué pasa:** `select r.* from requisiciones order by created_at desc` sin `limit`; `select * from gastos`; `select * from caja_menor`; `/api/dashboard` carga las tres colecciones completas (con ítems) y agrega en JS.
- **Por qué importa:** con "decenas de requisiciones por semana" (PRD) el histórico pasa de 1 000 filas en un año. El payload de `/api/requisitions` con ítems pasará de KB a MB y cada bandeja lo descarga entero en cada visita.
- **Acción:**
  1. Filtros server-side (`status`, `workId`, `from`, `to`) y paginación por cursor (`created_at, id`, `limit 100`) en requisiciones, órdenes y gastos. La bandeja de revisión pide solo `enviada, en_revision, devuelta` (ya existe `requisiciones_revision_idx`).
  2. Dashboard con agregados SQL: conteo por estado, `sum(...) group by obra_id`, `group by periodo` (últimos 6 meses), cola de atención con `limit 20` en SQL.
  3. Índices nuevos: `gastos(referencia_id)` y `gastos(fecha_pago)`.
- **Meta:** `/api/requisitions` ≤ 100 filas / ≤ 100 KB por página; `/api/dashboard` < 300 ms con 5 000 filas.

### H4 · Un solo bundle para todos los roles — Alto

- **Dónde:** `components/mizar-app.tsx` importa estáticamente todas las pantallas; `components/screens/connected.tsx` (4 672 líneas) importa `recharts`.
- **Qué pasa:** el chunk de 610 KB (158 KB gzip) contiene dashboard, alta, detalle, bandejas, órdenes, gastos, catálogos admin (1 348 líneas), proveedores (683), esqueletos, pantallas demo y recharts. Un Solicitante que solo crea requisiciones lo descarga y lo evalúa completo.
- **Acción:**
  1. Dividir `connected.tsx` en `components/screens/connected/{data,dashboard,new-requisition,detail,requisitions,orders,expenses}.tsx`.
  2. Cargar cada pantalla con `next/dynamic` desde `ConnectedScreen` y `MizarApp`; el esqueleto de ruta ya existe y sirve como `loading`.
  3. Gráficos en `dashboard-charts.tsx` con `dynamic(() => import(...), { ssr: false })`; recharts solo se descarga en el dashboard.
  4. Pantallas demo cargadas solo cuando `demoMode` es verdadero.
  5. Medir con `npx next experimental-analyze` (analizador de Turbopack, Next ≥ 16.1).
- **Meta:** JS inicial ≤ 150 KB gzip; cada pantalla ≤ 60 KB gzip.

### H5 · Cada navegación remonta la app y reautentica — Medio

- **Dónde:** `app/page.tsx`, `app/[...slug]/page.tsx`, `components/mizar-app.tsx:148-150`.
- **Qué pasa:** cada clic en el menú hace `router.push` → RSC del server component → `getAuthSnapshot` (3 viajes) → remonta `MizarApp` y `AppShell`. El estado local (filtros, formularios a medias) se pierde; solo sobrevive el caché de módulo.
- **Acción:** `app/(app)/layout.tsx` con el guard y `AppShell` una sola vez, páginas hijas mínimas por ruta (`app/(app)/revision/page.tsx`, …) y navegación con `<Link prefetch>` en lugar de botones; `experimental.staleTimes.dynamic: 30` para reutilizar segmentos recientes. Alternativa mínima si no se quiere reestructurar: mantener `[...slug]` y apoyarse en la caché de actor de H1.

### H6 · Caché de rutas: invalidación total y volátil — Medio

- **Dónde:** `components/screens/connected.tsx:627-661`.
- **Qué pasa:** `clearRouteCache()` borra todo tras cualquier mutación; el caché vive en memoria de módulo y se pierde al recargar o abrir otra pestaña.
- **Acción:** invalidar por entidad (`requisition:<id>`, `dashboard`, `orders`, `expenses`) y respaldar en `sessionStorage` con TTL corto. Con H5 esto puede migrar al Client Cache de Next.

### H7 · CSS global monolítico y layout caro — Medio-bajo

- **Dónde:** `app/globals.css` (105 KB fuente, ~1 000 reglas, 22 media queries) cargado en `/login`, `/pantalla` y el portal público.
- **Qué pasa:** layouts de 138–200 ms con menos de 500 nodos apuntan a estilos costosos (28 `box-shadow`, 47 transiciones, 2 `backdrop-filter`).
- **Acción:** CSS Modules por pantalla (como ya hace `public-request-mobile.module.css`); revisar `transition: all`; `content-visibility: auto` en tablas largas; mover estilos de login/pantalla a sus módulos.

### H8 · Observabilidad inexistente — Medio

- **Qué pasa:** no hay `useReportWebVitals`, ni `Server-Timing`, ni `instrumentation.ts`. Caddy ya escribe logs JSON con latencia por request y nadie los lee.
- **Acción:** `Server-Timing: auth;dur=…, db;dur=…` en `authenticatedJson`; `useReportWebVitals` → `POST /api/internal/vitals` (o log); revisión semanal del log de Caddy hasta tener panel.

### H9 · Detalles de infraestructura — Bajo

- `sharedPostgres` usa `prepare: true` (`postgres-repositories.ts:13`): incompatible con el pooler transaccional de Supabase (puerto 6543). Confirmar `DATABASE_URL` en modo sesión (5432) o poner `prepare: false`.
- Next comprime por defecto y Caddy también (`encode zstd gzip`): poner `compress: false` en `next.config.ts` y dejar la compresión a Caddy.
- Región: Supabase en `sa-east-1` (PRD). La ubicación del VPS Hostinger define la latencia de H1; medir con `ping` y `psql \timing` desde el VPS antes de producción (tarea S0 del PRD).
- `/pantalla` refresca cada 60 s con `fetch no-store`: adecuado.
- `reactCompiler: true` (con `babel-plugin-react-compiler`) elimina re-renders en `connected.tsx` (76 `useState`, 2 `useMemo`, ningún `memo`) a coste casi nulo.

## Presupuesto de rendimiento

| Métrica | Hoy | Objetivo |
|---|---:|---:|
| JS por ruta (gzip) | 334 KB | ≤ 150 KB |
| Chunk de una pantalla (gzip) | 158 KB | ≤ 60 KB |
| Llamadas `/api` por pantalla | 2 – 7+N | ≤ 2 |
| Viajes a Supabase por llamada | 3 | ≤ 1 |
| Detalle con 10 ítems: peticiones | 16 | 1 |
| `/api/requisitions` por página | sin límite | ≤ 100 filas / ≤ 100 KB |
| LCP móvil p75 en producción | sin medir | < 2,5 s |
| INP p75 en producción | sin medir | < 200 ms |

## Plan de acción

| Fase | Alcance | Hallazgos | Esfuerzo | Verificación |
|---|---|---|---:|---|
| 0 · Medir | `Server-Timing` + Web Vitals; `ping` VPS↔Supabase; anotar cifras aquí | H8, H9 | 0,5–1 h | Cifras registradas en este documento |
| 1 · Servidor — **hecho (2026-09-10)** | Actor: consulta única + caché 60 s + `React.cache`; `/api/requisitions/:id` compuesto; adjuntos por lote; `/api/orders?requisitionId=`; catálogos con caché de sesión | H1, H2 | 3–4 h | `npm run lint`, `npm run typecheck`, `npm run test` en verde |
| 2 · Bundle — **hecho (2026-09-10)** | `connected.tsx` partido en `components/screens/connected/*`; `next/dynamic` por pantalla; recharts solo en `dashboard-charts.tsx`; pantallas demo solo con `demoMode`; test `bundle-boundaries` como red de seguridad | H4 | 3–4 h | `next build` en verde; JS de `/` 1 179 → 620 KB (334 → 192 KB gzip); E2E demo pendiente de correr (ver estado) |
| 3 · Datos — **hecho (2026-09-10)** / cliente — **hecho (2026-09-10)** / navegación — pendiente | Paginación y filtros server-side; dashboard en SQL; índices; `loadRoute` consume los endpoints compuestos; "Cargar más" en bandejas; caché de catálogos por sesión; invalidación selectiva en `mutate`; respaldo en `sessionStorage`. Layout `(app)` con guard único y `<Link>` — pendiente | H2, H3, H6 (hechos), H5 (pendiente) | 5–7 h | `npm run lint`, `npm run typecheck`, `npm run test` (530), `npm run verify:schema` en verde; fixture de 2 000 requisiciones pendiente y medición real de `/api/requisitions`/`/api/dashboard` < 300 ms queda pendiente (sin Postgres real en esta sesión) |
| 4 · Pulido — pendiente | CSS Modules; `compress: false`; `reactCompiler`. (`prepare` según pooler y región de Supabase ya no aplican: ver nota de migración) | H7, H9 | 2–3 h | Traza móvil: layout < 50 ms; build sin regresión |

Total estimado: **14–19 h**. Orden recomendado 0 → 1 → 2 → 3 → 4. Las fases 1 y 2 no se tocan entre sí y pueden repartirse entre dos personas o cuentas.

## Estado de ejecución (2026-09-10)

Ejecutado con subagentes de desarrollo y revisión centralizada, sobre el mismo árbol de trabajo y **sin commits** (queda mezclado con la migración a Postgres autoalojado que corrió en paralelo; separar ambos frentes es decisión de Ernesto).

**Nota de migración.** El mismo día se decidió salir de Supabase (ver `docs/migracion-autoalojado.md`). La sesión pasa a cookie propia resuelta contra `public.sesiones` (`lib/infrastructure/local-auth.ts`), construida sobre el caché de perfil de H1 (`actor-cache.ts`, 60 s). Por eso: la recomendación de `getClaims()` de H1 ya no aplica; la nota de `prepare: true` frente al pooler de Supabase y la región `sa-east-1` de H9 tampoco. H1 queda resuelto con una consulta de sesión + perfil cacheado por petición.

Qué cambió, medido:

| Métrica | Antes | Después |
|---|---:|---:|
| JS que descarga `/` (10–12 archivos) | 1 179 KB / 334 KB gzip | 620 KB / 192 KB gzip |
| Chunk con recharts | 610 KB, en toda ruta | 352 KB, solo al abrir el dashboard conectado |
| Detalle con N ítems | 6 + N peticiones, 2 rondas | 2 peticiones, 1 ronda (`/detail` + catálogos) |
| Gastos con M cajas menores | 3 + M | 3 (adjuntos por lote) |
| Órdenes | 3 (incluía todas las requisiciones) | 2 (líneas y fecha requerida vienen en el join) |
| Bandeja de revisión | 3 sin filtro ni límite | 3 con `status` y `limit=100` + "Cargar más" |
| Catálogos | 1 llamada por ruta | 1 por sesión (TTL 5 min, deduplicada) |
| Viajes al backend por llamada a la API solo por auth | 3 (Auth + 2 PostgREST) | 1 consulta de sesión + perfil cacheado 60 s |
| Dashboard | 3 colecciones completas en memoria | 8 consultas acotadas e indexadas (agregados en SQL) |
| LCP móvil emulado (CPU 4×, Slow 4G, build demo local) | 977 ms | 907 ms |

El LCP apenas se mueve porque es texto del SSR y su ruta crítica es el CSS (H7, pendiente); lo que baja es el JS que hay que evaluar antes de interactuar y, en producción, las llamadas al backend.

Verificación final del árbol completo (incluidos los cambios de la migración): `npm run lint` limpio, `npm run typecheck` limpio, `npm run test` 52 archivos / 530 pruebas en verde, `npm run verify:schema` en verde (lo corrió el agente de datos), `next build` en verde. Además se corrigió de paso un bug preexistente: `expense(row)` mapeaba `periodo` (columna `date`) con `String(Date).slice(0, 7)` → "Tue Sep", así que el filtro por periodo de gastos y `periodExpense` nunca coincidían; ahora usa `asIsoDate` y tiene test de regresión.

Pendiente, en orden sugerido:

1. Correr `npm run test:e2e` (22 recorridos demo) y `npm run visual:check` antes de integrar: la partición del bundle cambió el momento en que aparece cada pantalla.
2. H5: layout `app/(app)/layout.tsx` con guard único y navegación con `<Link>`; hoy cada clic sigue remontando `MizarApp` (mitigado por el caché de actor).
3. "Cargar más" también en órdenes y gastos (hoy solo en bandejas de requisiciones).
4. H7 (CSS Modules) y H8 cliente (`useReportWebVitals`); `compress: false` y `reactCompiler` son opcionales.
5. Fixture de 2 000 requisiciones para medir `/api/requisitions` y `/api/dashboard` con volumen real.

### Fase 1 — endpoints nuevos (servidor)

Compatibles hacia atrás: ninguno cambia el contrato de un endpoint existente, todos son aditivos.
El cliente los consume desde la parte de cliente de la Fase 3 (`components/screens/connected/data.ts`, `loadRoute`).

- `GET /api/requisitions/:id/detail` → `{ requisition, orders, expenses, history, attachments }` en una sola respuesta (reemplaza 4+1×N peticiones del detalle).
- `GET /api/attachments/:entity?ids=a,b,c` → adjuntos por lote (1–100 uuids), hoy restringido a `caja_menor` (ver decisión en `lib/services/attachment-service.ts`).
- `GET /api/orders?requisitionId=<uuid>` → filtra a una requisición; sin el parámetro, comportamiento intacto.
- `GET /api/expenses?referenceId=<uuid>` → filtra a los gastos de una requisición (directos o vía sus órdenes); sin el parámetro, comportamiento intacto.

### Fase 3 — datos (servidor), hecho 2026-09-10

Compatible hacia atrás igual que la Fase 1: **sin `limit` ni `cursor` en la URL, cada uno de los cuatro
endpoints de lista responde EXACTAMENTE lo que responde hoy** (array plano; con `status`/`workId`/`from`/`to`
aplicados si vienen, ninguno rompe lo existente porque son parámetros nuevos). El cliente consume
`status` + `limit=100` + cursor en las bandejas de requisiciones (`components/screens/connected/data.ts`,
`requisitions.tsx`); órdenes y gastos siguen pidiendo la lista sin paginar (pendiente).

- `GET /api/requisitions|orders|expenses|petty-cash` aceptan `?status=a,b&workId=&from=&to=&limit=&cursor=`.
  - `status`: solo en requisiciones (`enviada,en_revision,en_aprobacion,aprobada,devuelta,declinada`) y
    órdenes (`generada,cumplida,no_cumplida,no_necesario`); gastos y caja menor no tienen columna de
    estado — un `?status=` en esas dos rutas se ignora, no falla.
  - `workId`: uuid de obra. En órdenes filtra por la obra de la requisición dueña (join).
  - `from`/`to`: `YYYY-MM-DD`, inclusive en ambos extremos, sobre la columna de fecha propia de cada
    entidad — `created_at` en requisiciones, `fecha_generacion` en órdenes, `fecha` (fecha de PAGO) en
    gastos y caja menor.
  - `limit`: entero 1–200 (100 por defecto si se pagina sin indicarlo).
  - **Contrato de respuesta**: si viene `limit` o `cursor` → `{ rows: T[], nextCursor: string | null }`
    (cursor opaco, base64url, `nextCursor: null` en la última página). Si NO viene ninguno de los dos →
    el array de siempre, con los filtros aplicados si los hay (acotado internamente a 100 filas — ver
    "Riesgos y decisiones abiertas" más abajo).
  - Órdenes gana, de forma aditiva, `requisitionConsecutive`/`workId` en cada fila (join a requisiciones
    en el mismo SELECT) — la pantalla de órdenes deja de necesitar descargar todas las requisiciones
    solo para mostrar el consecutivo y la obra.
- `GET /api/dashboard` (sin cambio de contrato ni de parámetros): internamente ya no carga requisiciones/
  órdenes/gastos completos — `byStatus`/`pendingOrders`/`periodExpense`/`inProcessValue`/`expenseByWork`/
  `expenseByTag`/`expenseByPeriod` se agregan en SQL (`dashboardByStatus`, `dashboardPendingCount`,
  `dashboardAggregates`); `attentionQueue`/`recentActivity` siguen construyéndose en el dominio
  (`buildAttentionQueue`/`buildRecentActivity`, sin cambios) pero sobre candidatos acotados
  (`listVisibleHeaders`, `listAttentionCandidates`, `listRecentlyUpdated`), no la colección completa.
- Índices nuevos (`supabase/migrations/202609100002_indices_rendimiento.sql`): `gastos(referencia_id)`,
  `gastos(fecha)`, `gastos(fecha_orden desc, id desc)`, `requisiciones(updated_at desc)`,
  `requisiciones(created_at desc, id desc)`, `ordenes(updated_at desc)`,
  `ordenes(fecha_generacion desc, id desc)`, `caja_menor(fecha desc, id desc)`.

## Riesgos y decisiones abiertas

- `getClaims()` exige llaves JWT asimétricas en el proyecto Supabase (Auth → JWT Signing Keys). Si no se activan, se mantiene `getUser` con caché de 60 s: una cuenta desactivada conserva acceso hasta un minuto.
- Los advisors y `pg_stat_statements` de Supabase quedan pendientes de correr con un token de la organización dueña del proyecto.
- **Decisión (Fase 3, datos):** la paginación de `gastos` ordena/pagina por `fecha_orden` (nace con el
  registro, NUNCA nula) en vez de `fecha` (fecha de PAGO, nula mientras la orden no se ha pagado desde
  202609070003_gasto_fecha_pago.sql) — un cursor de teclado sobre una columna nullable rompe la
  comparación de tupla `(a, b) < (cursor)` en SQL. `from`/`to` sí filtran sobre `fecha` (la pregunta de
  negocio real es "qué se pagó en este rango"). Si el negocio prefiere paginar por fecha de pago, hay
  que resolver primero cómo ordenar de forma estable los compromisos sin pagar (¿antes que todo lo
  pagado? ¿en un bloque aparte?) — decisión de producto pendiente, no solo técnica.
- **Decisión (Fase 3, datos):** cuando la URL trae `status`/`workId`/`from`/`to` pero NO `limit` ni
  `cursor`, la ruta responde igual un array plano (compatibilidad con el consumidor actual) pero
  reutiliza el camino paginado con el límite por defecto (100 filas) — no un escaneo sin límite. Con más
  de 100 filas filtradas, ese array queda truncado en silencio sin ninguna señal de que hay más: es el
  trade-off elegido para no reabrir H3 (nada sin límite) en un modo que el plan pidió mantener como
  "el array de siempre". El cliente que necesite más de 100 filas filtradas debe pasar `limit`/`cursor`
  explícitos y consumir `{ rows, nextCursor }`.
- **Hallazgo fuera de alcance (no corregido aquí):** `expense(row)` en `postgres-repositories.ts` mapea
  `period: row.periodo != null ? String(row.periodo).slice(0, 7) : undefined` — `row.periodo` es una
  columna `date`, que postgres.js parsea como `Date` (no como texto); `String(unaFecha)` da un formato
  tipo "Tue Sep 01 2026 ...", no "2026-09", así que `.slice(0, 7)` no produce el periodo esperado (mismo
  tipo de bug que `asIsoDate` existe para evitar en otras columnas de fecha de este archivo). Los
  agregados nuevos de esta fase (`dashboardAggregates`) NO reutilizan ese mapeador — calculan
  `expenseByPeriod` con `to_char(periodo, 'YYYY-MM')` directamente en SQL, así que no heredan el bug —
  pero `Expense.period` en cualquier otro lugar que sí pase por `expense(row)` contra Postgres real
  puede estar mal. No se tocó por estar fuera del alcance de esta tarea (dato, no filtros/paginación) y
  para no interferir con el trabajo concurrente en otros archivos de `lib/infrastructure/`.

Nota de esta revisión: `.next/` quedó con el build en modo demo que se usó para medir. `npm run build` lo regenera y `npm run dev` no lo usa.
