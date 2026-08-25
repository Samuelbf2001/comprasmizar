-- SOLO DESARROLLO LOCAL. Datos ficticios, no ejecutar en producción.
-- Las cuentas no contienen datos personales y existen únicamente para probar RLS/roles.

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'solicitante.local@mizar.test', extensions.crypt('local-only-change-me', extensions.gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{}', now(), now()),
  ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'revisor.local@mizar.test', extensions.crypt('local-only-change-me', extensions.gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{}', now(), now()),
  ('10000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'aprobador.local@mizar.test', extensions.crypt('local-only-change-me', extensions.gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{}', now(), now()),
  ('10000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'contabilidad.local@mizar.test', extensions.crypt('local-only-change-me', extensions.gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{}', now(), now()),
  ('10000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'admin-mizar.local@mizar.test', extensions.crypt('local-only-change-me', extensions.gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{}', now(), now()),
  ('10000000-0000-0000-0000-000000000006', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'admin-sixteam.local@mizar.test', extensions.crypt('local-only-change-me', extensions.gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{}', now(), now())
on conflict (id) do update set updated_at = excluded.updated_at;

insert into public.usuarios (id, nombre, email, estado) values
  ('10000000-0000-0000-0000-000000000001', 'Solicitante Local', 'solicitante.local@mizar.test', 'activo'),
  ('10000000-0000-0000-0000-000000000002', 'Revisor Local', 'revisor.local@mizar.test', 'activo'),
  ('10000000-0000-0000-0000-000000000003', 'Aprobador Local', 'aprobador.local@mizar.test', 'activo'),
  ('10000000-0000-0000-0000-000000000004', 'Contabilidad Local', 'contabilidad.local@mizar.test', 'activo'),
  ('10000000-0000-0000-0000-000000000005', 'Admin Mizar Local', 'admin-mizar.local@mizar.test', 'activo'),
  ('10000000-0000-0000-0000-000000000006', 'Admin Sixteam Local', 'admin-sixteam.local@mizar.test', 'activo')
on conflict (id) do update set nombre = excluded.nombre, email = excluded.email, estado = excluded.estado;

insert into public.usuario_roles (usuario_id, rol) values
  ('10000000-0000-0000-0000-000000000001', 'solicitante'),
  ('10000000-0000-0000-0000-000000000002', 'revisor'),
  ('10000000-0000-0000-0000-000000000003', 'aprobador'),
  ('10000000-0000-0000-0000-000000000004', 'contabilidad'),
  ('10000000-0000-0000-0000-000000000005', 'admin_mizar'),
  ('10000000-0000-0000-0000-000000000006', 'admin_sixteam')
on conflict do nothing;

insert into public.sociedades (id, nombre, nit) values
  ('20000000-0000-0000-0000-000000000001', 'Sociedad Demo Norte', '900000001-1'),
  ('20000000-0000-0000-0000-000000000002', 'Sociedad Demo Centro', '900000002-2'),
  ('20000000-0000-0000-0000-000000000003', 'Sociedad Demo Sur', '900000003-3')
on conflict (id) do update set nombre = excluded.nombre, nit = excluded.nit;

insert into public.obras (id, nombre, sociedad_id, estado, public_submission_enabled, public_code_hash) values
  ('30000000-0000-0000-0000-000000000001', 'Obra Demo 01', '20000000-0000-0000-0000-000000000001', 'activa', true, extensions.crypt('LOCAL-OBRA-01', extensions.gen_salt('bf'))),
  ('30000000-0000-0000-0000-000000000002', 'Obra Demo 02', '20000000-0000-0000-0000-000000000002', 'activa', false, null),
  ('30000000-0000-0000-0000-000000000003', 'Obra Demo 03', '20000000-0000-0000-0000-000000000003', 'activa', false, null),
  ('30000000-0000-0000-0000-000000000004', 'Obra Demo 04', '20000000-0000-0000-0000-000000000001', 'activa', false, null),
  ('30000000-0000-0000-0000-000000000005', 'Obra Demo 05', '20000000-0000-0000-0000-000000000002', 'activa', false, null),
  ('30000000-0000-0000-0000-000000000006', 'Obra Demo 06', '20000000-0000-0000-0000-000000000003', 'activa', false, null),
  ('30000000-0000-0000-0000-000000000007', 'Obra Demo 07', '20000000-0000-0000-0000-000000000001', 'activa', false, null),
  ('30000000-0000-0000-0000-000000000008', 'Obra Demo 08', '20000000-0000-0000-0000-000000000002', 'activa', false, null),
  ('30000000-0000-0000-0000-000000000009', 'Obra Demo 09', '20000000-0000-0000-0000-000000000003', 'activa', false, null),
  ('30000000-0000-0000-0000-000000000010', 'Obra Demo 10', '20000000-0000-0000-0000-000000000001', 'activa', false, null),
  ('30000000-0000-0000-0000-000000000011', 'Obra Demo 11', '20000000-0000-0000-0000-000000000002', 'activa', false, null),
  ('30000000-0000-0000-0000-000000000012', 'Obra Demo 12', '20000000-0000-0000-0000-000000000003', 'activa', false, null),
  ('30000000-0000-0000-0000-000000000013', 'Obra Demo 13', '20000000-0000-0000-0000-000000000001', 'activa', false, null),
  ('30000000-0000-0000-0000-000000000014', 'Obra Demo 14', '20000000-0000-0000-0000-000000000002', 'activa', false, null),
  ('30000000-0000-0000-0000-000000000015', 'Obra Demo 15', '20000000-0000-0000-0000-000000000003', 'activa', false, null),
  ('30000000-0000-0000-0000-000000000016', 'Obra Demo 16', '20000000-0000-0000-0000-000000000001', 'activa', false, null),
  ('30000000-0000-0000-0000-000000000017', 'Obra Demo 17', '20000000-0000-0000-0000-000000000002', 'activa', false, null)
on conflict (id) do update set nombre = excluded.nombre, sociedad_id = excluded.sociedad_id, estado = excluded.estado;

insert into public.etiquetas (nombre, aprobador_id, activa) values
  ('Materiales', '10000000-0000-0000-0000-000000000003', true),
  ('Nomina', '10000000-0000-0000-0000-000000000003', true),
  ('Servicios', '10000000-0000-0000-0000-000000000003', true),
  ('Herramientas', '10000000-0000-0000-0000-000000000003', true),
  ('Transporte', '10000000-0000-0000-0000-000000000003', true)
on conflict (nombre) do update set aprobador_id = excluded.aprobador_id, activa = excluded.activa;

insert into public.proveedores (id, razon_social, nit, contacto, datos_bancarios, activo) values
  ('40000000-0000-0000-0000-000000000001', 'Proveedor Demo Uno SAS', '901000001-1', '{}', '{}', true),
  ('40000000-0000-0000-0000-000000000002', 'Proveedor Demo Dos SAS', '901000002-2', '{}', '{}', true),
  ('40000000-0000-0000-0000-000000000003', 'Proveedor Demo Tres SAS', '901000003-3', '{}', '{}', true),
  ('40000000-0000-0000-0000-000000000004', 'Proveedor Demo Cuatro SAS', '901000004-4', '{}', '{}', true),
  ('40000000-0000-0000-0000-000000000005', 'Proveedor Demo Cinco SAS', '901000005-5', '{}', '{}', true)
on conflict (id) do update set razon_social = excluded.razon_social, nit = excluded.nit, activo = excluded.activo;

insert into public.items (nombre, nombre_normalizado, especificacion, unidad_defecto, categoria, estado, creado_por) values
  ('Cemento gris 50 kg', 'cemento gris 50 kg', null, 'bulto', 'Materiales', 'activo', '10000000-0000-0000-0000-000000000002'),
  ('Arena de rio', 'arena de rio', null, 'm3', 'Materiales', 'activo', '10000000-0000-0000-0000-000000000002'),
  ('Grava triturada', 'grava triturada', null, 'm3', 'Materiales', 'activo', '10000000-0000-0000-0000-000000000002'),
  ('Varilla corrugada 3/8', 'varilla corrugada 3 8', null, 'unidad', 'Materiales', 'activo', '10000000-0000-0000-0000-000000000002'),
  ('Alambre recocido', 'alambre recocido', null, 'kg', 'Materiales', 'activo', '10000000-0000-0000-0000-000000000002'),
  ('Ladrillo hueco', 'ladrillo hueco', null, 'unidad', 'Materiales', 'activo', '10000000-0000-0000-0000-000000000002'),
  ('Bloque estructural', 'bloque estructural', null, 'unidad', 'Materiales', 'activo', '10000000-0000-0000-0000-000000000002'),
  ('Tubo PVC 1 pulgada', 'tubo pvc 1 pulgada', null, 'metro', 'Plomeria', 'activo', '10000000-0000-0000-0000-000000000002'),
  ('Codo PVC 1 pulgada', 'codo pvc 1 pulgada', null, 'unidad', 'Plomeria', 'activo', '10000000-0000-0000-0000-000000000002'),
  ('Cable electrico calibre 12', 'cable electrico calibre 12', null, 'metro', 'Electricidad', 'activo', '10000000-0000-0000-0000-000000000002'),
  ('Interruptor sencillo', 'interruptor sencillo', null, 'unidad', 'Electricidad', 'activo', '10000000-0000-0000-0000-000000000002'),
  ('Pintura blanca', 'pintura blanca', null, 'galon', 'Acabados', 'activo', '10000000-0000-0000-0000-000000000002'),
  ('Rodillo de pintura', 'rodillo de pintura', null, 'unidad', 'Herramientas', 'activo', '10000000-0000-0000-0000-000000000002'),
  ('Brocha 3 pulgadas', 'brocha 3 pulgadas', null, 'unidad', 'Herramientas', 'activo', '10000000-0000-0000-0000-000000000002'),
  ('Disco de corte', 'disco de corte', null, 'unidad', 'Herramientas', 'activo', '10000000-0000-0000-0000-000000000002'),
  ('Guantes de seguridad', 'guantes de seguridad', null, 'par', 'Seguridad', 'activo', '10000000-0000-0000-0000-000000000002'),
  ('Casco de seguridad', 'casco de seguridad', null, 'unidad', 'Seguridad', 'activo', '10000000-0000-0000-0000-000000000002'),
  ('Gafas de seguridad', 'gafas de seguridad', null, 'unidad', 'Seguridad', 'activo', '10000000-0000-0000-0000-000000000002'),
  ('Botas de seguridad', 'botas de seguridad', null, 'par', 'Seguridad', 'activo', '10000000-0000-0000-0000-000000000002'),
  ('Madera formaleta', 'madera formaleta', null, 'tabla', 'Materiales', 'activo', '10000000-0000-0000-0000-000000000002'),
  ('Puntilla 2 pulgadas', 'puntilla 2 pulgadas', null, 'lb', 'Materiales', 'activo', '10000000-0000-0000-0000-000000000002'),
  ('Tornillo drywall', 'tornillo drywall', null, 'caja', 'Materiales', 'activo', '10000000-0000-0000-0000-000000000002'),
  ('Yeso en polvo', 'yeso en polvo', null, 'bulto', 'Acabados', 'activo', '10000000-0000-0000-0000-000000000002'),
  ('Masilla acrilica', 'masilla acrilica', null, 'galon', 'Acabados', 'activo', '10000000-0000-0000-0000-000000000002'),
  ('Impermeabilizante', 'impermeabilizante', null, 'galon', 'Acabados', 'activo', '10000000-0000-0000-0000-000000000002'),
  ('Alquiler mezcladora', 'alquiler mezcladora', null, 'dia', 'Servicios', 'activo', '10000000-0000-0000-0000-000000000002'),
  ('Flete materiales', 'flete materiales', null, 'viaje', 'Transporte', 'activo', '10000000-0000-0000-0000-000000000002'),
  ('Servicio de excavacion', 'servicio de excavacion', null, 'hora', 'Servicios', 'activo', '10000000-0000-0000-0000-000000000002'),
  ('Mantenimiento herramienta', 'mantenimiento herramienta', null, 'servicio', 'Servicios', 'activo', '10000000-0000-0000-0000-000000000002'),
  ('Señalizacion de obra', 'senalizacion de obra', null, 'unidad', 'Seguridad', 'activo', '10000000-0000-0000-0000-000000000002'),
  ('Elemento pendiente demo', 'elemento pendiente demo', 'Normalizar con el revisor', 'unidad', 'Pendientes', 'pendiente_normalizacion', '10000000-0000-0000-0000-000000000002')
on conflict (nombre_normalizado) do update set nombre = excluded.nombre, especificacion = excluded.especificacion, unidad_defecto = excluded.unidad_defecto, categoria = excluded.categoria, estado = excluded.estado;
