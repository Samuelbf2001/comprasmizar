# Modelo de datos y controles — Plataforma Mizar

La fuente de verdad versionada está formada por la migración núcleo [`202608240001_core_compras.sql`](../supabase/migrations/202608240001_core_compras.sql), el expediente privado de proveedor [`202608240002_proveedores_expediente_privado.sql`](../supabase/migrations/202608240002_proveedores_expediente_privado.sql) y los adjuntos operativos privados [`202608240003_adjuntos_genericos_privados.sql`](../supabase/migrations/202608240003_adjuntos_genericos_privados.sql). No se ha aplicado ni desplegado ningún proyecto Supabase desde este repositorio.

## Límites del modelo

El modelo es single-tenant: una obra pertenece a una sociedad, pero no existe una capa de tenant genérica. Los módulos futuros agregan sus fuentes a `gastos` y reutilizan `adjuntos`, `auditoria` y `consecutivos`.

| Área | Tablas |
| --- | --- |
| Núcleo | `sociedades`, `usuarios`, `usuario_roles`, `modulos`, `obras`, `obra_solicitantes_autorizados`, `etiquetas`, `proveedores`, `items`, `consecutivos`, `adjuntos`, `auditoria` |
| Compras | `requisiciones`, `requisicion_items`, `ordenes`, `orden_items`, `gastos`, `gastos_reparto`, `caja_menor` |
| Integraciones | `notificaciones`, `whatsapp_eventos`, `kapso_procesamiento`, `mcp_api_keys`, `sesiones_pantalla` |
| Controles auxiliares | `requisicion_historial`, `configuracion`, vista `gasto_distribucion` |

`gastos` es el libro de gasto común. Una caja menor escribe su propio registro y un trigger crea/sincroniza su gasto. Para compras, el contrato de A2 es `origen='requisicion'` + `referencia_id=ordenes.id`: se genera **un gasto por OC/OP**, por lo que una requisición dividida entre proveedores conserva varios gastos sin romper `unique(origen, referencia_id)`. Para caja menor, `referencia_id=caja_menor.id`. Los gastos sin filas de reparto pertenecen por completo a `gastos.obra_id`; si existen filas en `gastos_reparto`, el trigger diferido exige que sumen exactamente `gastos.valor_total`. La vista `gasto_distribucion` normaliza ambos casos para reportes.

## Integridad y auditoría

