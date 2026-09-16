-- Arnés de 202609150001_pagos_anulacion_comprobante.sql. Registrado en scripts/verify-schema.ts.
-- Formato del repo: begin -> do $$ ... $$ (uno por grupo) -> rollback.
--
-- Lo que se prueba aquí no vive en TypeScript: que el trigger anti-sobrepago IGNORE los pagos
-- anulados (anular libera saldo; el reemplazo se acepta), que un pago no pueda quedar "anulado" sin
-- motivo, que `pagos_orden` escriba en `auditoria` por trigger, que un comprobante con entidad
-- `pago_orden` entre por la misma puerta canónica que caja_menor (y sea rechazado con otro tipo o
-- sin padre), y que la RLS de lectura del comprobante siga a quien puede operar/contabilizar.
begin;

-- 1. Objetos de esquema: columnas, check, índices parciales, trigger de auditoría, policy de UPDATE.
do $$
declare v_count int;
begin
  select count(*) into v_count from information_schema.columns
   where table_schema = 'public' and table_name = 'pagos_orden'
     and column_name in ('nota', 'anulado', 'motivo_anulacion', 'anulado_por', 'anulado_en');
  if v_count <> 5 then raise exception 'faltan columnas de anulación/nota en pagos_orden (hay %)', v_count; end if;

  if not exists (select 1 from pg_constraint where conrelid = 'public.pagos_orden'::regclass and conname = 'pagos_orden_anulacion_coherente') then
    raise exception 'falta el check pagos_orden_anulacion_coherente';
  end if;
  if not exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 'pagos_orden' and indexname = 'pagos_orden_vigentes_idx')
    or not exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 'pagos_orden' and indexname = 'pagos_orden_medio_fecha_idx') then
    raise exception 'faltan los índices parciales de pagos vigentes';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'pagos_orden_auditoria' and not tgisinternal) then
    raise exception 'falta el trigger pagos_orden_auditoria';
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'pagos_orden' and policyname = 'pagos_orden_anulacion_operativa' and cmd = 'UPDATE') then
    raise exception 'falta la policy de UPDATE pagos_orden_anulacion_operativa';
  end if;
  if not exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 'adjuntos' and indexname = 'adjuntos_genericos_pago_orden_idx') then
    raise exception 'falta el índice adjuntos_genericos_pago_orden_idx';
  end if;
end $$;

