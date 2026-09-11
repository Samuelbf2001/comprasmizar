-- Alta de usuarios desde la propia plataforma (2026-09-11).
--
-- Hasta ahora la plataforma NUNCA creaba cuentas de acceso: solo vinculaba un id que ya existiera en
-- `auth.users`, porque crearlas era trabajo del panel de Supabase. Al salir de Supabase ese panel
-- desapareció y con él la única forma de dar de alta a alguien — un hueco que dejaba el sistema sin
-- manera soportada de incorporar usuarios nuevos. Ver docs/migracion-autoalojado.md.
--
-- Esta migración prepara la base para que el alta la haga la aplicación. El insert vive en
-- lib/infrastructure/postgres-repositories.ts (create de la clase de catálogos), dentro de la misma
-- transacción que `usuarios` y `usuario_roles`.

-- El login resuelve la cuenta con `where lower(u.email) = lower($1) limit 1`
-- (lib/infrastructure/local-auth.ts). Sin unicidad sobre esa MISMA expresión, dos cuentas que solo
-- difieran en mayúsculas —"Ana@mizar.co" y "ana@mizar.co"— serían ambas válidas y el `limit 1`
-- elegiría una arbitrariamente: la persona entraría a veces con unos roles y a veces con otros.
-- `public.usuarios` ya tenía `unique (email)`, pero es sensible a mayúsculas y no cubre `auth.users`,
-- que es la tabla contra la que se autentica.
create unique index if not exists auth_users_email_unico_ci on auth.users (lower(email));

-- NO se añade un check que exija `encrypted_password`, aunque la primera versión de esta migración lo
-- intentaba. El arnés de esquema lo tumbó contra datos legado
-- (supabase/tests/legacy/*.pre.sql insertan cuentas solo con id y correo) y tenía razón: Supabase Auth
-- admitía cuentas sin contraseña —enlace mágico, proveedor externo— así que una base real puede
-- traerlas y la migración habría fallado al aplicarse. Tampoco hacía falta: el login ya exige
-- `encrypted_password is not null` (lib/infrastructure/local-auth.ts), de modo que una cuenta sin
-- clave simplemente no entra. La restricción habría añadido riesgo de despliegue sin cerrar ningún
-- agujero.
