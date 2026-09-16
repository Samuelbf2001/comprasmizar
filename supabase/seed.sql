-- DATOS DE DEMOSTRACIÓN. Los carga ops/datos-demo.sh cuando la plataforma arranca vacía (ver
-- docs/migracion-autoalojado.md) y también los usa el entorno de desarrollo local.
--
-- Todo es ficticio. Las cuentas llevan el nombre de pila del equipo de Mizar (Daniel, Nelson,
-- Juliana, Claudia) para que la demo se reconozca, pero son cuentas demo: correos @mizar.test, sin
-- datos personales, y la misma contraseña temporal para todas. Las sociedades usan los nombres de
-- empresas mencionados en la reunión del 2026-08-31 con NIT inventado; obras, proveedores y el
-- catálogo de ~115 materiales son placeholders hasta que Daniel envíe las listas reales.
--
-- ANTES DE OPERAR DE VERDAD, RECREAR LA BASE (auditoría inmutable, consecutivos consumidos): ver la
-- cabecera de ops/datos-demo.sh.
--
-- seed-demo.sql depende de estos IDs y nombres: usuarios 1..4, sociedades 1..3, obras 1..3,
-- proveedores 1..3, las etiquetas Materiales/Servicios/Herramientas/Transporte y seis ítems por
-- nombre_normalizado. No renumerar ni renombrar esos sin tocar seed-demo.sql.

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('10000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'solicitante.demo@mizar.test', extensions.crypt('local-only-change-me', extensions.gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{}', now(), now()),
  ('10000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'daniel.demo@mizar.test', extensions.crypt('local-only-change-me', extensions.gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{}', now(), now()),
  ('10000000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'nelson.demo@mizar.test', extensions.crypt('local-only-change-me', extensions.gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{}', now(), now()),
  ('10000000-0000-4000-8000-000000000004', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'claudia.demo@mizar.test', extensions.crypt('local-only-change-me', extensions.gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{}', now(), now()),
  ('10000000-0000-4000-8000-000000000005', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'admin-mizar.demo@mizar.test', extensions.crypt('local-only-change-me', extensions.gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{}', now(), now()),
  ('10000000-0000-4000-8000-000000000006', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'admin-sixteam.demo@mizar.test', extensions.crypt('local-only-change-me', extensions.gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{}', now(), now()),
  ('10000000-0000-4000-8000-000000000007', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'juliana.demo@mizar.test', extensions.crypt('local-only-change-me', extensions.gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{}', now(), now())
-- H8 (docs/qa/QA-pagos-y-caja.md): un cluster local sembrado ANTES del 15-sep tiene estas 7 cuentas
-- bajo UUIDs viejos (formato `…-0000-0000-…`, cambiado a `…-4000-8000-…`). `on conflict (id)` no
-- detecta ESE choque -- el id nuevo no colisiona con nada -- así que Postgres intenta el INSERT de
-- verdad y revienta contra `auth_users_email_unico_ci` (202609110001). El conflicto real es por
-- CORREO, no por id: se ataca por ahí, y el `where auth.users.id = excluded.id` deja el UPDATE como
-- no-op (la cuenta vieja queda intacta, con su id de siempre) en vez de intentar reasignarle un id
-- nuevo -- lo que arrastraría en cascada a `usuario_roles`, `requisiciones.solicitante_id`, etc. sin
-- ON UPDATE CASCADE. Refrescar contraseña/estado en una cuenta vieja sin poder renumerarla es la
-- limitación aceptada: `--reset` sigue siendo el camino para un cluster que ya arrastra datos reales
-- bajo esos ids viejos.
on conflict ((lower(email))) do update set encrypted_password = excluded.encrypted_password, updated_at = excluded.updated_at
where auth.users.id = excluded.id;

-- Roles según la reunión del 2026-08-31: Daniel revisa y fija obra/proveedor; Nelson y Juliana
-- aprueban; Claudia es contabilidad.
insert into public.usuarios (id, nombre, email, estado) values
  ('10000000-0000-4000-8000-000000000001', 'Solicitante Demo', 'solicitante.demo@mizar.test', 'activo'),
  ('10000000-0000-4000-8000-000000000002', 'Daniel Demo', 'daniel.demo@mizar.test', 'activo'),
  ('10000000-0000-4000-8000-000000000003', 'Nelson Demo', 'nelson.demo@mizar.test', 'activo'),
  ('10000000-0000-4000-8000-000000000004', 'Claudia Demo', 'claudia.demo@mizar.test', 'activo'),
  ('10000000-0000-4000-8000-000000000005', 'Admin Mizar Demo', 'admin-mizar.demo@mizar.test', 'activo'),
  ('10000000-0000-4000-8000-000000000006', 'Admin Sixteam', 'admin-sixteam.demo@mizar.test', 'activo'),
  ('10000000-0000-4000-8000-000000000007', 'Juliana Demo', 'juliana.demo@mizar.test', 'activo')
-- Mismo criterio que arriba: `usuarios` YA tenía `unique (email)` (202609110001) y el mismo choque de
-- id-viejo-vs-nuevo la revienta un paso más adelante si se sigue apuntando el conflicto a (id).
on conflict (email) do update set nombre = excluded.nombre, estado = excluded.estado
where usuarios.id = excluded.id;

-- Resuelto por CORREO contra `usuarios`, no por id literal: si una cuenta de arriba conservó su id
-- viejo (choque de correo, ver el comentario de auth.users), este insert le asigna el rol al id que
-- REALMENTE tiene hoy esa cuenta, en vez de a un id nuevo que podría no existir todavía y violar la FK.
insert into public.usuario_roles (usuario_id, rol)
select u.id, r.rol::public.rol_usuario
from public.usuarios u
join (values
  ('solicitante.demo@mizar.test', 'solicitante'),
  ('daniel.demo@mizar.test', 'revisor'),
  ('nelson.demo@mizar.test', 'aprobador'),
  ('claudia.demo@mizar.test', 'contabilidad'),
  ('admin-mizar.demo@mizar.test', 'admin_mizar'),
  ('admin-sixteam.demo@mizar.test', 'admin_sixteam'),
  ('juliana.demo@mizar.test', 'aprobador')
) as r(email, rol) on lower(u.email) = lower(r.email)
on conflict do nothing;

-- Empresas activas nombradas por Daniel en la reunión (Mizar, Ictinos, Villa del Sol, Proim, Palmoc).
-- NIT inventado: la lista oficial con NIT real la envía Mizar.
insert into public.sociedades (id, nombre, nit) values
  ('20000000-0000-4000-8000-000000000001', 'Mizar', '900000001-1'),
  ('20000000-0000-4000-8000-000000000002', 'Ictinos', '900000002-2'),
  ('20000000-0000-4000-8000-000000000003', 'Villa del Sol', '900000003-3'),
  ('20000000-0000-4000-8000-000000000004', 'Proim Ingenieria', '900000004-4'),
  ('20000000-0000-4000-8000-000000000005', 'Palmoc', '900000005-5')
on conflict (id) do update set nombre = excluded.nombre, nit = excluded.nit;

-- 17 obras (el número real de Mizar) repartidas entre las sociedades. Las obras 1..3 conservan la
-- sociedad 1..3 respectivamente porque seed-demo.sql las empareja así.
insert into public.obras (id, nombre, sociedad_id, estado, public_submission_enabled, public_code_hash) values
  ('30000000-0000-4000-8000-000000000001', 'Torre Mizar Etapa 1', '20000000-0000-4000-8000-000000000001', 'activa', true, extensions.crypt('LOCAL-OBRA-01', extensions.gen_salt('bf'))),
  ('30000000-0000-4000-8000-000000000002', 'Edificio Ictinos Centro', '20000000-0000-4000-8000-000000000002', 'activa', false, null),
  ('30000000-0000-4000-8000-000000000003', 'Conjunto Villa del Sol Fase 1', '20000000-0000-4000-8000-000000000003', 'activa', false, null),
  ('30000000-0000-4000-8000-000000000004', 'Torre Mizar Etapa 2', '20000000-0000-4000-8000-000000000001', 'activa', false, null),
  ('30000000-0000-4000-8000-000000000005', 'Bodega Ictinos Norte', '20000000-0000-4000-8000-000000000002', 'activa', false, null),
  ('30000000-0000-4000-8000-000000000006', 'Conjunto Villa del Sol Fase 2', '20000000-0000-4000-8000-000000000003', 'activa', false, null),
  ('30000000-0000-4000-8000-000000000007', 'Urbanizacion Mizar Sur', '20000000-0000-4000-8000-000000000001', 'activa', false, null),
  ('30000000-0000-4000-8000-000000000008', 'Locales Ictinos Plaza', '20000000-0000-4000-8000-000000000002', 'activa', false, null),
  ('30000000-0000-4000-8000-000000000009', 'Casa Modelo Villa del Sol', '20000000-0000-4000-8000-000000000003', 'activa', false, null),
  ('30000000-0000-4000-8000-000000000010', 'Parqueadero Mizar', '20000000-0000-4000-8000-000000000001', 'activa', false, null),
  ('30000000-0000-4000-8000-000000000011', 'Oficinas Ictinos Piso 3', '20000000-0000-4000-8000-000000000002', 'activa', false, null),
  ('30000000-0000-4000-8000-000000000012', 'Zonas Comunes Villa del Sol', '20000000-0000-4000-8000-000000000003', 'activa', false, null),
  ('30000000-0000-4000-8000-000000000013', 'Proim Via Terciaria Km 4', '20000000-0000-4000-8000-000000000004', 'activa', false, null),
  ('30000000-0000-4000-8000-000000000014', 'Proim Puente Peatonal', '20000000-0000-4000-8000-000000000004', 'activa', false, null),
  ('30000000-0000-4000-8000-000000000015', 'Miradores de Cantalta', '20000000-0000-4000-8000-000000000005', 'activa', false, null),
  ('30000000-0000-4000-8000-000000000016', 'Miradores de Cantalta Etapa 2', '20000000-0000-4000-8000-000000000005', 'activa', false, null),
  ('30000000-0000-4000-8000-000000000017', 'Proim Acueducto Vereda', '20000000-0000-4000-8000-000000000004', 'activa', false, null)
on conflict (id) do update set nombre = excluded.nombre, sociedad_id = excluded.sociedad_id, estado = excluded.estado;

-- La etiqueta sugiere el aprobador por defecto (el revisor puede cambiarlo). Nómina va a Juliana
-- para que ambos aprobadores aparezcan en la demo. `aprobador_id` por CORREO (H8, mismo motivo que
-- usuario_roles arriba): este insert SIEMPRE actualiza aprobador_id por el conflicto de `nombre`, y un
-- id literal que no exista todavía en `usuarios` (cuenta vieja conservada) violaría la FK en el UPDATE.
insert into public.etiquetas (nombre, aprobador_id, activa)
select t.nombre, u.id, true
from (values
  ('Materiales', 'nelson.demo@mizar.test'),
  ('Nomina', 'juliana.demo@mizar.test'),
  ('Servicios', 'nelson.demo@mizar.test'),
  ('Herramientas', 'nelson.demo@mizar.test'),
  ('Transporte', 'nelson.demo@mizar.test')
) as t(nombre, email)
join public.usuarios u on lower(u.email) = lower(t.email)
on conflict (nombre) do update set aprobador_id = excluded.aprobador_id, activa = excluded.activa;

insert into public.proveedores (id, razon_social, nit, contacto, datos_bancarios, activo) values
  ('40000000-0000-4000-8000-000000000001', 'Ferreteria Demo del Norte SAS', '901000001-1', '{}', '{}', true),
  ('40000000-0000-4000-8000-000000000002', 'Concretos Demo del Valle SAS', '901000002-2', '{}', '{}', true),
  ('40000000-0000-4000-8000-000000000003', 'Electricos Demo Ltda', '901000003-3', '{}', '{}', true),
  ('40000000-0000-4000-8000-000000000004', 'Maderas y Formaletas Demo SAS', '901000004-4', '{}', '{}', true),
  ('40000000-0000-4000-8000-000000000005', 'Transportes Demo del Sur SAS', '901000005-5', '{}', '{}', true)
on conflict (id) do update set razon_social = excluded.razon_social, nit = excluded.nit, activo = excluded.activo;

-- Catálogo de materiales frecuentes. Generado con la misma normalización que usa la aplicación
-- (lib/domain/normalization.ts) para que nombre_normalizado coincida con lo que la app calcularía.
insert into public.items (nombre, nombre_normalizado, especificacion, unidad_defecto, categoria, estado, creado_por) values
  ('Cemento gris 50 kg', 'cemento gris 50 kg', null, 'bulto', 'Materiales', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Arena de rio', 'arena de rio', null, 'm3', 'Materiales', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Varilla corrugada 3/8', 'varilla corrugada 3 8', null, 'unidad', 'Materiales', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Ladrillo hueco', 'ladrillo hueco', null, 'unidad', 'Materiales', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Pintura blanca', 'pintura blanca', null, 'galon', 'Acabados', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Cable electrico calibre 12', 'cable electrico calibre 12', null, 'm', 'Electrico', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Cemento blanco 25 kg', 'cemento blanco 25 kg', null, 'bulto', 'Materiales', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Arena de peña', 'arena de pena', null, 'm3', 'Materiales', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Arena lavada', 'arena lavada', null, 'm3', 'Materiales', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Triturado 3/4', 'triturado 3 4', null, 'm3', 'Materiales', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Triturado 1/2', 'triturado 1 2', null, 'm3', 'Materiales', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Gravilla', 'gravilla', null, 'm3', 'Materiales', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Recebo', 'recebo', null, 'm3', 'Materiales', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Varilla corrugada 1/2', 'varilla corrugada 1 2', null, 'unidad', 'Materiales', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Varilla corrugada 5/8', 'varilla corrugada 5 8', null, 'unidad', 'Materiales', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Varilla corrugada 1/4', 'varilla corrugada 1 4', null, 'unidad', 'Materiales', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Malla electrosoldada 15x15', 'malla electrosoldada 15x15', null, 'rollo', 'Materiales', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Alambre recocido', 'alambre recocido', null, 'kg', 'Materiales', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Alambre de amarre', 'alambre de amarre', null, 'kg', 'Materiales', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Bloque estructural', 'bloque estructural', null, 'unidad', 'Materiales', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Bloque de arcilla No 5', 'bloque de arcilla no 5', null, 'unidad', 'Materiales', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Ladrillo tolete', 'ladrillo tolete', null, 'unidad', 'Materiales', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Adoquin de concreto', 'adoquin de concreto', null, 'm2', 'Materiales', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Teja de zinc 3 m', 'teja de zinc 3 m', null, 'unidad', 'Materiales', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Teja de fibrocemento', 'teja de fibrocemento', null, 'unidad', 'Materiales', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Perfil metalico PHR C', 'perfil metalico phr c', null, 'unidad', 'Materiales', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Lamina galvanizada cal 22', 'lamina galvanizada cal 22', null, 'unidad', 'Materiales', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Angulo de hierro 1 1/2', 'angulo de hierro 1 1 2', null, 'unidad', 'Materiales', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Madera formaleta', 'madera formaleta', null, 'unidad', 'Materiales', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Tabla burra', 'tabla burra', null, 'unidad', 'Materiales', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Liston de madera 4x4', 'liston de madera 4x4', null, 'unidad', 'Materiales', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Puntilla 2 pulgadas', 'puntilla 2 pulgadas', null, 'kg', 'Materiales', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Puntilla 3 pulgadas', 'puntilla 3 pulgadas', null, 'kg', 'Materiales', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Tornillo drywall', 'tornillo drywall', null, 'caja', 'Materiales', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Lamina drywall 1/2', 'lamina drywall 1 2', null, 'unidad', 'Acabados', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Perfil paral drywall', 'perfil paral drywall', null, 'unidad', 'Acabados', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Yeso en polvo', 'yeso en polvo', null, 'bulto', 'Acabados', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Masilla acrilica', 'masilla acrilica', null, 'galon', 'Acabados', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Estuco plastico', 'estuco plastico', null, 'galon', 'Acabados', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Pintura vinilo tipo 1', 'pintura vinilo tipo 1', null, 'galon', 'Acabados', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Pintura anticorrosiva', 'pintura anticorrosiva', null, 'galon', 'Acabados', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Esmalte sintetico', 'esmalte sintetico', null, 'galon', 'Acabados', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Impermeabilizante', 'impermeabilizante', null, 'galon', 'Acabados', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Sika 1', 'sika 1', null, 'kg', 'Acabados', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Pegante ceramico', 'pegante ceramico', null, 'bulto', 'Acabados', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Boquilla para ceramica', 'boquilla para ceramica', null, 'kg', 'Acabados', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Ceramica piso 33x33', 'ceramica piso 33x33', null, 'm2', 'Acabados', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Porcelanato 60x60', 'porcelanato 60x60', null, 'm2', 'Acabados', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Guardaescoba ceramico', 'guardaescoba ceramico', null, 'm', 'Acabados', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Tubo PVC sanitario 4 pulgadas', 'tubo pvc sanitario 4 pulgadas', null, 'unidad', 'Plomeria', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Tubo PVC sanitario 2 pulgadas', 'tubo pvc sanitario 2 pulgadas', null, 'unidad', 'Plomeria', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Tubo PVC presion 1/2', 'tubo pvc presion 1 2', null, 'unidad', 'Plomeria', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Tubo PVC presion 1 pulgada', 'tubo pvc presion 1 pulgada', null, 'unidad', 'Plomeria', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Codo PVC 1 pulgada', 'codo pvc 1 pulgada', null, 'unidad', 'Plomeria', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Codo PVC 1/2', 'codo pvc 1 2', null, 'unidad', 'Plomeria', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Tee PVC 1/2', 'tee pvc 1 2', null, 'unidad', 'Plomeria', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Union PVC 1/2', 'union pvc 1 2', null, 'unidad', 'Plomeria', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Adaptador macho PVC 1/2', 'adaptador macho pvc 1 2', null, 'unidad', 'Plomeria', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Soldadura PVC 1/4 galon', 'soldadura pvc 1 4 galon', null, 'unidad', 'Plomeria', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Limpiador PVC', 'limpiador pvc', null, 'unidad', 'Plomeria', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Registro de bola 1/2', 'registro de bola 1 2', null, 'unidad', 'Plomeria', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Llave de paso 1/2', 'llave de paso 1 2', null, 'unidad', 'Plomeria', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Sanitario blanco', 'sanitario blanco', null, 'unidad', 'Plomeria', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Lavamanos blanco', 'lavamanos blanco', null, 'unidad', 'Plomeria', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Griferia lavamanos', 'griferia lavamanos', null, 'unidad', 'Plomeria', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Tanque de agua 500 L', 'tanque de agua 500 l', null, 'unidad', 'Plomeria', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Manguera 1/2 pulgada', 'manguera 1 2 pulgada', null, 'rollo', 'Plomeria', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Cable electrico calibre 10', 'cable electrico calibre 10', null, 'm', 'Electrico', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Cable electrico calibre 14', 'cable electrico calibre 14', null, 'm', 'Electrico', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Cable duplex 2x12', 'cable duplex 2x12', null, 'm', 'Electrico', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Tubo conduit PVC 1/2', 'tubo conduit pvc 1 2', null, 'unidad', 'Electrico', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Tubo conduit PVC 3/4', 'tubo conduit pvc 3 4', null, 'unidad', 'Electrico', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Caja octagonal PVC', 'caja octagonal pvc', null, 'unidad', 'Electrico', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Caja rectangular PVC', 'caja rectangular pvc', null, 'unidad', 'Electrico', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Interruptor sencillo', 'interruptor sencillo', null, 'unidad', 'Electrico', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Interruptor doble', 'interruptor doble', null, 'unidad', 'Electrico', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Toma doble con polo a tierra', 'toma doble con polo a tierra', null, 'unidad', 'Electrico', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Breaker 20 A', 'breaker 20 a', null, 'unidad', 'Electrico', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Tablero de 8 circuitos', 'tablero de 8 circuitos', null, 'unidad', 'Electrico', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Cinta aislante', 'cinta aislante', null, 'unidad', 'Electrico', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Bombillo LED 9 W', 'bombillo led 9 w', null, 'unidad', 'Electrico', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Roseta plastica', 'roseta plastica', null, 'unidad', 'Electrico', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Rodillo de pintura', 'rodillo de pintura', null, 'unidad', 'Herramientas', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Brocha 3 pulgadas', 'brocha 3 pulgadas', null, 'unidad', 'Herramientas', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Disco de corte 4 1/2', 'disco de corte 4 1 2', null, 'unidad', 'Herramientas', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Disco de pulir', 'disco de pulir', null, 'unidad', 'Herramientas', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Pala cuadrada', 'pala cuadrada', null, 'unidad', 'Herramientas', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Pica', 'pica', null, 'unidad', 'Herramientas', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Carretilla', 'carretilla', null, 'unidad', 'Herramientas', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Palustre', 'palustre', null, 'unidad', 'Herramientas', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Llana metalica', 'llana metalica', null, 'unidad', 'Herramientas', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Nivel de burbuja 24 pulgadas', 'nivel de burbuja 24 pulgadas', null, 'unidad', 'Herramientas', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Flexometro 5 m', 'flexometro 5 m', null, 'unidad', 'Herramientas', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Martillo de uña', 'martillo de una', null, 'unidad', 'Herramientas', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Segueta', 'segueta', null, 'unidad', 'Herramientas', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Cimbra', 'cimbra', null, 'unidad', 'Herramientas', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Balde plastico', 'balde plastico', null, 'unidad', 'Herramientas', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Guantes de seguridad', 'guantes de seguridad', null, 'par', 'Seguridad', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Casco de seguridad', 'casco de seguridad', null, 'unidad', 'Seguridad', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Gafas de seguridad', 'gafas de seguridad', null, 'unidad', 'Seguridad', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Botas de seguridad', 'botas de seguridad', null, 'par', 'Seguridad', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Arnes de seguridad', 'arnes de seguridad', null, 'unidad', 'Seguridad', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Tapabocas desechable', 'tapabocas desechable', null, 'caja', 'Seguridad', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Chaleco reflectivo', 'chaleco reflectivo', null, 'unidad', 'Seguridad', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Señalizacion de obra', 'senalizacion de obra', null, 'unidad', 'Seguridad', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Cinta de peligro', 'cinta de peligro', null, 'rollo', 'Seguridad', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Alquiler mezcladora', 'alquiler mezcladora', null, 'dia', 'Servicios', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Alquiler andamio', 'alquiler andamio', null, 'dia', 'Servicios', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Alquiler retroexcavadora', 'alquiler retroexcavadora', null, 'hora', 'Servicios', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Servicio de excavacion', 'servicio de excavacion', null, 'hora', 'Servicios', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Mantenimiento herramienta', 'mantenimiento herramienta', null, 'servicio', 'Servicios', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Mano de obra oficial', 'mano de obra oficial', null, 'dia', 'Servicios', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Mano de obra ayudante', 'mano de obra ayudante', null, 'dia', 'Servicios', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Flete materiales', 'flete materiales', null, 'viaje', 'Transporte', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Volqueta de escombros', 'volqueta de escombros', null, 'viaje', 'Transporte', 'activo', '10000000-0000-4000-8000-000000000002'),
  ('Elemento pendiente demo', 'elemento pendiente demo', 'Normalizar con el revisor', 'unidad', 'Pendientes', 'pendiente_normalizacion', '10000000-0000-4000-8000-000000000002')
on conflict (nombre_normalizado) do update set nombre = excluded.nombre, especificacion = excluded.especificacion, unidad_defecto = excluded.unidad_defecto, categoria = excluded.categoria, estado = excluded.estado;
