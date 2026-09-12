-- Arnés de 202609120003_cajas_ingresos_cierres.sql. Registrado en scripts/verify-schema.ts.
-- Mismo formato que pagos_orden_verification.sql/centros_costo_verification.sql: begin -> bloques
-- `do $$ ... $$` con `raise exception` en fallo -> rollback (corre sobre la base ya sembrada por
-- supabase/seed.sql; el par legado 202609120003_cajas_ingresos_cierres.{pre,post}.sql cubre el
-- backfill sobre datos que YA EXISTÍAN antes de esta migración, que aquí es indistinguible de un
-- backfill no-op).
--
-- Lo que importa de verdad aquí NO cabe en una prueba unitaria porque no vive en TypeScript: el
-- trigger que bloquea movimientos de un periodo cerrado, la restricción "ingreso siempre positivo", la
-- propagación de caja_id/medio_pago/iva al gasto sincronizado, la vista movimientos_centro_costo, y las
-- policies de RLS.
--
-- AVISO HONESTO (mismo que pagos_orden_verification.sql): hoy la aplicación se conecta con el rol
-- dueño de las tablas y autoriza en el servicio; las policies de aquí son defensa en profundidad, no
-- la cerradura principal.
begin;

-- ---------------------------------------------------------------------------
-- 1) Los objetos de esquema existen.
-- ---------------------------------------------------------------------------
do $$
declare v_count int;
begin
  select count(*) into v_count from information_schema.tables where table_schema = 'public' and table_name in ('cajas', 'ingresos', 'cierres_caja');
  if v_count <> 3 then raise exception 'faltan tablas: se esperaban 3 (cajas, ingresos, cierres_caja), hay %', v_count; end if;

  select count(*) into v_count from pg_type where typname in ('tipo_caja', 'estado_cierre') and typnamespace = 'public'::regnamespace;
  if v_count <> 2 then raise exception 'faltan los enums tipo_caja/estado_cierre'; end if;

  select count(*) into v_count from information_schema.columns
   where table_schema = 'public' and table_name = 'caja_menor' and column_name in ('caja_id', 'medio_pago', 'iva', 'cierre_id', 'centro_costo_id');
  if v_count <> 5 then raise exception 'a caja_menor le faltan columnas nuevas (caja_id/medio_pago/iva/cierre_id/centro_costo_id)'; end if;

  select count(*) into v_count from information_schema.columns
   where table_schema = 'public' and table_name = 'gastos' and column_name in ('caja_id', 'concepto', 'medio_pago', 'registrado_por', 'cierre_id');
  if v_count <> 5 then raise exception 'a gastos le faltan columnas nuevas (caja_id/concepto/medio_pago/registrado_por/cierre_id)'; end if;

  select count(*) into v_count from pg_trigger where tgname = 'caja_menor_0_periodo_cerrado' and not tgisinternal;
  if v_count <> 1 then raise exception 'falta el trigger caja_menor_0_periodo_cerrado'; end if;
  select count(*) into v_count from pg_trigger where tgname = 'ingresos_0_periodo_cerrado' and not tgisinternal;
  if v_count <> 1 then raise exception 'falta el trigger ingresos_0_periodo_cerrado'; end if;

  if not (select relrowsecurity from pg_class where oid = 'public.cajas'::regclass) then raise exception 'public.cajas debe tener RLS habilitada'; end if;
  if not (select relrowsecurity from pg_class where oid = 'public.ingresos'::regclass) then raise exception 'public.ingresos debe tener RLS habilitada'; end if;
  if not (select relrowsecurity from pg_class where oid = 'public.cierres_caja'::regclass) then raise exception 'public.cierres_caja debe tener RLS habilitada'; end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2) Catálogo `cajas`: nace activa, nombre único, backfill de "Caja menor" por defecto.
-- ---------------------------------------------------------------------------
do $$
declare v_caja uuid;
begin
  if not exists (select 1 from public.cajas where nombre = 'Caja menor' and tipo = 'caja_menor') then
    raise exception 'Debe existir la caja "Caja menor" por defecto (backfill)';
  end if;
  insert into public.cajas (nombre, tipo) values ('Caja Administrativa Test', 'administrativa') returning id into v_caja;
  if not exists (select 1 from public.cajas where id = v_caja and activo = true) then
    raise exception 'Una caja nueva debe nacer activa';
  end if;
  begin
    insert into public.cajas (nombre, tipo) values ('Caja Administrativa Test', 'banco');
    raise exception 'Un nombre de caja duplicado debió rechazarse';
  exception when unique_violation then null;
  end;
