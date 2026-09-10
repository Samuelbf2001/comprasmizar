# Modelo de datos y controles — Plataforma Mizar

La fuente de verdad versionada está formada por la migración núcleo [`202608240001_core_compras.sql`](../supabase/migrations/202608240001_core_compras.sql), el expediente privado de proveedor [`202608240002_proveedor_expediente_privado.sql`](../supabase/migrations/202608240002_proveedor_expediente_privado.sql), los adjuntos operativos privados [`202608240003_adjuntos_genericos_privados.sql`](../supabase/migrations/202608240003_adjuntos_genericos_privados.sql), la Fase 1 de empresa/eje administrativo [`202609010001_empresa_estado_item_y_eje_administrativo.sql`](../supabase/migrations/202609010001_empresa_estado_item_y_eje_administrativo.sql) (separa sociedad/obra en `requisiciones`, estado por ítem, eje administrativo independiente en `ordenes`, tasas de IVA/descuento, antifraude de doble orden y lista blanca global de solicitantes) y las tres migraciones de la reunión 2026-09: [`202609070001_aprobador_elegido.sql`](../supabase/migrations/202609070001_aprobador_elegido.sql) (el aprobador de una requisición lo elige el revisor, `requisiciones.aprobador_id`, en vez de heredarlo de la etiqueta), [`202609070002_acceso_publico_global.sql`](../supabase/migrations/202609070002_acceso_publico_global.sql) (contraseña GLOBAL del portal público, tabla singleton `acceso_publico`) y [`202609070003_gasto_fecha_pago.sql`](../supabase/migrations/202609070003_gasto_fecha_pago.sql) (`gastos.fecha_orden` nace con el registro; `gastos.fecha` pasa a significar fecha de PAGO). No se ha aplicado ni desplegado ningún proyecto Supabase desde este repositorio.

## Límites del modelo

El modelo es single-tenant: una obra pertenece a una sociedad, pero no existe una capa de tenant genérica. Los módulos futuros agregan sus fuentes a `gastos` y reutilizan `adjuntos`, `auditoria` y `consecutivos`.

| Área | Tablas |
| --- | --- |
| Núcleo | `sociedades`, `usuarios`, `usuario_roles`, `modulos`, `obras`, `obra_solicitantes_autorizados`, `solicitantes_autorizados`, `etiquetas`, `proveedores`, `items`, `consecutivos`, `adjuntos`, `auditoria` |
| Compras | `requisiciones`, `requisicion_items`, `ordenes`, `orden_items`, `gastos`, `gastos_reparto`, `caja_menor` |
| Integraciones | `notificaciones`, `whatsapp_eventos`, `kapso_procesamiento`, `mcp_api_keys`, `sesiones_pantalla` |
| Controles auxiliares | `requisicion_historial`, `configuracion`, `acceso_publico`, vista `gasto_distribucion` |

`gastos` es el libro de gasto común. Una caja menor escribe su propio registro y un trigger crea/sincroniza su gasto. Para compras, el contrato de A2 es `origen='requisicion'` + `referencia_id=ordenes.id`: se genera **un gasto por OC/OP**, por lo que una requisición dividida entre proveedores conserva varios gastos sin romper `unique(origen, referencia_id)`. Para caja menor, `referencia_id=caja_menor.id`. Los gastos sin filas de reparto pertenecen por completo a `gastos.obra_id`; si existen filas en `gastos_reparto`, el trigger diferido exige que sumen exactamente `gastos.valor_total`. La vista `gasto_distribucion` normaliza ambos casos para reportes. Desde `202609070003_gasto_fecha_pago.sql` (decisión del cliente, reunión 2026-09: "que quede como fechas aparte cuándo se sube y cuándo se paga; la del gasto es la del pago") `gastos` tiene dos fechas separadas: `fecha_orden` (NOT NULL, nace con el registro — generación de la orden o fecha del movimiento de caja menor, nunca cambia) y `fecha` (nullable, ahora significa fecha de PAGO — NULL para `origen='requisicion'` hasta que la orden que lo generó se marca `pagada`; para `origen='caja_menor'` sigue coincidiendo siempre con `fecha_orden`, porque se paga en el acto). `periodo` (columna generada a partir de `fecha`) hereda ese NULL a propósito: un gasto sin pagar no pertenece a ningún periodo de cierre.

