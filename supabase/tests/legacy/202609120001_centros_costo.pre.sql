-- Legado sembrado justo ANTES de 202609120001_centros_costo.sql (ver el mecanismo .pre/.post
-- documentado en el encabezado de scripts/verify-schema.ts y en docs/modelo-datos.md). En este punto
-- ya corrieron 202608240001..202609110005: `obras`/`requisiciones`/`gastos` existen con su esquema
-- COMPLETO salvo `centro_costo_id` (la columna que añade la migración bajo prueba) — reproduce una
-- base que llevaba tiempo en producción antes de que existiera el concepto de centro de costo. Sin
-- ROLLBACK: estas filas deben sobrevivir para que la migración bajo prueba (y su .post.sql) las
-- encuentren.
--
-- Namespace de IDs '90000000-...-0000000003xx': no colisiona con los otros tres pares .pre/.post
-- (que usan '...0001'-'...000b', '...0101'-'...0106' y '...0201'-'...0202') ni con supabase/seed.sql.
--
-- Caso adrede: DOS obras de DOS SOCIEDADES DISTINTAS con el MISMO nombre literal ('Legado CC Obra')
-- — legado real, no hipotético. Ejercita la disambiguación por sufijo de id que hace el backfill de
-- centros_costo (ver el comentario largo junto al INSERT en la migración): sin ella, el backfill
-- fallaría contra la unicidad GLOBAL de `centros_costo.nombre` (a diferencia de `obras.nombre`, único
-- solo por sociedad) en cuanto se topara con esta pareja.

insert into public.sociedades (id, nombre) values
  ('90000000-0000-4000-8000-000000000301', 'Legado CC Sociedad A'),
  ('90000000-0000-4000-8000-000000000302', 'Legado CC Sociedad B')
  on conflict (id) do nothing;

insert into public.obras (id, nombre, sociedad_id, estado) values
  ('90000000-0000-4000-8000-000000000303', 'Legado CC Obra', '90000000-0000-4000-8000-000000000301', 'activa'),
  ('90000000-0000-4000-8000-000000000304', 'Legado CC Obra', '90000000-0000-4000-8000-000000000302', 'activa')
  on conflict (id) do nothing;

insert into auth.users (id, email) values
  ('90000000-0000-4000-8000-000000000305', 'legado-cc-solicitante@mizar.test')
  on conflict (id) do nothing;
insert into public.usuarios (id, nombre, email, estado) values
  ('90000000-0000-4000-8000-000000000305', 'Legado CC Solicitante', 'legado-cc-solicitante@mizar.test', 'activo')
  on conflict (id) do nothing;

insert into public.proveedores (id, razon_social) values
  ('90000000-0000-4000-8000-000000000306', 'Legado CC Proveedor')
  on conflict (id) do nothing;

-- Requisición + orden + gasto sobre la obra A: al no existir aún `centro_costo_id` en ninguna de las
-- tres tablas en este punto del pipeline, ninguno de los INSERT de abajo lo menciona.
insert into public.requisiciones (id, consecutivo, tipo, sociedad_id, obra_id, solicitante_id, canal) values
  ('90000000-0000-4000-8000-000000000307', '', 'compra', '90000000-0000-4000-8000-000000000301', '90000000-0000-4000-8000-000000000303', '90000000-0000-4000-8000-000000000305', 'web')
  on conflict (id) do nothing;
insert into public.ordenes (id, consecutivo, tipo, requisicion_id, proveedor_id) values
  ('90000000-0000-4000-8000-000000000308', 'OC-LEGADO-CC-0001', 'OC', '90000000-0000-4000-8000-000000000307', '90000000-0000-4000-8000-000000000306')
  on conflict (id) do nothing;
insert into public.gastos (id, obra_id, origen, referencia_id, proveedor_id, fecha_orden, valor_base, iva) values
  ('90000000-0000-4000-8000-000000000309', '90000000-0000-4000-8000-000000000303', 'requisicion', '90000000-0000-4000-8000-000000000308', '90000000-0000-4000-8000-000000000306', '2026-09-01', 200000, 38000)
  on conflict (id) do nothing;

-- Movimiento de caja menor legado sobre la MISMA obra A, vía la tabla `caja_menor` (dispara
-- `sincronizar_gasto_caja_menor` tal como estaba justo ANTES de esta migración: sin `centro_costo_id`,
-- porque esa columna todavía no existe en `gastos` en este punto).
insert into public.caja_menor (id, obra_id, fecha, concepto, valor, registrado_por) values
  ('90000000-0000-4000-8000-00000000030a', '90000000-0000-4000-8000-000000000303', '2026-09-02', 'Legado CC caja menor', 30000, '90000000-0000-4000-8000-000000000305')
  on conflict (id) do nothing;
