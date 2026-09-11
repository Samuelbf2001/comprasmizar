-- Arnés de 202609110002_notificaciones_updated_at.sql. Registrado en scripts/verify-schema.ts.
-- Formato del repo: begin -> do $$ ... $$ (uno por grupo) -> rollback.
begin;

-- 1. EL CANDADO GENERAL, que es lo que de verdad importa de este arnés.
--
--    El defecto original no fue una columna olvidada, fue que nadie comprobaba la coherencia entre
--    el bucle que reparte `set_updated_at` (202608240001_core_compras.sql:918, una lista de nombres
--    escrita a mano) y las columnas que esas tablas tienen. `notificaciones` entró en la lista sin
--    tener `updated_at`, y como el disparador solo se ejecuta al ACTUALIZAR, la migración se aplicó
--    limpia y la tabla quedó imposible de actualizar para siempre. Sin este candado, añadir una
--    tabla a esa lista y olvidar la columna vuelve a producir el mismo fallo diferido.
do $$
declare v_faltantes text;
begin
  select string_agg(c.relname, ', ' order by c.relname) into v_faltantes
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_proc p on p.oid = t.tgfoid
   where p.proname = 'set_updated_at'
     and not t.tgisinternal
     and not exists (
       select 1 from information_schema.columns col
        where col.table_schema = 'public' and col.table_name = c.relname and col.column_name = 'updated_at');
  if v_faltantes is not null then
    raise exception 'estas tablas tienen el disparador set_updated_at pero no la columna updated_at, así que cualquier UPDATE sobre ellas aborta: %', v_faltantes;
  end if;
end $$;

-- 2. Comportamiento: la cola se puede ACTUALIZAR de verdad.
--
--    La comprobación 1 mira la forma; esta ejecuta el update que hacía fallar al despachador (tomar
--    el lease con `set bloqueada_hasta`). Es la que habría detectado el fallo real, porque el 500 no
--    venía de una columna ausente en abstracto sino de esta escritura concreta.
do $$
declare v_id uuid; v_updated_antes timestamptz; v_updated_despues timestamptz;
  -- OJO al comprobar `updated_at` dentro de un arnés: `now()` es la marca de INICIO DE TRANSACCIÓN,
  -- igual para todas las sentencias de este bloque. Comparar "antes" contra "después" siempre da
  -- iguales aunque el disparador funcione perfectamente. Por eso abajo se parte de una fecha
  -- deliberadamente vieja: si el disparador corre, la pisa con now(); si no corre, se queda en 2020.
begin
  -- Se usa `telefono_destino` y no `usuario_id` para no depender de ninguna fila del seed: la tabla
  -- exige exactamente uno de los dos (`notificaciones_destino_check`), y el destino externo deja el
  -- arnés inmune a los cambios de los datos de demostración.
  insert into public.notificaciones (telefono_destino, canal, plantilla, payload)
  values ('573000000000', 'whatsapp', 'prueba_arnes', '{}'::jsonb)
  returning id, updated_at into v_id, v_updated_antes;

  -- El lease que toma claimBatch (lib/infrastructure/notification-dispatcher.ts).
  update public.notificaciones set bloqueada_hasta = now() + interval '1 minute' where id = v_id;

  -- Y las dos transiciones terminales que usa el despachador.
  update public.notificaciones set estado_envio = 'fallido', intentos = intentos + 1, ultimo_error = 'SIN_TELEFONO_DESTINO' where id = v_id;
  update public.notificaciones set estado_envio = 'enviado', enviado_at = now() where id = v_id;

  -- El disparador tiene que PISAR lo que mande el llamador: se intenta dejar una fecha de 2020 y
  -- debe quedar la del momento. Si el disparador no estuviera, la fila se quedaría en 2020.
  update public.notificaciones set updated_at = timestamptz '2020-01-01 00:00:00+00' where id = v_id;
  select updated_at into v_updated_despues from public.notificaciones where id = v_id;
  if v_updated_despues = timestamptz '2020-01-01 00:00:00+00' then
    raise exception 'set_updated_at no está pisando notificaciones.updated_at: quedó en % en vez de la fecha actual', v_updated_despues;
  end if;
  if v_updated_antes is null then
    raise exception 'notificaciones.updated_at nació nulo en el insert; debería tener default now()';
  end if;
end $$;

rollback;
