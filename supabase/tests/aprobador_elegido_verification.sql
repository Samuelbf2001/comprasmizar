-- Verifica 202609070001_aprobador_elegido.sql: el aprobador de una requisición ya NO se deriva de la
-- etiqueta (reunión 2026-09, decisión del cliente) — lo elige el revisor y se persiste en
-- requisiciones.aprobador_id. Sigue el mismo formato que schema_verification.sql: transacción +
-- bloques `do $$ ... $$` con `raise exception` en fallo, `rollback` al final.
--
-- Deliberadamente NO se registra en scripts/verify-schema.ts en este cambio (otro agente toca ese
-- archivo en paralelo); ver el informe final de esta tarea para cómo se ejecutó a mano contra el mismo
-- Postgres embebido.
begin;

-- La columna existe y es la fuente de verdad de lectura (ver getRequisition/listVisibleRequisitions en
-- lib/infrastructure/postgres-repositories.ts, que ya no hacen left join etiquetas para resolverla).
do $$ begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'requisiciones' and column_name = 'aprobador_id'
  ) then raise exception 'Falta columna requisiciones.aprobador_id'; end if;
  if not exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'requisiciones_aprobador_idx') then
    raise exception 'Falta índice requisiciones_aprobador_idx';
  end if;
  if (select count(*) from pg_trigger where not tgisinternal and tgname = 'requisiciones_aprobador_elegible') <> 1 then
    raise exception 'Falta el trigger de elegibilidad de aprobador_id';
  end if;
end $$;

-- Backfill: se reproduce el mismo UPDATE de la migración sobre una fila fresca cuyo aprobador_id se
-- fuerza a NULL primero (simula el estado "pre-backfill" de una requisición ya existente antes de esta
-- migración) — debe quedar copiado el aprobador_id de la etiqueta 'Materiales' (10000000-...-000003,
-- ver supabase/seed.sql).
do $$
declare v_req uuid; v_etiqueta uuid;
begin
  select id into v_etiqueta from public.etiquetas where nombre = 'Materiales';
  insert into public.requisiciones(consecutivo, tipo, obra_id, solicitante_id, canal, etiqueta_id)
    values ('', 'compra', '30000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'web', v_etiqueta)
    returning id into v_req;
  update public.requisiciones set aprobador_id = null where id = v_req;
  update public.requisiciones r set aprobador_id = e.aprobador_id
    from public.etiquetas e where e.id = r.etiqueta_id and r.aprobador_id is null and r.id = v_req;
  if not exists (select 1 from public.requisiciones where id = v_req and aprobador_id = '10000000-0000-0000-0000-000000000003') then
    raise exception 'El backfill no copió el aprobador_id de la etiqueta';
  end if;
end $$;

-- Asignar un usuario NO elegible (Solicitante Local, 10000000-...-000001: no tiene rol
-- aprobador/revisor/admin_sixteam) se rechaza con 23514, igual que ya rechaza etiquetas.aprobador_id.
do $$
declare v_req uuid;
begin
  insert into public.requisiciones(consecutivo, tipo, obra_id, solicitante_id, canal)
    values ('', 'compra', '30000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'web')
    returning id into v_req;
  begin
    update public.requisiciones set aprobador_id = '10000000-0000-0000-0000-000000000001' where id = v_req;
    raise exception 'Se pudo asignar un aprobador no elegible';
  exception when sqlstate '23514' then null;
  end;
end $$;

-- Asignar un usuario elegible funciona, y puede ser DISTINTO del aprobador por defecto de la etiqueta
-- de la misma requisición: 'Materiales' enruta por defecto a 10000000-...-000003 (Aprobador Local), pero
-- aquí se asigna 10000000-...-000006 (Admin Sixteam Local, también elegible) — es justo la decisión del
-- cliente: el revisor elige, la etiqueta solo sugiere.
do $$
declare v_req uuid; v_etiqueta uuid; v_etiqueta_aprobador uuid;
begin
  select id, aprobador_id into v_etiqueta, v_etiqueta_aprobador from public.etiquetas where nombre = 'Materiales';
  insert into public.requisiciones(consecutivo, tipo, obra_id, solicitante_id, canal, etiqueta_id)
    values ('', 'compra', '30000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'web', v_etiqueta)
    returning id into v_req;
  update public.requisiciones set aprobador_id = '10000000-0000-0000-0000-000000000006' where id = v_req;
  if not exists (select 1 from public.requisiciones where id = v_req and aprobador_id = '10000000-0000-0000-0000-000000000006') then
    raise exception 'No se pudo asignar un aprobador elegible';
  end if;
  if v_etiqueta_aprobador = '10000000-0000-0000-0000-000000000006' then
    raise exception 'Fixture inválido: el aprobador de la etiqueta ya coincidía con el asignado, la prueba no distingue nada';
  end if;
  if not exists (
    select 1 from public.requisiciones r join public.etiquetas e on e.id = r.etiqueta_id
    where r.id = v_req and r.aprobador_id is distinct from e.aprobador_id
  ) then raise exception 'La requisición no quedó con un aprobador distinto al de su etiqueta'; end if;
end $$;

rollback;
