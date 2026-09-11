-- Arnés de 202609110005_adjuntos_aprobador_por_item.sql. Registrado en scripts/verify-schema.ts.
-- Formato del repo: begin -> do $$ ... $$ -> rollback.
--
-- Se prueba `puede_leer_adjunto` DIRECTAMENTE, no a través de un `select` sobre `adjuntos`. Es la
-- función donde vive la decisión —la policy solo la compone con las comprobaciones de forma del
-- fichero (ruta, mime, nombre, tamaño)—, así que llamarla es probar lo que de verdad autoriza, sin
-- tener que fabricar una fila de adjunto que satisfaga media docena de restricciones de Storage que
-- no tienen nada que ver con quién puede leer.
--
-- La función exige `p_usuario_id = auth.uid()`, así que cada caso pone la identidad como la pone
-- PostgREST. Se devuelve al final: `reset role` quita el rol pero NO el GUC, y dejarlo puesto
-- contamina los bloques siguientes (ya pasó en el arnés del aprobador por ítem).
begin;

-- 1. Cabecera, ítem y ajeno sobre una requisición con los ítems repartidos.
do $$
declare
  v_req uuid; v_item_nelson uuid; v_item_juliana uuid;
  c_solicitante constant uuid := '10000000-0000-4000-8000-000000000001';
  c_cabecera    constant uuid := '10000000-0000-4000-8000-000000000003'; -- Nelson
  c_por_item    constant uuid := '10000000-0000-4000-8000-000000000007'; -- Juliana
  c_ajeno       constant uuid := '10000000-0000-4000-8000-0000000000cc';
begin
  insert into auth.users (id, instance_id, aud, role, email)
    values (c_ajeno, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'aprobador.ajeno.adj@mizar.test');
  insert into public.usuarios (id, nombre, email, estado)
    values (c_ajeno, 'Aprobador Ajeno Adjuntos', 'aprobador.ajeno.adj@mizar.test', 'activo');
  insert into public.usuario_roles (usuario_id, rol) values (c_ajeno, 'aprobador');

  insert into public.requisiciones(consecutivo, tipo, obra_id, solicitante_id, canal)
    values ('', 'compra', '30000000-0000-4000-8000-000000000001', c_solicitante, 'web')
    returning id into v_req;
  update public.requisiciones set aprobador_id = c_cabecera where id = v_req;
  insert into public.requisicion_items(requisicion_id, descripcion_libre, cantidad, unidad)
    values (v_req, 'Cemento', 20, 'bulto') returning id into v_item_nelson;
  insert into public.requisicion_items(requisicion_id, descripcion_libre, cantidad, unidad, aprobador_id)
    values (v_req, 'Arena', 3, 'm3', c_por_item) returning id into v_item_juliana;

  perform set_config('request.jwt.claim.sub', c_cabecera::text, true);
  if not public.puede_leer_adjunto('requisicion', v_req, c_cabecera) then
    raise exception 'el aprobador de cabecera no puede leer los adjuntos de su requisición';
  end if;

  perform set_config('request.jwt.claim.sub', c_por_item::text, true);
  if not public.puede_leer_adjunto('requisicion', v_req, c_por_item) then
    raise exception 'el aprobador por ítem no puede leer los adjuntos de la requisición que decide';
  end if;
  -- La foto del ítem AJENO también: es el contexto para decidir el suyo, y la requisición ya la ve.
  if not public.puede_leer_adjunto('requisicion_item', v_item_nelson, c_por_item) then
    raise exception 'el aprobador por ítem no puede leer la foto de otro ítem de su misma requisición';
  end if;

  perform set_config('request.jwt.claim.sub', c_ajeno::text, true);
  if public.puede_leer_adjunto('requisicion', v_req, c_ajeno) then
    raise exception 'un aprobador ajeno lee adjuntos de una requisición que no decide';
  end if;
  if public.puede_leer_adjunto('requisicion_item', v_item_juliana, c_ajeno) then
    raise exception 'un aprobador ajeno lee la foto de un ítem que no decide';
  end if;

  perform set_config('request.jwt.claim.sub', '', true);
end $$;

-- 2. LO QUE SOBRABA: el aprobador por defecto de la ETIQUETA ya no lee por serlo.
--    Es la mitad menos obvia del arreglo. `puede_leer_adjunto` preguntaba por `etiquetas.aprobador_id`,
--    que desde 2026-09-07 es solo una sugerencia: dos requisiciones con la misma etiqueta pueden tener
--    aprobadores distintos, y quien figure en la etiqueta podía leer los adjuntos de ambas.
do $$
declare
  v_req uuid; v_etiqueta uuid;
  c_cabecera constant uuid := '10000000-0000-4000-8000-000000000003'; -- Nelson, aprueba la requisición
  c_etiqueta constant uuid := '10000000-0000-4000-8000-000000000007'; -- Juliana, aprueba la etiqueta
begin
  -- "Nomina" es de Juliana en el seed; la requisición la aprueba Nelson.
  select id into v_etiqueta from public.etiquetas where aprobador_id = c_etiqueta and activa limit 1;
  if v_etiqueta is null then raise exception 'el seed ya no trae una etiqueta activa de ese aprobador'; end if;

  insert into public.requisiciones(consecutivo, tipo, obra_id, solicitante_id, canal, etiqueta_id)
    values ('', 'compra', '30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'web', v_etiqueta)
    returning id into v_req;
  update public.requisiciones set aprobador_id = c_cabecera where id = v_req;

  perform set_config('request.jwt.claim.sub', c_etiqueta::text, true);
  if public.puede_leer_adjunto('requisicion', v_req, c_etiqueta) then
    raise exception 'el aprobador de la ETIQUETA lee adjuntos de una requisición cuyo aprobador es otro';
  end if;

  -- Control: el aprobador de verdad sí lee. Sin esto, el aserto de arriba pasaría aunque la función
  -- hubiera dejado de dar lectura a todo el mundo.
  perform set_config('request.jwt.claim.sub', c_cabecera::text, true);
  if not public.puede_leer_adjunto('requisicion', v_req, c_cabecera) then
    raise exception 'el control falló: el aprobador asignado tampoco lee';
  end if;

  perform set_config('request.jwt.claim.sub', '', true);
end $$;

-- 3. Lo que NO cambia: el resto de entidades conserva su criterio. Ampliar una rama no puede ampliar
--    las vecinas, y `proveedor` es la más sensible (expediente privado, migración 202608240002).
do $$
declare c_cabecera constant uuid := '10000000-0000-4000-8000-000000000003';
begin
  perform set_config('request.jwt.claim.sub', c_cabecera::text, true);
  if public.puede_leer_adjunto('proveedor', '40000000-0000-4000-8000-000000000001', c_cabecera) then
    raise exception 'un aprobador lee el expediente de un proveedor';
  end if;
  if public.puede_leer_adjunto('gasto', '40000000-0000-4000-8000-000000000001', c_cabecera) then
    raise exception 'un aprobador lee adjuntos de gasto';
  end if;
  perform set_config('request.jwt.claim.sub', '', true);
end $$;

rollback;
