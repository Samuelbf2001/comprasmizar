-- ÓRDENES DE PAGO Y CAJA MENOR — paquete N1 (PRD-pagos-y-caja-menor.md §4.4/§5 RF-507/RF-508/RF-510,
-- decisiones A3/A4/A5 de docs/TASKS-pagos-y-caja.md). Un pago registrado se puede ANULAR (nunca borrar)
-- con motivo; el comprobante de pago es un adjunto polimórfico con entidad `pago_orden`; y `pagos_orden`
-- entra en la auditoría genérica (hasta hoy era la única tabla operativa que no escribía en `auditoria`
-- por trigger). Aditiva e idempotente: ningún DROP de columna/tabla, ningún ALTER TYPE ... ADD VALUE.
-- El medio "Caja" de la caja menor es el valor `efectivo` YA existente del enum `medio_pago` (A1): se
-- reetiqueta en la UI, no aquí.
--
-- ORDEN DELIBERADO del archivo: (1) columnas nuevas en pagos_orden, (2) trigger anti-sobrepago
-- reescrito para ignorar anulados, (3) auditoría + RLS de anulación, (4) entidad `pago_orden` en
-- `adjuntos` (mismo patrón con el que 202608240003 definió requisicion/requisicion_item/caja_menor: check
-- de metadata, validador de path, existencia del padre, lectura por RLS y policy de Storage).

-- ---------------------------------------------------------------------------
-- 1) pagos_orden: nota y anulación
-- ---------------------------------------------------------------------------
-- `anulado` NOT NULL DEFAULT false: toda fila existente sigue siendo un pago VIGENTE sin backfill. Las
-- cuatro columnas de anulación viajan juntas: el check `pagos_orden_anulacion_coherente` impide un pago
-- "anulado" sin motivo ni fecha, y un motivo colgado de un pago que no está anulado no hace daño (queda
-- como texto, la lectura solo mira `anulado`).
alter table public.pagos_orden add column if not exists nota text;
alter table public.pagos_orden add column if not exists anulado boolean not null default false;
alter table public.pagos_orden add column if not exists motivo_anulacion text;
alter table public.pagos_orden add column if not exists anulado_por uuid references public.usuarios(id) on delete set null;
alter table public.pagos_orden add column if not exists anulado_en timestamptz;
comment on column public.pagos_orden.anulado is
  'RF-510: un pago se ANULA, nunca se borra. Anulado = no cuenta para el saldo pagado (trigger validar_pago_no_excede_orden, Order.paidAmount) pero sigue visible, tachado, en la ficha.';
comment on column public.pagos_orden.nota is 'Nota libre del pago (RF-507), distinta de referencia_externa (número de transferencia/consignación).';

do $$ begin
  alter table public.pagos_orden add constraint pagos_orden_anulacion_coherente
    check (not anulado or (nullif(btrim(motivo_anulacion), '') is not null and anulado_en is not null));
exception when duplicate_object then null; end $$;

-- Índices parciales sobre los pagos VIGENTES: el `left join lateral` de las órdenes (postgres-repositories)
-- y el cierre de caja (medio = efectivo en un rango de fechas, RF-708) solo miran filas no anuladas.
create index if not exists pagos_orden_vigentes_idx on public.pagos_orden(orden_id, fecha) where not anulado;
create index if not exists pagos_orden_medio_fecha_idx on public.pagos_orden(medio_pago, fecha) where not anulado;

-- ---------------------------------------------------------------------------
-- 2) Trigger anti-sobrepago: ignora anulados. Reescritura completa de la versión de 202609120002.
-- ---------------------------------------------------------------------------
-- Un pago anulado nunca puede "exceder" nada (no cuenta), y al sumar lo previo se dejan fuera los
-- anulados — de lo contrario anular un pago no liberaría saldo y el reemplazo sería rechazado. El
-- trigger se recrea con `anulado` en su lista de columnas: un UPDATE que REACTIVE un pago (anulado
-- true -> false, algo que la aplicación no hace pero SQL directo podría) vuelve a pasar por la regla.
create or replace function public.validar_pago_no_excede_orden()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_total numeric(16,2);
  v_pagado_previo numeric(16,2);
