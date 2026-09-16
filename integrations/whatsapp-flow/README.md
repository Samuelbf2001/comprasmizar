# WhatsApp Flow — Requisición de obra (RF-902)

Definición versionada del formulario de requisición dentro del chat de WhatsApp
(`requisicion.flow.json`), y el script que la sube a Meta como **BORRADOR** vía el
proxy de Kapso. Antes de este cambio solo existía el receptor del webhook
(`app/api/kapso/route.ts`); el Flow en sí no existía en ningún lado.

> **Hay tres Flows en este directorio.** Este documento describe primero el de
> **captura** (`requisicion.flow.json`, RF-902), que es el que existía. El de
> **aprobación** (`aprobacion.flow.json`) es posterior y tiene su propia sección
> al final: [WhatsApp Flow — Aprobación de requisición](#whatsapp-flow--aprobación-de-requisición).
> El de **solicitud de pago** (`solicitud-pago.flow.json`, RF-908) es el tercero:
> [WhatsApp Flow — Solicitud de pago](#whatsapp-flow--solicitud-de-pago).

## Archivos

- `requisicion.flow.json` — Flow de captura **v1**, publicado (`1972861836748301`). Se conserva
  mientras el v2 no esté en producción; no se le hacen cambios (Meta no deja editar un Flow
  publicado).
- `requisicion-captura.flow.json` — Flow de captura **v2**, el vigente a partir de ahora.
  **GENERADO: no se edita a mano.** Su fuente es `../../scripts/build-flow-captura.ts`; una prueba
  compara byte a byte que no se separen.
- `aprobacion.flow.json` — fuente de verdad del Flow de aprobación (misma regla).
- `solicitud-pago.flow.json` — Flow de **solicitud de pago** (RF-908). **GENERADO: no se edita a
  mano.** Su fuente es `../../scripts/build-flow-pago.ts`; `tests/integration/kapso-pago.test.ts`
  compara byte a byte que no se separen.
- `../../scripts/publish-whatsapp-flow.ts` — crea el Flow (si no existe, por nombre)
  o actualiza su Flow JSON (si ya existe). Siempre dentro del estado `DRAFT`.
  Recibe cuál: `requisicion` (captura, por defecto), `aprobacion` o `pago`.
- `../../scripts/build-flow-captura.ts` — genera `requisicion-captura.flow.json`. Se ejecuta con
  `npx tsx scripts/build-flow-captura.ts`; con `--check` no escribe y falla si el JSON commiteado
  difiere.
- `../../scripts/build-flow-pago.ts` — genera `solicitud-pago.flow.json`, mismo uso y mismo `--check`.
- `../../tests/unit/whatsapp-flow.test.ts` y `../../tests/unit/approval-flow.test.ts` —
  validan la estructura local de cada JSON (pantallas, requeridos, terminal/complete)
  sin llamar a ninguna API.

## Diseño del Flow

6 pantallas, **sin Data Endpoint** (sin `endpoint_uri`/`data_channel_uri`, sin
cifrado, sin health checks). Toda la navegación es `navigate`/`complete` en el
cliente. **Un artículo por pantalla** para que cada ítem se distinga con claridad
del anterior (feedback de la prueba real):

1. **TIPO_Y_EMPRESA** (entrada) — **empresa** (`Dropdown`,
   reunión 2026-08-31: el solicitante elige empresa, no obra — la obra/centro de
   costo la asigna el revisor en la oficina). El listado de sociedades **no
   está quemado**: llega dinámico por `data.sociedades`. Desde el v4 (adenda de
   pagos, A11) **ya no se elige tipo**: la opción `tipo_solicitud=pago` existía y no
   funcionaba (el payload no traía beneficiario ni valor); la solicitud de pago tiene
   [Flow propio](#whatsapp-flow--solicitud-de-pago) y el `complete` manda `type: "compra"` fijo.
2. **ARTICULO_UNO** — artículo obligatorio: catálogo (opcional), descripción,
   cantidad, unidad, posible proveedor y link. Es el único obligatorio.
3. **ARTICULO_DOS** — segundo artículo, todo opcional (se omite con Continuar).
4. **ARTICULO_TRES** — tercer artículo, todo opcional.
5. **DETALLES** — fecha requerida (`DatePicker`, **opcional** desde la reunión
   2026-08-31, en los tres canales), observaciones (ya sin el campo "destino"
   separado: su sentido se fusiona aquí — la ayuda del campo pide decir a dónde
   va la compra), y un **`PhotoPicker` con `photo-source: camera_gallery`**: el solicitante puede
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

### Por qué 8 artículos y no una lista ilimitada

Meta no soporta listas dinámicas sin Data Endpoint, así que las pantallas son fijas. El v1 tenía 3
(1 obligatoria + 2 opcionales) y se quedó corto en cuanto Ernesto lo probó de verdad: *«me preocupa
querer agregar más y no poder»*. El **v2 tiene 8**, pero solo se visitan bajo demanda — cada
pantalla de artículo lleva **Continuar** (salta al resumen) y, debajo, **Agregar otro artículo**
(va a la siguiente). A partir del segundo los campos son opcionales, porque exigirlos impediría usar
"Continuar" para saltar.

Subir el tope es cambiar `MAX_ITEMS` en `scripts/build-flow-captura.ts` y regenerar; el adaptador
(`MAX_ITEM_SLOTS` en `lib/infrastructure/nfm-reply-adapter.ts`) tiene que subir con él.

### Seis reglas del validador de Meta que no están en su documentación

Todas se aprendieron a base de que la API las rechazara o —peor, las dos últimas— de que NO las
rechazara y el fallo apareciera en el teléfono. Conviene tenerlas a mano antes de tocar un Flow JSON:

**1. Los `id` de pantalla solo admiten letras y guion bajo.** `ARTICULO_1` se rechaza con
*«Property 'id' should only consist of alphabets and underscores»*. Por eso las pantallas se llaman
`ARTICULO_UNO`, `ARTICULO_DOS`… y no `ARTICULO_1`. Las **claves de datos** (`item_1_cantidad`) sí
admiten dígitos; la restricción es solo para el id de la pantalla.

**2. El `payload` de un `navigate` debe traer TODAS las claves que declara el `data` de la pantalla
destino**, no solo las que existan en ese momento:

> Following fields are expected in the next screen's data model but missing in payload:
> [item_8_catalogo, item_8_descripcion, …]

Como `DETALLES` declara los ocho artículos, quien salte al resumen desde el tercero tiene que mandar
del cuarto al octavo **en blanco**. De ahí `itemsEnBlanco()` en el generador.

**3. `visible` exige un booleano ya resuelto y rechaza comparaciones.** Para ocultar una línea según
su contenido, lo intuitivo es `"visible": "${data.item_2_descripcion} != ''"`, y Meta lo rechaza:

> Error while parsing dynamic expression `"${data.item_2_descripcion} != ''"`.
> The expression return type is 'string' which does not match the schema for the property.

Lo que sirve es el componente **`If`**, cuyo `condition` sí admite la comparación:

```json
{ "type": "If", "condition": "${data.item_2_descripcion} != ''", "then": [ { "type": "TextBody", "text": "…" } ] }
```

Así se condicionan en el resumen las líneas de los artículos 2 a 8 (la del 1 no: es obligatorio).
La alternativa era encadenar un booleano `item_N_presente` desde cada pantalla, y se descartó por un
motivo de fondo, no de comodidad: ese booleano solo podría decir *"se visitó la pantalla N"*, no
*"se llenó el artículo N"*, así que quien abriera una pantalla y la dejara en blanco habría seguido
viendo un renglón vacío.

**4. Un `${data.x}` dentro de una cadena normal se muestra LITERAL, y el validador no lo detecta.**
Esta es la más cara de todas, porque no falla: pasa la validación y sale mal en el teléfono.

```json
{ "type": "TextBody", "text": "Empresa: ${data.empresa}" }   ← pinta “Empresa: ${data.empresa}”
{ "type": "TextBody", "text": "${data.empresa}" }            ← pinta el valor
```

Para el validador eso es texto, así que `validation_errors: []` no dice nada al respecto. Es la razón
de fondo por la que el v1 y el v2 mostraban las llaves **incluso después** de declarar `data` y
encadenar el `payload`: el arreglo de la fontanería era necesario pero no suficiente.

**5. La concatenación con acentos graves existe (≥ 6.3) pero no admite signos dentro.**
`` `Fecha requerida: ${data.x}` `` se rechaza con `Unexpected ":" at character 15`; los paréntesis,
igual. Solo sirve para unir bindings separados por espacios, como el ejemplo oficial
`` `${data.a} ${data.b}` ``.

De ahí la forma del RESUMEN: un `TextCaption` estático con el rótulo y un `TextBody` con el binding
puro debajo. Por artículo, `TextCaption "Artículo k"` + `TextBody "${data.item_k_descripcion}"` +
`TextCaption` con `` `${data.item_k_cantidad} ${data.item_k_unidad}` ``.

**6. El valor de un `PhotoPicker` NO puede viajar en el `payload` de un `navigate`.**

> The value of PhotoPicker component is not allowed in the payload of navigate action.

Es decir: **una foto no se puede encadenar de pantalla en pantalla.** La única forma de que llegue al
envío es leerla donde se tomó, con `${screen.ARTICULO_X.form.foto}` en el `complete` — que sí lo
admite, porque no es un `navigate`.

Por eso la foto es la ÚNICA excepción a la regla de encadenar todo (ver la sección siguiente), y está
fijada como tal en `tests/unit/flow-captura-v2.test.ts`: todo lo demás mira hacia adelante, solo la
foto mira hacia atrás. El v2 la perdió precisamente por no saber esto — al quitar las referencias
entre pantallas para arreglar el resumen, se llevó por delante la única vía que tenía la foto,
mientras las ocho pantallas seguían ofreciendo el `PhotoPicker`.

### Y una regla de binding que el v1 incumplía sin que nadie lo notara

`${screen.OTRA_PANTALLA.form.campo}` sirve en el `payload` de una acción, pero **NO** dentro de una
propiedad de texto de un componente. Ahí solo se resuelven `${data.x}` —lo que la pantalla declara
recibir— y `${form.x}` —lo de la propia pantalla—.

El v1 pintaba el resumen con la sintaxis entre pantallas, así que **mostraba las llaves literales en
vez de los datos**. Y no habría funcionado de ninguna forma, porque ninguna pantalla del v1
declaraba `data` ni pasaba nada: sus seis `navigate` llevaban `payload: {}`. El v2 declara y
encadena en las once pantallas.

Corolario que conviene revisar si algo se ve vacío: el v1 también leía el catálogo como
`${screen.TIPO_Y_EMPRESA.data.catalogo}` desde cada pantalla de artículo — misma sintaxis entre
pantallas. En el v2 el catálogo se arrastra en el payload.

## Cómo se llenan los dropdowns dinámicos (empresa y catálogo)

Sin Data Endpoint, el **único** momento en que la pantalla de entrada recibe
datos dinámicos es cuando el negocio **envía** el mensaje interactivo que abre
el Flow. Ese envío incluye `interactive.action.parameters.flow_action_payload.data`,
un objeto JSON que llena el `data` declarado en la pantalla `TIPO_Y_EMPRESA`
(`flows/guides/sendingaflow.md`):

```json
{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "573000000000",
  "type": "interactive",
  "interactive": {
    "type": "flow",
    "body": { "text": "Solicita materiales para tu obra directamente desde WhatsApp." },
    "action": {
      "name": "flow",
      "parameters": {
        "flow_message_version": "3",
        "flow_id": "<FLOW-ID>",
        "flow_cta": "Solicitar",
        "flow_action": "navigate",
        "flow_token": "<timestampISO>.<hex>",
        "flow_action_payload": {
          "screen": "TIPO_Y_EMPRESA",
          "data": {
            "sociedades": [{ "id": "<uuid-sociedad>", "title": "Constructora Mizar S.A.S." }],
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
`FLOW_SEND_NOT_CONFIGURED` **antes** de consultar sociedades/catálogo — nunca toca
la BD a medias.

**Origen de `sociedades` y `catalogo`:** `createPostgresFlowCatalogSource` (misma
`sharedPostgres()` que usan los demás adaptadores) consulta sociedades con
`activa = true` e items con `estado = 'activo'` — los mismos filtros que ya
usa `GET /api/catalogs`. Orden: sociedades alfabético por nombre; items por uso más
reciente primero cuando hay señal (`max(requisicion_items.created_at)` por
`item_id`), alfabético para lo nunca usado.

**Tope de opciones — 200:** `flows/reference/components.md` (tabla "Limits and
restrictions" de `Dropdown`) fija el máximo de opciones de un `data-source`
dinámico en **200 si ninguna opción trae imagen, 100 si alguna la trae**.
Ninguna opción de `sociedades`/`catalogo` lleva imagen, así que el tope aplicado es
`MAX_DROPDOWN_OPTIONS = 200` (constante exportada de `flow-sender.ts`), pasado
explícito a cada consulta — nunca "lo que devuelva la BD". La misma tabla fija
en 30 caracteres el máximo de `title`; nombres más largos se recortan con
elipsis solo para el dropdown (el nombre completo se sigue usando en cualquier
otra pantalla).

### El resumen mostraba el uuid de la empresa, no su nombre (Juliana, 2026-09-11)

La pantalla RESUMEN de este Flow (v3, **PUBLICADO** en Meta como
`875992355468043`) pinta `${data.empresa}` — el VALOR de la opción elegida en
el Dropdown de sociedades, no su `title` visible (ver "Un `${data.x}` dentro
de una cadena normal se muestra LITERAL", arriba). Mientras `id` fue el uuid
de `sociedades.id`, el resumen mostraba el uuid en vez de "Mizar".

Como el Flow ya está **publicado**, su JSON no se puede tocar (Meta no deja
editar un Flow publicado), y mapear id→nombre dentro del propio Flow exigiría
encadenar un `If` por sociedad en el RESUMEN — inviable con un catálogo
dinámico, cuyas filas cambian sin republicar nada. La solución, sin tocar el
Flow: que el VALOR ya sea el nombre. `buildSocietyOptions` (`flow-sender.ts`)
arma las opciones del dropdown de sociedades con `id = title = nombre`
(recortado al mismo tope de 30 caracteres de `title`); si dos sociedades
ACTIVAS compartieran nombre (hoy imposible, `sociedades.nombre` tiene una
restricción `UNIQUE`), se desambiguan como `"Nombre (NIT)"` en ambos campos.

`nfm-reply-adapter.ts` acepta las dos formas de `societyId` en la respuesta:
un uuid crudo (Flows ya en curso, emitidos antes de este cambio) o el nombre
de la sociedad, que `createPostgresSocietyResolver` resuelve de vuelta al
uuid real contra el catálogo de sociedades activas (por nombre exacto, y
también por su forma desambiguada `"Nombre (NIT)"`). Un nombre que no resuelve
rechaza el evento como `invalid_fields`, igual que un uuid mal formado antes
de este cambio — nunca se crea una requisición con una empresa a medias.

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

## Mapeo hacia el contrato del webhook (implementado en `lib/infrastructure/nfm-reply-adapter.ts` — Fase 6, reunión 2026-08-31)

**Nota de esta fase:** el mapeo de abajo describe el diseño original, ya
**implementado** (`adaptNfmReply`, `app/api/kapso/route.ts`) — la sección se
conserva por su valor de referencia, con los campos actualizados a los
vigentes tras la reunión 2026-08-31 (empresa en vez de obra; sin "destino";
fecha requerida opcional). El manejo real de `item_N_foto` (evidencia por
ítem, media id + descarga vía el proxy de Kapso) vive en
`resolveKapsoMediaDownloadUrl`/`firstEvidenceMediaId` (`nfm-reply-adapter.ts`)
y difiere del esquema `evidencia`/`cdn_url` cifrado que describe la sección
siguiente (ese es el camino de un **Data Endpoint**, que este Flow no tiene).

El payload de `complete` de `RESUMEN` es plano (Meta no permite objetos
anidados salvo para `PhotoPicker`/`DocumentPicker`, que además solo pueden ir
como propiedad de primer nivel). Lo que Meta entrega en el webhook de mensajes
es (`flows/guides/receiveflowresponse.md`):

```json
{
  "interactive": {
    "type": "nfm_reply",
    "nfm_reply": {
      "response_json": "{\"flow_token\":\"...\", \"type\":\"compra\", \"societyId\":\"...\", ...}"
    }
  }
}
```

Eso **no** calza directo con `kapsoWebhookSchema`/`KapsoFlowSubmission`
(`lib/services/kapso-contracts.ts`, `app/api/kapso/route.ts`), que esperan un
evento ya envuelto (`eventId`, `type: "flow_submission"`, `receivedAt`,
`submission.items[]`) — `adaptNfmReply` (`lib/infrastructure/nfm-reply-adapter.ts`)
es ese traductor, ya implementado. Tabla de referencia (actualizada a los
campos vigentes tras la reunión 2026-08-31):

| Campo del Flow (`response_json`) | Campo de `KapsoFlowSubmission` | Nota |
| --- | --- | --- |
| `type` | `type` | Siempre `"compra"`. Un `"pago"` (Flow v3 publicado, aún en producción) se rechaza como `invalid_fields`: la solicitud de pago tiene Flow y adaptador propios (`payment-reply-adapter.ts`). |
| `societyId` | `societyId` | Empresa elegida en el dropdown dinámico — el solicitante elige empresa, no obra (la asigna el revisor). Llega como el NOMBRE de la sociedad (o uuid, en Flows enviados antes de este cambio — ver subsección "El resumen mostraba el uuid" más abajo); `adaptNfmReply` lo resuelve al uuid real antes de construir `KapsoFlowSubmission`. Obligatorio y exigido por `ProcurementService.create` para el canal whatsapp. `workId` se conserva como campo OPCIONAL de compatibilidad (ver comentario en `extractTopLevelFields`, `nfm-reply-adapter.ts`); el Flow vigente ya no lo manda. |
| `requiredDate` | `requiredDate` | **Opcional** (reunión 2026-08-31): si viene, ya llega `YYYY-MM-DD` (DatePicker ≥5.0) y se valida el formato; si no viene, se omite en vez de rechazar el evento. |
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
npx tsx scripts/publish-whatsapp-flow.ts                  # captura — el vigente (v2)
npx tsx scripts/publish-whatsapp-flow.ts aprobacion       # Flow de aprobación
```

`requisicion` apunta al **v4** («Requisición de obra – Mizar v4», sin id todavía: se crea la
primera vez que se corra el comando). El v3 (`875992355468043`, publicado) sigue en producción
hasta que `WHATSAPP_FLOW_ID` apunte al v4; Meta no deja editar un Flow publicado, por eso cada
corrección es un Flow nuevo. El v1 (`1972861836748301`) queda como `requisicion_v1_deprecado`: la
entrada existe solo para que nadie suba `requisicion.flow.json` creyendo que es la fuente vigente.
No se actualiza ni se republica.

El script imprime `validation_errors`. **Que la lista salga vacía significa que Meta acepta la
estructura, no que el Flow se vea bien**: las dos cosas que fallan en silencio —un binding que pinta
la llave literal, un dropdown vacío— pasan la validación sin una queja. Antes de publicar hay que
recorrer la vista previa a ojo:

```sh
# devuelve preview.preview_url, válida 30 días
GET /{flow_id}?fields=preview.invalidate(false),status,validation_errors&business_account_id={waba}
```

Aviso para quien lo automatice: esa vista previa **no se deja recorrer desde un navegador
automatizado** — el botón "Continuar" no avanza de pantalla. Verificado por dos sesiones distintas
el 2026-09-11. La revisión final es humana, en un navegador normal.

El script busca un Flow por su nombre exacto en la WABA (`Requisición de obra – Mizar`
para el de captura, `Aprobación de requisición – Mizar` para el de aprobación):

- Si no existe, lo crea con `POST /{waba}/flows` y `"publish": false`
  (queda en `DRAFT`).
- Si ya existe, sube el JSON actualizado con
  `POST /{flow_id}/assets` (`asset_type: "FLOW_JSON"`), sin tocar su estado.

Al final imprime `{ flow, action, flow_id, validation_errors }`. Si
`validation_errors` no está vacío, el script sale con código distinto de cero
y hay que corregir el `.flow.json` correspondiente antes de reintentar.

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

---

# WhatsApp Flow — Aprobación de requisición

El otro extremo del ciclo: cuando el revisor manda una requisición a aprobación, el
**aprobador asignado** recibe en WhatsApp los ítems ya cotizados, desmarca lo que no
aprueba y decide, sin entrar a la plataforma.

No corresponde a ningún RF del PRD (que llega hasta RF-1206 y no contempla este canal).
Es una extensión del canal WhatsApp a las operaciones que la reunión del 2026-08-31 ya
definió y el dominio ya implementa —`decideItems` + `approve`/`returnForCorrection`—, no
un concepto de negocio nuevo. **No introduce ninguna capacidad que la app web no tenga.**

## Diseño

2 pantallas, **sin Data Endpoint** (igual que el Flow de captura: sin `endpoint_uri`, sin
cifrado, sin health checks). Los ítems reales viajan como datos dinámicos del mensaje que
abre el Flow, en `flow_action_payload.data`, exactamente el mismo mecanismo con el que el
Flow de captura llena sus dropdowns.

1. **REVISION** (entrada) — cabecera (`REQ-…· obra`), resumen (solicitante, fecha
   requerida, total vigente) y un **`CheckboxGroup`** con un ítem por línea, **todos
   marcados de entrada**. El aprobador solo desmarca lo que no aprueba: el camino
   frecuente ("apruebo todo") queda en dos toques.
2. **DECISION** (terminal, `success: true`) — `RadioButtonsGroup` obligatorio
   (`Aprobar` / `Devolver al revisor`) y un `TextArea` de motivo opcional. Dispara
   `complete` con `{kind, requisitionId, aprobados, accion, motivo}`.

Solo se muestran las líneas **no declinadas**: lo que el revisor ya descartó no reaparece.

### Límites de la pantalla (verificados en la documentación de Meta, 2026-09-10)

Tabla de límites de `CheckboxGroup` en `whatsapp/flows/reference/components`:

| Propiedad | Límite de Meta | Lo que usamos |
|---|---|---|
| Máx. opciones | **20** | `MAX_APPROVAL_ITEMS = 20` (el tope real, no una precaución) |
| `title` de la opción | 30 | 30 |
| `description` de la opción | 300 | 80, por legibilidad en teléfono |
| `label` del componente | 30 | 15 (`Ítems a aprobar`) |

Ojo con el label: **30** es el tope de `CheckboxGroup`/`RadioButtonsGroup`; los 20 caracteres
que documenta la sección del Flow de captura aplican a `TextInput`/`TextArea`/`Dropdown`.

Las 20 opciones son un techo de Meta, así que una requisición con más ítems vigentes **no se
puede aprobar por WhatsApp** por más que se quiera: el despachador cae al aviso de plantilla
y esa persona entra por la web. Otros límites relevantes del Flow JSON: el archivo no puede
pasar de **10 MB** y el modelo de rutas admite hasta **10 ramas** (`reference/flowjson`);
este Flow usa 2 pantallas y una sola rama, así que sobra margen.

## Contrato de `flow_token` — distinto al del Flow de captura

```
flow_token = "<timestampISO>.<hex>"
hex        = HMAC-SHA256(telefono + "." + timestampISO + "." + requisicionId, KAPSO_WEBHOOK_SECRET)
```

El `requisicionId` entra en la firma porque este token no autoriza "responder un
formulario" sino **decidir sobre esa requisición concreta**: sin él, un token legítimo
emitido para la requisición A serviría para aprobar la B cambiando un campo del payload.
Como efecto colateral buscado, los dos contratos son mutuamente excluyentes — un token de
captura nunca valida como token de aprobación ni al revés. Caduca a los **7 días** (el de
captura, a las 24 h): una aprobación es una tarea humana con plazo laboral.

## Identidad y por qué esto no contradice RF-1205

RF-1205 (verificado en `PRD.md`) excluye aprobar/denegar **del MCP**: "la aprobación es el
acto de control interno de Mizar y debe ocurrir en la interfaz con la persona autenticada,
no delegable a un agente". Está implementado como `mcpForbidden` en `lib/domain/rules.ts`,
que deniega esos permisos cuando `origin === "mcp"`.

Este canal entra con `origin: "kapso"`, que `authOrigin()` trata como `"web"`. No es un
rodeo: lo que RF-1205 prohíbe es que **un agente** decida, no que la persona decida desde
otra pantalla. La identidad se sostiene en cuatro capas independientes, todas verificadas
antes de llamar al servicio:

1. La firma del webhook (`verifyKapsoSignature`), que ya protege todo el canal.
2. El remitente verificado por Meta (`message.from`): no lo declara el payload.
3. El `flow_token` HMAC atado a ese número **y** a esa requisición, emitido únicamente al
   teléfono del aprobador asignado.
4. `requisition.approverId === actor.id`, que sigue comprobándose dentro de
   `decideItems`/`approve`/`returnForCorrection`.

Ninguna se debilita para que este canal funcione.

**Sobre `usuarios.telefono`:** el teléfono remitente se resuelve contra esa columna, que es
dato de contacto (nullable, sin índice único) y por sí sola no sería una credencial
aceptable. Aquí no lo es: la autorización la dan el token y el chequeo del dominio; la
consulta solo le pone **nombre** al actor. Por eso exige unicidad — si dos usuarios activos
con rol de aprobación comparten teléfono, la resolución es ambigua y se **rechaza** en vez
de elegir uno. Se decidió no crear una tabla nueva de "teléfonos que pueden aprobar"
justamente porque no es ahí donde vive la autorización.

## Piezas

| Pieza | Archivo |
|---|---|
| Flow JSON | `aprobacion.flow.json` |
| Emisor + token + contexto desde la BD | `../../lib/infrastructure/approval-flow-sender.ts` |
| Adaptador de la respuesta (valida y traduce) | `../../lib/infrastructure/approval-reply-adapter.ts` |
| Plan y aplicación de la decisión | `../../lib/infrastructure/approval-processor.ts` |
| Entrada del webhook | `../../app/api/kapso/route.ts` |
| Reenvío manual | `POST /api/internal/send-approval-flow` |
| Pruebas | `../../tests/unit/approval-flow.test.ts` |

## La ventana de 24 h manda sobre todo esto (verificado en vivo, 2026-09-10)

Un Flow es un mensaje **interactivo**, no una plantilla, y WhatsApp solo admite mensajes
interactivos dentro de la ventana de servicio de 24 h que abre la propia persona al
escribirle al negocio. Fuera de esa ventana el proxy responde:

```
422 {"error":"Cannot send non-template messages outside the 24-hour window.",
     "next_steps":"Send a WhatsApp template message to reopen the session."}
```

**Esto no es un caso raro: es el caso normal.** Un aprobador rara vez le ha escrito al
número de Mizar el mismo día en que le toca aprobar algo.

### La solución: el Flow dentro de una plantilla

Una plantilla **sí** atraviesa la ventana (es para lo que existe), y **puede llevar el Flow
adentro** como botón de tipo `FLOW`. Los datos dinámicos viajan igual, solo cambia el
nombre del campo: `flow_action_data` en vez de `flow_action_payload.data` — por eso este
Flow sigue sin necesitar Data Endpoint por ninguno de los dos caminos.

Plantilla registrada: **`aprobacion_requisicion`** (id `1974324693523971`, categoría
`UTILITY`, idioma `es`), definida y reproducible en
[`scripts/publish-approval-template.ts`](../../scripts/publish-approval-template.ts):

> Hola {{1}}. La requisicion {{2}} de la obra {{3}} esta esperando tu aprobacion.
> Total: {{4}}. Abre el boton para revisar los items y decidir.
> `[Revisar y aprobar]` → abre el Flow en la pantalla `REVISION`

**Meta exige que el Flow esté PUBLICADO** para aceptar el botón: con el Flow en borrador la
creación de la plantilla falla con "Debe publicarse el flujo asociado con el botón"
(`error_subcode 2388142`). Por eso el Flow se publicó (ver estado más abajo).

### El orden de intentos, y por qué ese orden

El despachador prueba en este orden, que es una decisión de **costo**:

1. **Mensaje interactivo** — gratis mientras la sesión de 24 h esté abierta.
2. **Plantilla con botón de Flow** (`APPROVAL_FLOW_SESSION_CLOSED`) — atraviesa la ventana,
   pero abre una conversación de utilidad **facturable**.
3. **Aviso de texto** — solo si el Flow no cabe de ninguna forma (requisición ya no está en
   aprobación, más de 20 ítems, canal sin configurar). La persona entra por la web.

Invertir 1 y 2 pagaría una conversación en cada aviso, incluso con el chat abierto. El
costo por conversación es justamente la decisión P6 abierta del PRD ("costos WhatsApp"):
esto la vuelve concreta — se paga una conversación de utilidad por cada requisición que
llegue a aprobación con la sesión cerrada.

## Cómo se dispara

`sendForApproval` ya encolaba una notificación `pendiente_aprobador` al aprobador por
WhatsApp. **No se creó ninguna cola ni cron nuevo:** el despachador
(`POST /api/internal/dispatch-notifications`) ahora entrega esa notificación como el Flow
en vez de como plantilla de texto, reutilizando su lease, reintentos y auditoría.

El canal se activa solo con configurar `WHATSAPP_APPROVAL_FLOW_ID`. Sin esa variable, el
despachador ni siquiera intenta el Flow y todo se comporta exactamente como antes. Si el
Flow no se puede armar para una requisición concreta (demasiados ítems, ya no está en
aprobación, aprobador sin teléfono), cae a la plantilla: la persona siempre se entera.

`POST /api/internal/send-approval-flow` (secreto `SEND_FLOW_SECRET` en `x-dispatch-secret`,
body `{"requisitionId": "…"}`) reenvía a mano, para el caso real de "se le perdió el
mensaje" o "cargaron su teléfono después". **No acepta un número destino**: el
destinatario sale siempre de `aprobador_id` en la BD, así que un llamador interno
comprometido no puede desviar una aprobación a un tercero.

## Qué hace cada respuesta

| Respuesta del aprobador | Efecto |
|---|---|
| Aprobar, todo marcado | `decideItems` marca cada línea `aprobado` + `approve` |
| Aprobar, algo desmarcado | lo desmarcado queda `declinado` con el motivo escrito (o uno por defecto que dice que se desmarcó en WhatsApp sin motivo) + `approve` |
| Aprobar, todo desmarcado | **rechazado**: el dominio no tiene "declinar la requisición" desde `en_aprobacion`; debe usar Devolver |
| Devolver sin motivo | **rechazado**: `assertTransition` exige comentario para `devuelta` |
| Devolver con motivo | `returnForCorrection` |
| La requisición ya no está `en_aprobacion` | **ignorado** (reintento del webhook o respuesta tardía), no es un error |

Los rechazos se registran en `whatsapp_eventos` como entrada inválida, igual que los del
Flow de captura, y nunca devuelven 5xx.

## Pendiente antes de que este canal funcione en real

1. ~~Crear el Flow en Meta~~ **HECHO (2026-09-10)**: `flow_id 2249539985776722`,
   `validation_errors: []`. Meta aceptó el JSON sin objeciones, lo que confirma que
   `CheckboxGroup` con `data-source`/`init-value` dinámicos y un arreglo en el payload del
   `complete` son válidos. Se actualiza con `npx tsx scripts/publish-whatsapp-flow.ts aprobacion`.
2. ~~Publicar el Flow~~ **HECHO (2026-09-10)**: estado `PUBLISHED`. Fue obligatorio para
   poder adjuntarlo a la plantilla. **No se recorrió antes en un teléfono real**: si aparece
   un problema de UX, corregirlo puede exigir un Flow nuevo.
3. ~~Crear la plantilla~~ **HECHO (2026-09-10)**: `aprobacion_requisicion`, id
   `1974324693523971`, categoría `UTILITY`. **En estado `PENDING`**: hasta que Meta la
   apruebe, el envío fuera de la ventana de 24 h no funciona. Consultar con
   `npx tsx --env-file=.env.local scripts/publish-approval-template.ts --status`.
4. **Cargar `WHATSAPP_APPROVAL_FLOW_ID=2249539985776722`** en el entorno de producción (en
   `.env.local` ya está). Sin esa variable el canal ni se intenta y todo sigue como antes.
5. **Cargar el teléfono de cada aprobador** en `usuarios.telefono`. Sin él no hay a quién
   enviarle y la notificación cae al aviso de texto.
6. **Recorrido real de punta a punta**: falta la vuelta de regreso. El envío ya se ejercitó
   contra la API real (y devolvió el 422 de la ventana, que es lo que motivó la plantilla);
   la respuesta (webhook → requisición aprobada) no se puede probar desde local porque Kapso
   no alcanza `localhost`, así que exige el sitio desplegado con el webhook conectado.

---

# WhatsApp Flow — Solicitud de pago

RF-908 (adenda «Órdenes de Pago y caja menor», §4.5): un Flow **aparte** del de captura para pedir un
pago a una persona o empresa. Daniel: «si no es por ahí, no es por ningún otro lado». Llega a la
misma bandeja de revisión como `tipo=pago`, `canal=whatsapp`, con el beneficiario **por
identificación** (RF-606): si la identificación ya existe en `proveedores` se enlaza; si no, nace
`pendiente_normalizacion` y Compras completa la ficha.

## Cómo se llega

El menú del bot (`lib/infrastructure/whatsapp-router.ts`, RF-902 modificado) ofrece tres botones:
**Montar requisición**, **Solicitar un pago** y **Mis requisiciones**. Tres es el tope de WhatsApp
para botones de respuesta. Al pulsar el segundo, `sendPaymentFlow` (`flow-sender.ts`) envía este
Flow con el mismo mensaje `interactive.type=flow` de siempre, pero:

- `flow_id` = `WHATSAPP_FLOW_PAGO_ID` (con `WHATSAPP_FLOW_PAGO_CTA`, `_BODY` y `_MODE` opcionales,
  ver `.env.example`).
- `flow_action_payload.screen` = `BENEFICIARIO`, y `data` solo trae `sociedades` (no hay catálogo:
  una solicitud de pago es un concepto libre con un valor). Las opciones salen de
  `buildSocietyOptions`, con `id = title = nombre`, por la misma razón que en el de captura.
- `flow_token` con el **mismo contrato** que el de captura (`issueFlowToken`: teléfono + timestamp,
  24 h). Es deliberado: desde la plataforma es la misma operación, un solicitante autorizado por su
  número crea una requisición nueva.

«Mis requisiciones» lista también las de tipo pago, marcadas con `Pago ·`.

## Diseño

3 pantallas, **sin Data Endpoint y sin PhotoPicker** (generadas por `scripts/build-flow-pago.ts`):

1. **BENEFICIARIO** (entrada) — tipo de identificación (`RadioButtonsGroup`: CC por defecto, NIT,
   CE, PAS — los mismos valores que `SUPPLIER_IDENTIFICATION_TYPE_VALUES`), número (`TextInput`,
   `^[0-9A-Za-z.-]{3,32}$`) y nombre completo o razón social.
2. **PAGO** — empresa a la que cobra (`Dropdown` sobre `data.sociedades`), monto en pesos
   (`TextInput` con `^[1-9][0-9]{0,11}$`: solo dígitos, sin puntos) y concepto corto.
3. **RESUMEN** (terminal) — rótulos estáticos en `TextCaption` y bindings **puros** en `TextBody`;
   la única concatenación es `` `${data.tipo_identificacion} ${data.identificacion}` `` (solo
   bindings y espacios, regla 5). El `complete` manda `kind: "pago"` más
   `tipo_identificacion, identificacion, nombre, empresa, monto, concepto`, todo encadenado desde
   `data` (ninguna referencia entre pantallas).

Cada pantalla declara en `data` lo que recibe y lo reenvía completo en el `navigate` (regla 2).
`tests/integration/kapso-pago.test.ts` fija todo esto y cruza el `complete` con
`CAMPOS_PAGO_LEIDOS` del adaptador, en las dos direcciones.

## Recepción: `lib/infrastructure/payment-reply-adapter.ts`

Llega como `nfm_reply`, igual que los otros dos; se reconoce por `kind: "pago"` y se atiende en
`app/api/kapso/route.ts` **antes** que el camino de captura. Valida en este orden: `flow_token`
(mismo `validateFlowToken`), forma de los campos, **monto** (`invalid_amount` si falta, es cero,
negativo, con letras o decimales; acepta puntos de miles), empresa (nombre → uuid con
`createPostgresSocietyResolver`, o uuid crudo) y lista blanca (`unauthorized_requester`). Un rechazo
responde `200 {status:"rejected", reason}` y se registra en `whatsapp_eventos` con
`createPostgresNfmReplyRejectionRecorder`, sin crear requisición ni proveedor.

Si pasa, se traduce al contrato normalizado y entra por `processKapsoEvent` (idempotencia por wamid,
registro en `whatsapp_eventos` vía `claim`) hasta `ProcurementService.create`:

| Campo del Flow | `KapsoFlowSubmission` | Nota |
| --- | --- | --- |
| `kind` | — | Discriminador; debe ser `"pago"`. |
| `tipo_identificacion`, `identificacion`, `nombre` | `beneficiary` | + `phone` = remitente verificado (E.164), como contacto del proveedor si nace pendiente. |
| `empresa` | `societyId` | Nombre del Dropdown → uuid. |
| `monto` | `items[0].unitBase` | COP entero > 0; `quantity: 1`, `unit: "unidad"`. |
| `concepto` | `items[0].proposedDescription` | Es la `descripcion_libre` de la única línea. |
| remitente (`message.from`) | `phone`, `requesterName` | Identidad por lista blanca global. |

`kapsoWebhookSchema` exige, para `type: "pago"`, `beneficiary` y exactamente un ítem con
`unitBase > 0`: un pago a medias no llega nunca a `create()`.

## Publicar y activar

```sh
npx tsx scripts/build-flow-pago.ts --check                       # el JSON commiteado está al día
npx tsx --env-file=.env.local scripts/publish-whatsapp-flow.ts pago   # crea/actualiza el borrador; imprime validation_errors
```

Luego cargar `WHATSAPP_FLOW_PAGO_ID=<flow_id>` y `WHATSAPP_FLOW_PAGO_MODE=draft`, recorrer la vista
previa en un teléfono real (ver «Publicar el borrador» arriba: `validation_errors: []` no garantiza
que se vea bien) y publicar con el mismo `POST /{FLOW_ID}/publish` documentado allí. Al publicar,
quitar `WHATSAPP_FLOW_PAGO_MODE`.