## Integridad y auditoría

- Los importes COP usan `numeric(16,2)` con `CHECK valor = trunc(valor)`: se conservan como pesos enteros y SQL directo no puede introducir centavos. La cantidad conserva `numeric(14,3)`. En requisiciones y gastos, `valor_total` se genera como `valor_base + iva`.
- El trigger de transición admite solo el flujo `enviada → en_revision → en_aprobacion → aprobada|devuelta`, y `devuelta → en_revision`; `declinada` es terminal y exige motivo. Una devolución también exige motivo.
- Los consecutivos `REQ`, `OC` y `OP` se reservan con un `UPSERT` atómico sobre `consecutivos`, por año. No se calcula `MAX()+1`.
- Cada cambio de tablas de dominio produce una fila de `auditoria` con `origen` (`web`, `mcp`, `kapso`, `importacion` o `sistema`) y evento en `UPPER_SNAKE_CASE` (por ejemplo `INSERT`, `STATE_CHANGE` o `REQUISICION_APROBADA`). En inserciones/borrados conserva la fila visible; en ediciones conserva `antes/despues` de cada campo cambiado. Secretos, hashes, payloads y PII se reemplazan por `{redactado:true}`. `auditoria_campo_sensible` redacta por **nombre de columna** (`password`, `key_hash`, `token_hash`, `public_code_hash`, `payload`, `datos_bancarios`, `contacto`, `telefono`, `email`, `observaciones`, ...), sin importar la tabla, más un puñado de reglas por tabla (nombre/teléfono de usuarios y solicitantes, eventos WhatsApp). GRAVE corregido en 202609070002 (QA Postgres real): un secreto NUNCA debe vivir en una columna genérica compartida (como `configuracion.valor`, jsonb reutilizado por cualquier clave de configuración) porque esa columna no puede redactarse sin perder trazabilidad legítima de las claves no secretas que la comparten — de ahí que la contraseña del portal público viva en su propia tabla (`acceso_publico.public_code_hash`), con columna nombrada para heredar la redacción existente en vez de ensanchar la lista o la regla por tabla. Así el adaptador A2 puede guardar eventos de dominio sin quedar atado a una lista cerrada. Tanto `auditoria` como `requisicion_historial` son inmutables por trigger. El origen por defecto es `web` para sesión de usuario y `sistema` para `service_role`; los adaptadores MCP/Kapso registran su evento técnico explícito mediante `registrar_evento_auditoria`, RPC concedida solo a `service_role`. También se admite `app.audit_origin` dentro de una transacción/RPC de servidor confiable. No se aceptan encabezados de cliente como evidencia de origen.
- Los índices cubren bandeja de revisión/aprobación, filtros por obra y período, órdenes pendientes, adjuntos, trazabilidad y eventos WhatsApp. Además hay índices parciales de los maestros disponibles (obra, etiqueta, proveedor, ítem y solicitante autorizado) para que las consultas operativas no recorran bajas históricas.
- Las bajas de `sociedades`, `usuarios`, `obras`, `obra_solicitantes_autorizados`, `etiquetas`, `proveedores` e `items` son reversibles: un trigger prohíbe `DELETE` y se usa `activa`/`activo`/`estado`. Una etiqueta activa exige por construcción un aprobador activo con rol `aprobador`, `revisor` o `admin_sixteam`; activar/reasignar etiquetas y retirar esos roles se serializa con un lock de la fila de usuario. Por ello no se puede desactivar al aprobador ni quitarle su último rol elegible mientras tenga etiquetas activas: primero se desactiva o reasigna la etiqueta, sin borrar históricos. Otros triggers rechazan nuevas requisiciones, ítems, órdenes y cajas menores que apunten a una obra cerrada, sociedad inactiva, etiqueta no enrutable, usuario inactivo, proveedor inactivo o ítem `inactivo`/`fusionado`. Las filas históricas se conservan y sus cambios de estado no se bloquean por una baja posterior del catálogo.
- `requisiciones.aprobador_id` (`202609070001_aprobador_elegido.sql`, nullable — se asigna en revisión, no al crear) lleva la misma protección de elegibilidad que `etiquetas.aprobador_id`: un trigger rechaza asignarlo a un usuario que no sea activo con rol `aprobador`/`revisor`/`admin_sixteam`, pero solo valida en `INSERT` o cuando el valor **realmente cambia** (Postgres dispara `UPDATE OF aprobador_id` con solo que la columna aparezca en el `SET`, así que sin ese guard cualquier guardado de una requisición cuyo aprobador dejó de ser elegible mientras tanto habría fallado, aunque no se estuviera tocando ese campo). Un segundo trigger, hermano de la protección de etiquetas, impide dar de baja a un usuario que sea `aprobador_id` de alguna requisición todavía `en_aprobacion` — hay que reasignarlas primero. El backfill de esta migración (aprobador heredado de la etiqueta para requisiciones ya existentes) también filtra por elegibilidad: una fila cuyo aprobador de etiqueta ya no era elegible queda con `aprobador_id` NULL, no con un aprobador roto.
- `kapso_procesamiento` es el ledger transaccional de idempotencia de webhooks Kapso: `event_id` es la clave, conserva únicamente un payload objeto técnico y registra `processing`, `retryable` o `completed`. Los `flow_submission` no pueden marcarse `completed` sin una `requisicion_id`, cuya fila usa `requisiciones.kapso_event_id` único parcial. Los `message_status` pueden completarse sin requisición y se correlacionan con `whatsapp_eventos`. Su RLS es exclusivamente `service_role` y Admin Sixteam técnico; su auditoría guarda solo hash de `event_id`, tipo y estado, nunca el payload.
- `notificaciones` funciona como outbox transaccional: creación externa, envío a aprobación, aprobación, devolución y declinación encolan su plantilla dentro de la misma unidad de trabajo. El destino es exactamente un `usuario_id` o un `telefono_destino`, nunca ambos; conserva intentos, último error y bloqueo de reintento. Un estado `enviado` o `entregado` exige `enviado_at`. El despachador Kapso, los reintentos reales y las plantillas aprobadas siguen siendo un gate externo; una fila `pendiente` no se presenta como mensaje enviado.
- `mcp_api_keys.key_hash` acepta únicamente el HMAC-SHA256 en 64 hexadecimales minúsculas de la clave con `MCP_KEY_PEPPER`; una clave `mizar_...` en claro es rechazada por constraint y no debe aparecer en logs, seeds ni auditoría.
- `requisiciones.sociedad_id` es NOT NULL (empresa) y `obra_id` pasó a nullable (una requisición corporativa puede no tener obra concreta). Un trigger `BEFORE INSERT` (`requisiciones_0_derivar_sociedad`, que por nombre dispara alfabéticamente antes que `requisiciones_catalogos_activos`) deriva `sociedad_id` desde `obras.sociedad_id` cuando llega nula con obra presente; lo necesitan tanto el portal público (`crear_requisicion_publica`, anclado a la obra) como cualquier alta legacy. Cuando ambas están presentes, la obra debe pertenecer exactamente a la sociedad de la requisición.
- `requisicion_items.estado` (`pendiente`/`aprobado`/`declinado`) permite decidir ítem por ítem dentro de una requisición; `declinado` exige `motivo_declinacion`.
- `ordenes` tiene un eje administrativo (`estado_administrativo`: `pendiente`/`contabilizada`/`pagada`, con `contabilizada_at`/`pagada_at`/`forma_pago`) completamente independiente de `estado_cumplimiento`: contabilizar o pagar una orden no altera si fue cumplida operativamente, y viceversa. La invariante de orden entre transiciones administrativas vive en el dominio, no en un check de base de datos.
- `requisicion_items.iva_tasa` y `descuento_tasa` son fracciones (`0.19`, no `19`) acotadas a `[0,1]`; no hay check que ate `iva` a `iva_tasa` porque el histórico no siempre cuadra exactamente.
- `ordenes_una_por_requisicion_proveedor` es un índice único sobre `(requisicion_id, coalesce(proveedor_id, uuid cero))`: evita generar dos órdenes para la misma requisición y proveedor (incluido el caso sin proveedor asignado).
- `solicitantes_autorizados` es la lista blanca global de solicitantes (mismo patrón de normalización de teléfono, unicidad, auditoría y baja reversible que `obra_solicitantes_autorizados`, pero sin `obra_id`); `obra_solicitantes_autorizados` se conserva intacta porque el portal público sigue anclado a la obra.
- `requisiciones.destino` quedó obsoleta (fusionada en `observaciones`) y no se elimina para no romper historial ni el contrato de `crear_requisicion_publica`.