begin
  if new.anulado then return new; end if;

  select g.valor_total into v_total
    from public.gastos g
   where g.origen = 'requisicion' and g.referencia_id = new.orden_id;
  if v_total is null then
    raise exception 'La orden % no tiene un gasto asociado; no se puede registrar un pago', new.orden_id
      using errcode = '23514';
  end if;

  select coalesce(sum(valor), 0) into v_pagado_previo
    from public.pagos_orden
   where orden_id = new.orden_id and id <> new.id and not anulado;

  if v_pagado_previo + new.valor > v_total then
    raise exception 'El pago de % excede el saldo pendiente de la orden % (pagado %, total %)',
      new.valor, new.orden_id, v_pagado_previo, v_total
      using errcode = '23514';
  end if;
  return new;
end; $$;

drop trigger if exists pagos_orden_no_excede on public.pagos_orden;
create trigger pagos_orden_no_excede before insert or update of valor, orden_id, anulado on public.pagos_orden
  for each row execute function public.validar_pago_no_excede_orden();

-- ---------------------------------------------------------------------------
-- 3) Auditoría genérica y RLS de anulación
-- ---------------------------------------------------------------------------
-- `pagos_orden` nació (202609120002) fuera del loop de `escribir_auditoria` de 202608240001: registrar
-- y anular pagos quedaba solo en los eventos de dominio de `ordenes`. RF-1003 pide que registro y
-- anulación queden auditados fila por fila, como cualquier otra tabla operativa.
do $$ begin
  create trigger pagos_orden_auditoria after insert or update or delete on public.pagos_orden
    for each row execute function public.escribir_auditoria();
exception when duplicate_object then null; end $$;

-- Anular es un UPDATE: la única policy de escritura hasta hoy era de INSERT. Mismo conjunto de roles
-- que `payment:register` (revisor/contabilidad/admin_sixteam), igual que la policy de alta.
do $$ begin
  create policy "pagos_orden_anulacion_operativa" on public.pagos_orden for update to authenticated using (
    public.is_active_user() and (public.can_operate_compras() or public.has_role('contabilidad'))
  ) with check (
    public.is_active_user() and (public.can_operate_compras() or public.has_role('contabilidad'))
  );
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- 4) Comprobante de pago = adjunto con entidad `pago_orden` (A5: cero tablas nuevas)
-- ---------------------------------------------------------------------------
-- 4a) El check de la columna `entidad` (202608240001) enumera las entidades admitidas: se recrea con
--     `pago_orden`. Es un CHECK, no una columna ni datos: recrearlo es la única forma de ampliarlo.
alter table public.adjuntos drop constraint if exists adjuntos_entidad_check;
alter table public.adjuntos add constraint adjuntos_entidad_check
  check (entidad in ('requisicion', 'requisicion_item', 'orden', 'proveedor', 'gasto', 'caja_menor', 'pago_orden'));

-- 4b) Path canónico: pagos-orden/<pago_uuid>/<adjunto_uuid>/<nombre_seguro> (mismo molde que caja-menor).
create or replace function public.path_adjunto_generico_valido(p_path text)
returns boolean language sql immutable set search_path = public as $$
  select coalesce(p_path ~
    '^(requisiciones|requisicion-items|caja-menor|pagos-orden)/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[a-z0-9][a-z0-9._-]{0,127}$', false);
$$;

create or replace function public.entidad_adjunto_desde_path(p_path text)
returns text language sql immutable set search_path = public as $$
  select case split_part(p_path, '/', 1)
    when 'requisiciones' then 'requisicion'
    when 'requisicion-items' then 'requisicion_item'
    when 'caja-menor' then 'caja_menor'
    when 'pagos-orden' then 'pago_orden'
    else null
  end;
$$;

