# Migración a Postgres autoalojado

**Fecha:** 10 de septiembre de 2026 · **Estado:** código listo, pendiente de ejecutar en el VPS

Sale Supabase; entra un Postgres propio en el VPS que ya pagamos, con respaldo diario cifrado a
Google Drive. La aplicación no cambia de forma: sigue siendo Next.js hablando SQL directo.

## Por qué

La decisión original ([PRD §9.2](../PRD.md)) fue correcta con la información de entonces: USD 25/mes
del plan Pro compraban backups, autenticación y almacenamiento ya construidos. Dos cosas la
cambiaron:

1. **El plan Free no sirve para esto.** Pausa el proyecto tras 7 días sin actividad y no hace
   backups. El 10 de septiembre el proyecto configurado en `.env.local` no resolvía ni en DNS y el
   pooler rechazaba las credenciales — exactamente el aspecto de un proyecto Free pausado.
2. **El acoplamiento resultó ser mínimo.** Toda la lógica ya hablaba SQL directo con el driver
   `postgres`. Solo dos cosas dependían de Supabase: la autenticación (~134 líneas) y el
   almacenamiento de adjuntos (7 llamadas). El resto —13.658 líneas— era portable tal cual.

Con el VPS ya pagado, autoalojar cuesta el trabajo de reemplazar esas dos piezas y la operación de
los respaldos. A cambio: sin pausas, sin límite de 1 GB de archivos, sin mensualidad.

## Qué cambió en el código

| Pieza | Antes | Ahora |
|---|---|---|
| Base de datos | Postgres gestionado por Supabase | Servicio `db` en [compose.yaml](../compose.yaml), Postgres 18, sin puerto público |
| Sesiones | JWT de Supabase Auth | Token opaco en `public.sesiones` ([local-auth.ts](../lib/infrastructure/local-auth.ts)) |
| Contraseñas | bcrypt en `auth.users` | **Las mismas**, verificadas con `extensions.crypt` |
| Adjuntos | Supabase Storage + URLs firmados | Volumen `storage_data` + token HMAC ([local-storage.ts](../lib/infrastructure/local-storage.ts)) |
| Migraciones | `supabase db push` | [ops/apply-migrations.sh](../ops/apply-migrations.sh) |
| Respaldo | Workflow de GitHub Actions | [ops/backup-daily.sh](../ops/backup-daily.sh) → Google Drive |

Dos consecuencias que conviene tener presentes:

- **Nadie pierde su contraseña.** Supabase Auth guardaba bcrypt en `auth.users.encrypted_password`, y
  este repo ya usaba bcrypt vía pgcrypto para el portal público. Verificamos con el mismo algoritmo,
  así que los hashes que vengan en el `pg_dump` siguen sirviendo.
- **La recuperación por correo desapareció.** No hay SMTP detrás y montarlo para <30 usuarios no se
  justifica. Ahora un administrador asigna una contraseña temporal con
  `POST /api/usuarios/:id/clave`, que además cierra todas las sesiones de esa cuenta.

## Antes de empezar

- Acceso SSH al VPS y `docker compose` funcionando.
- Una cuenta de Google para los respaldos. Con Workspace (como sixteam.pro) la pantalla de
  consentimiento se crea **Interna**; con una cuenta Gmail corriente hay que **publicar** la app
  («En producción»), porque una app Externa en modo «Prueba» emite tokens que caducan a los 7 días y
  el respaldo se rompería en silencio.
- Decidir si se cifra. Con cifrado, guardar **fuera del VPS** la `BACKUP_PASSPHRASE`: si se pierde
  con el servidor, los respaldos cifrados no sirven para nada. Sin cifrado (`BACKUP_ENCRYPT=no`, el
  estado actual desde el 18-sep-2026) el Drive de destino debe ser privado y no compartirse.

## Paso 1 — Recuperar los datos de Supabase

**Primero:** entra al panel de Supabase y mira si el proyecto está pausado o eliminado.

**Si está pausado:** reactívalo y saca el volcado completo, incluido el esquema `auth` (ahí viven las
contraseñas) y los archivos de los buckets.

```bash
pg_dump --format=custom --no-owner --no-acl --schema=public --schema=auth -f mizar-supabase.dump "$SUPABASE_DATABASE_URL"
```

Los archivos de Storage hay que bajarlos aparte — `pg_dump` no los incluye. Descarga los buckets
`requisicion-adjuntos` y `proveedor-documentos-privados` desde el panel o con la CLI de Supabase.

**Si está eliminado:** los datos no se recuperan y la plataforma arranca vacía. **Este es el camino
elegido el 10-sep-2026.** Se aplican bootstrap y migraciones, y luego `ops/datos-demo.sh`:

