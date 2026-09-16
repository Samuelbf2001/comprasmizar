-- Arnés de 202609150006_telefono_externo_opcional.sql. Registrado en scripts/verify-schema.ts.
-- Formato del repo: begin -> do $$ ... $$ -> rollback. Sin par legado: recrear un CHECK más laxo no
-- puede romper ninguna fila existente (lo que antes pasaba sigue pasando).
begin;

do $$
declare v_req_compra uuid; v_req_pago uuid; v_req_con_tel uuid;
begin
  -- H2: una requisición externa SIN teléfono, con nombre, se crea — para 'compra' y para 'pago'.
  insert into public.requisiciones(consecutivo, tipo, obra_id, solicitante_nombre_externo, solicitante_telefono_externo, canal)
    values ('', 'compra', '30000000-0000-4000-8000-000000000001', 'SinTel QA', null, 'publico')
    returning id into v_req_compra;
  if v_req_compra is null then raise exception 'la compra externa sin teléfono debía crearse'; end if;

  insert into public.requisiciones(consecutivo, tipo, obra_id, solicitante_nombre_externo, solicitante_telefono_externo, canal)
    values ('', 'pago', '30000000-0000-4000-8000-000000000001', 'SinTel QA Pago', null, 'publico')
    returning id into v_req_pago;
  if v_req_pago is null then raise exception 'el pago externo sin teléfono debía crearse'; end if;

  -- Con teléfono sigue funcionando igual que antes (no se perdió el caso original).
  insert into public.requisiciones(consecutivo, tipo, obra_id, solicitante_nombre_externo, solicitante_telefono_externo, canal)
    values ('', 'compra', '30000000-0000-4000-8000-000000000001', 'ConTel QA', '3001112244', 'publico')
    returning id into v_req_con_tel;
  if v_req_con_tel is null then raise exception 'la compra externa con teléfono debía seguir creándose'; end if;

  -- Lo que el CHECK SÍ debe seguir bloqueando: ni solicitante interno ni nombre externo.
  begin
    insert into public.requisiciones(consecutivo, tipo, obra_id, solicitante_nombre_externo, solicitante_telefono_externo, canal)
      values ('', 'compra', '30000000-0000-4000-8000-000000000001', null, null, 'publico');
    raise exception 'se aceptó una requisición externa sin nombre ni teléfono';
  exception when sqlstate '23514' then null;
  end;
end $$;

rollback;