create or replace function public.adjunto_generico_existe(p_entidad text, p_entidad_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select case p_entidad
    when 'requisicion' then exists (select 1 from public.requisiciones where id = p_entidad_id)
    when 'requisicion_item' then exists (select 1 from public.requisicion_items where id = p_entidad_id)
    when 'caja_menor' then exists (select 1 from public.caja_menor where id = p_entidad_id)
    when 'pago_orden' then exists (select 1 from public.pagos_orden where id = p_entidad_id)
    else false
  end;
$$;

-- 4c) Lectura: el comprobante de un pago lo ven los mismos roles que ven `pagos_orden` por operación
--     (compras y contabilidad) — el contador es justamente quien cruza comprobantes (PRD §4.3). Versión
--     VIGENTE de esta función = la de 202609110005 (aprobador real vía es_aprobador_de), más `pago_orden`.
create or replace function public.puede_leer_adjunto(p_entidad text, p_entidad_id uuid, p_usuario_id uuid default auth.uid())
returns boolean language sql stable security definer set search_path = public as $$
  select p_usuario_id = auth.uid() and public.is_active_user(p_usuario_id) and case p_entidad
    when 'requisicion' then exists (
      select 1 from public.requisiciones r
      where r.id = p_entidad_id and (
        public.can_operate_compras(p_usuario_id) or public.has_role('contabilidad', p_usuario_id)
        or r.solicitante_id = p_usuario_id
        or public.es_aprobador_de(r.id, p_usuario_id)
      )
    )
    when 'requisicion_item' then exists (
      select 1 from public.requisicion_items ri
      join public.requisiciones r on r.id = ri.requisicion_id
      where ri.id = p_entidad_id and (
        public.can_operate_compras(p_usuario_id) or public.has_role('contabilidad', p_usuario_id)
        or r.solicitante_id = p_usuario_id
        or public.es_aprobador_de(r.id, p_usuario_id)
      )
    )
    when 'caja_menor' then public.can_operate_compras(p_usuario_id) or public.has_role('contabilidad', p_usuario_id)
    when 'pago_orden' then public.can_operate_compras(p_usuario_id) or public.has_role('contabilidad', p_usuario_id)
    when 'proveedor' then public.can_operate_compras(p_usuario_id) or public.can_manage_catalogos(p_usuario_id) or public.has_role('contabilidad', p_usuario_id)
    when 'orden' then exists (
      select 1 from public.ordenes o join public.requisiciones r on r.id = o.requisicion_id
      where o.id = p_entidad_id and (
        public.can_operate_compras(p_usuario_id) or public.has_role('contabilidad', p_usuario_id)
        or public.es_aprobador_de(r.id, p_usuario_id)
      )
    )
    when 'gasto' then public.is_reviewer_or_admin(p_usuario_id) or public.has_role('contabilidad', p_usuario_id)
    else false
  end;
$$;

-- 4d) Metadata canónica: `pago_orden` solo admite tipo 'soporte' (igual que caja_menor). El CHECK se
--     recrea NOT VALID, exactamente como lo instaló 202608240003 (no valida historia antigua).
alter table public.adjuntos drop constraint if exists adjuntos_genericos_documento_valido;
alter table public.adjuntos
  add constraint adjuntos_genericos_documento_valido check (
    entidad not in ('requisicion', 'requisicion_item', 'caja_menor', 'pago_orden') or (
      storage_bucket is not null and storage_bucket = 'requisicion-adjuntos'
      and (
        (entidad = 'requisicion' and tipo in ('soporte', 'cotizacion', 'foto'))
        or (entidad = 'requisicion_item' and tipo = 'foto')
        or (entidad = 'caja_menor' and tipo = 'soporte')
        or (entidad = 'pago_orden' and tipo = 'soporte')
      )
      and nombre_original ~ '^[a-z0-9][a-z0-9._-]{0,127}$'
      and position('..' in nombre_original) = 0
      and mime_type is not null and mime_type in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')
      and public.nombre_mime_adjunto_valido(nombre_original, mime_type)
      and tamano_bytes is not null and tamano_bytes > 0 and tamano_bytes <= 20971520
      and public.path_adjunto_generico_valido(url_storage)
      and public.entidad_adjunto_desde_path(url_storage) = entidad
      and public.entidad_id_adjunto_desde_path(url_storage) = entidad_id
      and split_part(url_storage, '/', 3) = id::text
      and split_part(url_storage, '/', 4) = nombre_original
      and (checksum_sha256 is null or checksum_sha256 ~ '^[a-f0-9]{64}$')
    )
  ) not valid;
comment on constraint adjuntos_genericos_documento_valido on public.adjuntos is
  'Se aplica a toda alta o cambio nuevo. Las filas genéricas históricas, si existen, requieren remediación antes de VALIDATE CONSTRAINT.';

