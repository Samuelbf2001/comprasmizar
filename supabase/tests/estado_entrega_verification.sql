-- Arnés de 202609110003_estado_entrega_whatsapp.sql (acuses de entrega de WhatsApp).
-- Registrado en scripts/verify-schema.ts. Formato del repo: begin -> do $$ ... $$ -> rollback.
--
-- Lo que se prueba aquí NO se puede probar en una unidad: el avance monotónico vive en el `where` de
-- la consulta de `aplicarAcuse` (lib/infrastructure/whatsapp-delivery-status.ts), y con un `sql`
-- simulado la prueba solo comprobaría que llamamos a la función, no que la condición esté bien.
-- La condición es justo lo que importa, porque Kapso entrega "at-least-once and not guaranteed to
-- arrive in order": un acuse rezagado es funcionamiento normal, no un caso raro.
--
-- NOTA SOBRE CÓMO SE ESCRIBIÓ ESTE ARNÉS, que es la lección de un fallo real. La primera versión
-- copiaba el `case` de la consulta a mano, aquí y allá. Las dos copias tenían el MISMO defecto
-- (`fallido` caía en un `else 0`, así que un `sent` rezagado lo pisaba), de modo que el arnés daba
-- verde sobre la misma equivocación que debía cazar. Ahora la comparación vive en una función de la
-- base —`public.rango_estado_entrega`— que usan tanto la aplicación como este arnés: hay una sola
-- definición y no pueden divergir.
begin;

-- 1. Las columnas nuevas, el índice de correlación y la función de rango.
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

-- 2. El ORDEN de los rangos, comprobado directamente sobre la función. Si alguien reordena esto, lo
--    de abajo deja de significar lo que dice.
do $$
begin
  if not (public.rango_estado_entrega('pendiente') < public.rango_estado_entrega('enviado')
      and public.rango_estado_entrega('enviado')   < public.rango_estado_entrega('entregado')
      and public.rango_estado_entrega('entregado') < public.rango_estado_entrega('fallido')) then
    raise exception 'el orden de rango_estado_entrega no es pendiente < enviado < entregado < fallido';
  end if;
end $$;

-- 3. EL AVANCE MONOTÓNICO. Se usa la MISMA condición que `aplicarAcuse`, vía la función.
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
     and coalesce(public.rango_estado_entrega(estado_entrega), 0) < public.rango_estado_entrega('entregado');
  select estado_entrega::text into v_estado from public.whatsapp_eventos where id=v_id;
  if v_estado <> 'entregado' then raise exception 'delivered debería avanzar sobre enviado (quedó %)', v_estado; end if;

  -- b) un `sent` TARDÍO no retrocede.
  update public.whatsapp_eventos set estado_entrega='enviado'
   where kapso_message_id='wamid.PRUEBA-MONOTONICO' and direccion='salida'
     and coalesce(public.rango_estado_entrega(estado_entrega), 0) < public.rango_estado_entrega('enviado');
  select estado_entrega::text into v_estado from public.whatsapp_eventos where id=v_id;
  if v_estado <> 'entregado' then raise exception 'un sent tardío pisó un delivered (quedó %)', v_estado; end if;

  -- c) repetir el MISMO acuse no cambia nada: at-least-once significa que va a pasar.
  update public.whatsapp_eventos set estado_entrega='entregado'
   where kapso_message_id='wamid.PRUEBA-MONOTONICO' and direccion='salida'
     and coalesce(public.rango_estado_entrega(estado_entrega), 0) < public.rango_estado_entrega('entregado');
  select estado_entrega::text into v_estado from public.whatsapp_eventos where id=v_id;
  if v_estado <> 'entregado' then raise exception 'reaplicar el mismo acuse cambió el estado (quedó %)', v_estado; end if;

  -- d) `failed` SÍ pisa lo que haya: si Meta dice que se perdió, eso manda sobre cualquier
  --    optimismo anterior. Es la única excepción al avance monotónico, y es deliberada.
  update public.whatsapp_eventos set estado_entrega='fallido', motivo_fallo='131026 · Message undeliverable'
   where kapso_message_id='wamid.PRUEBA-MONOTONICO' and direccion='salida';
  select estado_entrega::text into v_estado from public.whatsapp_eventos where id=v_id;
  if v_estado <> 'fallido' then raise exception 'failed debe pisar incluso un entregado (quedó %)', v_estado; end if;

  -- e) EL CASO QUE SE NOS ESCAPÓ: un `sent` REZAGADO TRAS UN `failed` no puede resucitar el aviso.
  --    Con `fallido` sin rango propio caía en un `else 0` y esto lo pisaba, dejando la fila diciendo
  --    "enviado" de algo que Meta descartó — el engaño de partida, reaparecido por la puerta de atrás.
  update public.whatsapp_eventos set estado_entrega='enviado'
   where kapso_message_id='wamid.PRUEBA-MONOTONICO' and direccion='salida'
     and coalesce(public.rango_estado_entrega(estado_entrega), 0) < public.rango_estado_entrega('enviado');
  select estado_entrega::text into v_estado from public.whatsapp_eventos where id=v_id;
  if v_estado <> 'fallido' then raise exception 'un sent rezagado resucitó un fallido (quedó %)', v_estado; end if;

  -- f) Y un `delivered` rezagado tampoco, por la misma razón.
  update public.whatsapp_eventos set estado_entrega='entregado'
   where kapso_message_id='wamid.PRUEBA-MONOTONICO' and direccion='salida'
     and coalesce(public.rango_estado_entrega(estado_entrega), 0) < public.rango_estado_entrega('entregado');
  select estado_entrega::text into v_estado from public.whatsapp_eventos where id=v_id;
  if v_estado <> 'fallido' then raise exception 'un delivered rezagado pisó un fallido (quedó %)', v_estado; end if;

  select motivo_fallo into v_estado from public.whatsapp_eventos where id=v_id;
  if v_estado is null then raise exception 'el motivo del fallo se perdió por el camino'; end if;
end $$;

-- 4. Un acuse NUNCA debe tocar una fila de ENTRADA, aunque compartiera identificador: las de entrada
--    las escribe el router y hablan de mensajes que nos mandaron, no de los que mandamos. Por eso
--    todas las consultas filtran `direccion = 'salida'`.
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