-- 2. Anular libera saldo: total 10000, pagos 6000 + 4000 (cubierto); se anula el de 4000 y OTRO de
--    4000 se acepta; un peso más, no. Anular sin motivo se rechaza por el check. Cada escritura deja
--    su fila en `auditoria` (entidad = 'pagos_orden').
do $$
declare v_req uuid; v_orden uuid; v_pago_a uuid; v_pago_b uuid; v_pagado numeric; v_auditadas int;
begin
  insert into public.requisiciones(consecutivo, tipo, obra_id, solicitante_id, canal)
    values ('', 'compra', '30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'web')
    returning id into v_req;
  insert into public.ordenes(consecutivo, tipo, requisicion_id, proveedor_id, fecha_generacion)
    values ('OC-TEST-AN-0001', 'OC', v_req, '40000000-0000-4000-8000-000000000001', now())
    returning id into v_orden;
  insert into public.gastos(obra_id, origen, referencia_id, proveedor_id, fecha_orden, fecha, valor_base, iva)
    values ('30000000-0000-4000-8000-000000000001', 'requisicion', v_orden, '40000000-0000-4000-8000-000000000001', current_date, null, 10000, 0);

  insert into public.pagos_orden(orden_id, fecha, valor, medio_pago, registrado_por, nota)
    values (v_orden, current_date, 6000, 'efectivo', '10000000-0000-4000-8000-000000000002', 'Anticipo topógrafo')
    returning id into v_pago_a;
  insert into public.pagos_orden(orden_id, fecha, valor, medio_pago, registrado_por)
    values (v_orden, current_date, 4000, 'transferencia', '10000000-0000-4000-8000-000000000002')
    returning id into v_pago_b;

  -- Sin motivo: el check lo rechaza antes de que la anulación exista a medias.
  begin
    update public.pagos_orden set anulado = true, anulado_en = now() where id = v_pago_b;
    raise exception 'se permitió anular un pago sin motivo';
  exception when sqlstate '23514' then null;
  end;

  update public.pagos_orden
     set anulado = true, motivo_anulacion = 'Transferencia rebotó', anulado_por = '10000000-0000-4000-8000-000000000002', anulado_en = now()
   where id = v_pago_b;

  select coalesce(sum(valor), 0) into v_pagado from public.pagos_orden where orden_id = v_orden and not anulado;
  if v_pagado <> 6000 then raise exception 'el pagado vigente tras anular debía ser 6000, es %', v_pagado; end if;

  -- El reemplazo por el saldo exacto se acepta: el trigger dejó de contar el anulado.
  insert into public.pagos_orden(orden_id, fecha, valor, medio_pago, registrado_por)
    values (v_orden, current_date, 4000, 'transferencia', '10000000-0000-4000-8000-000000000002');
  begin
    insert into public.pagos_orden(orden_id, fecha, valor, medio_pago) values (v_orden, current_date, 1, 'otro');
    raise exception 'se permitió un pago sobre una orden ya cubierta (el anulado no debe liberar más de lo que valía)';
  exception when sqlstate '23514' then null;
  end;

  -- Reactivar el anulado (SQL directo) vuelve a pasar por la regla: ahora sí excedería.
  begin
    update public.pagos_orden set anulado = false where id = v_pago_b;
    raise exception 'se permitió reactivar un pago anulado que excede el total';
  exception when sqlstate '23514' then null;
  end;

  select count(*) into v_auditadas from public.auditoria where entidad = 'pagos_orden' and entidad_id in (v_pago_a, v_pago_b);
  if v_auditadas < 3 then raise exception 'pagos_orden debe auditar insert y update por trigger (hay % filas)', v_auditadas; end if;
  if not exists (select 1 from public.auditoria where entidad = 'pagos_orden' and entidad_id = v_pago_b and evento = 'UPDATE'
                   and datos_json -> 'datos_cambio' ? 'anulado') then
    raise exception 'la anulación debe quedar en auditoria como UPDATE con el cambio de anulado';
  end if;
end $$;

-- 3. Comprobante de pago: adjunto con entidad `pago_orden`, ruta canónica pagos-orden/<pago>/<adjunto>/
--    <nombre>. Solo tipo 'soporte'; sin padre existente se rechaza (23503); tipo distinto, 23514.
do $$
declare
  v_req uuid; v_orden uuid; v_pago uuid;
  v_adjunto uuid := '70000000-0000-4000-8000-0000000000a1';
  v_path text;
begin
  if not public.path_adjunto_generico_valido('pagos-orden/50000000-0000-4000-8000-000000000001/70000000-0000-4000-8000-000000000001/recibo.png')
    or public.entidad_adjunto_desde_path('pagos-orden/50000000-0000-4000-8000-000000000001/70000000-0000-4000-8000-000000000001/recibo.png') <> 'pago_orden' then
    raise exception 'el validador de path no reconoce pagos-orden';
  end if;

  insert into public.requisiciones(consecutivo, tipo, obra_id, solicitante_id, canal)
    values ('', 'pago', '30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'web')
    returning id into v_req;
  insert into public.ordenes(consecutivo, tipo, requisicion_id, proveedor_id, fecha_generacion)
    values ('OP-TEST-AN-0002', 'OP', v_req, '40000000-0000-4000-8000-000000000001', now())
    returning id into v_orden;
  insert into public.gastos(obra_id, origen, referencia_id, proveedor_id, fecha_orden, fecha, valor_base, iva)
    values ('30000000-0000-4000-8000-000000000001', 'requisicion', v_orden, '40000000-0000-4000-8000-000000000001', current_date, null, 600000, 0);
  insert into public.pagos_orden(orden_id, fecha, valor, medio_pago, registrado_por)
    values (v_orden, current_date, 600000, 'efectivo', '10000000-0000-4000-8000-000000000002')
    returning id into v_pago;

  v_path := 'pagos-orden/' || v_pago || '/' || v_adjunto || '/recibo-caja.png';
  begin
    insert into public.adjuntos(id, entidad, entidad_id, url_storage, tipo, nombre_original, tamano_bytes, storage_bucket, mime_type, subido_por)
      values (v_adjunto, 'pago_orden', v_pago, v_path, 'foto', 'recibo-caja.png', 1024, 'requisicion-adjuntos', 'image/png', '10000000-0000-4000-8000-000000000002');
    raise exception 'pago_orden aceptó un tipo distinto de soporte';
  exception when sqlstate '23514' then null;
  end;
  begin
    insert into public.adjuntos(id, entidad, entidad_id, url_storage, tipo, nombre_original, tamano_bytes, storage_bucket, mime_type, subido_por)
      values (v_adjunto, 'pago_orden', '50000000-0000-4000-8000-000000000999',
        'pagos-orden/50000000-0000-4000-8000-000000000999/' || v_adjunto || '/recibo-caja.png',
        'soporte', 'recibo-caja.png', 1024, 'requisicion-adjuntos', 'image/png', '10000000-0000-4000-8000-000000000002');
    raise exception 'aceptó un comprobante de un pago inexistente';
  exception when sqlstate '23503' then null;
  end;

  insert into public.adjuntos(id, entidad, entidad_id, url_storage, tipo, nombre_original, tamano_bytes, storage_bucket, mime_type, subido_por)
    values (v_adjunto, 'pago_orden', v_pago, v_path, 'soporte', 'recibo-caja.png', 1024, 'requisicion-adjuntos', 'image/png', '10000000-0000-4000-8000-000000000002');
  insert into storage.objects(bucket_id, name, owner_id, metadata)
    values ('requisicion-adjuntos', v_path, '10000000-0000-4000-8000-000000000002', '{}'::jsonb);

  -- RLS: contabilidad (Claudia) lee el comprobante finalizado; el solicitante, no.
  perform set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000004', true);
  execute 'set local role authenticated';
  if not exists (select 1 from public.adjuntos where id = v_adjunto) then
    raise exception 'RLS: contabilidad no ve el comprobante de pago';
  end if;
  if not exists (select 1 from storage.objects where bucket_id = 'requisicion-adjuntos' and name = v_path) then
    raise exception 'RLS Storage: contabilidad no ve el objeto del comprobante';
  end if;
  execute 'reset role';
  perform set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);
  execute 'set local role authenticated';
  if exists (select 1 from public.adjuntos where id = v_adjunto)
    or exists (select 1 from storage.objects where bucket_id = 'requisicion-adjuntos' and name = v_path) then
    raise exception 'RLS: un solicitante lee el comprobante de un pago';
  end if;
  execute 'reset role';
  perform set_config('request.jwt.claim.sub', '', true);
end $$;

-- 4. RLS de anulación: contabilidad puede anular (UPDATE) un pago; un aprobador ajeno, no.
do $$
declare v_req uuid; v_orden uuid; v_pago uuid; v_filas int;
begin
  insert into public.requisiciones(consecutivo, tipo, obra_id, solicitante_id, canal)
    values ('', 'compra', '30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'web')
    returning id into v_req;
  insert into public.ordenes(consecutivo, tipo, requisicion_id, proveedor_id, fecha_generacion)
    values ('OC-TEST-AN-0003', 'OC', v_req, '40000000-0000-4000-8000-000000000001', now())
    returning id into v_orden;
  insert into public.gastos(obra_id, origen, referencia_id, proveedor_id, fecha_orden, fecha, valor_base, iva)
    values ('30000000-0000-4000-8000-000000000001', 'requisicion', v_orden, '40000000-0000-4000-8000-000000000001', current_date, null, 20000, 0);
  insert into public.pagos_orden(orden_id, fecha, valor, medio_pago, registrado_por)
    values (v_orden, current_date, 5000, 'transferencia', '10000000-0000-4000-8000-000000000002')
    returning id into v_pago;

  perform set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000003', true);
  execute 'set local role authenticated';
  update public.pagos_orden set anulado = true, motivo_anulacion = 'intento ajeno', anulado_en = now() where id = v_pago;
  get diagnostics v_filas = row_count;
  if v_filas > 0 then raise exception 'RLS: un aprobador ajeno pudo anular un pago'; end if;
  execute 'reset role';

  perform set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000004', true);
  execute 'set local role authenticated';
  -- `anulado_por` va como literal, no `auth.uid()`: el prelude embebido no concede el esquema auth al
  -- rol authenticated (la aplicación lo escribe desde el servicio, no desde SQL con ese rol).
  update public.pagos_orden set anulado = true, motivo_anulacion = 'Duplicado', anulado_por = '10000000-0000-4000-8000-000000000004', anulado_en = now() where id = v_pago;
  get diagnostics v_filas = row_count;
  if v_filas <> 1 then raise exception 'RLS: contabilidad no pudo anular el pago'; end if;
  execute 'reset role';
  perform set_config('request.jwt.claim.sub', '', true);
end $$;

rollback;
