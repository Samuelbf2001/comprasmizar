# ESTADO — feat/portal-adjuntos-tipos

Rama y base: `feat/portal-adjuntos-tipos` desde `main` local @ 7f35ebd (adenda de pagos + su QA ya integrados).
Último commit: este — «El soporte del portal público deja de ser solo una foto: acepta PDF, Excel, Word, CSV e imágenes, cada uno reconocido por su contenido».

## Decisión que implementa

Ernesto, 17-sep-2026, sobre el adjunto del portal público: **«si puede ser muchos tipos de archivos, CSV, Excel, etc., PDF, imágenes, lo que sea»**. Cierra el pendiente «El adjunto del pago es solo FOTO (JPG/PNG/WebP ≤5 MB)» de `docs/ESTADO-Y-PENDIENTES.md` §S3.

## Hecho

- **`lib/infrastructure/attachment-mime.ts`** — la ampliación, siempre por CONTENIDO, nunca por extensión ni por el `Content-Type` del cliente:
  - PDF `%PDF`; JPEG `FF D8 FF`; PNG `89 50 4E 47 0D 0A 1A 0A`; WebP `RIFF`…`WEBP` (los de siempre).
  - **OOXML** (`.xlsx`/`.docx`/`.pptx`): `PK\x03\x04` **no basta** —lo cumple cualquier zip—, así que se recorre el **directorio central** del zip y se exige la entrada `[Content_Types].xml` que ECMA-376 hace obligatoria, más la carpeta que distingue la familia (`xl/`, `word/`, `ppt/`).
  - **XLS legado**: contenedor OLE2 `D0 CF 11 E0 A1 B1 1A E1`, que también podría ser un `.doc`, un `.ppt` o un `.msi`; se recorre su directorio por la FAT y solo se acepta con el flujo `Workbook`/`Book`, nunca con `WordDocument` ni `PowerPoint Document`.
  - **CSV / texto**: sin firma. `sniffAttachmentMime` sigue devolviendo `null` para texto (contrato intacto de `kapso-store.ts`); el nuevo `sniffAttachmentMimeOrPlainText` lo acepta como **último recurso** solo si TODO es UTF-8 válido, sin NUL y sin controles salvo tab/LF/CR.
- **`lib/services/attachment-service.ts`** — una sola tabla `ATTACHMENT_EXTENSIONS` es a la vez la lista blanca de MIME y la de extensiones. `MAX_PRIVATE_ATTACHMENT_BYTES` baja a **10 MB**. Un `requisicion_item` admite `foto` **o** `soporte`; `foto` sigue exigiendo un MIME de imagen.
- **`lib/infrastructure/public-attachments.ts`** (antes `public-photos.ts`) — el `tipo` sale de lo que el archivo RESULTÓ ser: imagen → `foto`, documento → `soporte`. Tope 10 MB. Descarte silencioso de lo inválido, igual que antes (la requisición ya existe; reventar aquí provocaría envíos duplicados).
- **`app/api/storage/object/route.ts`** — lista blanca importada del servicio (ya no copiada); husmea con el sniffer que incluye texto; al servir añade `Content-Security-Policy: default-src 'none'; sandbox` junto al `attachment` + `nosniff` que ya había, y `charset=utf-8` para el texto.
- **`app/api/attachments/[entity]/[entityId]/route.ts`** — `attachmentUploadSchema` importa tipos y tope del servicio en vez de repetirlos.
- **UI** — portal (`public-request.tsx`): `CampoFoto` → `CampoSoporte`, `accept` con MIME **y** extensiones, sin `capture="environment"` (forzaba la cámara), ayuda «Foto, PDF, Excel, Word o CSV. Hasta 10 MB.», icono en vez de miniatura para documentos (también en el resumen), errores y copy sin «foto». Selector interno (`AttachmentPicker`): misma lista y ayuda «PDF, Excel, Word, CSV o imagen · máximo 10 MB». `detail.tsx`: un soporte de ítem ya no se rotula «Soporte general».
- **Migración `202609170002_adjuntos_tipos_de_archivo.sql`** + arnés `supabase/tests/adjuntos_tipos_archivo_verification.sql` (registrado en `scripts/verify-schema.ts`): amplía `nombre_mime_adjunto_valido`, extrae la lista blanca a `mime_adjunto_generico_permitido`, **añade** `tipo_mime_adjunto_coherente` (foto ⇒ `image/*`), permite `requisicion_item` con `soporte`, y deja el bucket declarando los mismos formatos. El expediente de proveedor no se toca.