end $$;

-- ---------------------------------------------------------------------------
-- 3) Gasto directo de caja (vía caja_menor, ahora generalizado a cualquier caja): el gasto
--    sincronizado debe llevar caja_id/medio_pago/iva/concepto/registrado_por/centro_costo_id, y el
--    IVA YA NO se fuerza a 0 (bloqueante corregido por esta migración).
-- ---------------------------------------------------------------------------
do $$
declare
  v_obra constant uuid := '30000000-0000-4000-8000-000000000001';
  v_centro uuid;
  v_caja uuid;
  v_movimiento uuid;
  v_gasto uuid;
  v_gasto_row record;
begin
  insert into public.centros_costo (nombre) values ('Centro Cajas Test') returning id into v_centro;
  update public.obras set centro_costo_id = v_centro where id = v_obra;
  insert into public.cajas (nombre, tipo) values ('Caja Test Gasto Directo', 'caja_menor') returning id into v_caja;

  insert into public.caja_menor (obra_id, fecha, concepto, valor, iva, medio_pago, caja_id, registrado_por)
    values (v_obra, current_date, 'Compra de ferretería con IVA', 100000, 19000, 'tarjeta', v_caja, '10000000-0000-4000-8000-000000000002')
    returning id, gasto_id into v_movimiento, v_gasto;

  select * into v_gasto_row from public.gastos where id = v_gasto;
  if v_gasto_row.caja_id is distinct from v_caja then raise exception 'El gasto debe copiar caja_id del movimiento (esperado %, obtenido %)', v_caja, v_gasto_row.caja_id; end if;
  if v_gasto_row.medio_pago::text is distinct from 'tarjeta' then raise exception 'El gasto debe copiar medio_pago (obtenido %)', v_gasto_row.medio_pago; end if;
  if v_gasto_row.iva <> 19000 then raise exception 'El gasto YA NO debe forzar iva=0: esperado 19000, obtenido %', v_gasto_row.iva; end if;
  if v_gasto_row.concepto is distinct from 'Compra de ferretería con IVA' then raise exception 'El gasto debe copiar concepto'; end if;
  if v_gasto_row.registrado_por is distinct from '10000000-0000-4000-8000-000000000002'::uuid then raise exception 'El gasto debe copiar registrado_por'; end if;
  if v_gasto_row.centro_costo_id is distinct from v_centro then raise exception 'El gasto debe seguir derivando centro_costo_id de la obra (esperado %, obtenido %)', v_centro, v_gasto_row.centro_costo_id; end if;
  if v_gasto_row.valor_total <> 119000 then raise exception 'El total del gasto (base+iva) debe ser 119000, obtenido %', v_gasto_row.valor_total; end if;

  -- Una caja inactiva no puede recibir movimientos nuevos.
  update public.cajas set activo = false where id = v_caja;
  begin
    insert into public.caja_menor (obra_id, fecha, concepto, valor, medio_pago, caja_id, registrado_por)
      values (v_obra, current_date, 'No debería pasar', 1000, 'efectivo', v_caja, '10000000-0000-4000-8000-000000000002');
    raise exception 'Un movimiento contra una caja inactiva debió rechazarse';
  exception when sqlstate '23514' then null;
  end;
  update public.cajas set activo = true where id = v_caja;

  -- Override de centro de costo (`caja_menor.centro_costo_id`, mismo patrón que
  -- `requisiciones.costCenterId`): un valor explícito gana sobre el de la obra.
  declare v_centro_override uuid; v_gasto_override uuid; v_centro_gasto uuid;
  begin
    insert into public.centros_costo (nombre) values ('Centro Override Test') returning id into v_centro_override;
    insert into public.caja_menor (obra_id, fecha, concepto, valor, medio_pago, caja_id, centro_costo_id, registrado_por)
      values (v_obra, current_date, 'Gasto con centro propio', 5000, 'efectivo', v_caja, v_centro_override, '10000000-0000-4000-8000-000000000002')
      returning gasto_id into v_gasto_override;
    select centro_costo_id into v_centro_gasto from public.gastos where id = v_gasto_override;
    if v_centro_gasto is distinct from v_centro_override then
      raise exception 'Un centro_costo_id explícito en caja_menor debe ganarle al de la obra (esperado %, obtenido %)', v_centro_override, v_centro_gasto;
    end if;
  end;
end $$;

