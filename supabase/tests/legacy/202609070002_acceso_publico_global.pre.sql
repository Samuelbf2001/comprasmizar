-- Legado sembrado justo ANTES de 202609070002_acceso_publico_global.sql (ver el mecanismo .pre/.post
-- documentado en el encabezado de scripts/verify-schema.ts y en docs/modelo-datos.md): una obra con
-- `public_submission_enabled = true` y un `public_code_hash` histórico POR OBRA (el modelo viejo, aún
-- vigente en este punto del pipeline — la migración bajo prueba todavía no corrió). No hace falta
-- desactivar ningún trigger: bajo el esquema vigente en este punto, esta fila ya es perfectamente
-- válida (obras_codigo_publico_check exige justo esto: hash presente cuando el portal está habilitado).
-- Sin ROLLBACK: debe sobrevivir para que la migración bajo prueba (y su .post.sql) la encuentren.
--
-- Namespace de IDs '90000000-...-0002xx': no colisiona con supabase/seed.sql ni con los demás arneses.

insert into public.sociedades (id, nombre) values
  ('90000000-0000-0000-0000-000000000201', 'Legado AP Sociedad')
  on conflict (id) do nothing;

insert into public.obras (id, nombre, sociedad_id, estado, public_submission_enabled, public_code_hash) values
  ('90000000-0000-0000-0000-000000000202', 'Legado AP Obra', '90000000-0000-0000-0000-000000000201', 'activa', true,
   extensions.crypt('legado-obra-clave-vieja', extensions.gen_salt('bf')))
  on conflict (id) do nothing;
