-- Verifica 202609120001_centros_costo.sql: catálogo nuevo, backfill sin nulos, validación de
-- coherencia de sociedad/actividad, copia (no derivación) en gastos, y el atajo de caja menor. Mismo
-- formato que gasto_fecha_pago_verification.sql/aprobador_elegido_verification.sql: transacción +
-- bloques `do $$ ... $$` con `raise exception` en fallo, `rollback` al final (corre sobre la base ya
-- sembrada por supabase/seed.sql — ver scripts/verify-schema.ts).
begin;

-- ---------------------------------------------------------------------------
-- 0) Backfill: cero requisiciones con obra o gastos sin centro, en la base YA SEMBRADA. `obras` NO
--    entra en esta comprobación a propósito: `obras.centro_costo_id` es OPCIONAL por diseño (una obra
--    puede no tener centro configurado todavía, ver el comentario de CatalogWork en contracts.ts) — la
--    obligación real del backfill es sobre requisiciones-con-obra y gastos, no sobre el catálogo de
--    obras en sí. `supabase/seed.sql` (17 obras) las siembra DESPUÉS de esta migración, sin centro
--    propio, y eso es perfectamente válido: no hay ningún backfill que "arregle" una obra nueva creada
--    tras la migración. Ver también supabase/tests/legacy/202609120001_centros_costo.{pre,post}.sql
--    para el caso con datos legado real (obras, requisiciones y gastos ya existentes ANTES de migrar).
-- ---------------------------------------------------------------------------
do $$
declare v_requisiciones_sin_centro integer; v_gastos_sin_centro integer;
begin
  select count(*) into v_requisiciones_sin_centro from public.requisiciones where obra_id is not null and centro_costo_id is null;
  select count(*) into v_gastos_sin_centro from public.gastos where centro_costo_id is null;
  if v_requisiciones_sin_centro > 0 then raise exception 'Backfill: % requisición(es) con obra siguen sin centro', v_requisiciones_sin_centro; end if;
  if v_gastos_sin_centro > 0 then raise exception 'Backfill: % gasto(s) siguen sin centro', v_gastos_sin_centro; end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1) Crear un centro de costo: nombre único, código opcional normalizado, activo por defecto.
-- ---------------------------------------------------------------------------
do $$
declare v_centro uuid; begin
  insert into public.centros_costo (nombre, codigo, sociedad_id)
    values ('Centro Administrativo Test', 'CC-01', '20000000-0000-4000-8000-000000000001')
    returning id into v_centro;
  if not exists (
    select 1 from public.centros_costo
    where id = v_centro and activo = true and codigo_normalizado = 'CC01'
  ) then raise exception 'Un centro de costo nuevo debe nacer activo y con codigo_normalizado calculado'; end if;

  -- Nombre duplicado: rechazado (unique global, a diferencia de obras.nombre que es único por sociedad).
  begin
    insert into public.centros_costo (nombre) values ('Centro Administrativo Test');
    raise exception 'Un nombre de centro de costo duplicado debió rechazarse (unique global)';
  exception when unique_violation then null;
  end;

  -- Código equivalente (misma letra/dígitos, solo cambia la puntuación): rechazado por
  -- codigo_normalizado. MISMO criterio que nit_normalizado (sociedades/proveedores): case-SENSITIVE
  -- (no hace lower()) — "CC-01" y "cc-01" son códigos DISTINTOS a propósito, igual que un NIT con
  -- letras en otra mayúscula/minúscula; lo que se ignora es solo la puntuación/espacios.
  begin
    insert into public.centros_costo (nombre, codigo) values ('Centro Administrativo Test 2', 'CC 01');
    raise exception 'Un código de centro de costo equivalente (CC 01 vs CC-01) debió rechazarse';
  exception when unique_violation then null;
  end;
end $$;

