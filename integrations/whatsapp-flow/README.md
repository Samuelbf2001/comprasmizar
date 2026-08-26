# WhatsApp Flow — Requisición de obra (RF-902)

Definición versionada del formulario de requisición dentro del chat de WhatsApp
(`requisicion.flow.json`), y el script que la sube a Meta como **BORRADOR** vía el
proxy de Kapso. Antes de este cambio solo existía el receptor del webhook
(`app/api/kapso/route.ts`); el Flow en sí no existía en ningún lado.

## Archivos

- `requisicion.flow.json` — fuente de verdad del Flow. Cualquier cambio de UX se
  hace aquí y se sube con el script; nunca se edita a mano en el Builder de Meta.
- `../../scripts/publish-whatsapp-flow.ts` — crea el Flow (si no existe, por nombre)
  o actualiza su Flow JSON (si ya existe). Siempre dentro del estado `DRAFT`.
- `../../tests/unit/whatsapp-flow.test.ts` — valida la estructura local del JSON
  (pantallas, requeridos, terminal/complete) sin llamar a ninguna API.

## Diseño del Flow

6 pantallas, **sin Data Endpoint** (sin `endpoint_uri`/`data_channel_uri`, sin
cifrado, sin health checks). Toda la navegación es `navigate`/`complete` en el
cliente. **Un artículo por pantalla** para que cada ítem se distinga con claridad
del anterior (feedback de la prueba real):

1. **TIPO_Y_OBRA** (entrada) — tipo (`compra`/`pago`) y obra (`Dropdown`). El
   listado de obras **no está quemado**: llega dinámico por `data.obras`.
2. **ARTICULO_UNO** — artículo obligatorio: catálogo (opcional), descripción,
   cantidad, unidad, posible proveedor y link. Es el único obligatorio.
3. **ARTICULO_DOS** — segundo artículo, todo opcional (se omite con Continuar).
4. **ARTICULO_TRES** — tercer artículo, todo opcional.
5. **DETALLES** — fecha requerida (`DatePicker`), destino/frente, observaciones,
   y un **`PhotoPicker` con `photo-source: camera_gallery`**: el solicitante puede
   **tomar una foto con la cámara** o elegirla de la galería.
6. **RESUMEN** (terminal, `success: true`) — dispara `complete` con el payload
   plano. Las claves item_N_* se conservan aunque cada ítem venga de su pantalla.

Los `id` de pantalla solo usan letras y guion bajo (Meta rechaza dígitos: por eso
`ARTICULO_UNO`, no `ARTICULO_1`). Versión de Flow JSON: `7.3`.

### Identidad del solicitante: por número de WhatsApp, no por formulario

El Flow **no pide nombre ni teléfono**. La identidad es el número de WhatsApp del
remitente, que el adaptador (`nfm-reply-adapter.ts`) resuelve contra la lista
blanca `obra_solicitantes_autorizados` vía `resolveAuthorizedRequesterName`
(`lib/infrastructure/public-access.ts`). Si el número no está autorizado para la
obra elegida, la requisición se rechaza como `unauthorized_requester`. Esto
implementa el pedido de "relacionar una BBDD de los números permitidos".

### Límite de 20 caracteres en labels (restricción dura de Meta)

Meta limita el `label` de `TextInput`, `TextArea` y `Dropdown` a **20 caracteres**
(`flows/reference/components.md`). Todos los labels del Flow respetan ese tope; la
prueba `tests/unit/whatsapp-flow.test.ts` lo verifica y falla si alguno se pasa.

### Por qué 3 artículos y no una lista ilimitada

Meta no soporta listas dinámicas sin Data Endpoint. Se usan 3 pantallas fijas
(1 obligatoria + 2 opcionales). Una requisición con más de 3 ítems requiere otro
envío; subir el límite es duplicar una pantalla `ARTICULO_*`.

## Cómo se llenan los dropdowns dinámicos (obra y catálogo)

