-- Historial de cambios (ADM-08 / RF-1003) y «Daniel puede hacer todo» (decisión del cliente, 25-sep-2026).
--
-- 1) Índice para la pantalla de historial. GET /api/audit lista `auditoria` en orden cronológico
--    descendente con cursor (fecha, id) y SOLO los eventos de aplicación: los que escriben los
--    servicios con quién, qué y sobre qué. Las filas de los disparadores genéricos
--    (`escribir_auditoria`: INSERT/UPDATE/DELETE/STATE_CHANGE, y KAPSO_PROCESSING_*) son la copia fila a
--    fila de cada tabla: sin actor (el Postgres autoalojado no pone `request.jwt.claim.sub`) y varias
--    por cada cambio de negocio. Son la mayoría de la tabla, y por eso el índice es PARCIAL: la consulta
--    repite exactamente este predicado (lib/infrastructure/audit-log-repository.ts) para que el
--    planificador lo use. El índice existente `auditoria_entidad_idx` (entidad, entidad_id, fecha) sirve
--    al historial de UNA requisición, no a un listado global por fecha.
create index if not exists auditoria_eventos_app_fecha_idx
  on public.auditoria (fecha desc, id desc)
  where evento not in ('INSERT', 'UPDATE', 'DELETE', 'STATE_CHANGE') and evento not like 'KAPSO\_PROCESSING\_%';

-- 2) Permisos nuevos dentro de las excepciones ya guardadas en Configuración → Permisos por rol.
--    Un rol CON excepción guardada (`configuracion.permisos_por_rol_v1`) usa esa lista tal cual y no ve
--    los defaults de lib/domain/rules.ts. Los permisos creados hoy no existían cuando alguien guardó esa
--    excepción, así que nadie decidió negarlos: sin este paso, un revisor con excepción no recibiría
--    lo que el cliente decidió darle, y un admin_mizar o admin_sixteam con excepción PERDERÍA lo que
--    antes tenía por nombre de rol (consultar usuarios, restablecer claves, portal público, pantallas).
--    Solo se AÑADEN, sin duplicar y sin tocar nada de lo que ya había; un rol con "*" no se toca.
--    Si no hay fila (lo normal) no hace nada. La lista de cada rol es la diferencia entre su default de
--    hoy y el de ayer en rules.ts.
do $$
declare
  v_valor jsonb;
  v_nuevo jsonb;
  v_rol text;
  v_lista jsonb;
  v_permiso text;
  v_agregar text[];
begin
  select valor into v_valor from public.configuracion where clave = 'permisos_por_rol_v1';
  if v_valor is null or jsonb_typeof(v_valor) <> 'object' then return; end if;
  v_nuevo := v_valor;
  for v_rol, v_lista in select key, value from jsonb_each(v_valor) loop
    if jsonb_typeof(v_lista) <> 'array' or v_lista ? '*' then continue; end if;
    v_agregar := case v_rol
      when 'revisor' then array['catalog:manage', 'society:manage', 'requester:manage', 'user:read', 'user:manage', 'user:reset_password', 'public_access:manage', 'audit:read']
      when 'admin_mizar' then array['society:manage', 'requester:manage', 'user:read', 'user:reset_password', 'public_access:manage', 'screen:manage', 'audit:read']
      when 'admin_sixteam' then array['society:manage', 'requester:manage', 'user:read', 'user:manage', 'user:reset_password', 'public_access:manage', 'screen:manage', 'audit:read']
      else array[]::text[]
    end;
    foreach v_permiso in array v_agregar loop
      if not v_lista ? v_permiso then v_lista := v_lista || to_jsonb(v_permiso); end if;
    end loop;
    v_nuevo := jsonb_set(v_nuevo, array[v_rol], v_lista);
  end loop;
  if v_nuevo is distinct from v_valor then
    update public.configuracion set valor = v_nuevo, updated_at = now() where clave = 'permisos_por_rol_v1';
  end if;
end $$;
