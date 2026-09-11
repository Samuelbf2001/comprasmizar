-- Legado sembrado justo ANTES de 202609070001_aprobador_elegido.sql (ver el mecanismo .pre/.post
-- documentado en el encabezado de scripts/verify-schema.ts y en docs/modelo-datos.md): una etiqueta
-- ACTIVA cuyo aprobador ya está INACTIVO, y una requisición etiquetada con ella.
--
-- Por qué hace falta desactivar triggers para sembrar esto: las validaciones de "elegibilidad"
-- (public.es_aprobador_elegible) ya existen desde la migración BASE (202608240001_core_compras.sql,
-- ya aplicada en cualquier entorno real) — `validar_aprobador_etiqueta_activa` impide asignar un
-- aprobador no elegible a una etiqueta activa, `validar_baja_usuario_con_etiquetas_activas` impide
-- desactivar a un usuario que sea aprobador de una etiqueta activa, y
-- `validar_catalogos_activos_requisicion` impide crear una requisición contra una etiqueta cuyo
-- aprobador no sea elegible. Ese es exactamente el estado inconsistente que estas protecciones evitan
-- crear DE AQUÍ EN ADELANTE — pero es el estado que SÍ pudo colarse en datos reales de antes de que
-- esas protecciones existieran (o por cirugía manual directa sobre la base). Para reproducirlo sin
-- mentir sobre qué se está sembrando, se desactivan momentáneamente los mismos triggers de guardia
-- que hoy impiden crearlo desde cero — solo alrededor de la operación puntual que los dispararía. Sin
-- ROLLBACK: estas filas deben sobrevivir para que la migración bajo prueba (y su .post.sql) las
-- encuentren.
--
-- Namespace de IDs '90000000-...-0001xx': no colisiona con supabase/seed.sql ni con los demás arneses.

insert into auth.users (id, email) values
  ('90000000-0000-0000-0000-000000000101', 'legado-ae-aprobador@mizar.test')
  on conflict (id) do nothing;
insert into public.usuarios (id, nombre, email, estado) values
  ('90000000-0000-0000-0000-000000000101', 'Legado AE Aprobador Inactivo', 'legado-ae-aprobador@mizar.test', 'activo')
  on conflict (id) do nothing;
insert into public.usuario_roles (usuario_id, rol) values
  ('90000000-0000-0000-0000-000000000101', 'aprobador')
  on conflict do nothing;

insert into auth.users (id, email) values
  ('90000000-0000-0000-0000-000000000102', 'legado-ae-solicitante@mizar.test')
  on conflict (id) do nothing;
insert into public.usuarios (id, nombre, email, estado) values
  ('90000000-0000-0000-0000-000000000102', 'Legado AE Solicitante', 'legado-ae-solicitante@mizar.test', 'activo')
  on conflict (id) do nothing;

insert into public.sociedades (id, nombre) values
  ('90000000-0000-0000-0000-000000000103', 'Legado AE Sociedad')
  on conflict (id) do nothing;
insert into public.obras (id, nombre, sociedad_id, estado) values
  ('90000000-0000-0000-0000-000000000104', 'Legado AE Obra', '90000000-0000-0000-0000-000000000103', 'activa')
  on conflict (id) do nothing;

-- La etiqueta nace activa con un aprobador TODAVÍA activo (si no, validar_aprobador_etiqueta_activa
-- la rechazaría de entrada).
insert into public.etiquetas (id, nombre, aprobador_id, activa) values
  ('90000000-0000-0000-0000-000000000105', 'Legado AE Etiqueta', '90000000-0000-0000-0000-000000000101', true)
  on conflict (id) do nothing;

-- El aprobador queda inactivo DESPUÉS: se desactiva el trigger de guardia solo para esta UPDATE, que
-- es justo la operación que hoy (con el trigger encendido) el sistema ya rechaza.
alter table public.usuarios disable trigger usuarios_baja_etiquetas_activas;
update public.usuarios set estado = 'inactivo' where id = '90000000-0000-0000-0000-000000000101';
alter table public.usuarios enable trigger usuarios_baja_etiquetas_activas;

-- La requisición queda etiquetada con esa etiqueta (aprobador ya inactivo): mismo motivo, se
-- desactiva momentáneamente el trigger que hoy ya bloquearía crear una requisición nueva contra una
-- etiqueta con aprobador no elegible.
alter table public.requisiciones disable trigger requisiciones_catalogos_activos;
insert into public.requisiciones (id, consecutivo, tipo, obra_id, solicitante_id, canal, etiqueta_id) values
  ('90000000-0000-0000-0000-000000000106', '', 'compra', '90000000-0000-0000-0000-000000000104', '90000000-0000-0000-0000-000000000102', 'web', '90000000-0000-0000-0000-000000000105')
  on conflict (id) do nothing;
alter table public.requisiciones enable trigger requisiciones_catalogos_activos;