Sin Data Endpoint, el **único** momento en que la pantalla de entrada recibe
datos dinámicos es cuando el negocio **envía** el mensaje interactivo que abre
el Flow. Ese envío incluye `interactive.action.parameters.flow_action_payload.data`,
un objeto JSON que llena el `data` declarado en la pantalla `TIPO_Y_OBRA`
(`flows/guides/sendingaflow.md`):

```json
{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "573000000000",
  "type": "interactive",
  "interactive": {
    "type": "flow",
    "body": { "text": "Solicita materiales o pagos para tu obra directamente desde WhatsApp." },
    "action": {
      "name": "flow",
      "parameters": {
        "flow_message_version": "3",
        "flow_id": "<FLOW-ID>",
        "flow_cta": "Solicitar",
        "flow_action": "navigate",
        "flow_token": "<timestampISO>.<hex>",
        "flow_action_payload": {
          "screen": "TIPO_Y_OBRA",
          "data": {
            "obras": [{ "id": "<uuid-obra>", "title": "Obra La Pradera" }],
            "catalogo": [{ "id": "<uuid-item>", "title": "Cemento gris 50kg" }]
          }
        }
      }
    }
  }
}
```

### El emisor: `lib/infrastructure/flow-sender.ts` + `POST /api/internal/send-flow`

Esto **ya existe en el repo**. `sendRequisitionFlow(to)` arma y envía
exactamente el mensaje de arriba contra el proxy de Kapso
(`POST {KAPSO_META_PROXY_URL}/{KAPSO_PHONE_NUMBER_ID}/messages`, header
`X-API-Key`), y `POST /api/internal/send-flow` lo dispara con el mismo patrón
de candado que `POST /api/internal/dispatch-notifications` (secreto compartido
en el header `x-dispatch-secret`, comparado en tiempo constante; 503 sin
secreto configurado, 401 si no coincide). Usa un secreto propio,
`SEND_FLOW_SECRET`, distinto de `NOTIFICATION_DISPATCH_SECRET`: ese otro
autoriza drenar una cola interna ya validada, este autoriza empujar un mensaje
real a cualquier número que decida el llamador. Body: `{ "to": "57..." }`.
Respuesta: solo `{ ok, messageId }` — nunca teléfonos ni el cuerpo de Kapso.

**Configuración** (`.env.example`):

- `WHATSAPP_FLOW_ID` — id del Flow a enviar (hoy, el borrador real:
  `1972861836748301`).
- `WHATSAPP_FLOW_CTA` — opcional, texto del botón (por defecto `"Solicitar"`).
- `WHATSAPP_FLOW_BODY` — opcional, texto de `interactive.body.text`. **No es
  cosmético**: Meta exige `body.text` en todo mensaje interactivo salvo
  `location_request_message` (`InteractiveMessage` en
  `api/meta/whatsapp/openapi-whatsapp.yaml`, corpus de Kapso) — sin él, Meta
  rechaza el envío real con 400 aunque el ejemplo de más arriba (centrado solo
  en el mecanismo de `flow_action_payload.data`) no lo mostrara.
- `WHATSAPP_FLOW_MODE` — opcional, `"draft"` o `"published"`. La Graph API
  asume `"published"` si se omite (`flows/guides/sendingaflow.md`), y el Flow
  de arriba **hoy es un borrador**: para probarlo de verdad hace falta
  `WHATSAPP_FLOW_MODE=draft` explícito. El día que se publique, quitar la
  variable (o ponerla en `"published"`) sin tocar código.
- `SEND_FLOW_SECRET` — candado del endpoint disparador.
- Reutiliza `KAPSO_API_KEY`, `KAPSO_PHONE_NUMBER_ID`, `KAPSO_META_PROXY_URL` y
  `KAPSO_WEBHOOK_SECRET` (este último para firmar `flow_token`, ver abajo) ya
  documentados arriba.

**Fallo cerrado:** sin `KAPSO_API_KEY`, `WHATSAPP_FLOW_ID`,
`KAPSO_PHONE_NUMBER_ID` o `KAPSO_WEBHOOK_SECRET`, `sendRequisitionFlow` lanza
`FLOW_SEND_NOT_CONFIGURED` **antes** de consultar obras/catálogo — nunca toca
la BD a medias.

