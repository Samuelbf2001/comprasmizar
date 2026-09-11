-- La RLS de adjuntos decidía por el aprobador DE LA ETIQUETA, no por el de la requisición.
--
-- `puede_leer_adjunto` (202608240003) resuelve "¿puede este usuario ver este adjunto?" y para las tres
-- entidades colgadas de una requisición —requisicion, requisicion_item, orden— preguntaba por
-- `etiquetas.aprobador_id`. Eso quedó obsoleto el 2026-09-07, cuando el aprobador REAL pasó a
-- `requisiciones.aprobador_id` y la etiqueta se quedó solo con la sugerencia por defecto (migración
-- 202609070001). Nadie volvió aquí.
--
-- Se corrige en las DOS direcciones, y la segunda es la que importa:
--
--   - FALTABA: el aprobador de verdad —el que eligió el revisor— no tenía lectura por RLS. Y desde el
--     aprobador por ítem (202609110004), tampoco quien decide un ítem suelto.
--   - SOBRABA: quien figure como aprobador por defecto de una etiqueta podía leer los adjuntos de
--     CUALQUIER requisición con esa etiqueta, aunque su aprobador fuera otro. Dos requisiciones con la
--     misma etiqueta y aprobadores distintos es exactamente el caso que la migración de 2026-09-07
--     existía para separar.
--
-- NO ES UN AGUJERO VIVO: la aplicación se conecta con el rol dueño y autoriza en
-- `PrivateAttachmentService.assertRead`, así que estas policies son defensa en profundidad. Pero una
-- segunda capa que dice algo distinto de la primera no es defensa: es una trampa para el día que
-- alguien se apoye en ella. Ahora las dos dicen lo mismo, y lo dicen con la MISMA función.

create or replace function public.puede_leer_adjunto(p_entidad text, p_entidad_id uuid, p_usuario_id uuid default auth.uid())
returns boolean language sql stable security definer set search_path = public as $$
  select p_usuario_id = auth.uid() and public.is_active_user(p_usuario_id) and case p_entidad
    when 'requisicion' then exists (
      select 1 from public.requisiciones r
      where r.id = p_entidad_id and (
        public.can_operate_compras(p_usuario_id) or public.has_role('contabilidad', p_usuario_id)
        or r.solicitante_id = p_usuario_id
        -- Cabecera O ítem, con la misma función que usan las policies de requisiciones, items,
        -- historial y órdenes (202609110004). Una sola definición de "a quién le toca decidir aquí".
        or public.es_aprobador_de(r.id, p_usuario_id)
      )
    )
    when 'requisicion_item' then exists (
      select 1 from public.requisicion_items ri
      join public.requisiciones r on r.id = ri.requisicion_id
      where ri.id = p_entidad_id and (
        public.can_operate_compras(p_usuario_id) or public.has_role('contabilidad', p_usuario_id)
        or r.solicitante_id = p_usuario_id
        -- Por la requisición del ítem, no por el ítem: quien decide UN ítem ve las fotos de la
        -- requisición entera, igual que ve su cabecera. Acotar la foto al ítem propio sonaría más
        -- fino y sería peor: la foto del ítem de al lado es justo el contexto para decidir el suyo.
        or public.es_aprobador_de(r.id, p_usuario_id)
      )
    )
    when 'caja_menor' then public.can_operate_compras(p_usuario_id) or public.has_role('contabilidad', p_usuario_id)
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

-- Los GRANT y REVOKE de 202608240003 siguen valiendo: `create or replace` conserva los privilegios de
-- la función y no cambia su firma. Se deja dicho para que nadie los repita aquí "por si acaso" —
-- repetirlos es como se acaba concediendo a `authenticated` algo que se había revocado a conciencia.