-- ---------------------------------------------------------------------------
-- 2) Obra con centro DEFAULT propio (una obra nueva, distinta de la ya backfillada).
-- ---------------------------------------------------------------------------
do $$
declare v_centro_obra uuid; v_obra uuid; begin
  insert into public.centros_costo (nombre, sociedad_id) values ('Centro de Obra Nueva Test', '20000000-0000-4000-8000-000000000001') returning id into v_centro_obra;
  insert into public.obras (nombre, sociedad_id, estado, centro_costo_id)
    values ('Obra Nueva Test', '20000000-0000-4000-8000-000000000001', 'activa', v_centro_obra)
    returning id into v_obra;
  if not exists (select 1 from public.obras where id = v_obra and centro_costo_id = v_centro_obra) then
    raise exception 'Una obra nueva debe poder fijar su centro de costo default al crearse';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3) Requisición que HEREDA el centro de su obra (lo asigna la aplicación, ver resolveCostCenter en
--    lib/domain/rules.ts) y LUEGO CAMBIA a otro centro válido — el trigger deja pasar ambos. Usa una
--    obra PROPIA (con centro explícito), no la sembrada por seed.sql: esa nace sin centro (punto 0).
-- ---------------------------------------------------------------------------
do $$
declare v_centro_obra uuid; v_centro_alterno uuid; v_obra uuid; v_req uuid; begin
  insert into public.centros_costo (nombre, sociedad_id) values ('Centro Base Mizar Test', '20000000-0000-4000-8000-000000000001') returning id into v_centro_obra;
  insert into public.centros_costo (nombre, sociedad_id) values ('Centro Alterno Mizar Test', '20000000-0000-4000-8000-000000000001') returning id into v_centro_alterno;
  insert into public.obras (nombre, sociedad_id, estado, centro_costo_id)
    values ('Obra Base Test', '20000000-0000-4000-8000-000000000001', 'activa', v_centro_obra)
    returning id into v_obra;

  insert into public.requisiciones (consecutivo, tipo, sociedad_id, obra_id, solicitante_id, canal, centro_costo_id)
    values ('', 'compra', '20000000-0000-4000-8000-000000000001', v_obra, '10000000-0000-4000-8000-000000000001', 'web', v_centro_obra)
    returning id into v_req;
  if not exists (select 1 from public.requisiciones where id = v_req and centro_costo_id = v_centro_obra) then
    raise exception 'La requisición debe poder nacer con el centro heredado de su obra';
  end if;

  -- El revisor cambia el centro: sigue siendo válido (misma sociedad, activo) y el trigger lo acepta.
  update public.requisiciones set centro_costo_id = v_centro_alterno where id = v_req;
  if not exists (select 1 from public.requisiciones where id = v_req and centro_costo_id = v_centro_alterno) then
    raise exception 'El revisor debe poder cambiar el centro de costo de una requisición a otro centro válido';
  end if;

  -- ---------------------------------------------------------------------------
  -- 4) Gasto que COPIA el centro (instantánea, no derivada): nace con el centro efectivo de ESTE
  --    momento; si luego la requisición vuelve a cambiar de centro, el gasto ya guardado no se mueve.
  -- ---------------------------------------------------------------------------
  declare v_orden uuid; v_gasto uuid; begin
    insert into public.ordenes (consecutivo, tipo, requisicion_id, proveedor_id)
      values ('OC-TEST-CC-0001', 'OC', v_req, '40000000-0000-4000-8000-000000000001')
      returning id into v_orden;
    insert into public.gastos (obra_id, origen, referencia_id, proveedor_id, fecha_orden, valor_base, iva, centro_costo_id)
      values (v_obra, 'requisicion', v_orden, '40000000-0000-4000-8000-000000000001', current_date, 100000, 19000, v_centro_alterno)
      returning id into v_gasto;
    if not exists (select 1 from public.gastos where id = v_gasto and centro_costo_id = v_centro_alterno) then
      raise exception 'El gasto debe copiar el centro efectivo de la requisición en el momento de generarse';
    end if;

    -- La requisición vuelve a cambiar de centro: el gasto YA CREADO conserva el suyo (no se deriva en lectura).
    update public.requisiciones set centro_costo_id = v_centro_obra where id = v_req;
    if not exists (select 1 from public.gastos where id = v_gasto and centro_costo_id = v_centro_alterno) then
      raise exception 'El centro de costo de un gasto ya creado NO debe moverse cuando la requisición cambia de centro después';
    end if;

    -- gasto_distribucion expone el centro del gasto (no uno por obra repartida: no hay reparto aquí).
    if not exists (select 1 from public.gasto_distribucion where gasto_id = v_gasto and centro_costo_id = v_centro_alterno) then
      raise exception 'gasto_distribucion debe exponer centro_costo_id del gasto';
    end if;
  end;
end $$;

