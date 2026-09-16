-- Legado sembrado justo ANTES de 202609150003_centro_costo_tipo_empresa_facturada.sql (mecanismo
-- .pre/.post documentado en scripts/verify-schema.ts). En este punto `requisiciones`/`gastos` existen
-- SIN `empresa_facturada_id` y `centros_costo` sin `tipo`: reproduce una requisición de Ictinos ya
-- facturada y su gasto, más un gasto de caja menor sobre la misma obra, como los que llevan semanas en
-- producción. Sin rollback: la migración bajo prueba y su .post.sql deben encontrarlos.
--
-- Namespace '93000000-...': no choca con '90000000' (centros_costo), '91000000' (cajas), '92000000'
-- (proveedores) ni con supabase/seed.sql. El centro de costo y la obra se crean con centro explícito
-- porque 202609120001 (y su backfill) ya corrieron: el guardián "cero gastos sin centro" de
-- centros_costo_verification.sql corre después sobre esta misma base compartida.
insert into public.sociedades (id, nombre) values
  ('93000000-0000-4000-8000-000000000501', 'Legado EF Sociedad')
  on conflict (id) do nothing;
insert into public.centros_costo (id, nombre, sociedad_id) values
  ('93000000-0000-4000-8000-000000000502', 'Legado EF Centro', '93000000-0000-4000-8000-000000000501')
  on conflict (id) do nothing;
insert into public.obras (id, nombre, sociedad_id, estado, centro_costo_id) values
  ('93000000-0000-4000-8000-000000000503', 'Legado EF Obra', '93000000-0000-4000-8000-000000000501', 'activa', '93000000-0000-4000-8000-000000000502')
  on conflict (id) do nothing;
insert into auth.users (id, email) values
  ('93000000-0000-4000-8000-000000000504', 'legado-ef-usuario@mizar.test')
  on conflict (id) do nothing;
insert into public.usuarios (id, nombre, email, estado) values
  ('93000000-0000-4000-8000-000000000504', 'Legado EF Usuario', 'legado-ef-usuario@mizar.test', 'activo')
  on conflict (id) do nothing;
insert into public.proveedores (id, razon_social) values
  ('93000000-0000-4000-8000-000000000505', 'Legado EF Proveedor')
  on conflict (id) do nothing;

insert into public.requisiciones (id, consecutivo, tipo, sociedad_id, obra_id, solicitante_id, canal, centro_costo_id) values
  ('93000000-0000-4000-8000-000000000506', '', 'compra', '93000000-0000-4000-8000-000000000501', '93000000-0000-4000-8000-000000000503', '93000000-0000-4000-8000-000000000504', 'web', '93000000-0000-4000-8000-000000000502')
  on conflict (id) do nothing;
insert into public.ordenes (id, consecutivo, tipo, requisicion_id, proveedor_id) values
  ('93000000-0000-4000-8000-000000000507', 'OC-LEGADO-EF-0001', 'OC', '93000000-0000-4000-8000-000000000506', '93000000-0000-4000-8000-000000000505')
  on conflict (id) do nothing;
insert into public.gastos (id, obra_id, origen, referencia_id, proveedor_id, fecha_orden, valor_base, iva, centro_costo_id) values
  ('93000000-0000-4000-8000-000000000508', '93000000-0000-4000-8000-000000000503', 'requisicion', '93000000-0000-4000-8000-000000000507', '93000000-0000-4000-8000-000000000505', '2026-09-01', 150000, 28500, '93000000-0000-4000-8000-000000000502')
  on conflict (id) do nothing;
-- Movimiento de caja menor legado sobre la misma obra: su gasto lo crea `sincronizar_gasto_caja_menor`
-- (versión vigente de 202609120003, que aún no conoce empresa_facturada_id).
insert into public.caja_menor (id, obra_id, fecha, concepto, valor, registrado_por) values
  ('93000000-0000-4000-8000-000000000509', '93000000-0000-4000-8000-000000000503', '2026-09-02', 'Legado EF caja menor', 20000, '93000000-0000-4000-8000-000000000504')
  on conflict (id) do nothing;