- Los importes COP usan `numeric(16,2)` con `CHECK valor = trunc(valor)`: se conservan como pesos enteros y SQL directo no puede introducir centavos. La cantidad conserva `numeric(14,3)`. En requisiciones y gastos, `valor_total` se genera como `valor_base + iva`.
- El trigger de transición admite solo el flujo `enviada → en_revision → en_aprobacion → aprobada|devuelta`, y `devuelta → en_revision`; `declinada` es terminal y exige motivo. Una devolución también exige motivo.
- Los consecutivos `REQ`, `OC` y `OP` se reservan con un `UPSERT` atómico sobre `consecutivos`, por año. No se calcula `MAX()+1`.
- Cada cambio de tablas de dominio produce una fila de `auditoria` con `origen` (`web`, `mcp`, `kapso`, `importacion` o `sistema`) y evento en `UPPER_SNAKE_CASE` (por ejemplo `INSERT`, `STATE_CHANGE` o `REQUISICION_APROBADA`). En inserciones/borrados conserva la fila visible; en ediciones conserva `antes/despues` de cada campo cambiado. Secretos, hashes, payloads y PII se reemplazan por `{redactado:true}`. La redacción es dependiente de tabla: conserva el nombre de obras, sociedades, etiquetas, proveedores e ítems, pero oculta nombre/correo/teléfono de usuarios, solicitantes autorizados, solicitantes externos y eventos WhatsApp (incluido `kapso_message_id`). Así el adaptador A2 puede guardar eventos de dominio sin quedar atado a una lista cerrada. Tanto `auditoria` como `requisicion_historial` son inmutables por trigger. El origen por defecto es `web` para sesión de usuario y `sistema` para `service_role`; los adaptadores MCP/Kapso registran su evento técnico explícito mediante `registrar_evento_auditoria`, RPC concedida solo a `service_role`. También se admite `app.audit_origin` dentro de una transacción/RPC de servidor confiable. No se aceptan encabezados de cliente como evidencia de origen.
- Los índices cubren bandeja de revisión/aprobación, filtros por obra y período, órdenes pendientes, adjuntos, trazabilidad y eventos WhatsApp. Además hay índices parciales de los maestros disponibles (obra, etiqueta, proveedor, ítem y solicitante autorizado) para que las consultas operativas no recorran bajas históricas.
- Las bajas de `sociedades`, `usuarios`, `obras`, `obra_solicitantes_autorizados`, `etiquetas`, `proveedores` e `items` son reversibles: un trigger prohíbe `DELETE` y se usa `activa`/`activo`/`estado`. Una etiqueta activa exige por construcción un aprobador activo con rol `aprobador`, `revisor` o `admin_sixteam`; activar/reasignar etiquetas y retirar esos roles se serializa con un lock de la fila de usuario. Por ello no se puede desactivar al aprobador ni quitarle su último rol elegible mientras tenga etiquetas activas: primero se desactiva o reasigna la etiqueta, sin borrar históricos. Otros triggers rechazan nuevas requisiciones, ítems, órdenes y cajas menores que apunten a una obra cerrada, sociedad inactiva, etiqueta no enrutable, usuario inactivo, proveedor inactivo o ítem `inactivo`/`fusionado`. Las filas históricas se conservan y sus cambios de estado no se bloquean por una baja posterior del catálogo.
- `kapso_procesamiento` es el ledger transaccional de idempotencia de webhooks Kapso: `event_id` es la clave, conserva únicamente un payload objeto técnico y registra `processing`, `retryable` o `completed`. Los `flow_submission` no pueden marcarse `completed` sin una `requisicion_id`, cuya fila usa `requisiciones.kapso_event_id` único parcial. Los `message_status` pueden completarse sin requisición y se correlacionan con `whatsapp_eventos`. Su RLS es exclusivamente `service_role` y Admin Sixteam técnico; su auditoría guarda solo hash de `event_id`, tipo y estado, nunca el payload.
- `notificaciones` funciona como outbox transaccional: creación externa, envío a aprobación, aprobación, devolución y declinación encolan su plantilla dentro de la misma unidad de trabajo. El destino es exactamente un `usuario_id` o un `telefono_destino`, nunca ambos; conserva intentos, último error y bloqueo de reintento. Un estado `enviado` o `entregado` exige `enviado_at`. El despachador Kapso, los reintentos reales y las plantillas aprobadas siguen siendo un gate externo; una fila `pendiente` no se presenta como mensaje enviado.
- `mcp_api_keys.key_hash` acepta únicamente el HMAC-SHA256 en 64 hexadecimales minúsculas de la clave con `MCP_KEY_PEPPER`; una clave `mizar_...` en claro es rechazada por constraint y no debe aparecer en logs, seeds ni auditoría.

## RLS y acceso

Las tablas de aplicación tienen RLS activado y `anon` no tiene privilegios directos sobre ellas.

| Actor | Permisos principales |
| --- | --- |
| Solicitante | Lee sus propias requisiciones, sus ítems e historial; crea requisición web propia. |
| Revisor | Opera ítems/proveedores, revisión y caja menor. |
| Aprobador | Solo lee/actualiza requisiciones cuya `etiqueta.aprobador_id` es su usuario; un trigger solo permite cambiar la decisión y el motivo de devolución. |
| Contabilidad | Solo lectura operativa de proveedores, requisiciones, órdenes, gastos, caja menor y soportes. |
| Admin Sixteam | Administra catálogos, configuración técnica, claves MCP, notificaciones técnicas y activa módulos. |
| Admin Mizar | Puede administrar catálogos únicamente al activar Sixteam `modulos.catalogos_admin_mizar` (alcance Completo), consultar agregados de gasto/reportes y gestionar sesiones de pantalla. No opera requisiciones, ítems, caja menor, claves MCP, configuración ni notificaciones globales. RF-203 reserva ítems al Revisor/Sixteam. |
| Service role | No se expone en RLS ni cliente: bypass de Supabase solo para servicios de servidor. |

Un usuario con `estado='inactivo'` no supera `is_active_user()` y las políticas de lectura propia, catálogos, requisiciones, adjuntos, notificaciones, historial y storage lo excluyen aunque su sesión de Auth aún no haya expirado.