```bash
ops/datos-demo.sh completo   # maestros + movimiento de demostración, para poder mostrarla
ops/datos-demo.sh maestros   # solo los maestros, para operar de verdad
```

Los maestros reales (17 obras, proveedores, catálogo de ítems) se recargan después con
`scripts/import-master-data.ts` desde los Excel del cliente, y los usuarios se crean con contraseña
temporal vía `POST /api/usuarios/:id/clave`. Con 17 obras y menos de 30 usuarios es un día de
trabajo, no un proyecto.

> **Antes de operar de verdad, recrea la base.** Los datos de demostración no se pueden deshacer
> del todo: `auditoria` es inmutable por diseño (un trigger rechaza UPDATE y DELETE), así que la
> actividad inventada deja rastro permanente en el registro contable, y los consecutivos
> `REQ-2026-0001` en adelante quedan consumidos. Mientras no haya datos reales, recrear es barato:
> `docker compose down && docker volume rm <proyecto>_db_data && docker compose up -d db`, luego
> `ops/apply-migrations.sh` y `ops/datos-demo.sh maestros`.

## Paso 2 — Levantar el Postgres propio

En el VPS, con el repo en `/opt/mizar`:

```bash
cd /opt/mizar && docker compose up -d db
```

Variables nuevas en `.env.production` (las tres de Supabase ya no se usan y se pueden borrar):

| Variable | Qué es |
|---|---|
| `POSTGRES_PASSWORD` | Contraseña del Postgres local. Solo la usa la red interna de Docker |
| `DATABASE_URL` | `postgresql://mizar:<contraseña>@db:5432/mizar` |
| `STORAGE_ROOT` | `/var/lib/mizar/storage` |
| `STORAGE_SIGNING_SECRET` | ≥32 caracteres. Firma los enlaces de subida/descarga |

La base **no expone ningún puerto** a propósito. Para conectarse: `docker compose exec db psql -U mizar`.

## Paso 3 — Esquema y datos

```bash
ops/apply-migrations.sh
```

Aplica el bootstrap ([supabase/bootstrap/00_compat_autoalojado.sql](../supabase/bootstrap/00_compat_autoalojado.sql):
roles, esquema `auth`, pgcrypto) y luego las migraciones en orden, registrando cada una en
`public.migraciones_aplicadas`. Es idempotente: se puede correr en cada despliegue.

Ese bootstrap es el mismo archivo que usa `npm run verify:schema` en CI — a propósito. Si CI y el
servidor arrancaran desde puntos distintos, CI dejaría de probar lo que se despliega.

### Si tienes volcado de Supabase, el ORDEN se invierte

Restaura **antes** de migrar, no después. El volcado trae el esquema de Supabase tal como estaba el
día del corte; si se aplican primero las migraciones, `migraciones_aplicadas` queda con las diez
marcadas sobre una base vacía y **los backfills nunca tocan los datos restaurados**. El más caro es
el de `202609070003`: `gastos.fecha_orden` se llenaría con `current_date`, es decir, con la fecha del
despliegue en vez de la fecha real de cada orden.

```bash
# 1. Sobre la base recién creada, ANTES de ops/apply-migrations.sh
docker compose exec -T db pg_restore --no-owner --no-acl -U mizar -d mizar < mizar-supabase.dump

# 2. Comprobar que los índices únicos NUEVOS no choquen con los datos que acaban de entrar.
#    Las dos consultas deben devolver cero filas; si no, hay que deduplicar antes de migrar.
docker compose exec -T db psql -U mizar -d mizar -c "
  select requisicion_id, proveedor_id, count(*) from public.ordenes
   group by 1,2 having count(*) > 1;"
docker compose exec -T db psql -U mizar -d mizar -c "
  select lower(email), count(*) from auth.users
   group by 1 having count(*) > 1;"

# 3. Ahora sí las migraciones, que backfillean sobre los datos reales
ops/apply-migrations.sh

# 4. Los archivos, que pg_dump no incluye
docker compose cp ./adjuntos app:/var/lib/mizar/storage/requisicion-adjuntos
```

Con arranque en vacío (el camino elegido) nada de esto aplica: las migraciones corren sobre una base
sin filas y no hay nada que deduplicar.

## Paso 4 — Google Drive

Una sola vez, desde tu máquina (necesita navegador):

```bash
GDRIVE_CLIENT_ID=... GDRIVE_CLIENT_SECRET=... node ops/gdrive-authorize.mjs
```

El guion lleva las instrucciones de qué crear en Google Cloud Console (proyecto, Drive API, cliente
OAuth **de tipo App de escritorio**) y al terminar imprime `GDRIVE_REFRESH_TOKEN` y
`GDRIVE_FOLDER_ID` para el entorno del cron.