**Origen de `obras` y `catalogo`:** `createPostgresFlowCatalogSource` (misma
`sharedPostgres()` que usan los demás adaptadores) consulta obras con
`estado = 'activa'` e items con `estado = 'activo'` — los mismos filtros que ya
usa `GET /api/catalogs`. Orden: obras alfabético por nombre; items por uso más
reciente primero cuando hay señal (`max(requisicion_items.created_at)` por
`item_id`), alfabético para lo nunca usado.

**Tope de opciones — 200:** `flows/reference/components.md` (tabla "Limits and
restrictions" de `Dropdown`) fija el máximo de opciones de un `data-source`
dinámico en **200 si ninguna opción trae imagen, 100 si alguna la trae**.
Ninguna opción de `obras`/`catalogo` lleva imagen, así que el tope aplicado es
`MAX_DROPDOWN_OPTIONS = 200` (constante exportada de `flow-sender.ts`), pasado
explícito a cada consulta — nunca "lo que devuelva la BD". La misma tabla fija
en 30 caracteres el máximo de `title`; nombres más largos se recortan con
elipsis solo para el dropdown (el nombre completo se sigue usando en cualquier
otra pantalla).

### Contrato de `flow_token` (para quien construya el adaptador del webhook)

`flow_token` liga el envío al teléfono destino y a una marca de tiempo, para
que el receptor del webhook pueda validar que una respuesta corresponde a un
Flow que este backend realmente envió:

```
flow_token = "<timestampISO>.<hex>"
hex        = HMAC-SHA256(telefono + "." + timestampISO, KAPSO_WEBHOOK_SECRET)  // hex, 64 caracteres
```

- `telefono` es el número normalizado (solo dígitos, sin `+` ni separadores)
  al que se envió el Flow.
- `timestampISO` es `Date#toISOString()` en el momento del envío (incluye
  milisegundos) — **ese timestamp ya trae un punto propio** (el separador de
  milisegundos), así que partir el token por el *primer* punto es incorrecto.
  Para separarlo de vuelta: `hex` son siempre los últimos 64 caracteres del
  token (sha256 en hex tiene longitud fija); todo lo anterior al último punto
  es `timestampISO`.
- Se firma con `KAPSO_WEBHOOK_SECRET` — el mismo secreto que ya verifica la
  firma del webhook entrante (`verifyKapsoSignature` en
  `lib/infrastructure/kapso.ts`), para no introducir un secreto nuevo solo
  para esto: quien pueda falsificar un `flow_token` ya podría falsificar una
  firma de webhook completa.
- Para validar: recomputar el HMAC con el `telefono` reportado por el webhook
  (o el remitente real del mensaje) y el `timestampISO` extraído del token, y
  comparar en tiempo constante (`safeEqual` en `lib/security/crypto.ts`).
  Rechazar (o degradar a "sin verificar") un `flow_token` cuyo `timestampISO`
  sea demasiado viejo, ya que no lleva expiración propia.

## Mapeo requerido hacia el contrato del webhook (no implementado; NO se tocó `app/api/kapso/route.ts`)

El payload de `complete` de `RESUMEN` es plano (Meta no permite objetos
anidados salvo para `PhotoPicker`/`DocumentPicker`, que además solo pueden ir
como propiedad de primer nivel). Lo que Meta entrega en el webhook de mensajes
es (`flows/guides/receiveflowresponse.md`):

```json
{
  "interactive": {
    "type": "nfm_reply",
    "nfm_reply": {
      "response_json": "{\"flow_token\":\"...\", \"type\":\"compra\", \"workId\":\"...\", ...}"
    }
  }
}
```

Eso **no** calza con `kapsoWebhookSchema`/`KapsoFlowSubmission`
(`lib/services/kapso-contracts.ts`, `app/api/kapso/route.ts`), que esperan un
evento ya envuelto (`eventId`, `type: "flow_submission"`, `receivedAt`,
`submission.items[]`). Alguien —Kapso como proxy normalizador, o un adaptador
propio si Kapso entrega el `nfm_reply` crudo— tiene que traducir antes de
llamar al webhook existente. Documentamos el mapeo exacto en vez de tocar ese
archivo (pertenece a otro agente):

| Campo del Flow (`response_json`) | Campo de `KapsoFlowSubmission` | Nota |
| --- | --- | --- |
| `type` | `type` | Coincide tal cual (`"compra"\|"pago"`). |
| `workId` | `workId` | UUID de la obra elegida en el dropdown dinámico. |
| `requiredDate` | `requiredDate` | Ya viene `YYYY-MM-DD` (DatePicker ≥5.0); coincide con `z.string().date()`. |
| `requesterName` | `requesterName` | Coincide tal cual. |
| `phone` | `phone` | **Decisión pendiente**: el Flow deja editar el teléfono aunque lo precarga con el remitente real de WhatsApp. Recomendado: para el campo de identidad usar el remitente verificado del mensaje (`context.from`/`from` en el webhook de mensajes de Meta) y tratar `phone` del Flow solo como dato de contacto alternativo, no como identidad. |
| `item_N_catalogo` (N=1..3, si no vacío) | `items[i].itemId` | Solo incluir el ítem N en el arreglo si `item_N_catalogo` **o** `item_N_descripcion` no están vacíos; las franjas 2/3 vacías se descartan completas, no se envían como ítem con cantidad 0. |
| `item_N_descripcion` | `items[i].proposedDescription` | Requiere `itemId` o `proposedDescription`, igual que hoy exige `kapsoItemSchema`. |
| `item_N_cantidad` | `items[i].quantity` | **Llega como string** (el `TextInput` de Flow no tiene tipo numérico verdadero). Convertir con `Number(...)` y validar `> 0` antes de pasarlo al schema, que exige un `number`. |
| `item_N_unidad` | `items[i].unit` | Coincide tal cual (id corto, p. ej. `"m3"`, `"bulto"`). |
| `item_N_proveedor` | `items[i].possibleSupplier` | Coincide tal cual; vacío → omitir el campo. |
| `item_N_link` | `items[i].productLink` | Coincide tal cual; ya viene validado con `pattern` como `https://...` en el Flow. |
| `evidencia` | `items[i].attachmentUrl` | **No mapear directo.** Ver siguiente sección. |

### `evidencia` no es una URL HTTPS — no intentar mapearla a `attachmentUrl` todavía

`DocumentPicker`/`PhotoPicker` no entregan una URL pública: entregan un
arreglo de objetos cifrados alojados temporalmente (≈20 días) en el CDN de
WhatsApp, con `media_id`, `cdn_url` y `encryption_metadata` (AES256-CBC +
HMAC-SHA256 + pkcs7). Descargar, descifrar y validar ese archivo es
responsabilidad de quien reciba el `data_exchange`/`complete` — no hay forma
de que llegue ya como una URL HTTPS simple como la que espera
`kapsoItemSchema.attachmentUrl`.

El webhook (`app/api/kapso/route.ts`) ya no rechaza los eventos con
`attachmentUrl`: cuando un ítem la trae, el servidor descarga el binario desde
Kapso (bearer `KAPSO_API_KEY`), valida su firma binaria real (pdf/jpeg/png/webp)
y su tamaño, y lo copia al bucket privado `requisicion-adjuntos` como adjunto
del `requisicion_item` (`lib/infrastructure/kapso-store.ts`,
`createKapsoAttachmentCopier`). Si la descarga o la copia falla, la requisición
se crea igual y el fallo queda registrado en `whatsapp_eventos` y `auditoria`
(evento `ADJUNTO_KAPSO_FALLIDO`) para reintento manual.

Eso resuelve el destino del archivo, no su origen: `attachmentUrl` debe llegar
ya como una URL HTTPS simple descargable con el token de Kapso, y el `evidencia`
crudo del Flow **no lo es** (es el arreglo cifrado descrito arriba). Ese
descifrado del lado Meta/Kapso sigue sin resolverse y es responsabilidad de
quien construya el adaptador Kapso↔Flow:

1. Descargar cada `cdn_url` y descifrarlo (algoritmo arriba) antes de que
   expire.
2. Alojar el archivo descifrado detrás de una URL HTTPS descargable con el
   bearer de Kapso.
3. Solo entonces pasarla como `attachmentUrl` al webhook, que se encarga de la
   copia al bucket propio.

Mientras ese descifrado no exista, **no envíes el campo `evidencia` al
webhook**: la requisición se registra sin el adjunto, nunca se descarta en
silencio.

## Publicar el borrador

Variables requeridas (ya están en `.env.local`, no se imprimen aquí):

- `KAPSO_API_KEY` — header `X-API-Key` contra el proxy de Kapso.
- `KAPSO_WABA_ID` — WABA de Mizar.
- `KAPSO_META_PROXY_URL` — opcional; por defecto
  `https://api.kapso.ai/meta/whatsapp/v24.0`.

```sh
npx tsx scripts/publish-whatsapp-flow.ts
```

El script busca un Flow con el nombre exacto `Requisición de obra – Mizar` en
la WABA:

- Si no existe, lo crea con `POST /{waba}/flows` y `"publish": false`
  (queda en `DRAFT`).
- Si ya existe, sube el JSON actualizado con
  `POST /{flow_id}/assets` (`asset_type: "FLOW_JSON"`), sin tocar su estado.

Al final imprime `{ action, flow_id, validation_errors }`. Si
`validation_errors` no está vacío, el script sale con código distinto de cero
y hay que corregir `requisicion.flow.json` antes de reintentar.

**Estado verificado (2026-08-24, corrida real contra la API):** `flow_id
1972861836748301`, `status DRAFT`, `validation_errors: []`. Preview embebible
(expira 30 días desde la fecha de generación, no requiere login):
`https://business.facebook.com/wa/manage/flows/1972861836748301/preview/?token=9467398b-f2d2-4e39-a8f7-f050a6802c81`.

### Nota técnica: `business_account_id` en endpoints con forma `/{flow_id}/...`

El proxy de Kapso reenvía `GET /{waba}/flows` y `POST /{waba}/flows` sin
problema, pero cualquier endpoint identificado solo por `flow_id` (detalle,
`/assets`, `/publish`, `/deprecate`) es ambiguo si el proyecto de Kapso tiene
más de una configuración de WhatsApp conectada — sin más contexto, el proxy
no sabe a qué cuenta pertenece ese `flow_id` y responde `404 {"error":
"WhatsApp configuration not found"}` aunque el Flow exista. La solución
(confirmada contra `api/meta/whatsapp/openapi-whatsapp.yaml` del corpus de
Kapso y probada en vivo) es agregar `?business_account_id={waba}` a la query
string. El script ya lo hace en la llamada de actualización; cualquier
llamada manual a un endpoint `/{flow_id}/...` necesita el mismo parámetro.

### El script NUNCA publica. Publicar es una decisión humana

Cuando el borrador esté validado y probado en la app real, publicarlo es este
comando explícito (no está en ningún script del repo):

```sh
curl -X POST "https://api.kapso.ai/meta/whatsapp/v24.0/<FLOW_ID>/publish?business_account_id=$KAPSO_WABA_ID" \
  --header "X-API-Key: $KAPSO_API_KEY"
```

**Antes de correrlo:** un Flow publicado no se puede editar ni borrar (solo
"deprecar"). Confirmar que la app real muestra el Flow como se espera (usar el
`preview_url` de arriba, o regenerarlo con `GET
/<FLOW_ID>?fields=preview.invalidate(false)&business_account_id=<WABA>`), que
`WHATSAPP_FLOW_MODE` pasa de `draft` a `published` (o se retira) en el emisor
(`lib/infrastructure/flow-sender.ts`, ya existe — ver arriba), y que el
adaptador del webhook (pendiente, ver "Mapeo requerido..." arriba) ya existe —
publicar el Flow sin el adaptador del webhook deja a un solicitante llenando
un formulario que nadie procesa.