create or replace function public.validar_adjunto_generico()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.entidad in ('requisicion', 'requisicion_item', 'caja_menor', 'pago_orden')
    and not public.adjunto_generico_existe(new.entidad, new.entidad_id) then
    raise exception 'El soporte debe pertenecer a una entidad existente' using errcode = '23503';
  end if;
  return new;
end;
$$;

create or replace function public.puede_leer_adjunto_generico_finalizado(
  p_adjunto_id uuid,
  p_entidad text,
  p_entidad_id uuid,
  p_storage_path text,
  p_storage_bucket text,
  p_tipo text,
  p_nombre text,
  p_mime text,
  p_tamano bigint,
  p_usuario_id uuid default auth.uid()
) returns boolean language sql stable security definer set search_path = public, storage as $$
  select p_usuario_id = auth.uid()
    and public.puede_leer_adjunto(p_entidad, p_entidad_id, p_usuario_id)
    and p_entidad in ('requisicion', 'requisicion_item', 'caja_menor', 'pago_orden')
    and p_storage_bucket = 'requisicion-adjuntos'
    and (
      (p_entidad = 'requisicion' and p_tipo in ('soporte', 'cotizacion', 'foto'))
      or (p_entidad = 'requisicion_item' and p_tipo = 'foto')
      or (p_entidad = 'caja_menor' and p_tipo = 'soporte')
      or (p_entidad = 'pago_orden' and p_tipo = 'soporte')
    )
    and p_nombre ~ '^[a-z0-9][a-z0-9._-]{0,127}$'
    and position('..' in p_nombre) = 0
    and p_mime in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')
    and public.nombre_mime_adjunto_valido(p_nombre, p_mime)
    and p_tamano > 0 and p_tamano <= 20971520
    and public.path_adjunto_generico_valido(p_storage_path)
    and public.entidad_adjunto_desde_path(p_storage_path) = p_entidad
    and public.entidad_id_adjunto_desde_path(p_storage_path) = p_entidad_id
    and split_part(p_storage_path, '/', 3) = p_adjunto_id::text
    and split_part(p_storage_path, '/', 4) = p_nombre
    and exists (
      select 1 from storage.objects o
      where o.bucket_id = p_storage_bucket and o.name = p_storage_path
    );
$$;

-- Los GRANT/REVOKE de 202608240003 sobre estas tres funciones se conservan: `create or replace` no
-- cambia la firma ni los privilegios (misma nota que 202609110005).

create index if not exists adjuntos_genericos_pago_orden_idx
  on public.adjuntos(entidad_id, fecha desc) where entidad = 'pago_orden';

-- 4e) Policies de lectura (adjuntos y Storage): misma forma que 202608240003, con la cuarta entidad
--     genérica en el `case`. Se recrean completas porque una policy no admite `or replace`.
drop policy if exists "adjuntos_lectura_operativa" on public.adjuntos;
create policy "adjuntos_lectura_operativa" on public.adjuntos for select to authenticated using (
  case when entidad in ('requisicion', 'requisicion_item', 'caja_menor', 'pago_orden') then
    public.puede_leer_adjunto_generico_finalizado(
      id, entidad, entidad_id, url_storage, storage_bucket, tipo, nombre_original, mime_type, tamano_bytes
    )
  else public.puede_leer_adjunto(entidad, entidad_id) end
);

drop policy if exists "mizar_storage_read" on storage.objects;
create policy "mizar_storage_read" on storage.objects for select to authenticated using (
  bucket_id = 'requisicion-adjuntos' and public.is_active_user()
  and exists (
    select 1 from public.adjuntos a
    where a.storage_bucket = storage.objects.bucket_id and a.url_storage = storage.objects.name
      and case when a.entidad in ('requisicion', 'requisicion_item', 'caja_menor', 'pago_orden') then
        public.puede_leer_adjunto_generico_finalizado(
          a.id, a.entidad, a.entidad_id, a.url_storage, a.storage_bucket, a.tipo,
          a.nombre_original, a.mime_type, a.tamano_bytes
        )
      else public.puede_leer_adjunto(a.entidad, a.entidad_id) end
  )
);

comment on column public.adjuntos.url_storage is
  'Clave Storage privada, nunca URL pública/firmada. Genérico: requisiciones|requisicion-items|caja-menor|pagos-orden/<entidad_uuid>/<adjunto_uuid>/<nombre_seguro>.';
