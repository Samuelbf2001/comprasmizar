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

## Estado y seguridad

La pantalla actual muestra un estado seguro sin iframe cuando falta una URL pública HTTPS válida. No hay cuenta, número, plantilla, webhook ni credencial real en este manual. El onboarding, número dedicado, sandbox, plantillas aprobadas y costos son gates externos; ver [gates-externos.md](../gates-externos.md).

No usar el teléfono personal de Daniel. No registrar URLs-capability ni API keys en capturas. Para una incidencia, conservar payload/fallo con PII mínima y escalar a Sixteam.

## Aceptación de canal (PRD §11.1, §11.2 y §15)

- [ ] Existe sandbox Kapso y número dedicado autorizado.
- [ ] El Flow real llega a revisión con canal WhatsApp.
- [ ] Hay fixtures de payloads y log de eventos verificable.
- [ ] Plantillas de solicitante/aprobador están aprobadas.
- [ ] Una compra multi-proveedor completa el E2E sin bandeja propia.