Detalle que cuesta una tarde si se descubre solo: **no uses una cuenta de servicio con una carpeta de
"Mi unidad"**. Las cuentas de servicio no tienen cuota propia y la subida falla con *"Service Accounts
do not have storage quota"*. El camino con token de actualización de una cuenta normal (el que
configura este guion) no tiene ese problema. La cuenta de servicio solo sirve contra una Unidad
compartida de Workspace.

## Paso 5 — El cron

```bash
sudo crontab -e
```

```cron
MAILTO=ernesto@sixteam.pro
0 8 * * * cd /opt/mizar && set -a && . /opt/mizar/.env.backup && set +a && ops/backup-daily.sh >> /var/log/mizar-backup.log 2>&1
```

03:00 hora Colombia = 08:00 UTC. `/opt/mizar/.env.backup` (permisos 600) lleva `BACKUP_PASSPHRASE`
(o `BACKUP_ENCRYPT=no`), `GDRIVE_CLIENT_ID`, `GDRIVE_CLIENT_SECRET`, `GDRIVE_REFRESH_TOKEN`,
`GDRIVE_FOLDER_ID` y, opcional
pero recomendado, `HEARTBEAT_BACKUP_URL`: la URL de un latido de healthchecks.io o de Better Stack.
El guion la llama al terminar bien y le añade `/fail` si falla. Si un día el cron ni siquiera arranca,
el monitor avisa porque el latido no llega. `MAILTO` solo avisa cuando hay salida, y un cron que no
corre no produce ninguna.

Cada noche sube dos objetos —la base y los archivos, cifrados salvo `BACKUP_ENCRYPT=no`— más su
`.sha256`, purga lo que pase de 35 días y limpia las sesiones vencidas.

## Paso 5b — Enrutar el dominio (VPS con EasyPanel)

EasyPanel ya ocupa los puertos 80 y 443 con su propio Traefik, así que **no se levanta el servicio
`caddy` de compose.yaml**: solo `docker compose up -d db app`. El enrutado se le añade a ese Traefik
con un archivo propio, sin tocar ninguno de los que EasyPanel genera para los demás servicios del
servidor:

```bash
scp ops/traefik-easypanel.yaml root@<vps>:/etc/easypanel/traefik/config/mizar-compras.yaml
ssh root@<vps> "docker network connect easypanel mizar-app-1"
```

Conectar la aplicación a la red `easypanel` es imprescindible: es la única que Traefik ve, y hay que
rehacerlo tras cada `docker compose down`. Traefik recarga ese directorio solo, sin reiniciarse.

Aplicado y verificado el 2026-09-11: `https://comprasmizar.sixteam.pro/api/health` responde 200 y
`/` redirige a `/login` sin error de configuración.

## Paso 6 — Verificar

1. `curl -s localhost:3000/api/health` responde `ok`, no `unconfigured`.
2. Login con un usuario real. Si el volcado traía las contraseñas, la suya funciona sin cambios.
3. Subir un adjunto y volver a descargarlo.
4. `ops/backup-daily.sh` a mano una vez, y comprobar que los archivos aparecen en Drive.
5. **`ops/restore-verify.sh`** — el ensayo de restauración. Baja el respaldo, verifica el checksum, lo
   descifra y lo restaura en una base desechable. **Esto es bloqueante antes de dar el sistema por
   productivo**, y se repite cada trimestre. Un backup que nunca se restauró no es un backup.

## Reversión

Mientras el proyecto de Supabase siga existiendo, volver es cambiar `DATABASE_URL` y restaurar las
tres variables de Supabase. El esquema es el mismo. Lo que **no** vuelve solo son los adjuntos subidos
después del corte (están en el volumen, no en el bucket) y las sesiones abiertas (todo el mundo tendrá
que entrar de nuevo).

Pasada la primera semana sin incidentes, esa puerta se cierra sola: los datos nuevos solo estarán en
el VPS.

## Lo que esta migración mejoró de paso

- **Se verifica el MIME real de lo que sube el navegador.** Antes el archivo iba directo al bucket y
  el servidor nunca veía los bytes: había que creerle al `Content-Type` declarado. Ahora la subida
  pasa por `/api/storage/object`, que husmea la firma binaria. Un ejecutable renombrado a `.pdf` ya no
  entra.
- **Cerrar sesión y dar de baja surten efecto de inmediato.** Un JWT vale hasta que vence; un token en
  tabla se borra.
- **El respaldo incluye los archivos.** El workflow anterior solo copiaba la base — restaurarlo habría
  dejado todas las requisiciones sin sus fotos ni facturas, y eso no se descubre hasta el peor día.
