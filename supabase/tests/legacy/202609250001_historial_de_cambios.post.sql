-- Post-check para 202609250001_historial_de_cambios.sql sobre la excepción legado de su .pre.sql: los
-- permisos nuevos se AÑADEN a revisor y admin_mizar, sin duplicar ni quitar nada de lo que ya había
-- (el revisor sigue sin payment:register), "*" y los roles sin permisos nuevos quedan intactos, y el
-- índice parcial del historial existe con el predicado que repite la consulta.
do $$
declare v_valor jsonb; v_permiso text;
begin
  select valor into v_valor from public.configuracion where clave = 'permisos_por_rol_v1';

  foreach v_permiso in array array['catalog:manage', 'society:manage', 'requester:manage', 'user:read', 'user:manage', 'user:reset_password', 'public_access:manage', 'audit:read', 'requisition:review', 'item:manage'] loop
    if not (v_valor -> 'revisor') ? v_permiso then
      raise exception 'Excepción legado: al revisor le falta % (obtenido %)', v_permiso, v_valor -> 'revisor';
    end if;
  end loop;
  if (v_valor -> 'revisor') ? 'payment:register' then
    raise exception 'Excepción legado: la migración no puede devolverle al revisor un permiso que se le quitó a propósito';
  end if;
  if (select count(*) from jsonb_array_elements_text(v_valor -> 'revisor') e) <> (select count(distinct e) from jsonb_array_elements_text(v_valor -> 'revisor') e) then
    raise exception 'Excepción legado: la lista del revisor quedó con repetidos (%)', v_valor -> 'revisor';
  end if;

  foreach v_permiso in array array['society:manage', 'requester:manage', 'user:read', 'user:reset_password', 'public_access:manage', 'screen:manage', 'audit:read', 'catalog:manage'] loop
    if not (v_valor -> 'admin_mizar') ? v_permiso then
      raise exception 'Excepción legado: a admin_mizar le falta % (obtenido %)', v_permiso, v_valor -> 'admin_mizar';
    end if;
  end loop;
  if (v_valor -> 'admin_mizar') ? 'user:manage' then
    raise exception 'Excepción legado: admin_mizar nunca administró usuarios; no puede ganar user:manage';
  end if;

  if v_valor -> 'admin_sixteam' <> '["*"]'::jsonb then
    raise exception 'Excepción legado: el comodín de admin_sixteam no se toca (obtenido %)', v_valor -> 'admin_sixteam';
  end if;
  if v_valor -> 'contabilidad' <> '["order:read", "order:account", "dashboard:read"]'::jsonb then
    raise exception 'Excepción legado: contabilidad no recibe permisos nuevos (obtenido %)', v_valor -> 'contabilidad';
  end if;

  if not exists (
    select 1 from pg_indexes
     where schemaname = 'public' and indexname = 'auditoria_eventos_app_fecha_idx'
       and indexdef like '%KAPSO%' and indexdef like '%STATE_CHANGE%'
  ) then
    raise exception 'Falta el índice parcial auditoria_eventos_app_fecha_idx del historial de cambios';
  end if;

  -- El seed y los arneses posteriores asumen la plataforma sin excepciones guardadas.
  delete from public.configuracion where clave = 'permisos_por_rol_v1';
end $$;
