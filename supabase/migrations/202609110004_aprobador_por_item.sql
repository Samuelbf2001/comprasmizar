-- APROBADOR POR ÍTEM (Ernesto, 11-sep-2026, corrigiendo la lectura de la reunión: «no es aprobador por
-- tiempo, es aprobador por ítem: así como se puede declinar por ítem, se puede designar un aprobador
-- para todo o aprobadores por ítems»).
--
-- HERENCIA, no sustitución: `requisicion_items.aprobador_id` es OPCIONAL y nulo significa «lo decide el
-- aprobador de la cabecera». Por eso todo lo que ya está en vuelo sigue funcionando sin tocar una fila:
-- una requisición sin ningún aprobador por ítem se comporta exactamente como hasta hoy.
--
-- El número es …0004 y no …0003: `202609110003_estado_entrega_whatsapp.sql` ya está aplicada en
-- producción. Dos migraciones con el mismo prefijo se pisan en `apply-migrations.sh` (una se aplica y la
-- otra se da por hecha), y ese fallo no avisa.

alter table public.requisicion_items
  add column if not exists aprobador_id uuid references public.usuarios(id) on delete restrict;

comment on column public.requisicion_items.aprobador_id is
  'Aprobador de ESTE ítem. NULL = hereda el de la cabecera (requisiciones.aprobador_id).';

-- Parcial: la inmensa mayoría de los ítems no lleva aprobador propio, y el índice solo tiene que servir
-- a «mis ítems pendientes», que siempre filtra por un aprobador concreto.
create index if not exists requisicion_items_aprobador_idx
  on public.requisicion_items(aprobador_id) where aprobador_id is not null;

-- ¿Le toca decidir a este usuario en esta requisición? Cabecera O algún ítem suyo.
--
-- SECURITY DEFINER no es adorno: esta función se usa dentro de la policy de SELECT de
-- `requisicion_items`, y leer esa misma tabla desde su propia policy volvería a evaluarla en bucle.
-- Al correr como definidor, la consulta interna no pasa por RLS y la recursión no existe.
create or replace function public.es_aprobador_de(p_requisicion uuid, p_user_id uuid default auth.uid())
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.requisiciones r where r.id = p_requisicion and r.aprobador_id = p_user_id
  ) or exists (
    select 1 from public.requisicion_items i where i.requisicion_id = p_requisicion and i.aprobador_id = p_user_id
  );
$$;

-- Mismo listón que el aprobador de cabecera (`validar_aprobador_requisicion`, 202609070001): activo y
-- elegible. Sin esto, por ítem se podría designar a alguien sin rol aprobador — justo el control que la
-- cabecera sí tiene, evitado por la puerta de al lado.
create or replace function public.validar_aprobador_item()
returns trigger language plpgsql security definer set search_path = public as $$ begin
  if new.aprobador_id is not null and not public.es_aprobador_elegible(new.aprobador_id) then
    raise exception 'El aprobador asignado a un ítem debe ser un usuario activo y elegible' using errcode = '23514';
  end if;
  return new;
end; $$;

do $$ begin
  create trigger requisicion_items_aprobador_elegible before insert or update of aprobador_id on public.requisicion_items
    for each row execute function public.validar_aprobador_item();
exception when duplicate_object then null; end $$;

-- HERMANO de `validar_baja_usuario_aprobador_requisiciones` (202609070001), que solo mira
-- `requisiciones.aprobador_id`. Sin esta ampliación se podía dar de baja a quien tiene ítems esperando
-- su decisión y dejarlos huérfanos sin un solo aviso — el mismo agujero que aquella cerró para la
-- cabecera, abierto otra vez por el camino nuevo.
create or replace function public.validar_baja_usuario_aprobador_requisiciones()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_pendientes integer; begin
  if old.estado = 'activo' and new.estado = 'inactivo' then
    select count(*) into v_pendientes from public.requisiciones r
      where r.estado = 'en_aprobacion' and (
        r.aprobador_id = old.id
        or exists (select 1 from public.requisicion_items i where i.requisicion_id = r.id and i.aprobador_id = old.id)
      );
    if v_pendientes > 0 then
      raise exception 'No se puede desactivar: es aprobador de % requisición(es) en aprobación; reasígnelas antes de dar de baja' , v_pendientes
        using errcode = '23514';
    end if;
  end if;
  return new;
end; $$;