## RLS y acceso

Las tablas de aplicación tienen RLS activado y `anon` no tiene privilegios directos sobre ellas.

| Actor | Permisos principales |
| --- | --- |
| Solicitante | Lee sus propias requisiciones, sus ítems e historial; crea requisición web propia. |
| Revisor | Opera ítems/proveedores, revisión y caja menor. |
| Aprobador | Solo lee/actualiza requisiciones cuyo `aprobador_id` es su usuario (desde `202609070001_aprobador_elegido.sql`: ya no se deriva de `etiqueta.aprobador_id` — lo asigna el revisor al revisar; la etiqueta solo sugiere un aprobador por defecto); un trigger solo permite cambiar la decisión y el motivo de devolución. |
| Contabilidad | Solo lectura operativa de proveedores, requisiciones, órdenes, gastos, caja menor y soportes. |
| Admin Sixteam | Administra catálogos, configuración técnica, claves MCP, notificaciones técnicas y activa módulos. |
| Admin Mizar | Puede administrar catálogos únicamente al activar Sixteam `modulos.catalogos_admin_mizar` (alcance Completo), consultar agregados de gasto/reportes y gestionar sesiones de pantalla. No opera requisiciones, ítems, caja menor, claves MCP, configuración ni notificaciones globales. RF-203 reserva ítems al Revisor/Sixteam. |
| Service role | No se expone en RLS ni cliente: bypass de Supabase solo para servicios de servidor. |

