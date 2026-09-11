-- Acuses de entrega de WhatsApp: poder distinguir "Meta lo entregó" de "Meta lo descartó".
--
-- Hasta ahora `whatsapp_eventos.estado_entrega = 'enviado'` significaba únicamente "Kapso respondió
-- 200". Eso hizo creer durante horas que los avisos salían mientras Meta los descartaba: la
-- plataforma decía `enviado`, el teléfono no recibía nada, y no había forma de notar la diferencia
-- sin entrar a Kapso. Un estado que miente hacia el lado optimista es peor que no tener estado.
--
-- Con los webhooks `whatsapp.message.sent|delivered|read|failed` (ver
-- lib/infrastructure/whatsapp-delivery-status.ts) el estado pasa a reflejar lo que de verdad ocurrió.

-- Por qué Meta lo descartó, ya resumido como "<código> · <título>" (p. ej. "131047 · Re-engagement
-- message"). Se guarda el CÓDIGO además del título porque el título cambia entre versiones de la API
-- y el código es lo que sirve para buscarlo en la documentación cuando alguien pregunte por qué no
-- llegó su aviso. El texto largo del error NO se guarda: puede traer el teléfono.
alter table public.whatsapp_eventos add column if not exists motivo_fallo text;

-- Clave de correlación entre la cola de notificaciones y el acuse.
--
-- No existía: `markSent` (lib/infrastructure/notification-dispatcher.ts) guardaba el wamid en
-- `whatsapp_eventos.kapso_message_id` pero no dejaba nada en la fila de `notificaciones`, así que no
-- había forma de llevar el acuse hasta la cola — que es justo lo que mira quien pregunta "¿se
-- avisó?". Sin esto, `notificaciones.estado_envio` seguiría diciendo `enviado` para un mensaje que
-- Meta tiró: el mismo engaño, una capa más arriba.
alter table public.notificaciones add column if not exists kapso_message_id text;

-- Índice parcial: la actualización del acuse busca por esta columna y la inmensa mayoría de filas la
-- tienen nula (todo lo que aún no se ha enviado).
create index if not exists notificaciones_kapso_message_id_idx
  on public.notificaciones (kapso_message_id) where kapso_message_id is not null;

-- Conteo de fallidos de las últimas 24 h, que expone /api/health. El índice existente por
-- `kapso_message_id` en whatsapp_eventos no sirve para esta consulta (filtra por estado y fecha).
create index if not exists whatsapp_eventos_fallidos_idx
  on public.whatsapp_eventos (fecha) where direccion = 'salida' and estado_entrega = 'fallido';
