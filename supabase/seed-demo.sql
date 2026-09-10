-- Datos de DEMOSTRACIÓN. Opcional y separado de supabase/seed.sql a propósito: seed.sql siembra los
-- maestros mínimos (usuarios, sociedades, obras, etiquetas, proveedores, ítems) que cualquier entorno
-- necesita; esto añade movimiento — requisiciones en todos los estados, órdenes, gastos y caja menor —
-- para que las bandejas y el dashboard tengan algo que mostrar.
--
-- Lo aplica scripts/dev-db.ts salvo que se pase --no-demo. NUNCA debe aplicarse en producción.
--
-- Dos decisiones que valen la pena:
--
-- 1. Las requisiciones NO se insertan ya aprobadas: nacen en 'enviada' y suben por el embudo con
--    UPDATE, uno por transición. El trigger validar_transicion_requisicion solo vigila los UPDATE
--    (un INSERT directo en 'aprobada' pasaría sin chistar), así que recorrer el camino real es lo
--    único que garantiza que estos datos sean alcanzables por la aplicación — y de paso
--    registrar_historial_requisicion llena requisicion_historial, que es lo que pinta la línea de
--    tiempo en la pantalla de detalle. Datos demo que la aplicación no habría podido producir son
--    una trampa: enseñan pantallas que no existen.
--
-- 2. Las fechas son relativas a `current_date`, no fijas. Un seed con fechas de agosto de 2026 deja
--    el dashboard vacío en cuanto pasa el mes, porque el corte es mensual.
do $$
declare
  v_solicitante uuid := '10000000-0000-0000-0000-000000000001';
  v_revisor     uuid := '10000000-0000-0000-0000-000000000002';
  v_aprobador   uuid := '10000000-0000-0000-0000-000000000003';
  v_contab      uuid := '10000000-0000-0000-0000-000000000004';
  v_obra1 uuid := '30000000-0000-0000-0000-000000000001';
  v_obra2 uuid := '30000000-0000-0000-0000-000000000002';
  v_obra3 uuid := '30000000-0000-0000-0000-000000000003';
  v_soc1 uuid := '20000000-0000-0000-0000-000000000001';
  v_soc2 uuid := '20000000-0000-0000-0000-000000000002';
  v_soc3 uuid := '20000000-0000-0000-0000-000000000003';
  v_prov1 uuid := '40000000-0000-0000-0000-000000000001';
  v_prov2 uuid := '40000000-0000-0000-0000-000000000002';
  v_prov3 uuid := '40000000-0000-0000-0000-000000000003';
  v_et_mat uuid; v_et_serv uuid; v_et_herr uuid; v_et_transp uuid;
  v_cemento uuid; v_arena uuid; v_varilla uuid; v_ladrillo uuid; v_pintura uuid;
  v_cable uuid; v_guantes uuid; v_flete uuid; v_excav uuid; v_disco uuid;
  v_req uuid; v_orden uuid;
