-- ÓRDENES DE PAGO Y CAJA MENOR — paquete N3 (PRD-pagos-y-caja-menor.md §2.3/§5 RF-007/RF-009/RF-701,
-- decisiones A7/A8 de docs/TASKS-pagos-y-caja.md). Daniel lo dijo con claridad: el contador contabiliza
-- por la RAZÓN SOCIAL DEL RECIBO, Claudia mira el CENTRO DE COSTO — dos atributos independientes.
--   1) `centros_costo.tipo`: el catálogo crece más allá de las obras (gastos administrativos, personales
--      de socios, de la empresa/PROIM). text con CHECK, no un enum (misma convención que
--      `proveedores.tipo_identificacion` en N2: nada de ALTER TYPE).
--   2) `requisiciones.empresa_facturada_id`: la sociedad a cuyo nombre viene el soporte. Backfill =
--      `sociedad_id` (hasta hoy eran la misma cosa) y un trigger BEFORE que la deja por defecto en la
--      sociedad de la requisición cuando llega NULL — así toda alta legado (arneses, importación) sigue
--      funcionando y la columna puede ser NOT NULL. El dominio (`resolveBilledCompany`) es quien
--      propone el default "sociedad del centro de costo, si no la de la obra" en revisión; este trigger
--      es solo la red de la base.
--   3) `gastos.empresa_facturada_id`: INSTANTÁNEA copiada al crear el gasto (igual que centro_costo_id,
--      202609120001), nunca derivada en lectura. Backfill desde la requisición dueña (origen requisicion)
--      o la sociedad de la obra (origen caja_menor). NULLABLE a propósito: los arneses previos insertan
--      gastos sin mencionarla, y `saveExpense` es quien la fija para todo gasto nuevo.
-- Aditiva e idempotente: ningún DROP de columna/tabla, ningún ALTER TYPE.

-- ---------------------------------------------------------------------------
-- 1) centros_costo.tipo
-- ---------------------------------------------------------------------------
alter table public.centros_costo add column if not exists tipo text not null default 'obra';
do $$ begin
  alter table public.centros_costo add constraint centros_costo_tipo_check
    check (tipo in ('obra', 'administrativo', 'personal', 'empresa'));
exception when duplicate_object then null; end $$;
comment on column public.centros_costo.tipo is
  'RF-007: obra (default, los nacidos del backfill de 202609120001), administrativo, personal (socios) o empresa (p. ej. servicios de PROIM). Un centro no-obra no exige obra en la requisición.';

-- ---------------------------------------------------------------------------
-- 2) requisiciones.empresa_facturada_id
-- ---------------------------------------------------------------------------
alter table public.requisiciones add column if not exists empresa_facturada_id uuid references public.sociedades(id) on delete restrict;
comment on column public.requisiciones.empresa_facturada_id is
  'RF-009: sociedad a cuyo nombre viene el soporte (lo que contabiliza el contador), independiente del centro de costo. Default en dominio: sociedad del centro de costo, si no la de la obra; editable en revisión.';

update public.requisiciones set empresa_facturada_id = sociedad_id where empresa_facturada_id is null;

-- Red de la base: sin empresa facturada explícita, la de la requisición. Prefijo "1_" para disparar
-- DESPUÉS de `requisiciones_0_derivar_sociedad` (que resuelve sociedad_id desde la obra en el canal
-- público) y antes del resto de triggers BEFORE de la tabla — Postgres los ordena por nombre.
create or replace function public.derivar_empresa_facturada_requisicion()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.empresa_facturada_id is null then new.empresa_facturada_id := new.sociedad_id; end if;
  return new;
end; $$;
drop trigger if exists requisiciones_1_empresa_facturada on public.requisiciones;
create trigger requisiciones_1_empresa_facturada before insert or update of empresa_facturada_id, sociedad_id on public.requisiciones
  for each row execute function public.derivar_empresa_facturada_requisicion();

do $$
declare v_sin_empresa integer;
begin
  select count(*) into v_sin_empresa from public.requisiciones where empresa_facturada_id is null;
  if v_sin_empresa > 0 then
    raise exception 'Backfill de empresa facturada incompleto: % requisición(es) siguen sin empresa', v_sin_empresa;
  end if;
end $$;
alter table public.requisiciones alter column empresa_facturada_id set not null;

-- ---------------------------------------------------------------------------
-- 3) gastos.empresa_facturada_id (instantánea)
-- ---------------------------------------------------------------------------
alter table public.gastos add column if not exists empresa_facturada_id uuid references public.sociedades(id) on delete restrict;
comment on column public.gastos.empresa_facturada_id is
  'RF-009: INSTANTÁNEA de requisiciones.empresa_facturada_id al generar la orden (nunca derivada en lectura), o la sociedad de la obra para un gasto de caja menor.';

update public.gastos g
   set empresa_facturada_id = r.empresa_facturada_id
  from public.ordenes o join public.requisiciones r on r.id = o.requisicion_id
 where g.origen = 'requisicion' and g.referencia_id = o.id and g.empresa_facturada_id is null;

update public.gastos g
   set empresa_facturada_id = ob.sociedad_id
  from public.obras ob
 where g.origen = 'caja_menor' and ob.id = g.obra_id and g.empresa_facturada_id is null;

-- ---------------------------------------------------------------------------
-- 4) Índices: los filtros "empresa facturada" del panel de órdenes (RF-509) y del reporte (RF-707).
-- ---------------------------------------------------------------------------
create index if not exists requisiciones_empresa_facturada_idx on public.requisiciones(empresa_facturada_id);
create index if not exists gastos_empresa_facturada_periodo_idx on public.gastos(empresa_facturada_id, periodo);