Un usuario con `estado='inactivo'` no supera `is_active_user()` y las políticas de lectura propia, catálogos, requisiciones, adjuntos, notificaciones, historial y storage lo excluyen aunque su sesión de Auth aún no haya expirado.

La división de órdenes por proveedor no depende de un booleano confiado al cliente: aunque el contrato HTTP la solicite, el servicio exige que `modulos.ordenes_multi_proveedor` esté activo dentro de la misma transacción. La migración lo deja desactivado hasta habilitar el alcance Completo.

El backend debe usar la sesión del usuario para operaciones normales; la conexión de la aplicación (`DATABASE_URL`) vive exclusivamente en el proceso servidor y nunca llega al navegador, reporte o log. Desde la [migración a autoalojado](migracion-autoalojado.md) no existe un `service_role` de PostgREST: los flujos técnicos (generación de órdenes/gastos, importación aprobada, webhooks) entran por la misma capa de servicio que la web, con su misma autorización y auditoría. `crear_requisicion_publica` y la consulta pública están concedidas únicamente a `service_role`; el endpoint Next aplica rate limiting antes de invocarlas.

## Storage

Las migraciones declaran buckets privados separados para soportes operativos y expediente de proveedor, con máximo 20 MiB y PDF/JPEG/PNG/WebP. Los clientes JWT no reciben `INSERT`, `UPDATE` ni `DELETE` directo sobre `adjuntos` o `storage.objects`: el servidor prepara una URL de carga firmada no reutilizable, el navegador envía el multipart exigido por Supabase y el servidor hace `HEAD/info` de tamaño y MIME antes de crear metadata legible. La descarga usa una ruta autenticada que emite una URL firmada de 60 segundos con `no-store` y `no-referrer`; ni la clave del objeto ni la URL firmada aparecen en las vistas de listado.

