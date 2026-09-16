-- ÓRDENES DE PAGO Y CAJA MENOR — paquete N4.1 (PRD-pagos-y-caja-menor.md RF-008: «Un CC de tipo
-- administrativo o personal no requiere obra»). Hasta hoy `gastos.obra_id` era NOT NULL, así que una
-- requisición contra un centro administrativo/personal/de empresa (servicios públicos de PROIM, gastos
-- de un socio) tenía que colgarse de una obra inventada para poder generar su gasto.
--
-- `requisiciones.obra_id` YA es nullable desde 202609010001; aquí se relaja `gastos.obra_id` con el
-- mismo `drop not null` documentado que usaron esa migración y 202609070003 (`gastos.fecha`). Nada de
-- `drop column`/`drop table`. La obligación no desaparece: se traslada a un trigger que la exige
-- EXACTAMENTE cuando corresponde — un gasto sin obra solo puede existir bajo un centro de costo cuyo
-- tipo NO sea `obra` (202609150003). Del lado de `requisiciones` la misma regla vive en el dominio
-- (`sendForApproval`, `costCenterRequiresWork` en lib/domain/rules.ts) y no en un trigger: una
-- requisición pasa por estados intermedios legítimos con centro y sin obra (canal público antes de la
-- revisión, borradores de revisión), y solo al enviarla a aprobación tiene sentido exigirla.
--
-- `caja_menor.obra_id` NO se toca (módulo que la adenda deja dormido, A10).

alter table public.gastos alter column obra_id drop not null;
comment on column public.gastos.obra_id is
  'RF-008: NULL solo para un gasto cuyo centro de costo no es de tipo obra (administrativo/personal/empresa) — lo exige el trigger gastos_obra_segun_centro. Con centro de tipo obra sigue siendo obligatoria.';

create or replace function public.validar_obra_gasto_segun_centro()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_tipo text;
begin
  if new.obra_id is not null then return new; end if;
  if new.centro_costo_id is null then
    raise exception 'Un gasto sin obra exige un centro de costo que no sea de tipo obra' using errcode = '23514';
  end if;
  select tipo into v_tipo from public.centros_costo where id = new.centro_costo_id;
  if v_tipo is null or v_tipo = 'obra' then
    raise exception 'Un gasto contra un centro de costo de tipo obra exige obra' using errcode = '23514';
  end if;
  return new;
end; $$;

drop trigger if exists gastos_obra_segun_centro on public.gastos;
create trigger gastos_obra_segun_centro before insert or update of obra_id, centro_costo_id on public.gastos
  for each row execute function public.validar_obra_gasto_segun_centro();
