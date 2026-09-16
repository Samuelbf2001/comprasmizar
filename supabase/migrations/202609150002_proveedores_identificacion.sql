-- ÓRDENES DE PAGO Y CAJA MENOR — paquete N2 (PRD-pagos-y-caja-menor.md §5 RF-601/RF-606, decisión A6 de
-- docs/TASKS-pagos-y-caja.md). El beneficiario de una orden de pago puede ser una EMPRESA (NIT) o una
-- PERSONA (cédula, cédula de extranjería, pasaporte): el topógrafo, el maestro de obra, el propio Daniel.
-- Una sola tabla (`proveedores`) para no duplicar catálogos; `nit` se CONSERVA como legado (lo leen el
-- PDF, el importador y `findSupplierDuplicate`) y pasa a ser un espejo de `identificacion` cuando el tipo
-- es NIT. Aditiva e idempotente: ningún DROP, ningún ALTER TYPE; `tipo_identificacion` es text con CHECK
-- (mismo criterio que `centros_costo.tipo` en N3), no un enum nuevo.
--
-- `pendiente_normalizacion` (RF-606): un beneficiario creado "al vuelo" desde el portal público o el
-- Flow de WhatsApp (solo identificación + nombre) queda marcado para que Daniel complete la ficha; es
-- el mismo patrón que `items.estado = 'pendiente_normalizacion'`, pero como booleano porque
-- `proveedores.activo` ya ocupa el eje de vigencia.

-- ---------------------------------------------------------------------------
-- 1) Columnas
-- ---------------------------------------------------------------------------
alter table public.proveedores add column if not exists tipo_identificacion text not null default 'NIT';
do $$ begin
  alter table public.proveedores add constraint proveedores_tipo_identificacion_check
    check (tipo_identificacion in ('NIT', 'CC', 'CE', 'PAS'));
exception when duplicate_object then null; end $$;
alter table public.proveedores add column if not exists identificacion text;
-- Misma normalización que `nit_normalizado` (202608240001): compara por forma (sin puntos, guiones ni
-- espacios), case-sensitive en las letras — "900.123.456-7" y "9001234567" son la misma identificación.
alter table public.proveedores add column if not exists identificacion_normalizada text
  generated always as (nullif(regexp_replace(coalesce(identificacion, ''), '[^0-9A-Za-z]', '', 'g'), '')) stored;
alter table public.proveedores add column if not exists pendiente_normalizacion boolean not null default false;
comment on column public.proveedores.tipo_identificacion is 'RF-601: NIT (empresa) o CC/CE/PAS (persona natural). `nit` queda como espejo legado cuando el tipo es NIT.';
comment on column public.proveedores.identificacion is 'RF-601/RF-606: identificación tal como se capturó; la unicidad es por (tipo, identificacion_normalizada).';
comment on column public.proveedores.pendiente_normalizacion is 'RF-606: creado al vuelo (portal/WhatsApp) con solo identificación + nombre; Daniel completa la ficha.';

-- ---------------------------------------------------------------------------
-- 2) Backfill: todo proveedor que ya tenía NIT lo conserva como identificación (tipo NIT por default)
-- ---------------------------------------------------------------------------
update public.proveedores set identificacion = nit where identificacion is null and nit is not null;

-- ---------------------------------------------------------------------------
-- 3) Unicidad por (tipo, identificación normalizada). Un NIT y una cédula con los mismos dígitos son
--    dos terceros distintos (tipos distintos); dos cédulas iguales, uno solo. `proveedores_nit_unico`
--    (sobre nit_normalizado) sigue vigente y, para tipo NIT, dice lo mismo por el espejo del punto 4.
-- ---------------------------------------------------------------------------
create unique index if not exists proveedores_identificacion_unico_idx
  on public.proveedores(tipo_identificacion, identificacion_normalizada) where identificacion_normalizada is not null;
create index if not exists proveedores_pendientes_normalizacion_idx
  on public.proveedores(razon_social) where pendiente_normalizacion;

-- ---------------------------------------------------------------------------
-- 4) `nit` e `identificacion` no pueden decir cosas distintas. Un solo trigger BEFORE mantiene el espejo
--    en las dos direcciones: el código nuevo escribe `identificacion` (y `nit` la sigue si el tipo es
--    NIT); el código legado (importador, catálogo viejo) sigue escribiendo solo `nit` (y `identificacion`
--    lo sigue). Para una persona (tipo ≠ NIT) `nit` queda NULL: una cédula no es un NIT, y así
--    `proveedores_nit_unico` no choca contra una empresa con los mismos dígitos.
-- ---------------------------------------------------------------------------
create or replace function public.sincronizar_identificacion_proveedor()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.tipo_identificacion = 'NIT' then
    if tg_op = 'UPDATE' and new.nit is distinct from old.nit and new.identificacion is not distinct from old.identificacion then
      new.identificacion := new.nit;
    else
      new.identificacion := coalesce(new.identificacion, new.nit);
      new.nit := new.identificacion;
    end if;
  else
    new.nit := null;
  end if;
  return new;
end; $$;

drop trigger if exists proveedores_identificacion on public.proveedores;
create trigger proveedores_identificacion before insert or update of nit, identificacion, tipo_identificacion on public.proveedores
  for each row execute function public.sincronizar_identificacion_proveedor();

-- ---------------------------------------------------------------------------
-- 5) Auditoría: la cédula de una persona es dato personal. Se reproduce el cuerpo VIGENTE de
--    `auditoria_campo_sensible` (202609010001) y se añaden `identificacion`/`identificacion_normalizada`
--    de proveedores — `nit` se deja visible como hasta hoy (identificador tributario de una empresa).
-- ---------------------------------------------------------------------------
create or replace function public.auditoria_campo_sensible(p_tabla text, p_clave text)
returns boolean language sql immutable set search_path = public as $$
  select p_clave = any(array[
    'password', 'key_hash', 'token_hash', 'public_code_hash', 'payload', 'payload_json',
    'datos_bancarios', 'contacto', 'telefono', 'telefono_destino', 'email', 'observaciones'
  ])
  or (p_tabla = 'requisiciones' and p_clave = any(array['solicitante_nombre_externo', 'solicitante_telefono_externo']))
  or (p_tabla = 'obra_solicitantes_autorizados' and p_clave = any(array['nombre', 'telefono_normalizado']))
  or (p_tabla = 'solicitantes_autorizados' and p_clave = any(array['nombre', 'telefono_normalizado']))
  or (p_tabla = 'usuarios' and p_clave = 'nombre')
  or (p_tabla = 'whatsapp_eventos' and p_clave = any(array['telefono', 'kapso_message_id']))
  or (p_tabla = 'adjuntos' and p_clave = any(array['url_storage', 'nombre_original', 'checksum_sha256', 'mime_type']))
  or (p_tabla = 'proveedores' and p_clave = any(array['identificacion', 'identificacion_normalizada']));
$$;