## Decisiones tomadas (y por qué)

- **Discrepancia 10 / 20 MB**: se unifica en **10 MB** (`MAX_PRIVATE_ATTACHMENT_BYTES`, `attachmentUploadSchema` que ahora lo importa, `MAX_ATTACHMENT_BYTES` del selector, `MAX_PUBLIC_ATTACHMENT_BYTES` del portal). El CHECK de la base se queda en **20 MiB a propósito**: es `not valid`, así que apretarlo rompería cualquier `UPDATE` sobre filas radicadas con el tope viejo. La base es la barrera exterior; el límite del producto vive en TypeScript. El tope agregado del multipart público se queda en 60 MB (no 20 × 10 MB): acota lo que un anónimo puede hacernos leer de una vez.
- **CSV**: de un `.csv` no se puede demostrar que no sea un script. Se acepta **como texto** y se guarda con `text/plain` **fijado por el servidor**; la defensa no es adivinar el contenido sino no interpretarlo nunca (descarga forzada + `nosniff` + CSP en sandbox). `.csv` y `.txt` comparten MIME porque el servidor no puede distinguirlos.
- **La ampliación es de toda la plataforma**, no solo del portal: la tabla `adjuntos`, el CHECK y la ruta de descarga son los mismos, y aceptar un XLSX del proveedor pero rechazarlo cuando lo sube contabilidad habría dejado dos listas divergiendo.
- **El campo multipart sigue llamándose `foto_<índice>`**: es el contrato de red que ya hablan portal y endpoint, y renombrarlo no cambia ninguna validación (queda comentado en la ruta). El módulo y el test sí se renombraron, donde el nombre sí engaña al lector.
- **Legacy `.doc` no se admite** (el encargo pedía XLS legado): sin necesidad de negocio, un formato menos que defender.

## Cómo verificar

```
npm run typecheck   -> 0
npm run lint        -> 0
npm run test        -> 95 archivos / 1187 pruebas, todo verde
npm run verify:schema -> prelude + 24 migraciones + seed + seed-demo + 24 arneses, todo verde
```

Pruebas nuevas: `tests/integration/attachment-file-types.test.ts` (12) con archivos REALES — PDF de `pdf-lib`, XLSX de `exceljs`, un OLE2 construido a mano — y `tests/integration/public-attachments.test.ts` (+4). Cubren: se acepta un PDF real, un XLSX real y un CSV; se RECHAZAN un ejecutable disfrazado de PDF, un zip que no es OOXML, un OLE2 que es Word, un archivo por encima del tope y un `content-type` mentiroso; y la descarga sale con `Content-Disposition: attachment`, `nosniff` y CSP.

## Riesgos y pendientes

- **Un `.csv` puede ser cualquier texto** (un script, un HTML). Se sirve como descarga y nunca se interpreta, pero quien lo abra en su máquina lo abre bajo su responsabilidad. Relacionado: **inyección de fórmulas en CSV** (una celda que empieza por `=`) — Excel la ejecutará al abrir; no se sanea, es el archivo tal como lo mandó el proveedor.
- **El descarte del portal sigue siendo silencioso**: si el servidor rechaza el archivo, la requisición se radica sin él y nadie avisa. Se mantuvo a propósito (un 503 aquí provocaría envíos duplicados) y el formulario ya filtra en el navegador casi todo lo que fallaría, pero un PDF corrupto se pierde sin decirlo.
- **UI no recorrida en navegador**: los cambios del portal y del selector interno están cubiertos por pruebas de jsdom y se actualizó `tests/e2e/public-portal.spec.ts`, pero **el E2E de Playwright y el visual no se corrieron** en este paquete (mismo riesgo que ya arrastraba el QA de la adenda).
- **`MAX_PUBLIC_ATTACHMENT_BYTES` está duplicado** en cliente y servidor (10 MB en `public-request.tsx` y en `public-attachments.ts`): es el patrón del repo —no comparten build— pero si uno cambia, el otro también.
- La migración no aprieta el CHECK de tamaño a 10 MB: si algún día se quiere, hace falta remediar antes las filas históricas y validar la constraint.