-- ---------------------------------------------------------------------------
-- 5) Sociedad incoherente: un centro atado a la sociedad A no puede asignarse a una requisición de la
--    sociedad B. Un centro COMPARTIDO (sociedad_id NULL) sí puede, sin importar la sociedad.
-- ---------------------------------------------------------------------------
do $$
declare v_centro_ictinos uuid; v_centro_compartido uuid; v_req uuid; begin
  select id into v_centro_ictinos from public.centros_costo where sociedad_id = '20000000-0000-4000-8000-000000000002' limit 1;
  if v_centro_ictinos is null then
    insert into public.centros_costo (nombre, sociedad_id) values ('Centro Ictinos Test', '20000000-0000-4000-8000-000000000002') returning id into v_centro_ictinos;
  end if;
  insert into public.centros_costo (nombre) values ('Centro Compartido Test') returning id into v_centro_compartido;

  insert into public.requisiciones (consecutivo, tipo, sociedad_id, obra_id, solicitante_id, canal)
    values ('', 'compra', '20000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'web')
    returning id into v_req;

  begin
    update public.requisiciones set centro_costo_id = v_centro_ictinos where id = v_req;
    raise exception 'Un centro de otra sociedad (Ictinos) debió rechazarse en una requisición de Mizar';
  exception when sqlstate '23514' then null;
  end;

  -- El compartido (sociedad_id NULL) sí se acepta en cualquier sociedad.
  update public.requisiciones set centro_costo_id = v_centro_compartido where id = v_req;
  if not exists (select 1 from public.requisiciones where id = v_req and centro_costo_id = v_centro_compartido) then
    raise exception 'Un centro de costo compartido (sociedad_id NULL) debe aceptarse en cualquier sociedad';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 6) Centro inactivo: rechazado igual que una obra/etiqueta inactiva.
-- ---------------------------------------------------------------------------
do $$
declare v_centro_inactivo uuid; v_req uuid; begin
  insert into public.centros_costo (nombre, sociedad_id, activo) values ('Centro Inactivo Test', '20000000-0000-4000-8000-000000000001', false) returning id into v_centro_inactivo;
  insert into public.requisiciones (consecutivo, tipo, sociedad_id, obra_id, solicitante_id, canal)
    values ('', 'compra', '20000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'web')
    returning id into v_req;
  begin
    update public.requisiciones set centro_costo_id = v_centro_inactivo where id = v_req;
    raise exception 'Un centro de costo inactivo debió rechazarse';
  exception when sqlstate '23514' then null;
  end;
end $$;

-- ---------------------------------------------------------------------------
-- 7) Caja menor: el gasto que genera hereda el centro de SU obra (no tiene noción propia) y lo
--    actualiza si el movimiento se edita hacia otra obra. Dos obras PROPIAS con centro explícito cada
--    una (no las sembradas por seed.sql, que nacen sin centro — punto 0).
-- ---------------------------------------------------------------------------
do $$
declare v_centro_obra1 uuid; v_centro_obra2 uuid; v_obra1 uuid; v_obra2 uuid; v_caja uuid; v_gasto uuid; begin
  insert into public.centros_costo (nombre, sociedad_id) values ('Centro Caja Menor 1 Test', '20000000-0000-4000-8000-000000000001') returning id into v_centro_obra1;
  insert into public.centros_costo (nombre, sociedad_id) values ('Centro Caja Menor 2 Test', '20000000-0000-4000-8000-000000000001') returning id into v_centro_obra2;
  insert into public.obras (nombre, sociedad_id, estado, centro_costo_id) values ('Obra Caja Menor 1 Test', '20000000-0000-4000-8000-000000000001', 'activa', v_centro_obra1) returning id into v_obra1;
  insert into public.obras (nombre, sociedad_id, estado, centro_costo_id) values ('Obra Caja Menor 2 Test', '20000000-0000-4000-8000-000000000001', 'activa', v_centro_obra2) returning id into v_obra2;

  insert into public.caja_menor (obra_id, fecha, concepto, etiqueta_id, valor, registrado_por)
    values (v_obra1, current_date, 'Test caja menor CC', (select id from public.etiquetas where nombre = 'Transporte'), 15000, '10000000-0000-4000-8000-000000000002')
    returning id, gasto_id into v_caja, v_gasto;
  if not exists (select 1 from public.gastos where id = v_gasto and centro_costo_id = v_centro_obra1) then
    raise exception 'Un gasto de caja menor debe nacer con el centro de costo de su obra';
  end if;

  update public.caja_menor set obra_id = v_obra2 where id = v_caja;
  if not exists (select 1 from public.gastos where id = v_gasto and centro_costo_id = v_centro_obra2) then
    raise exception 'Al mover un movimiento de caja menor a otra obra, el gasto debe seguir el centro de la obra nueva';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 8) Sin borrado físico: DELETE sobre centros_costo se bloquea igual que el resto de catálogos.
-- ---------------------------------------------------------------------------
do $$
declare v_centro uuid; begin
  insert into public.centros_costo (nombre) values ('Centro Para Borrar Test') returning id into v_centro;
  begin
    delete from public.centros_costo where id = v_centro;
    raise exception 'DELETE sobre centros_costo debió bloquearse (baja reversible con activo=false)';
  exception when sqlstate '55000' then null;
  end;
end $$;

rollback;
