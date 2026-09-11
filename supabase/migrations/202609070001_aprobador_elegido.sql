-- Decisión del cliente (reunión 2026-09, literal de Daniel): "etiqueto a qué obra va y etiqueto quién
-- me va a aprobar" — el aprobador de una requisición ya NO se deriva de la etiqueta (antes: review()
-- exigía tagId, hacía tags.getApproverId(tagId) y guardaba ese usuario como approverId). Ahora lo elige
-- el revisor al revisar. La etiqueta se conserva como clasificación del gasto (alimenta el reporte por
-- etiqueta) y su aprobador pasa a ser solo una sugerencia por defecto en la pantalla.

-- requisiciones.aprobador_id: nullable porque se asigna en revisión, no al crear la requisición.
-- ON DELETE RESTRICT, mismo criterio que solicitante_id/creado_por sobre usuarios: no se puede borrar
-- físicamente un usuario referenciado (los catálogos se retiran con baja reversible, no DELETE).
alter table public.requisiciones add column if not exists aprobador_id uuid references public.usuarios(id) on delete restrict;

-- Backfill: toda requisición existente hereda el aprobador que hoy tenía por etiqueta (lectura actual,
-- vía left join etiquetas). Solo toca filas sin aprobador_id propio (idempotente ante un re-run).
-- QA Postgres real (bloqueante 3): SIN el filtro de elegibilidad de abajo, este backfill siembra el
-- problema desde el minuto cero — copia ciegamente `etiquetas.aprobador_id` aunque ese usuario ya no
-- sea elegible (p. ej. quedó inactivo después de que la etiqueta lo tuviera asignado). Con el filtro,
-- esas filas quedan en NULL: el revisor lo asigna de nuevo al revisar, en vez de heredar un aprobador
-- roto.
update public.requisiciones r set aprobador_id = e.aprobador_id
from public.etiquetas e
where e.id = r.etiqueta_id and r.aprobador_id is null and public.es_aprobador_elegible(e.aprobador_id);

create index if not exists requisiciones_aprobador_idx on public.requisiciones(aprobador_id);

-- Mismo contrato de elegibilidad que ya usa `validar_catalogos_activos_requisicion` para etiqueta_id
-- (public.es_aprobador_elegible): usuario activo con rol aprobador/revisor/admin_sixteam. Dispara solo
-- cuando aprobador_id cambia (insert, o update explícito de esa columna) — no en cada UPDATE de la fila.
-- QA Postgres real (bloqueante 3): `UPDATE OF aprobador_id` en Postgres dispara el trigger en cuanto
-- esa columna APARECE en el SET, cambie su valor o no — y `saveRequisition` (postgres-repositories.ts)
-- siempre la menciona en el `on conflict do update`. Sin el guard de abajo, el día que un aprobador ya
-- asignado deje de ser elegible, CUALQUIER guardado posterior de esa requisición (aunque no toque
-- aprobador_id) revienta con 23514 — un guardado no debería poder fallar por un dato que no está
-- cambiando. El guard compara contra old explícitamente: valida en INSERT siempre, y en UPDATE solo si
-- el valor realmente cambió.
create or replace function public.validar_aprobador_requisicion()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and new.aprobador_id is not distinct from old.aprobador_id then
    return new;
  end if;
  if new.aprobador_id is not null and not public.es_aprobador_elegible(new.aprobador_id) then
    raise exception 'El aprobador asignado a una requisición debe ser un usuario activo y elegible' using errcode = '23514';
  end if;
  return new;
end; $$;

do $$ begin
  create trigger requisiciones_aprobador_elegible before insert or update of aprobador_id on public.requisiciones
    for each row execute function public.validar_aprobador_requisicion();
exception when duplicate_object then null; end $$;

