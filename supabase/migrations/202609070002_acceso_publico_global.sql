-- Decisión del cliente (reunión, literal): "yo digo que sea solamente una contraseña para todo el
-- mundo". El enlace del portal público SIGUE siendo por obra (obra + token HMAC en el fragmento `#`,
-- ver PUBLIC_FORM_CODE_PEPPER); lo que cambia es contra qué se compara el código que el solicitante
-- escribe: ya no es un hash por obra (`obras.public_code_hash`), sino un hash GLOBAL guardado en
-- `configuracion` (mismo patrón que `impuestos_v1`, ver 202608240001_core_compras.sql ~L412-422).
-- `public_submission_enabled` se conserva intacta: sigue decidiendo qué obras aceptan el portal —
-- solo cambia contra qué se valida el código, no quién puede usarlo.
-- Todo aditivo: no se dropea `public_code_hash` (queda obsoleta, comentada) ni ninguna tabla existente,
-- ningún ALTER TYPE ... ADD VALUE. No se toca 202608240001_core_compras.sql ni las demás migraciones.

-- ---------------------------------------------------------------------------
-- 1) Hash global en `configuracion`
-- ---------------------------------------------------------------------------
-- `codigo_hash` arranca en null: sin contraseña fijada, verificar_codigo_publico (más abajo) rechaza
-- todo por diseño en vez de "abrir" el portal por config vacía. Se fija desde la plataforma
-- (PATCH /api/public-access, lib/services/public-access-admin-service.ts), nunca por SQL manual.
insert into public.configuracion (clave, valor)
values ('acceso_publico_v1', '{"codigo_hash": null, "actualizado_en": null}'::jsonb)
on conflict (clave) do nothing;

-- ---------------------------------------------------------------------------
-- 2) obras: se relaja la constraint que exigía hash POR OBRA
-- ---------------------------------------------------------------------------
-- La constraint original ataba public_submission_enabled a un public_code_hash propio de la obra; con
-- el código global esa exigencia ya no tiene sentido — una obra puede aceptar el portal sin tener (ni
-- necesitar) su propio hash. No se dropea la columna: es una operación no aditiva que este repo evita
-- por norma, y borrar datos históricos de golpe no aporta nada frente a solo dejar de usarla.
alter table public.obras drop constraint if exists obras_codigo_publico_check;

comment on column public.obras.public_code_hash is 'OBSOLETA (202609070002): el código público pasó a ser GLOBAL. Ver configuracion.acceso_publico_v1 y public.verificar_codigo_publico. Esta columna ya no se lee ni se escribe; se conserva solo por compatibilidad histórica con datos previos a esta migración.';

-- ---------------------------------------------------------------------------
-- 3) Verificador global
-- ---------------------------------------------------------------------------
-- security definer + search_path fijo, mismo criterio que el resto de funciones de este módulo. Sin
-- hash configurado (codigo_hash null) devuelve false SIEMPRE: una config vacía nunca debe traducirse
-- en "cualquier código vale". stable (no muta nada) para que el planner pueda cachearla en la sentencia.
create or replace function public.verificar_codigo_publico(p_codigo text)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(
    (
      select (c.valor ->> 'codigo_hash') is not null
        and c.valor ->> 'codigo_hash' = extensions.crypt(p_codigo, c.valor ->> 'codigo_hash')
      from public.configuracion c
      where c.clave = 'acceso_publico_v1'
    ),
    false
  );
$$;

-- Mismo criterio que next_consecutivo: la app llama a esta función con la conexión propietaria
-- (DATABASE_URL), que conserva privilegios de dueño pese al revoke. Lo que este revoke cierra es la
-- exposición automática de PostgREST hacia anon/authenticated (como ya se hace con
-- crear_requisicion_publica/consultar_estado_requisicion_publica).
revoke all on function public.verificar_codigo_publico(text) from public, anon, authenticated;