begin
  -- Guardia de idempotencia: si ya hay movimiento demo, no se duplica.
  if exists (select 1 from public.requisiciones where consecutivo like 'REQ-%' limit 1) then
    raise notice 'seed-demo: ya hay requisiciones, no se siembra de nuevo';
    return;
  end if;

  select id into v_et_mat    from public.etiquetas where nombre = 'Materiales';
  select id into v_et_serv   from public.etiquetas where nombre = 'Servicios';
  select id into v_et_herr   from public.etiquetas where nombre = 'Herramientas';
  select id into v_et_transp from public.etiquetas where nombre = 'Transporte';

  select id into v_cemento  from public.items where nombre_normalizado = 'cemento gris 50 kg';
  select id into v_arena    from public.items where nombre_normalizado = 'arena de rio';
  select id into v_varilla  from public.items where nombre_normalizado = 'varilla corrugada 3 8';
  select id into v_ladrillo from public.items where nombre_normalizado = 'ladrillo hueco';
  select id into v_pintura  from public.items where nombre_normalizado = 'pintura blanca';
  select id into v_cable    from public.items where nombre_normalizado = 'cable electrico calibre 12';
  select id into v_guantes  from public.items where nombre_normalizado = 'guantes de seguridad';
  select id into v_flete    from public.items where nombre_normalizado = 'flete materiales';
  select id into v_excav    from public.items where nombre_normalizado = 'servicio de excavacion';
  select id into v_disco    from public.items where nombre_normalizado = 'disco de corte';

  -- Lista blanca del Flow de WhatsApp (RF-902): sin esto el canal rechaza toda requisición.
  insert into public.solicitantes_autorizados (nombre, telefono, activo) values
    ('Daniel Hernández', '3001234567', true),
    ('Nelson Ramírez', '3009876543', true),
    ('Claudia Restrepo', '3005550101', true)
  on conflict do nothing;

  -- ── 1. Recién llegada, esperando al revisor ────────────────────────────────────────────────
  v_req := gen_random_uuid();
  insert into public.requisiciones (id, consecutivo, tipo, obra_id, sociedad_id, solicitante_id, canal, fecha_requerida, destino, observaciones, etiqueta_id, estado, created_at)
  values (v_req, '', 'compra', v_obra1, v_soc1, v_solicitante, 'whatsapp', current_date + 3, 'Bodega obra 01', 'Urge para la fundida del viernes', v_et_mat, 'enviada', now() - interval '6 hours');
  insert into public.requisicion_items (requisicion_id, item_id, cantidad, unidad) values
    (v_req, v_cemento, 80, 'bulto'),
    (v_req, v_arena, 12, 'm3'),
    (v_req, v_varilla, 150, 'unidad');

  -- ── 2. En revisión: el revisor ya la tomó y está cotizando ─────────────────────────────────
  v_req := gen_random_uuid();
  insert into public.requisiciones (id, consecutivo, tipo, obra_id, sociedad_id, solicitante_id, canal, fecha_requerida, destino, etiqueta_id, estado, created_at)
  values (v_req, '', 'compra', v_obra2, v_soc2, v_solicitante, 'web', current_date + 5, 'Frente 2', v_et_herr, 'enviada', now() - interval '2 days');
  insert into public.requisicion_items (requisicion_id, item_id, cantidad, unidad, valor_base, iva, iva_tasa, posible_proveedor_texto) values
    (v_req, v_disco, 20, 'unidad', 12000, 2280, 0.19, 'Ferretería del centro'),
    (v_req, v_guantes, 30, 'par', 8000, 1520, 0.19, 'Dotaciones SAS');
  update public.requisiciones set estado = 'en_revision' where id = v_req;

  -- ── 3. En aprobación, esperando a Nelson ───────────────────────────────────────────────────
  v_req := gen_random_uuid();
  insert into public.requisiciones (id, consecutivo, tipo, obra_id, sociedad_id, solicitante_id, canal, fecha_requerida, destino, etiqueta_id, aprobador_id, estado, forma_pago, created_at)
  values (v_req, '', 'compra', v_obra1, v_soc1, v_solicitante, 'whatsapp', current_date + 2, 'Obra 01', v_et_mat, v_aprobador, 'enviada', 'Crédito 30 días', now() - interval '3 days');
  insert into public.requisicion_items (requisicion_id, item_id, cantidad, unidad, valor_base, iva, iva_tasa, proveedor_final_id) values
    (v_req, v_ladrillo, 2000, 'unidad', 1200, 228, 0.19, v_prov1),
    (v_req, v_pintura, 15, 'galon', 85000, 16150, 0.19, v_prov2);
  update public.requisiciones set estado = 'en_revision' where id = v_req;
  update public.requisiciones set estado = 'en_aprobacion' where id = v_req;

  -- ── 4. Devuelta al revisor: el aprobador pidió corregir ────────────────────────────────────
  v_req := gen_random_uuid();
  insert into public.requisiciones (id, consecutivo, tipo, obra_id, sociedad_id, solicitante_id, canal, fecha_requerida, etiqueta_id, aprobador_id, estado, created_at)
  values (v_req, '', 'compra', v_obra3, v_soc3, v_solicitante, 'web', current_date + 7, v_et_mat, v_aprobador, 'enviada', now() - interval '5 days');
  insert into public.requisicion_items (requisicion_id, item_id, cantidad, unidad, valor_base, iva, iva_tasa) values
    (v_req, v_cemento, 200, 'bulto', 32000, 6080, 0.19);
  update public.requisiciones set estado = 'en_revision' where id = v_req;
  update public.requisiciones set estado = 'en_aprobacion' where id = v_req;
  update public.requisiciones set estado = 'devuelta', motivo_devolucion = 'Cotizar con dos proveedores más antes de aprobar' where id = v_req;

  -- ── 5. Declinada por el revisor ────────────────────────────────────────────────────────────
  v_req := gen_random_uuid();
  insert into public.requisiciones (id, consecutivo, tipo, obra_id, sociedad_id, solicitante_id, canal, fecha_requerida, etiqueta_id, estado, created_at)
  values (v_req, '', 'compra', v_obra2, v_soc2, v_solicitante, 'whatsapp', current_date + 1, v_et_herr, 'enviada', now() - interval '8 days');
  insert into public.requisicion_items (requisicion_id, descripcion_libre, cantidad, unidad) values
    (v_req, 'Taladro percutor industrial', 2, 'unidad');
  update public.requisiciones set estado = 'en_revision' where id = v_req;
  update public.requisiciones set estado = 'declinada', motivo_declinacion = 'Ya hay dos taladros disponibles en la bodega central' where id = v_req;

  -- ── 6. Aprobada con orden PAGADA (obra 1, periodo actual) ──────────────────────────────────
  v_req := gen_random_uuid();
  insert into public.requisiciones (id, consecutivo, tipo, obra_id, sociedad_id, solicitante_id, canal, fecha_requerida, etiqueta_id, aprobador_id, estado, forma_pago, created_at)
  values (v_req, '', 'compra', v_obra1, v_soc1, v_solicitante, 'whatsapp', current_date - 5, v_et_mat, v_aprobador, 'enviada', 'Contado', now() - interval '15 days');
  insert into public.requisicion_items (requisicion_id, item_id, cantidad, unidad, valor_base, iva, iva_tasa, proveedor_final_id, estado) values
    (v_req, v_cemento, 120, 'bulto', 32000, 6080, 0.19, v_prov1, 'aprobado'),
    (v_req, v_arena, 20, 'm3', 95000, 18050, 0.19, v_prov1, 'aprobado');
  update public.requisiciones set estado = 'en_revision' where id = v_req;
  update public.requisiciones set estado = 'en_aprobacion' where id = v_req;
  update public.requisiciones set estado = 'aprobada' where id = v_req;

  v_orden := gen_random_uuid();
  insert into public.ordenes (id, consecutivo, tipo, requisicion_id, proveedor_id, estado_cumplimiento, estado_administrativo, creada_por, fecha_generacion, contabilizada_at, pagada_at, forma_pago)
  values (v_orden, '', 'OC', v_req, v_prov1, 'cumplida', 'pagada', v_revisor, now() - interval '14 days', now() - interval '12 days', now() - interval '9 days', 'Contado');
  -- 120*32000 + 20*95000 = 5.740.000 base; IVA 19% = 1.090.600
  insert into public.gastos (obra_id, origen, referencia_id, etiqueta_id, proveedor_id, fecha_orden, fecha, valor_base, iva)
  values (v_obra1, 'requisicion', v_orden, v_et_mat, v_prov1, current_date - 14, current_date - 9, 5740000, 1090600);

  -- ── 7. Aprobada con orden CONTABILIZADA pero sin pagar (gasto sin fecha de pago) ───────────
  v_req := gen_random_uuid();
  insert into public.requisiciones (id, consecutivo, tipo, obra_id, sociedad_id, solicitante_id, canal, fecha_requerida, etiqueta_id, aprobador_id, estado, forma_pago, created_at)
  values (v_req, '', 'compra', v_obra2, v_soc2, v_solicitante, 'web', current_date - 2, v_et_mat, v_aprobador, 'enviada', 'Crédito 30 días', now() - interval '10 days');
  insert into public.requisicion_items (requisicion_id, item_id, cantidad, unidad, valor_base, iva, iva_tasa, proveedor_final_id, estado) values
    (v_req, v_cable, 500, 'metro', 3200, 608, 0.19, v_prov2, 'aprobado'),
    (v_req, v_varilla, 300, 'unidad', 18000, 3420, 0.19, v_prov2, 'aprobado');
  update public.requisiciones set estado = 'en_revision' where id = v_req;
  update public.requisiciones set estado = 'en_aprobacion' where id = v_req;
  update public.requisiciones set estado = 'aprobada' where id = v_req;

  v_orden := gen_random_uuid();
  insert into public.ordenes (id, consecutivo, tipo, requisicion_id, proveedor_id, estado_cumplimiento, estado_administrativo, creada_por, fecha_generacion, contabilizada_at, forma_pago)
  values (v_orden, '', 'OC', v_req, v_prov2, 'cumplida', 'contabilizada', v_revisor, now() - interval '9 days', now() - interval '7 days', 'Crédito 30 días');
  -- 500*3200 + 300*18000 = 7.000.000 base. `fecha` NULL: la orden aún no se paga (migración 202609070003).
  insert into public.gastos (obra_id, origen, referencia_id, etiqueta_id, proveedor_id, fecha_orden, fecha, valor_base, iva)
  values (v_obra2, 'requisicion', v_orden, v_et_mat, v_prov2, current_date - 9, null, 7000000, 1330000);

  -- ── 8. Aprobada con orden GENERADA, pendiente de cumplir ───────────────────────────────────
  v_req := gen_random_uuid();
  insert into public.requisiciones (id, consecutivo, tipo, obra_id, sociedad_id, solicitante_id, canal, fecha_requerida, etiqueta_id, aprobador_id, estado, created_at)
  values (v_req, '', 'compra', v_obra3, v_soc3, v_solicitante, 'whatsapp', current_date + 4, v_et_transp, v_aprobador, 'enviada', now() - interval '4 days');
  insert into public.requisicion_items (requisicion_id, item_id, cantidad, unidad, valor_base, iva, iva_tasa, proveedor_final_id, estado) values
    (v_req, v_flete, 6, 'viaje', 180000, 34200, 0.19, v_prov3, 'aprobado');
  update public.requisiciones set estado = 'en_revision' where id = v_req;
  update public.requisiciones set estado = 'en_aprobacion' where id = v_req;
  update public.requisiciones set estado = 'aprobada' where id = v_req;

  v_orden := gen_random_uuid();
  insert into public.ordenes (id, consecutivo, tipo, requisicion_id, proveedor_id, estado_cumplimiento, estado_administrativo, creada_por, fecha_generacion, forma_pago)
  values (v_orden, '', 'OC', v_req, v_prov3, 'generada', 'pendiente', v_revisor, now() - interval '3 days', 'Contado');
  insert into public.gastos (obra_id, origen, referencia_id, etiqueta_id, proveedor_id, fecha_orden, fecha, valor_base, iva)
  values (v_obra3, 'requisicion', v_orden, v_et_transp, v_prov3, current_date - 3, null, 1080000, 205200);

  -- ── 9. Orden de PAGO (tipo 'pago', no compra) ──────────────────────────────────────────────
  v_req := gen_random_uuid();
  insert into public.requisiciones (id, consecutivo, tipo, obra_id, sociedad_id, solicitante_id, canal, fecha_requerida, etiqueta_id, aprobador_id, estado, created_at)
  values (v_req, '', 'pago', v_obra1, v_soc1, v_solicitante, 'web', current_date - 1, v_et_serv, v_aprobador, 'enviada', now() - interval '7 days');
  insert into public.requisicion_items (requisicion_id, item_id, cantidad, unidad, valor_base, iva, iva_tasa, proveedor_final_id, estado) values
    (v_req, v_excav, 24, 'hora', 145000, 27550, 0.19, v_prov3, 'aprobado');
  update public.requisiciones set estado = 'en_revision' where id = v_req;
  update public.requisiciones set estado = 'en_aprobacion' where id = v_req;
  update public.requisiciones set estado = 'aprobada' where id = v_req;

  v_orden := gen_random_uuid();
  insert into public.ordenes (id, consecutivo, tipo, requisicion_id, proveedor_id, estado_cumplimiento, estado_administrativo, creada_por, fecha_generacion, contabilizada_at, pagada_at, forma_pago)
  values (v_orden, '', 'OP', v_req, v_prov3, 'cumplida', 'pagada', v_revisor, now() - interval '6 days', now() - interval '5 days', now() - interval '4 days', 'Transferencia');
  insert into public.gastos (obra_id, origen, referencia_id, etiqueta_id, proveedor_id, fecha_orden, fecha, valor_base, iva)
  values (v_obra1, 'requisicion', v_orden, v_et_serv, v_prov3, current_date - 6, current_date - 4, 3480000, 661200);

  -- ── 10. Gasto del mes ANTERIOR, para que el filtro por periodo tenga con qué comparar ──────
  v_req := gen_random_uuid();
  insert into public.requisiciones (id, consecutivo, tipo, obra_id, sociedad_id, solicitante_id, canal, etiqueta_id, aprobador_id, estado, created_at)
  values (v_req, '', 'compra', v_obra1, v_soc1, v_solicitante, 'whatsapp', v_et_mat, v_aprobador, 'enviada', now() - interval '40 days');
  insert into public.requisicion_items (requisicion_id, item_id, cantidad, unidad, valor_base, iva, iva_tasa, proveedor_final_id, estado) values
    (v_req, v_ladrillo, 5000, 'unidad', 1200, 228, 0.19, v_prov1, 'aprobado');
  update public.requisiciones set estado = 'en_revision' where id = v_req;
  update public.requisiciones set estado = 'en_aprobacion' where id = v_req;
  update public.requisiciones set estado = 'aprobada' where id = v_req;

  v_orden := gen_random_uuid();
  insert into public.ordenes (id, consecutivo, tipo, requisicion_id, proveedor_id, estado_cumplimiento, estado_administrativo, creada_por, fecha_generacion, contabilizada_at, pagada_at, forma_pago)
  values (v_orden, '', 'OC', v_req, v_prov1, 'cumplida', 'pagada', v_revisor, now() - interval '39 days', now() - interval '38 days', now() - interval '35 days', 'Contado');
  insert into public.gastos (obra_id, origen, referencia_id, etiqueta_id, proveedor_id, fecha_orden, fecha, valor_base, iva)
  values (v_obra1, 'requisicion', v_orden, v_et_mat, v_prov1, current_date - 39, current_date - 35, 6000000, 1140000);

  -- ── 11. Caja menor. El trigger sincronizar_gasto_caja_menor crea el gasto solo ──────────────
  insert into public.caja_menor (obra_id, fecha, concepto, etiqueta_id, proveedor_id, valor, registrado_por) values
    (v_obra1, current_date - 2, 'Transporte de herramienta menor', v_et_transp, null, 85000, v_contab),
    (v_obra1, current_date - 6, 'Refrigerios cuadrilla fundida', v_et_serv, null, 140000, v_contab),
    (v_obra2, current_date - 3, 'Compra urgente de puntillas', v_et_mat, v_prov2, 62000, v_contab),
    (v_obra3, current_date - 9, 'Alquiler de andamio por un día', v_et_serv, v_prov3, 220000, v_contab),
    (v_obra2, current_date - 33, 'Combustible planta eléctrica', v_et_serv, null, 310000, v_contab);

  raise notice 'seed-demo: datos de demostración cargados';
end $$;