La división de órdenes por proveedor no depende de un booleano confiado al cliente: aunque el contrato HTTP la solicite, el servicio exige que `modulos.ordenes_multi_proveedor` esté activo dentro de la misma transacción. La migración lo deja desactivado hasta habilitar el alcance Completo.

El backend debe usar la sesión del usuario para operaciones normales; el `SUPABASE_SERVICE_ROLE_KEY` vive exclusivamente en el proceso servidor para flujos técnicos (generación de órdenes/gastos, importación aprobada, webhooks) y nunca llega al navegador, reporte o log. `crear_requisicion_publica` y la consulta pública están concedidas únicamente a `service_role`; el endpoint Next aplica rate limiting antes de invocarlas.

## Storage

Las migraciones declaran buckets privados separados para soportes operativos y expediente de proveedor, con máximo 20 MiB y PDF/JPEG/PNG/WebP. Los clientes JWT no reciben `INSERT`, `UPDATE` ni `DELETE` directo sobre `adjuntos` o `storage.objects`: el servidor prepara una URL de carga firmada no reutilizable, el navegador envía el multipart exigido por Supabase y el servidor hace `HEAD/info` de tamaño y MIME antes de crear metadata legible. La descarga usa una ruta autenticada que emite una URL firmada de 60 segundos con `no-store` y `no-referrer`; ni la clave del objeto ni la URL firmada aparecen en las vistas de listado.

La RLS de lectura hereda la entidad padre y, para requisición, ítem y caja menor, exige metadata canónica y objeto finalizado; filas históricas que no satisfagan el contrato moderno permanecen ocultas hasta su remediación. Proveedor mantiene su aislamiento propio; Contabilidad es lectura/descarga y Revisor/Admin Sixteam administran. La ejecución real de estas políticas y del flujo multipart contra Supabase sigue pendiente porque este checkout no dispone de CLI/`psql`/proyecto autorizado. La emisión de URL firmada para el formulario público y la copia de adjuntos Kapso todavía fallan cerradas.

## Supuestos provisionales obligatorios

- **P1 impuestos:** solo se modela IVA configurable (`configuracion.impuestos_v1`); no hay retenciones ni formato Helisa definitivo hasta la sesión con contabilidad.
- **P2 formulario público:** control temporal con enlace de obra + código almacenado con `crypt`/bcrypt. No se persiste ningún fingerprint SHA-256 del código. Las RPC de formulario están revocadas para `anon` y `authenticated`: el endpoint Next del servidor valida el código y aplica rate limit antes de usar la service role. `obra_solicitantes_autorizados` y `obras.require_authorized_requester` dejan lista la capacidad de lista blanca de teléfono, desactivada hasta que Mizar cierre P2.
- **P3 gasto compartido:** reparto manual por montos, validado a suma exacta. No se implementan porcentajes ni prorrateos predefinidos.

## Semillas e importación

`supabase/seed.sql` es estrictamente local: crea seis identidades ficticias, seis roles, tres sociedades, **17 obras**, cinco etiquetas, **cinco proveedores** y **31 ítems** sin PII. No ejecutar contra producción.

El importador acepta `items`, `proveedores` u `obras`, en CSV/XLSX. Normaliza mayúsculas, tildes, espacios y puntuación para detectar duplicados. Por defecto solo crea `import-report.json`, que contiene conteos, número de fila y códigos de error, nunca valores de proveedores/contactos. NIT y `kapso_message_id` admiten múltiples valores ausentes; el último solo es único cuando viene informado.

```powershell
npx tsx scripts/import-master-data.ts --entity items --file .\entrada\items.xlsx --report .\salida\items-report.json
npx tsx scripts/import-master-data.ts --entity proveedores --file .\entrada\proveedores.csv --apply
```

`--apply` requiere `NEXT_PUBLIC_SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` ya cargadas en el entorno. El script no imprime esos valores. Solo ejecutar `--apply` después de revisar el reporte sin errores; si hay filas inválidas, no aplica nada. `obras --apply` está deliberadamente deshabilitado: sociedades y obras requieren una RPC transaccional aprobada para no dejar una carga parcial. El dry-run entrega JSON listo para la revisión y carga controlada.

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
