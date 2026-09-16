-- Legado sembrado justo ANTES de 202609150002_proveedores_identificacion.sql (mecanismo .pre/.post
-- documentado en el encabezado de scripts/verify-schema.ts). En este punto `proveedores` existe con su
-- esquema de ANTES: solo `nit`, sin `tipo_identificacion`/`identificacion`/`pendiente_normalizacion` —
-- reproduce el catálogo real que Daniel entregó por WhatsApp el 15-sep (proveedores con NIT) y un
-- proveedor dado de alta solo por razón social (RF-603, NIT pendiente). Sin rollback: estas filas deben
-- sobrevivir para que la migración bajo prueba (y su .post.sql) las encuentren.
--
-- Namespace '92000000-...': no choca con '90000000-...' (centros_costo), '91000000-...' (cajas) ni con
-- supabase/seed.sql.
insert into public.proveedores (id, razon_social, nit) values
  ('92000000-0000-4000-8000-000000000401', 'Legado Identificación Con NIT', '900.777.888-1'),
  ('92000000-0000-4000-8000-000000000402', 'Legado Identificación Sin NIT', null)
  on conflict (id) do nothing;
