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

4 pantallas, **sin Data Endpoint** (sin `endpoint_uri`/`data_channel_uri`, sin
cifrado, sin health checks). Toda la navegación es `navigate`/`complete` en el
cliente:

1. **TIPO_Y_OBRA** (pantalla de entrada) — tipo de solicitud (`compra`/`pago`,
   `RadioButtonsGroup`) y obra (`Dropdown`). El listado de obras **no está quemado
   en el JSON**: llega dinámico mediante `data.obras` — ver "Cómo se llenan los
   dropdowns dinámicos" abajo.
2. **ITEMS** — 3 franjas fijas de ítem (`item_1_*`, `item_2_*`, `item_3_*`):
   descripción, cantidad, unidad, proveedor posible y link de producto. **Solo el
   ítem 1 es obligatorio**; los ítems 2 y 3 son opcionales. Cada franja también
   ofrece un `Dropdown` opcional contra el catálogo (`data.catalogo`, mismo
   mecanismo dinámico que `obras`) para elegir en vez de describir.
3. **DATOS_SOLICITANTE** — nombre, teléfono (precargado con el remitente de
   WhatsApp vía `init-value`, editable), fecha requerida (`DatePicker`, formato
   `YYYY-MM-DD` nativo desde Flow JSON 5.0+), destino/frente y observaciones
   opcionales, y un `DocumentPicker` opcional para evidencia.
4. **RESUMEN** (terminal, `success: true`) — resumen de lectura y botón
   "Enviar solicitud" que dispara `complete` con el payload plano descrito abajo.

Versión de Flow JSON: `7.3` (recomendada tanto para publicar como para enviar,
según `changelogs.md` del corpus de Meta).

### Por qué 3 ítems fijos y no una pantalla repetible

Meta no soporta listas dinámicas de longitud ilimitada dentro de un Flow sin
Data Endpoint. La documentación (`flows/guides/flowjson.md`) recomienda dos
patrones: **N franjas fijas** o **pantalla que se repite navegando hacia sí
misma**. Se eligió N=3 franjas fijas porque:

- Evita lógica de visibilidad condicional (`visible` con expresiones), que es
  una fuente común de errores de validación de Meta y añade riesgo a un
  borrador que todavía no se ha probado con la app real.
- Cubre el caso típico de una requisición de obra sin obligar a más de un envío.

**Limitación conocida:** una requisición con más de 3 ítems no cabe en un solo
envío del Flow. Hoy no hay lógica de "enviar y continuar"; el solicitante debe
usar el portal público (`components/screens/public-request.tsx` → futuro,
soporta 1 ítem) o enviar el Flow más de una vez. Si RF-902 necesita más
franjas, subir el límite es un cambio mecánico en `requisicion.flow.json`
(duplicar el bloque `item_N_*`) — no requiere Data Endpoint.

### Por qué `DocumentPicker` y no `PhotoPicker`

Meta prohíbe combinar `PhotoPicker` y `DocumentPicker` en la misma pantalla, y
solo permite una instancia de cualquiera de los dos por pantalla
(`flows/guides/media_upload.md`). Se eligió `DocumentPicker` con
`allowed-mime-types: ["application/pdf", "image/jpeg", "image/png"]` porque
cubre "foto **o** documento de soporte" (foto desde galería + PDF) en un solo
componente. La contrapartida: no permite tomar una foto con la cámara en el
momento (eso solo lo da `PhotoPicker`). Si la captura en vivo se vuelve un
requisito, cambiar a `PhotoPicker` es un cambio de un componente, pero entonces
se pierde la opción de adjuntar PDF en esa misma pantalla.

## Cómo se llenan los dropdowns dinámicos (obra y catálogo)

Sin Data Endpoint, el **único** momento en que la pantalla de entrada recibe
datos dinámicos es cuando el negocio **envía** el mensaje interactivo que abre
el Flow. Ese envío incluye `interactive.action.parameters.flow_action_payload.data`,
un objeto JSON que llena el `data` declarado en la pantalla `TIPO_Y_OBRA`
(`flows/guides/sendingaflow.md`):

```json
{
  "type": "interactive",
  "interactive": {
    "type": "flow",
    "action": {
      "name": "flow",
      "parameters": {
        "flow_message_version": "3",
        "flow_id": "<FLOW-ID>",
        "flow_cta": "Solicitar",
        "flow_action": "navigate",
        "flow_action_payload": {
          "screen": "TIPO_Y_OBRA",
          "data": {
            "obras": [{ "id": "<uuid-obra>", "title": "Obra La Pradera" }],
            "catalogo": [{ "id": "<uuid-item>", "title": "Cemento gris 50kg" }],
            "telefono_remitente": "573000000000"
          }
        }
      }
    }
  }
}
```

**Esto todavía no existe en el repo.** Ninguna ruta ni servicio arma y envía
este mensaje hoy — es la pieza que falta para que alguien reciba el Flow por
WhatsApp. Para completar RF-902 hace falta un pequeño emisor (análogo a
`sendKapsoTemplate` en `lib/infrastructure/kapso.ts`, pero para
`interactive.type=flow`) que lea las obras activas y el catálogo desde
Supabase y arme `flow_action_payload.data` antes de llamar al proxy de envío
de Kapso. Ese emisor no toca los archivos protegidos de este ticket y puede
construirse como un servicio nuevo en `lib/services/`.

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

Hoy el webhook (`app/api/kapso/route.ts`) ya rechaza con `503
attachment_storage_not_configured` cualquier evento con `attachmentUrl`,
precisamente porque el storage privado todavía no existe (ver
`docs/manuales/whatsapp-kapso.md`, punto 4). Mientras ese gate siga cerrado:
**no envíes el campo `evidencia` al webhook existente.** Si Kapso llega a
entregar el `evidencia` crudo, quien construya el adaptador debe:

1. Descargar cada `cdn_url` y descifrarlo (algoritmo arriba) antes de que
   expire.
2. Copiarlo al bucket privado de Supabase con control por rol.
3. Solo entonces producir una URL HTTPS propia y pasarla como `attachmentUrl`.

Hasta que eso exista, una requisición enviada por WhatsApp con adjunto debe
tratarse igual que hoy: se registra sin el adjunto, o se rechaza explícitamente,
nunca se descarta en silencio.

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
/<FLOW_ID>?fields=preview.invalidate(false)&business_account_id=<WABA>`) y que
el emisor de mensajes (pendiente, ver arriba) y el adaptador del webhook
(pendiente, ver arriba) ya existen — publicar el Flow sin ellos deja a un
solicitante llenando un formulario que nadie procesa.
