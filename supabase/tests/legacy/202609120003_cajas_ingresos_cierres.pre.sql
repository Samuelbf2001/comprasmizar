-- Legado sembrado justo ANTES de 202609120003_cajas_ingresos_cierres.sql (mecanismo .pre/.post
-- documentado en el encabezado de scripts/verify-schema.ts). En este punto ya corrieron
-- 202608240001..202609120002: `caja_menor` existe con su esquema de ANTES de esta migración (sin
-- `caja_id`/`medio_pago`/`iva`/`cierre_id`) — reproduce un movimiento de caja menor real que llevaba
-- tiempo en producción antes de que existiera el concepto de "caja". Sin rollback: esta fila debe
-- sobrevivir para que la migración bajo prueba (y su .post.sql) la encuentren.
--
-- Namespace '91000000-...': no choca con '90000000-...' (legado de centros_costo) ni con seed.sql.

insert into public.sociedades (id, nombre) values
  ('91000000-0000-4000-8000-000000000301', 'Legado Cajas Sociedad')
  on conflict (id) do nothing;

-- Centro de costo propio: en este punto del pipeline la migración 202609120001_centros_costo.sql (y
-- su backfill) YA corrió — una obra nueva creada aquí, después de esa migración, no hereda ningún
-- centro automáticamente (el backfill de esa migración solo corrió sobre las filas que existían EN SU
-- MOMENTO). Sin esto, el gasto que sincroniza el movimiento de abajo nacería con `centro_costo_id`
-- NULL, y `centros_costo_verification.sql` (que corre más tarde, sobre la base COMPARTIDA por todo el
-- arnés — este .pre.sql no hace rollback a propósito) fallaría su propio guardián "cero gastos sin
-- centro" por una fila que ni siquiera es del área que esa migración prueba.
insert into public.centros_costo (id, nombre, sociedad_id) values
  ('91000000-0000-4000-8000-000000000306', 'Legado Cajas Centro', '91000000-0000-4000-8000-000000000301')
  on conflict (id) do nothing;

insert into public.obras (id, nombre, sociedad_id, estado, centro_costo_id) values
  ('91000000-0000-4000-8000-000000000302', 'Legado Cajas Obra', '91000000-0000-4000-8000-000000000301', 'activa', '91000000-0000-4000-8000-000000000306')
  on conflict (id) do nothing;

insert into auth.users (id, email) values
  ('91000000-0000-4000-8000-000000000303', 'legado-cajas-usuario@mizar.test')
  on conflict (id) do nothing;
insert into public.usuarios (id, nombre, email, estado) values
  ('91000000-0000-4000-8000-000000000303', 'Legado Cajas Usuario', 'legado-cajas-usuario@mizar.test', 'activo')
  on conflict (id) do nothing;
insert into public.usuario_roles (usuario_id, rol) values
  ('91000000-0000-4000-8000-000000000303', 'contabilidad')
  on conflict do nothing;

-- Movimiento de caja menor legado: en este punto del pipeline `caja_menor` todavía no tiene
-- caja_id/medio_pago/iva/cierre_id (los añade la migración bajo prueba), así que el INSERT no los
-- menciona — igual que un movimiento real que ya estaba en producción antes de esta migración.
insert into public.caja_menor (id, obra_id, fecha, concepto, valor, registrado_por) values
  ('91000000-0000-4000-8000-000000000304', '91000000-0000-4000-8000-000000000302', '2026-09-02', 'Legado caja menor sin caja', 45000, '91000000-0000-4000-8000-000000000303')
  on conflict (id) do nothing;
