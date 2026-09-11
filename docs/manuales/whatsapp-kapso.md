# Guía de WhatsApp vía Kapso — una página

## Qué es

Kapso es la capa de infraestructura para el número de WhatsApp Business, Flows, plantillas, webhooks y bandeja. La plataforma no habla con Meta directamente y no construye una bandeja propia: incrusta el Inbox de Kapso y conserva un log propio ligado a requisiciones.

## Recorrido esperado

1. El solicitante inicia el WhatsApp Flow con tipo de solicitud, obra, ítems, cantidad, posible proveedor, enlace y foto.
2. Kapso entrega el evento al endpoint configurado.
3. La solicitud cae en la misma bandeja de Daniel con canal `whatsapp`.
4. La requisición se crea siempre; los adjuntos se copian server-side al storage propio con control por rol (el servidor descarga el archivo desde Kapso, valida tipo y tamaño, y lo guarda en el bucket privado). Si la copia de un adjunto falla, no bloquea la solicitud: el fallo queda registrado en `whatsapp_eventos` y en auditoría para reintento manual.

Los cambios de estado ya crean una notificación `pendiente` en el outbox dentro de la misma transacción. Eso no significa que el mensaje haya salido: el envío y sus reintentos solo se habilitan después de configurar la cuenta, los destinos y las plantillas aprobadas de Kapso.
5. El solicitante y los aprobadores reciben plantillas de estado cuando estén aprobadas y activas.
6. La sección **Mensajes** muestra el Inbox embebido y `whatsapp_eventos` registra entradas, plantillas, destinatarios, fecha y resultado de entrega.

## Cómo sale un mensaje

Todo lo saliente —plantillas de texto, la plantilla de aprobación con su botón y los dos Flows— va por el **proxy de Meta que expone Kapso**, no por una API propia de Kapso:

```
POST {KAPSO_META_PROXY_URL}/{KAPSO_PHONE_NUMBER_ID}/messages
X-API-Key: {KAPSO_API_KEY}
```

con el cuerpo de la Cloud API de WhatsApp. `KAPSO_META_PROXY_URL` es opcional y por defecto vale `https://api.kapso.ai/meta/whatsapp/v24.0`.

**`KAPSO_API_URL` ya no se usa.** Las plantillas de texto se enviaban a `{KAPSO_API_URL}/v1/whatsapp/messages/templates`, un endpoint que **no existe** en Kapso: responde con la página HTML «Page not found» de Django. Por eso ninguna plantilla de texto salió nunca, y el `KAPSO_SEND_FAILED_404` que quedaba en `notificaciones.ultimo_error` parecía «Meta no tiene la plantilla» — tanto que `requisicion_recibida` siguió fallando igual después de que Meta la aprobara. El transporte correcto ya estaba en el repositorio, en el emisor de la plantilla de aprobación.

Las cinco plantillas de texto usan **parámetros con nombre** (`parameter_format: NAMED`), así que cada parámetro del cuerpo lleva `parameter_name` además del texto, y ese nombre debe coincidir letra por letra con la variable del texto aprobado: en ese formato Meta no interpola por posición. La de aprobación es la excepción, posicional, porque se creó así. La fuente única de nombres, textos y variables es `lib/infrastructure/plantillas-whatsapp.ts`.

Cuando Meta responde que la plantilla no existe (código `132001`), la cola **no gasta intento**: difiere esa notificación diez minutos y sigue con el resto del lote. Cualquier otro error sí agota los cinco intentos con espera creciente y acaba en `fallido`, para que se vea. La distinción es por el código de Meta, no por el HTTP: un 400 puede ser cualquiera de los dos.

## Enlaces a la bandeja

La bandeja embebida acepta **filtros iniciales por query string**, que se aplican al cargar el iframe. Los que Kapso documenta son exactamente estos y ningún otro: `status` (`active`/`ended`/`all`), `search`, `whatsapp_config_id` (UUID del número o `all`), `unread`, `handoff`, `contact_properties` (JSON codificado, hasta 3 entradas), y aparte `mode` para el tema y `language`.

**No hay parámetro para abrir una conversación concreta**, y conviene saberlo antes de intentarlo:

- `?wamid=` **no filtra nada**. El identificador de mensaje de Meta no es una clave que la bandeja entienda. Lo importante es cómo falla: la URL carga igual, sin error y sin filtro, así que parece que funcionó. Un enlace así llevaría a quien lo siga a la bandeja completa creyendo que está viendo una conversación concreta.
- `?conversation_id=` sí acota la vista, pero **no está documentado**. Es comportamiento observado al configurar la pantalla de Mensajes, fuera del contrato público de Kapso: puede cambiar o desaparecer sin aviso y sin que nadie se entere, porque —otra vez— el modo de fallo es silencioso. No construir nada encima sin aceptar ese riesgo.

Lo documentado y por tanto estable para acercarse a una conversación es `search`, que **prerrellena el buscador** con lo que se le pase (por ejemplo el teléfono); no selecciona la conversación, deja la bandeja filtrada por ese texto.

## Estado y seguridad

La pantalla actual muestra un estado seguro sin iframe cuando falta una URL pública HTTPS válida. No hay cuenta, número, plantilla, webhook ni credencial real en este manual. El onboarding, número dedicado, sandbox, plantillas aprobadas y costos son gates externos; ver [gates-externos.md](../gates-externos.md).

No usar el teléfono personal de Daniel. No registrar URLs-capability ni API keys en capturas. Para una incidencia, conservar payload/fallo con PII mínima y escalar a Sixteam.

## Aceptación de canal (PRD §11.1, §11.2 y §15)

- [ ] Existe sandbox Kapso y número dedicado autorizado.
- [ ] El Flow real llega a revisión con canal WhatsApp.
- [ ] Hay fixtures de payloads y log de eventos verificable.
- [ ] Plantillas de solicitante/aprobador están aprobadas.
- [ ] Una compra multi-proveedor completa el E2E sin bandeja propia.