-- `en_aprobacion → declinada` NO EXISTÍA. Con aprobador por ítem sí hace falta: si todos los ítems
-- acaban declinados no hay nada que aprobar, y sin esta transición la requisición se quedaría atascada
-- en aprobación para siempre. Se abre aquí y en `TRANSITIONS` de lib/domain/rules.ts; tenerlo en un solo
-- sitio haría que el dominio y la base discrepasen, que es peor que no tenerlo en ninguno.
create or replace function public.validar_transicion_requisicion()
returns trigger language plpgsql as $$ begin
  if new.estado = old.estado then return new; end if;
  if not ((old.estado = 'enviada' and new.estado = 'en_revision')
    or (old.estado = 'en_revision' and new.estado in ('en_aprobacion', 'declinada'))
    or (old.estado = 'en_aprobacion' and new.estado in ('aprobada', 'devuelta', 'declinada'))
    or (old.estado = 'devuelta' and new.estado = 'en_revision')) then
    raise exception 'Transición de requisición no permitida: % -> %', old.estado, new.estado using errcode = '23514';
  end if;
  return new;
end; $$;

-- RLS: las cuatro policies que miraban SOLO `r.aprobador_id` pasan a `es_aprobador_de`.
--
-- Sin esto, un aprobador por ítem no veía la requisición que tiene que decidir: ni sus ítems, ni el
-- historial, ni podía cerrar el estado. Hoy la aplicación no depende de estas policies —se conecta con
-- el rol dueño y autoriza en el servicio—, así que esto es defensa en profundidad, no la cerradura
-- principal; pero una policy que se queda corta es exactamente lo que nadie revisa el día que sí se
-- apoye en ella.
-- `requisiciones_select` PRIMERO, y no es una más de la lista: la policy de `requisicion_items` hace un
-- `exists` contra `requisiciones`, y ese `exists` pasa por ESTA policy. Con la cabecera como único
-- criterio, un aprobador por ítem no podía leer ni su propio ítem — no porque la policy del ítem
-- estuviera mal, sino porque la de la requisición le cerraba la puerta antes. Lo cazó el arnés; leyendo
-- el diff no se ve.
drop policy if exists "requisiciones_select" on public.requisiciones;
create policy "requisiciones_select" on public.requisiciones for select to authenticated using (
  public.is_active_user() and (public.can_operate_compras() or public.has_role('contabilidad') or solicitante_id = auth.uid()
  or public.es_aprobador_de(id)
  )
);

drop policy if exists "requisiciones_aprobador_update" on public.requisiciones;
create policy "requisiciones_aprobador_update" on public.requisiciones for update to authenticated using (
  public.is_active_user() and estado = 'en_aprobacion' and public.es_aprobador_de(id)
) with check (
  -- 'declinada' entra en la lista por la transición nueva: el último aprobador que declina el último
  -- ítem cierra la requisición, y sin esto la policy le bloquearía justo ese cierre.
  public.is_active_user() and public.es_aprobador_de(id) and estado in ('aprobada', 'devuelta', 'declinada')
);

drop policy if exists "requisicion_items_select" on public.requisicion_items;
create policy "requisicion_items_select" on public.requisicion_items for select to authenticated using (
  public.is_active_user() and exists (select 1 from public.requisiciones r where r.id = requisicion_id and (
    public.can_operate_compras() or public.has_role('contabilidad') or r.solicitante_id = auth.uid()
    or public.es_aprobador_de(r.id)
  ))
);

drop policy if exists "ordenes_lectura_operativa" on public.ordenes;
create policy "ordenes_lectura_operativa" on public.ordenes for select to authenticated using (public.is_active_user() and (public.can_operate_compras() or public.has_role('contabilidad') or exists (
  select 1 from public.requisiciones r where r.id = requisicion_id and public.es_aprobador_de(r.id)
)));

drop policy if exists "historial_lectura" on public.requisicion_historial;
create policy "historial_lectura" on public.requisicion_historial for select to authenticated using (
  public.is_active_user() and exists (select 1 from public.requisiciones r where r.id = requisicion_id and (
    public.can_operate_compras() or public.has_role('contabilidad') or r.solicitante_id = auth.uid()
    or public.es_aprobador_de(r.id)
  ))
);

-- `requisicion_items_operador_write` NO se toca: escribir la decisión de un ítem sigue siendo del
-- operador de compras, y la decisión del aprobador entra por el servicio. Se deja constancia para que
-- no parezca un olvido, igual que la nota de `gastos_lectura_operativa` en 202609070001.

grant execute on function public.es_aprobador_de(uuid, uuid) to authenticated;