-- ---------------------------------------------------------------------------
-- 4) `ingresos`: nunca un gasto en negativo (valor > 0), periodo generado, y el mismo criterio
--    "activo" que caja_menor (caja/centro/obra/usuario).
-- ---------------------------------------------------------------------------
do $$
declare
  v_obra constant uuid := '30000000-0000-4000-8000-000000000001';
  v_centro uuid;
  v_caja uuid;
  v_ingreso uuid;
  v_periodo date;
begin
  insert into public.centros_costo (nombre) values ('Centro Ingresos Test') returning id into v_centro;
  insert into public.cajas (nombre, tipo) values ('Caja Test Ingresos', 'banco') returning id into v_caja;

  insert into public.ingresos (caja_id, centro_costo_id, obra_id, fecha, concepto, valor, medio_pago, tercero, registrado_por)
    values (v_caja, v_centro, v_obra, '2026-09-15', 'Anticipo de cliente', 500000, 'transferencia', 'Cliente Demo', '10000000-0000-4000-8000-000000000004')
    returning id, periodo into v_ingreso, v_periodo;
  if v_periodo <> date '2026-09-01' then raise exception 'periodo generado incorrecto: esperado 2026-09-01, obtenido %', v_periodo; end if;

  -- obra_id es OPCIONAL en ingresos (a diferencia de caja_menor).
  insert into public.ingresos (caja_id, centro_costo_id, fecha, concepto, valor, medio_pago, registrado_por)
    values (v_caja, v_centro, '2026-09-16', 'Ingreso sin obra', 200000, 'efectivo', '10000000-0000-4000-8000-000000000004');

  begin
    insert into public.ingresos (caja_id, centro_costo_id, fecha, concepto, valor, medio_pago, registrado_por)
      values (v_caja, v_centro, current_date, 'Negativo', -1000, 'efectivo', '10000000-0000-4000-8000-000000000004');
    raise exception 'Un ingreso con valor negativo debió rechazarse';
  exception when sqlstate '23514' then null;
  end;
  begin
    insert into public.ingresos (caja_id, centro_costo_id, fecha, concepto, valor, medio_pago, registrado_por)
      values (v_caja, v_centro, current_date, 'Cero', 0, 'efectivo', '10000000-0000-4000-8000-000000000004');
    raise exception 'Un ingreso con valor cero debió rechazarse';
  exception when sqlstate '23514' then null;
  end;

  -- Centro de costo inactivo: rechazado.
  update public.centros_costo set activo = false where id = v_centro;
  begin
    insert into public.ingresos (caja_id, centro_costo_id, fecha, concepto, valor, medio_pago, registrado_por)
      values (v_caja, v_centro, current_date, 'Centro inactivo', 1000, 'efectivo', '10000000-0000-4000-8000-000000000004');
    raise exception 'Un ingreso contra un centro de costo inactivo debió rechazarse';
  exception when sqlstate '23514' then null;
  end;
  update public.centros_costo set activo = true where id = v_centro;
end $$;

-- ---------------------------------------------------------------------------
-- 5) Cierre mensual: bloquea altas y ediciones de movimientos (caja_menor e ingresos) con fecha
--    dentro del periodo cerrado, y reabrir lo vuelve a permitir. La secuencia de cierre (etiquetar
--    ANTES de marcar 'cerrado') es la que documenta el comentario de cierres_caja en la migración.
-- ---------------------------------------------------------------------------
do $$
declare
  v_obra constant uuid := '30000000-0000-4000-8000-000000000001';
  v_centro uuid;
  v_caja uuid;
  v_cierre uuid;
  v_periodo constant date := '2026-06-01';
  v_movimiento uuid;
  v_ingreso uuid;