-- Hermano de `validar_baja_usuario_con_etiquetas_activas` (202608240001_core_compras.sql, ~línea 586):
-- esa función solo mira `etiquetas.aprobador_id` (el aprobador "por defecto" de una etiqueta). Desde
-- esta migración el aprobador REAL de una requisición vive en `requisiciones.aprobador_id`, así que la
-- baja de un usuario también debe revisar ahí — si no, se podía desactivar a alguien con
-- requisiciones esperando exactamente su decisión y dejarlas huérfanas de aprobador sin aviso.
create or replace function public.validar_baja_usuario_aprobador_requisiciones()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_pendientes integer; begin
  if old.estado = 'activo' and new.estado = 'inactivo' then
    select count(*) into v_pendientes from public.requisiciones
      where aprobador_id = old.id and estado = 'en_aprobacion';
    if v_pendientes > 0 then
      raise exception 'No se puede desactivar: es aprobador de % requisición(es) en aprobación; reasígnelas antes de dar de baja' , v_pendientes
        using errcode = '23514';
    end if;
  end if;
  return new;
end; $$;

do $$ begin
  create trigger usuarios_baja_aprobador_requisiciones before update of estado on public.usuarios
    for each row execute function public.validar_baja_usuario_aprobador_requisiciones();
exception when duplicate_object then null; end $$;

-- `limitar_actualizacion_aprobador` (202608240001_core_compras.sql, ~línea 776): un aprobador que no es
-- revisor/admin solo puede tocar {estado, motivo_devolucion, updated_at} al aprobar/devolver su propia
-- requisición — cualquier otra columna (incluida aprobador_id) ya queda bloqueada por el `is distinct
-- from` de ese trigger. Revisado: NO necesita cambiar. aprobador_id nunca estuvo, y no debe estar, en la
-- lista de columnas que un aprobador puede modificar.

-- Las policies RLS que identificaban al aprobador por la etiqueta (`exists (select 1 from etiquetas e
-- where e.id = etiqueta_id and e.aprobador_id = auth.uid())`, definidas en 202608240001_core_compras.sql
-- líneas 985-1033) pasan a leer directamente `requisiciones.aprobador_id = auth.uid()`. Nota honesta: la
-- app se conecta con un rol que evade RLS (el service role de Supabase), así que la autorización real de
-- producción vive en ProcurementService (lib/services/procurement-service.ts), no aquí. Estas policies se
-- corrigen de todos modos para que no queden mintiendo sobre el modelo de datos vigente — y protegen
-- cualquier acceso futuro que sí use un JWT de usuario final.
drop policy if exists "requisiciones_select" on public.requisiciones;
create policy "requisiciones_select" on public.requisiciones for select to authenticated using (
  public.is_active_user() and (public.can_operate_compras() or public.has_role('contabilidad') or solicitante_id = auth.uid()
  or aprobador_id = auth.uid()
  )
);

drop policy if exists "requisiciones_aprobador_update" on public.requisiciones;
create policy "requisiciones_aprobador_update" on public.requisiciones for update to authenticated using (
  public.is_active_user() and estado = 'en_aprobacion' and aprobador_id = auth.uid()
) with check (
  public.is_active_user() and aprobador_id = auth.uid() and estado in ('aprobada', 'devuelta')
);

drop policy if exists "requisicion_items_select" on public.requisicion_items;
create policy "requisicion_items_select" on public.requisicion_items for select to authenticated using (
  public.is_active_user() and exists (select 1 from public.requisiciones r where r.id = requisicion_id and (
    public.can_operate_compras() or public.has_role('contabilidad') or r.solicitante_id = auth.uid()
    or r.aprobador_id = auth.uid()
  ))
);

drop policy if exists "ordenes_lectura_operativa" on public.ordenes;
create policy "ordenes_lectura_operativa" on public.ordenes for select to authenticated using (public.is_active_user() and (public.can_operate_compras() or public.has_role('contabilidad') or exists (
  select 1 from public.requisiciones r where r.id = requisicion_id and r.aprobador_id = auth.uid()
)));

drop policy if exists "historial_lectura" on public.requisicion_historial;
create policy "historial_lectura" on public.requisicion_historial for select to authenticated using (
  public.is_active_user() and exists (select 1 from public.requisiciones r where r.id = requisicion_id and (
    public.can_operate_compras() or public.has_role('contabilidad') or r.solicitante_id = auth.uid()
    or r.aprobador_id = auth.uid()
  ))
);

-- Nota (grep de verificación del informe final): `gastos_lectura_operativa` (línea 1015 de la base) NUNCA
-- filtró por aprobador de etiqueta — usa is_reviewer_or_admin()/contabilidad. No hay policy de `gastos`
-- que tocar aquí; se deja constancia para que quede explícito y no parezca un olvido.