La RLS de lectura hereda la entidad padre y, para requisición, ítem y caja menor, exige metadata canónica y objeto finalizado; filas históricas que no satisfagan el contrato moderno permanecen ocultas hasta su remediación. Proveedor mantiene su aislamiento propio; Contabilidad es lectura/descarga y Revisor/Admin Sixteam administran. La ejecución real de estas políticas y del flujo multipart contra Supabase sigue pendiente porque este checkout no dispone de CLI/`psql`/proyecto autorizado. La emisión de URL firmada para el formulario público y la copia de adjuntos Kapso todavía fallan cerradas.

## Supuestos provisionales obligatorios

- **P1 impuestos:** solo se modela IVA configurable (`configuracion.impuestos_v1`); no hay retenciones ni formato Helisa definitivo hasta la sesión con contabilidad.
- **P2 formulario público:** control temporal con enlace de obra + una contraseña. Actualización 2026-09 (decisión del cliente, literal: "yo digo que sea solamente una contraseña para todo el mundo"): la contraseña dejó de ser por obra y pasó a ser **GLOBAL** — `202609070002_acceso_publico_global.sql` la mueve a la tabla singleton `acceso_publico` (columna `public_code_hash`, `crypt`/bcrypt con `gen_salt('bf', 12)`), verificada por `public.verificar_codigo_publico`. `obras.public_code_hash` (el modelo viejo, por obra) queda comentada como obsoleta, sin dropear. No se persiste ningún fingerprint SHA-256 del código. Las RPC de formulario están revocadas para `anon` y `authenticated`: el endpoint Next del servidor valida el código y aplica rate limit antes de usar la service role. `obra_solicitantes_autorizados` y `obras.require_authorized_requester` dejan lista la capacidad de lista blanca de teléfono, desactivada hasta que Mizar cierre P2. Operativo: hasta que alguien fije la contraseña desde Catálogos › Acceso público, **el portal rechaza todo código** para cualquier obra habilitada — ver `docs/runbook-operacion.md`.
- **P3 gasto compartido:** reparto manual por montos, validado a suma exacta. No se implementan porcentajes ni prorrateos predefinidos.

## Semillas e importación

`supabase/seed.sql` es estrictamente local: crea seis identidades ficticias, seis roles, tres sociedades, **17 obras**, cinco etiquetas, **cinco proveedores** y **31 ítems** sin PII. No ejecutar contra producción.

El importador acepta `items`, `proveedores` u `obras`, en CSV/XLSX. Normaliza mayúsculas, tildes, espacios y puntuación para detectar duplicados. Por defecto solo crea `import-report.json`, que contiene conteos, número de fila y códigos de error, nunca valores de proveedores/contactos. NIT y `kapso_message_id` admiten múltiples valores ausentes; el último solo es único cuando viene informado.

```powershell
npx tsx scripts/import-master-data.ts --entity items --file .\entrada\items.xlsx --report .\salida\items-report.json
npx tsx scripts/import-master-data.ts --entity proveedores --file .\entrada\proveedores.csv --apply
```

`--apply` requiere `DATABASE_URL` ya cargada en el entorno y escribe por SQL directo, en una sola transacción por corrida (una importación a medias deja el catálogo en un estado que nadie revisó). El script no imprime esos valores. Solo ejecutar `--apply` después de revisar el reporte sin errores; si hay filas inválidas, no aplica nada. `obras --apply` está deliberadamente deshabilitado: sociedades y obras requieren una RPC transaccional aprobada para no dejar una carga parcial. El dry-run entrega JSON listo para la revisión y carga controlada.

## Verificación ejecutable

Con Supabase CLI local y una URL local de Postgres:

```powershell
supabase start
supabase db reset
psql $env:LOCAL_DATABASE_URL -v ON_ERROR_STOP=1 -f supabase/tests/schema_verification.sql
npm run typecheck
git diff --check
```

La prueba verifica presencia de las tablas requeridas por el PRD y el patrón de módulos, RLS, bucket privado, consecutivos atómicos, FK de reparto, NIT/IDs externos nulos repetibles, `auditoria.origen`, el límite de actualización de aprobador y que Admin-Mizar no pueda editar ítems. Las pruebas HTTP de JWT, rate-limit y URLs firmadas corresponden al arnés de integración de A6/A2.