begin
  insert into public.centros_costo (nombre) values ('Centro Cierre Test') returning id into v_centro;
  update public.obras set centro_costo_id = v_centro where id = v_obra;
  insert into public.cajas (nombre, tipo) values ('Caja Test Cierre', 'caja_menor') returning id into v_caja;

  insert into public.caja_menor (obra_id, fecha, concepto, valor, medio_pago, caja_id, registrado_por)
    values (v_obra, '2026-06-10', 'Gasto de junio', 30000, 'efectivo', v_caja, '10000000-0000-4000-8000-000000000002')
    returning id into v_movimiento;
  insert into public.ingresos (caja_id, centro_costo_id, fecha, concepto, valor, medio_pago, registrado_por)
    values (v_caja, v_centro, '2026-06-12', 'Ingreso de junio', 80000, 'efectivo', '10000000-0000-4000-8000-000000000004')
    returning id into v_ingreso;

  -- Secuencia de cierre: primero se etiqueta (el periodo sigue 'abierto', el trigger no interfiere).
  insert into public.cierres_caja (caja_id, periodo, saldo_inicial, total_ingresos, total_gastos, saldo_final, cerrado_por)
    values (v_caja, v_periodo, 0, 80000, 30000, 50000, '10000000-0000-4000-8000-000000000004')
    returning id into v_cierre;
  update public.caja_menor set cierre_id = v_cierre where id = v_movimiento;
  update public.ingresos set cierre_id = v_cierre where id = v_ingreso;
  -- Y solo AL FINAL se marca 'cerrado'.
  update public.cierres_caja set estado = 'cerrado', cerrado_at = now() where id = v_cierre;

  -- Un alta nueva en el mes cerrado se rechaza.
  begin
    insert into public.caja_menor (obra_id, fecha, concepto, valor, medio_pago, caja_id, registrado_por)
      values (v_obra, '2026-06-20', 'No debería pasar', 1000, 'efectivo', v_caja, '10000000-0000-4000-8000-000000000002');
    raise exception 'Un alta de caja_menor en un mes cerrado debió rechazarse';
  exception when sqlstate '23514' then null;
  end;
  begin
    insert into public.ingresos (caja_id, centro_costo_id, fecha, concepto, valor, medio_pago, registrado_por)
      values (v_caja, v_centro, '2026-06-21', 'No debería pasar', 1000, 'efectivo', '10000000-0000-4000-8000-000000000004');
    raise exception 'Un alta de ingreso en un mes cerrado debió rechazarse';
  exception when sqlstate '23514' then null;
  end;
  -- Editar el movimiento YA existente del mes cerrado también se rechaza.
  begin
    update public.caja_menor set valor = 99999 where id = v_movimiento;
    raise exception 'Editar un movimiento de un mes cerrado debió rechazarse';
  exception when sqlstate '23514' then null;
  end;

  -- Reabrir: ahora sí se puede editar/insertar en ese mismo periodo.
  update public.cierres_caja set estado = 'abierto' where id = v_cierre;
  update public.caja_menor set valor = 35000 where id = v_movimiento;
  if (select valor from public.caja_menor where id = v_movimiento) <> 35000 then
    raise exception 'Tras reabrir el cierre, el movimiento debió poder editarse';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 6) Vista `movimientos_centro_costo`: ingresos en positivo, gastos en negativo, mismo centro/periodo.
-- ---------------------------------------------------------------------------
do $$
declare
  v_obra constant uuid := '30000000-0000-4000-8000-000000000001';
  v_centro uuid;
  v_caja uuid;
  v_total numeric;
begin
  insert into public.centros_costo (nombre) values ('Centro Cruce Test') returning id into v_centro;
  update public.obras set centro_costo_id = v_centro where id = v_obra;
  insert into public.cajas (nombre, tipo) values ('Caja Test Cruce', 'caja_menor') returning id into v_caja;

  insert into public.caja_menor (obra_id, fecha, concepto, valor, medio_pago, caja_id, registrado_por)
    values (v_obra, '2026-07-05', 'Gasto de cruce', 40000, 'efectivo', v_caja, '10000000-0000-4000-8000-000000000002');
  insert into public.ingresos (caja_id, centro_costo_id, fecha, concepto, valor, medio_pago, registrado_por)
    values (v_caja, v_centro, '2026-07-06', 'Ingreso de cruce', 100000, 'efectivo', '10000000-0000-4000-8000-000000000004');

  select coalesce(sum(valor), 0) into v_total from public.movimientos_centro_costo
   where centro_costo_id = v_centro and periodo = '2026-07-01';
  if v_total <> 60000 then raise exception 'El cruce debe dar 100000 (ingreso) - 40000 (gasto) = 60000, obtenido %', v_total; end if;
  if not exists (select 1 from public.movimientos_centro_costo where centro_costo_id = v_centro and origen = 'ingreso' and valor = 100000) then
    raise exception 'El ingreso debe aparecer en el cruce con valor positivo';
  end if;
  if not exists (select 1 from public.movimientos_centro_costo where centro_costo_id = v_centro and origen = 'gasto_caja_menor' and valor = -40000) then
    raise exception 'El gasto debe aparecer en el cruce con valor negativo';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 7) RLS: cajas (catálogo, mismo criterio que centros_costo), ingresos (income:register: revisor,
--    contabilidad, admin_sixteam) y cierres_caja (cash:close: contabilidad, admin_sixteam — SIN
--    revisor, a diferencia de ingresos).
-- ---------------------------------------------------------------------------
do $$
declare
  v_obra constant uuid := '30000000-0000-4000-8000-000000000001';
  v_centro uuid;
  v_caja uuid;
  c_revisor constant uuid := '10000000-0000-4000-8000-000000000002';
  c_aprobador constant uuid := '10000000-0000-4000-8000-000000000003';
  c_contabilidad constant uuid := '10000000-0000-4000-8000-000000000004';
