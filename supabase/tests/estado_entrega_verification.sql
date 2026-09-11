-- Arnés de 202609110003_estado_entrega_whatsapp.sql (acuses de entrega de WhatsApp).
-- Registrado en scripts/verify-schema.ts. Formato del repo: begin -> do $$ ... $$ -> rollback.
--
-- Lo que se prueba aquí NO se puede probar en una unidad: el avance monotónico vive en el `where` de
-- la consulta de `aplicarAcuse` (lib/infrastructure/whatsapp-delivery-status.ts), y con un `sql`
-- simulado la prueba solo comprobaría que llamamos a la función, no que la condición esté bien.
-- La condición es justo lo que importa, porque Kapso entrega "at-least-once and not guaranteed to
-- arrive in order": un `sent` tardío DESPUÉS de un `delivered` es funcionamiento normal, no un caso
-- raro, y si lo dejáramos pisar el estado la plataforma diría "enviado" de algo ya entregado.
begin;

-- 1. Las dos columnas nuevas existen, y el índice que sostiene la correlación.
do $$
declare v_count int;
begin
  select count(*) into v_count from information_schema.columns
   where table_schema='public' and table_name='whatsapp_eventos' and column_name='motivo_fallo';
  if v_count <> 1 then raise exception 'falta whatsapp_eventos.motivo_fallo'; end if;

  select count(*) into v_count from information_schema.columns
   where table_schema='public' and table_name='notificaciones' and column_name='kapso_message_id';
  if v_count <> 1 then raise exception 'falta notificaciones.kapso_message_id — sin esa columna el acuse no llega a la cola'; end if;

  select count(*) into v_count from pg_indexes
   where schemaname='public' and tablename='notificaciones' and indexname='notificaciones_kapso_message_id_idx';
  if v_count <> 1 then raise exception 'falta el índice parcial sobre notificaciones.kapso_message_id'; end if;
end $$;

-- 2. EL AVANCE MONOTÓNICO, que es el motivo de este arnés.
--    Se reproduce literalmente la condición de `aplicarAcuse` para que el arnés falle si alguien la
--    cambia en el código sin pensar en el desorden de entrega.
do $$
declare
  v_id uuid;
  v_estado text;
begin
  insert into public.whatsapp_eventos (direccion, telefono, tipo, estado_entrega, kapso_message_id)
  values ('salida', '573002408743', 'plantilla', 'enviado', 'wamid.PRUEBA-MONOTONICO')
  returning id into v_id;

  -- a) delivered AVANZA sobre enviado.
  update public.whatsapp_eventos set estado_entrega='entregado'
   where kapso_message_id='wamid.PRUEBA-MONOTONICO' and direccion='salida'
     and ('entregado' = 'fallido' or coalesce(case estado_entrega when 'pendiente' then 0 when 'enviado' then 1 when 'entregado' then 2 else 0 end, 0) < 2);
  select estado_entrega::text into v_estado from public.whatsapp_eventos where id=v_id;
  if v_estado <> 'entregado' then raise exception 'delivered debería avanzar sobre enviado (quedó %)', v_estado; end if;

  -- b) un `sent` TARDÍO no retrocede. Es el caso que la documentación de Kapso anuncia y el que
  --    haría que la plataforma volviera a mentir.
  update public.whatsapp_eventos set estado_entrega='enviado'
   where kapso_message_id='wamid.PRUEBA-MONOTONICO' and direccion='salida'
     and ('enviado' = 'fallido' or coalesce(case estado_entrega when 'pendiente' then 0 when 'enviado' then 1 when 'entregado' then 2 else 0 end, 0) < 1);
  select estado_entrega::text into v_estado from public.whatsapp_eventos where id=v_id;
  if v_estado <> 'entregado' then raise exception 'un sent tardío pisó un delivered (quedó %)', v_estado; end if;

  -- c) repetir el MISMO acuse no cambia nada: at-least-once significa que va a pasar.
  update public.whatsapp_eventos set estado_entrega='entregado'
   where kapso_message_id='wamid.PRUEBA-MONOTONICO' and direccion='salida'
     and ('entregado' = 'fallido' or coalesce(case estado_entrega when 'pendiente' then 0 when 'enviado' then 1 when 'entregado' then 2 else 0 end, 0) < 2);
  select estado_entrega::text into v_estado from public.whatsapp_eventos where id=v_id;
  if v_estado <> 'entregado' then raise exception 'reaplicar el mismo acuse cambió el estado (quedó %)', v_estado; end if;

  -- d) `failed` SÍ pisa lo que haya: si Meta dice que se perdió, eso manda sobre cualquier
  --    optimismo anterior. Es la única excepción al avance monotónico, y es deliberada.
  update public.whatsapp_eventos set estado_entrega='fallido', motivo_fallo='131047 · Re-engagement message'
   where kapso_message_id='wamid.PRUEBA-MONOTONICO' and direccion='salida'
     and ('fallido' = 'fallido' or coalesce(case estado_entrega when 'pendiente' then 0 when 'enviado' then 1 when 'entregado' then 2 else 0 end, 0) < 0);
  select estado_entrega::text into v_estado from public.whatsapp_eventos where id=v_id;
  if v_estado <> 'fallido' then raise exception 'failed debe pisar incluso un entregado (quedó %)', v_estado; end if;

  select motivo_fallo into v_estado from public.whatsapp_eventos where id=v_id;
  if v_estado is null then raise exception 'el motivo del fallo no se guardó'; end if;
end $$;

-- 3. Un acuse NUNCA debe tocar una fila de ENTRADA, aunque compartiera identificador: las de entrada
--    las escribe el router con el sufijo ":router" y hablan de mensajes que nos mandaron, no de los
--    que mandamos. Por eso todas las consultas filtran `direccion = 'salida'`.
do $$
declare v_estado text;
begin
  insert into public.whatsapp_eventos (direccion, telefono, tipo, estado_entrega, kapso_message_id)
  values ('entrada', '573002408743', 'mensaje', 'entregado', 'wamid.PRUEBA-ENTRADA');

  update public.whatsapp_eventos set estado_entrega='fallido'
   where kapso_message_id='wamid.PRUEBA-ENTRADA' and direccion='salida';

  select estado_entrega::text into v_estado from public.whatsapp_eventos where kapso_message_id='wamid.PRUEBA-ENTRADA';
  if v_estado <> 'entregado' then raise exception 'un acuse modificó una fila de entrada (quedó %)', v_estado; end if;
end $$;

rollback;