### `npm run verify:schema` — el mismo arnés SQL, pero sin Supabase CLI ni Docker

Docker está roto en algunas máquinas de este equipo, y sin Postgres real detrás, dos bloqueantes de
la reunión 2026-08-31 pasaron los 342 tests unitarios con mocks y solo se vieron corriendo la
migración contra un motor de verdad (mismo tipo de bug que el commit `be06b83`, "bug solo-DB-real"):
el código real que Postgres emite para un `ON DELETE RESTRICT` (`23001`, no `23503`) y el hecho de
que una columna `NOT NULL DEFAULT 0` nunca deja leer `NULL` por más que el mapeador lo contemple.

`scripts/verify-schema.ts` monta ese mismo Postgres real de forma reproducible y sin Docker, con el
paquete `embedded-postgres` (Postgres 18.4, arranca y se detiene solo, sin instalación aparte):

```powershell
npm run verify:schema
```

El script: levanta un cluster efímero → aplica `supabase/tests/embedded_postgres_prelude.sql`
(stubea SOLO lo que Supabase da por hecho y que las migraciones/arneses asumen: roles
`anon`/`authenticated`/`service_role`, el esquema `auth` con `auth.users` y `auth.uid()`/`auth.role()`
leyendo los mismos GUC que PostgREST, el esquema `storage` con `buckets`/`objects` y RLS activo, y
`pgcrypto` instalado en un esquema `extensions`) → aplica las migraciones de `supabase/migrations/`
**en orden** (siete a la fecha) → aplica `supabase/seed.sql` → corre los arneses SQL de
`supabase/tests/*.sql` (`schema_verification.sql`, `generic_attachments_verification.sql`,
`supplier_documents_verification.sql`, `aprobador_elegido_verification.sql`,
`acceso_publico_verification.sql`, `gasto_fecha_pago_verification.sql`) → sale con código distinto de
cero si cualquier paso falla. No modifica ninguno de los arneses SQL existentes: el prelude es
exclusivamente aditivo.

#### Mecanismo `.pre`/`.post` para datos LEGADO (2026-09-07)

Todo lo anterior corre las migraciones sobre una base **vacía** — un backfill que no hace nada y uno
correcto son indistinguibles ahí, porque no hay ninguna fila previa que backfillear. Esto no es
teórico: el backfill de `202609070003_gasto_fecha_pago.sql` (`add column fecha_orden date default
current_date` antes del `update ... where fecha_orden is null`) pasaba los 6 arneses SQL sobre base
vacía y aun así perdía irreversiblemente la fecha original de todo gasto histórico, porque en
Postgres ≥ 11 un `ADD COLUMN ... DEFAULT` rellena TODAS las filas existentes de inmediato — el
`UPDATE` de backfill nunca encontraba una sola fila en NULL que tocar.

`scripts/verify-schema.ts` cierra ese hueco de forma genérica: para cada migración
`supabase/migrations/<nombre>.sql`, si existe `supabase/tests/legacy/<nombre>.pre.sql` se ejecuta
**justo antes** de esa migración (siembra filas como las que ya existirían en una base de
producción; sin `rollback`, deben sobrevivir para que la migración y su `.post` las encuentren), y si
existe `supabase/tests/legacy/<nombre>.post.sql` se ejecuta **justo después** (asserta el resultado
del backfill sobre esas filas legado, mismo formato `do $$ ... raise exception ... $$` que el resto de
arneses de este repo; el `.post` sí puede limpiar si hace falta que `supabase/seed.sql` no choque,
aunque normalmente basta con un namespace de IDs propio — este repo usa el prefijo `90000000-...` para
estos fixtures, sin colisión con `supabase/seed.sql` ni con los demás arneses). Ninguno de los dos
archivos es obligatorio por migración: la mayoría no toca datos existentes. Pares actuales:
`202609070001_aprobador_elegido` (una etiqueta activa con aprobador ya inactivo),
`202609070002_acceso_publico_global` (una obra con el hash histórico por obra) y
`202609070003_gasto_fecha_pago` (órdenes pagada/pendiente con gastos fechados en agosto, más un gasto
de caja menor).