begin
  insert into public.centros_costo (nombre) values ('Centro RLS Test') returning id into v_centro;
  insert into public.cajas (nombre, tipo) values ('Caja Test RLS', 'banco') returning id into v_caja;

  -- Lectura de `cajas`: cualquier usuario activo, incluido un aprobador ajeno a compras/contabilidad.
  perform set_config('request.jwt.claim.sub', c_aprobador::text, true);
  execute 'set local role authenticated';
  if not exists (select 1 from public.cajas where id = v_caja) then
    raise exception 'RLS: cualquier usuario activo debe poder leer el catálogo de cajas';
  end if;
  -- Pero NO puede administrar el catálogo (crear una caja nueva).
  begin
    insert into public.cajas (nombre, tipo) values ('Caja RLS No Debería', 'personal');
    raise exception 'RLS: un aprobador no debió poder crear una caja';
  exception when sqlstate '42501' then null;
  end;
  execute 'reset role';
  perform set_config('request.jwt.claim.sub', '', true);

  -- Ingresos: el revisor (income:register) puede registrar y leer.
  perform set_config('request.jwt.claim.sub', c_revisor::text, true);
  execute 'set local role authenticated';
  insert into public.ingresos (caja_id, centro_costo_id, fecha, concepto, valor, medio_pago, registrado_por)
    values (v_caja, v_centro, current_date, 'Ingreso RLS revisor', 10000, 'efectivo', c_revisor);
  if not exists (select 1 from public.ingresos where caja_id = v_caja and registrado_por = c_revisor) then
    raise exception 'RLS: el revisor no ve el ingreso que acaba de registrar';
  end if;
  execute 'reset role';
  perform set_config('request.jwt.claim.sub', '', true);

  -- Contabilidad (income:register) también puede registrar.
  perform set_config('request.jwt.claim.sub', c_contabilidad::text, true);
  execute 'set local role authenticated';
  insert into public.ingresos (caja_id, centro_costo_id, fecha, concepto, valor, medio_pago, registrado_por)
    values (v_caja, v_centro, current_date, 'Ingreso RLS contabilidad', 20000, 'efectivo', c_contabilidad);
  execute 'reset role';
  perform set_config('request.jwt.claim.sub', '', true);

  -- Un aprobador SIN rol de compras ni contabilidad: ni registra ni lee ingresos.
  perform set_config('request.jwt.claim.sub', c_aprobador::text, true);
  execute 'set local role authenticated';
  begin
    insert into public.ingresos (caja_id, centro_costo_id, fecha, concepto, valor, medio_pago, registrado_por)
      values (v_caja, v_centro, current_date, 'No debería pasar', 1000, 'efectivo', c_aprobador);
    raise exception 'RLS: un aprobador ajeno pudo registrar un ingreso';
  exception when sqlstate '42501' then null;
  end;
  if exists (select 1 from public.ingresos where concepto = 'Ingreso RLS revisor') then
    raise exception 'RLS: un aprobador ajeno lee ingresos que no le tocan';
  end if;
  execute 'reset role';
  perform set_config('request.jwt.claim.sub', '', true);

  -- cierres_caja: el revisor (income:register, pero NO cash:close) puede LEER (can_operate_compras)
  -- pero no puede cerrar un periodo.
  perform set_config('request.jwt.claim.sub', c_revisor::text, true);
  execute 'set local role authenticated';
  begin
    insert into public.cierres_caja (caja_id, periodo) values (v_caja, '2026-08-01');
    raise exception 'RLS: un revisor sin cash:close no debió poder abrir/cerrar un periodo de caja';
  exception when sqlstate '42501' then null;
  end;
  execute 'reset role';
  perform set_config('request.jwt.claim.sub', '', true);

  -- Contabilidad (cash:close) sí puede.
  perform set_config('request.jwt.claim.sub', c_contabilidad::text, true);
  execute 'set local role authenticated';
  insert into public.cierres_caja (caja_id, periodo, cerrado_por) values (v_caja, '2026-08-01', c_contabilidad);
  execute 'reset role';
  perform set_config('request.jwt.claim.sub', '', true);
end $$;

rollback;
