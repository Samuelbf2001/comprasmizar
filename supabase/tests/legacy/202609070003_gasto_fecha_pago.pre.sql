-- Legado sembrado justo ANTES de 202609070003_gasto_fecha_pago.sql (ver el mecanismo .pre/.post
-- documentado en el encabezado de scripts/verify-schema.ts y en docs/modelo-datos.md). En este punto
-- del pipeline de migraciones ya corrieron 202608240001..202609070002 (aprobador_id, acceso público
-- global), pero NO la migración bajo prueba: `gastos` todavía tiene el esquema VIEJO — solo `fecha`,
-- con el significado que tenía HASTA esta migración ("cuándo nace el registro": generación de la
-- orden, o fecha del movimiento de caja menor). Reproduce el estado real de una base que llevaba
-- tiempo en producción antes de este cambio. Sin ROLLBACK: estas filas deben sobrevivir para que la
-- migración bajo prueba (y su .post.sql) las encuentren.
--
-- Namespace de IDs '90000000-...': no colisiona con supabase/seed.sql (usa '10000000'..'40000000') ni
-- con los demás arneses de supabase/tests/*.sql — no hace falta que el .post.sql limpie nada para que
-- el seed posterior conviva sin choques de UNIQUE (nombre, NIT, razón social son todos distintos).

insert into public.sociedades (id, nombre) values
  ('90000000-0000-4000-8000-000000000001', 'Legado FP Sociedad')
  on conflict (id) do nothing;

insert into public.obras (id, nombre, sociedad_id, estado) values
  ('90000000-0000-4000-8000-000000000002', 'Legado FP Obra', '90000000-0000-4000-8000-000000000001', 'activa')
  on conflict (id) do nothing;

insert into auth.users (id, email) values
  ('90000000-0000-4000-8000-000000000003', 'legado-fp-solicitante@mizar.test')
  on conflict (id) do nothing;
insert into public.usuarios (id, nombre, email, estado) values
  ('90000000-0000-4000-8000-000000000003', 'Legado FP Solicitante', 'legado-fp-solicitante@mizar.test', 'activo')
  on conflict (id) do nothing;

insert into public.proveedores (id, razon_social) values
  ('90000000-0000-4000-8000-000000000004', 'Legado FP Proveedor')
  on conflict (id) do nothing;

-- Requisición + orden PAGADA en agosto. pagada_at en UTC (2026-09-01 03:30Z) cae en 2026-08-31 hora
-- Colombia (UTC-5 fijo, sin horario de verano): el .post.sql exige justo esa fecha, no la de UTC, para
-- probar la conversión de zona horaria del backfill.
insert into public.requisiciones (id, consecutivo, tipo, obra_id, solicitante_id, canal) values
  ('90000000-0000-4000-8000-000000000005', '', 'compra', '90000000-0000-4000-8000-000000000002', '90000000-0000-4000-8000-000000000003', 'web')
  on conflict (id) do nothing;
insert into public.ordenes (id, consecutivo, tipo, requisicion_id, proveedor_id, estado_administrativo, contabilizada_at, pagada_at) values
  ('90000000-0000-4000-8000-000000000006', 'OC-LEGADO-FP-0001', 'OC', '90000000-0000-4000-8000-000000000005', '90000000-0000-4000-8000-000000000004', 'pagada', '2026-08-31T12:00:00Z', '2026-09-01T03:30:00Z')
  on conflict (id) do nothing;
insert into public.gastos (id, obra_id, origen, referencia_id, proveedor_id, fecha, valor_base, iva) values
  ('90000000-0000-4000-8000-000000000007', '90000000-0000-4000-8000-000000000002', 'requisicion', '90000000-0000-4000-8000-000000000006', '90000000-0000-4000-8000-000000000004', '2026-08-10', 300000, 57000)
  on conflict (id) do nothing;

-- Requisición + orden PENDIENTE (todavía no pagada): el gasto debe perder su `fecha` (queda NULL: es
-- un compromiso, no un gasto todavía) pero conservar su fecha original de agosto como fecha_orden.
insert into public.requisiciones (id, consecutivo, tipo, obra_id, solicitante_id, canal) values
  ('90000000-0000-4000-8000-000000000008', '', 'compra', '90000000-0000-4000-8000-000000000002', '90000000-0000-4000-8000-000000000003', 'web')
  on conflict (id) do nothing;
insert into public.ordenes (id, consecutivo, tipo, requisicion_id, proveedor_id, estado_administrativo) values
  ('90000000-0000-4000-8000-000000000009', 'OC-LEGADO-FP-0002', 'OC', '90000000-0000-4000-8000-000000000008', '90000000-0000-4000-8000-000000000004', 'pendiente')
  on conflict (id) do nothing;
insert into public.gastos (id, obra_id, origen, referencia_id, proveedor_id, fecha, valor_base, iva) values
  ('90000000-0000-4000-8000-00000000000a', '90000000-0000-4000-8000-000000000002', 'requisicion', '90000000-0000-4000-8000-000000000009', '90000000-0000-4000-8000-000000000004', '2026-08-20', 100000, 19000)
  on conflict (id) do nothing;

-- Un gasto de caja menor legado: se inserta vía la tabla caja_menor (no directo en gastos) para que
-- corra el trigger sincronizar_gasto_caja_menor tal como estaba ANTES de esta migración (solo escribe
-- `fecha`, sin fecha_orden) — exactamente el escenario "legado" que el .post.sql necesita: el trigger
-- que la migración reescribe todavía no existe en este punto del pipeline.
insert into public.caja_menor (id, obra_id, fecha, concepto, valor, registrado_por) values
  ('90000000-0000-4000-8000-00000000000b', '90000000-0000-4000-8000-000000000002', '2026-08-25', 'Legado FP caja menor', 45000, '90000000-0000-4000-8000-000000000003')
  on conflict (id) do nothing;
