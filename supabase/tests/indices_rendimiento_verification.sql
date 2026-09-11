-- Verifica 202609100002_indices_rendimiento.sql: los índices nuevos para las consultas paginadas y los
-- agregados del dashboard (docs/plan-rendimiento.md, hallazgo H3) existen. Solo estructura (no hay
-- comportamiento data-dependiente que probar aquí, a diferencia de otros arneses de este directorio) —
-- mismo formato que aprobador_elegido_verification.sql: `do $$ ... raise exception ... $$`, `rollback`
-- al final. Registrado en scripts/verify-schema.ts.
begin;

do $$
declare v_faltantes text[];
begin
  select array_agg(nombre) into v_faltantes from (
    select unnest(array[
      'gastos_referencia_idx', 'gastos_fecha_idx', 'gastos_fecha_orden_id_idx',
      'requisiciones_updated_at_idx', 'requisiciones_created_at_id_idx',
      'ordenes_updated_at_idx', 'ordenes_fecha_generacion_id_idx',
      'caja_menor_fecha_id_idx'
    ]) as nombre
  ) esperados
  where not exists (
    select 1 from pg_indexes where schemaname = 'public' and indexname = esperados.nombre
  );
  if v_faltantes is not null then
    raise exception 'Faltan índices de rendimiento (H3): %', array_to_string(v_faltantes, ', ');
  end if;
end $$;

rollback;
