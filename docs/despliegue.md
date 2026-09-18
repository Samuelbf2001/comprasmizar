# Despliegue

La aplicación se despliega como **imagen Docker** publicada por CI en GitHub Container Registry (GHCR) y consumida por EasyPanel en el VPS. Desde la [migración a autoalojado](migracion-autoalojado.md) del 10 de septiembre de 2026, **los datos también viven en el VPS**: Postgres en un contenedor sin puerto público, sesiones propias y adjuntos en un volumen. Supabase ya no interviene.

```
  push a main ──► GitHub Actions ──► ghcr.io/samuelbf2001/comprasmizar:<sha>
                  (lint, tipos, tests,                    │
                   cobertura, build, E2E)                 ▼
                                              EasyPanel (VPS) hace pull
                                                          │
                                                          ▼
                                              contenedor :3000 + TLS
                                                          │
                                                          ▼
                                    Postgres + volumen de adjuntos (mismo VPS)
```

Por qué imagen y no build en el servidor: la imagen que se despliega es **exactamente** la que pasó CI, la etiqueta por commit permite revertir a una versión concreta, y el VPS no necesita toolchain de Node ni recursos para compilar.

## 1. Variables: build vs ejecución

Distinción crítica de Next.js. Las `NEXT_PUBLIC_*` se **incrustan en el bundle del navegador durante el build**; no se leen en ejecución. Si faltan al construir la imagen, quedan `undefined` en el cliente por más que se definan luego en EasyPanel.

**Se pasan como build-args** (en `.github/workflows/ci.yml`, desde *Variables* del repositorio — nunca *Secrets*, porque acaban siendo públicas en el bundle):

| Variable | Valor | Efecto si falta |
|---|---|---|
| `NEXT_PUBLIC_APP_URL` | `https://comprasmizar.sixteam.pro` | Enlaces de recuperación de contraseña rotos |
| `NEXT_PUBLIC_DEMO_MODE` | `false` (fijo en CI) | Falla cerrado hacia Auth — es el default seguro |

> La URL del inbox de Kapso **no** es build-arg a propósito: es una credencial portadora (abre las conversaciones de la línea sin login, verificado contra el servicio real). Va como `KAPSO_EMBED_URL` en el entorno de ejecución y la sirve `/api/kapso-embed` solo a sesiones autenticadas con rol Revisor o Administrador.

**Se definen en EasyPanel como entorno del servicio** (secretos reales, nunca en la imagen ni en el repo):

| Variable | Notas |
|---|---|
| `DATABASE_URL` | `postgresql://mizar:<contraseña>@db:5432/mizar`. La contraseña va **URL-encoded** (`!` → `%21`) |
| `POSTGRES_PASSWORD` | Contraseña del Postgres del compose. Solo circula por la red interna de Docker |
| `STORAGE_ROOT` | `/var/lib/mizar/storage` (volumen `storage_data`). Obligatoria, sin default |
| `STORAGE_SIGNING_SECRET` | ≥32 caracteres. Firma los enlaces de subida/descarga de adjuntos |
| `PUBLIC_FORM_CODE_PEPPER` | ≥32 caracteres. Generar con `crypto.randomBytes(32)` |
| `MCP_KEY_PEPPER` | ≥32 caracteres |
| `KAPSO_API_KEY` | Clave del proyecto Kapso |
| `KAPSO_WEBHOOK_SECRET` | ≥32 caracteres. **Debe coincidir** con el registrado en Kapso |
| `KAPSO_PHONE_NUMBER_ID` | `1221974497672719` (línea MIZAR) |
| `KAPSO_EMBED_URL` | URL del inbox embebido (embed `fab3fa49…`, alcance: solo línea MIZAR, orígenes: compras.grupomizar.com.co y localhost). **Con el dominio provisional `comprasmizar.sixteam.pro` este embed NO carga**: sus orígenes permitidos están atados al dominio definitivo; hay que crear otro embed con el origen nuevo (o esperar al dominio definitivo). Credencial portadora: tratar como secreto; para rotarla, DELETE del embed y crear otro |
| `NOTIFICATION_DISPATCH_SECRET` | ≥32 caracteres. Candado del endpoint interno que envía las notificaciones pendientes; el cron del VPS lo pasa en `x-dispatch-secret`. Sin él, el endpoint responde 503 |
| `LOG_INGEST_URL` / `LOG_INGEST_TOKEN` | Opcionales. Una fuente HTTP de Better Stack Telemetry (región **Alemania**): URL de ingesta y token de la fuente. Con ellas, cada error del servidor y cada adjunto descartado del portal se copian ahí por HTTPS ([lib/observability/report-error.ts](../lib/observability/report-error.ts)). Sin ellas quedan solo en `docker logs`. La app envía solo errores y avisos ya limpios: nunca cuerpos de petición, parámetros SQL ni query strings |
| `HEARTBEAT_DISPATCH_URL` | Opcional. URL del latido (healthchecks.io o Better Stack) que `ops/dispatch-notifications.sh` llama en cada vuelta buena y con `/fail` en cada vuelta mala. La lee el guion desde `.env.production`, no la aplicación. Si el cron deja de correr, ningún aviso de WhatsApp sale, y el latido que falta es lo que lo delata |
| `SEND_FLOW_SECRET` | ≥32 caracteres. Candado de los endpoints que reenvían un WhatsApp Flow a mano (`/api/internal/send-flow` y `/api/internal/send-approval-flow`). Propio y distinto del anterior: rotar uno no debe obligar a rotar el otro |

**WhatsApp Flows** (ver [integrations/whatsapp-flow/README.md](../integrations/whatsapp-flow/README.md)). Sin estas variables el canal simplemente no se intenta y las notificaciones salen como aviso de texto, así que se pueden cargar después sin romper nada:

| Variable | Notas |
|---|---|
| `WHATSAPP_FLOW_ID` | Flow de **captura** de requisición (`1972861836748301`) |
| `WHATSAPP_FLOW_MODE` | `draft` mientras ese Flow siga siendo borrador; quitar al publicarlo |
| `WHATSAPP_APPROVAL_FLOW_ID` | Flow de **aprobación** (`2249539985776722`). Ya está `PUBLISHED`, así que **no** lleva `WHATSAPP_APPROVAL_FLOW_MODE=draft` |
| `WHATSAPP_APPROVAL_TEMPLATE` | Opcional. Por defecto `aprobacion_requisicion`, la plantilla aprobada por Meta que lleva el botón del Flow y atraviesa la ventana de 24 h |
| `WHATSAPP_APPROVAL_TEMPLATE_LANG` | Opcional. Por defecto `es` |

El validador ([lib/security/env.ts](../lib/security/env.ts)) exige estas formas y **falla cerrado**: sin variables completas, `/api/health` responde `unconfigured` y los endpoints rechazan sin filtrar secretos.

## 2. Cómo se despliega de verdad en el VPS

**Léase esto antes que las secciones 3 y 4.** Describen un servicio tipo Compose gestionado por
EasyPanel que se planificó pero **no es lo que corre**. Lo que hay en producción desde el 11-sep-2026
es una pila `docker compose -p mizar` en `/opt/mizar`, construida **en el propio VPS**, con EasyPanel
limitándose a ser dueño de Traefik. La imagen de GHCR que publica CI existe y sirve para revertir,
pero el despliegue no la usa.

### La receta, exacta

Desde la máquina de desarrollo, con la llave SSH de despliegue:

```bash
SHA=$(git rev-parse origin/main)

# 1. El código. /opt/mizar NO es un repo git: se le vuelca el árbol de un commit.
#    ops/sync-arbol.sh BORRA lo que el commit ya no tiene (ver "Sincronizar borrando", abajo).
#    Se ejecuta desde /tmp a propósito: desde /opt/mizar/ops/ podría borrarse a sí mismo.
git archive --format=tar origin/main | ssh root@<vps> 'cat > /tmp/mizar-nuevo.tar'
scp ops/sync-arbol.sh root@<vps>:/tmp/sync-arbol.sh
ssh root@<vps> 'bash /tmp/sync-arbol.sh /tmp/mizar-nuevo.tar'

# 2. Imagen, con los TRES build-args. Ver más abajo por qué no son opcionales.
#    VA ANTES DE LAS MIGRACIONES: si el build falla, la base no se ha tocado.
ssh root@<vps> "cd /opt/mizar && docker compose -p mizar build \
  --build-arg NEXT_PUBLIC_APP_URL=https://comprasmizar.sixteam.pro \
  --build-arg NEXT_PUBLIC_DEMO_MODE=false \
  --build-arg APP_COMMIT=$SHA app"

# 3. Migraciones. Idempotente: lleva registro en public.migraciones_aplicadas.
ssh root@<vps> 'cd /opt/mizar && bash ops/apply-migrations.sh'

# 4. Arrancar y volver a enganchar Traefik (el connect se pierde en cada recreación).
ssh root@<vps> 'cd /opt/mizar && docker compose -p mizar up -d app \
  && docker network connect easypanel mizar-app-1'
```

**El orden de los pasos 2 y 3 es deliberado, y se pagó por aprenderlo.** Hasta el 11-sep-2026 las
migraciones iban antes del build. Ese día el build falló y el esquema quedó **adelantado respecto al
código que seguía corriendo**: la migración aplicada, la imagen vieja en pie. Fue inofensivo porque
esa migración solo añadía columnas, pero con una destructiva habría roto producción sin haber
desplegado nada. Construir primero hace que un build roto no llegue a tocar la base.

Queda una ventana irreducible entre el paso 3 y el 4: unos segundos con el esquema nuevo y el código
viejo. Para una migración aditiva es segura. **Para una destructiva no lo es**, y ninguna reordenación
la cierra: eso exige el patrón de dos fases — desplegar primero código que tolere los dos esquemas, y
borrar la columna en un despliegue posterior.

### Sincronizar borrando

`git archive | tar -x` escribe y sobrescribe, pero **nunca borra**. Un fichero que el commit elimina
se queda en el servidor para siempre. El 11-sep-2026 eso rompió un despliegue: la rama borró
`app/api/public/works/route.ts` y el huérfano siguió importando un símbolo que ya no existía, así que
`next build` falló. Había **seis** acumulados, todos del mismo refactor.

Ese fallo fue ruidoso por suerte, no por diseño. **Un huérfano que compile no rompe nada y se queda
sirviendo en producción**: una ruta de API borrada por seguridad seguiría respondiendo después de
"borrarla", y nadie lo vería.

[`ops/sync-arbol.sh`](../ops/sync-arbol.sh) lo resuelve con `rsync --delete` contra el árbol extraído
del commit. Conserva lo que no está en git y no debe perderse — `.env*` y sus respaldos,
`.credenciales-iniciales`, `respaldos/`, `node_modules/`, `.next/`, `.claude/` — y aborta si el tar
trae menos de 100 ficheros o le falta `package.json`/`compose.yaml`, porque un tar truncado con
`--delete` vaciaría medio `/opt/mizar`. Con `--simulacro` enseña lo que borraría sin tocar nada;
conviene usarlo la primera vez tras un refactor grande.

### Verificación, y qué mira cada comprobación

```bash
curl -s https://comprasmizar.sixteam.pro/api/health
```

Tienen que cumplirse las tres:

- `"status":"ok"` — el entorno base valida.
- `"origin":true` — se puede ESCRIBIR (ver la trampa 1). Sin esto la plataforma queda de solo lectura.
- `"commit":"<sha>"` — coincide con `git rev-parse origin/main`. Es lo que convierte «qué hay
  desplegado» en un dato comprobable en vez de una suposición.

Y una escritura de verdad, porque el health no la ejercita:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  https://comprasmizar.sixteam.pro/api/requisitions/<id>/actions \
  -H 'content-type: application/json' -H 'Origin: https://comprasmizar.sixteam.pro' \
  -d '{"action":"approve"}'
```

**401 es el resultado correcto** sin sesión: `assertSameOrigin` corre dentro de `authenticatedJson`,
así que sin cookie se rechaza antes de mirar la transición. Lo que NO puede salir es **503**: eso es
exactamente la trampa 1. Con una sesión válida sobre una requisición que no admita la transición,
sale un 422 de dominio.

### Las dos trampas que costaron un día entero

**1. Sin `--build-arg NEXT_PUBLIC_APP_URL`, la plataforma queda en SOLO LECTURA.**
Next sustituye `process.env.NEXT_PUBLIC_*` por un literal en tiempo de compilación, **también en el
código de servidor**. Si la build no recibe el valor, ahí no queda una variable que leer sino la
constante `undefined`, y `assertSameOrigin` ([lib/http/api.ts](../lib/http/api.ts)) lanza siempre.
Resultado: **todo POST y PATCH responden 503 mientras las lecturas siguen funcionando con
normalidad**. Navegando no se nota: el panel pinta datos reales y solo falla al guardar. Pasó el
11-sep-2026 y la plataforma estuvo así en producción sin que nadie lo viera.

El respaldo en ejecución es `APP_ORIGIN` (sin prefijo `NEXT_PUBLIC_`, por eso sí se lee al arrancar
y se puede corregir sin reconstruir). Está en `/opt/mizar/.env.production`. Pero el arreglo bueno es
pasar el build-arg; `APP_ORIGIN` es la red, no el suelo.

**2. `git archive` restaura los modos del índice, así que un guion puede llegar sin permiso de
ejecución.** Un fichero de `ops/` creado desde Windows —que no tiene bit de ejecución que git pueda
observar— se registra como `100644`. Al desplegar, el `chmod` que se le hubiera puesto a mano
desaparece y el cron pasa a fallar **cada minuto** con `Permission denied`, sin avisar a nadie: cron
no manda correo si no hay `MAILTO`, y el propio log solo recoge esa línea. Se perdieron 13 ciclos
antes de que se notara.

Regla: **todo guion de `ops/` va `100755` en el índice**. Comprobarlo con
`git ls-tree origin/main -- ops/`; si alguno sale `100644`, corregirlo con
`git update-index --chmod=+x <ruta>`.

### Otras cosas que conviene saber

- **El `docker network connect easypanel` hay que rehacerlo tras cada recreación** del contenedor.
  Sin él Traefik deja de enrutar el dominio y sale el «Service is not reachable» de EasyPanel, que
  parece una caída de la aplicación y no lo es.
- **`docker compose exec -T` consume stdin.** Un guion canalizado por `ssh 'bash -s'` que contenga un
  `docker compose exec` se corta a sí mismo: el exec se traga el resto del script. O se copia el
  guion con `scp` y se ejecuta, o cada `exec` lleva `< /dev/null`.
- Los secretos viven en `/opt/mizar/.env.production` (modo 600). Se generan **en el servidor**
  (`openssl rand -base64 32`) y no viajan por ningún otro sitio. Antes de tocar el fichero, copia de
  respaldo con marca de tiempo.

## 3. Publicar la imagen (respaldo y reversión)

Ya automatizado: cada push a `main` que pase calidad y E2E publica `ghcr.io/samuelbf2001/comprasmizar` con dos etiquetas — `:<sha>` (inmutable, para revertir) y `:main` (móvil).

El workflow trae `https://comprasmizar.sixteam.pro` como valor por defecto de `NEXT_PUBLIC_APP_URL`, así que no hace falta configurar nada en GitHub para el primer despliegue. Para cambiar de dominio (p. ej. al definitivo `compras.grupomizar.com.co`): definir la Variable del repositorio `NEXT_PUBLIC_APP_URL` en Settings → Secrets and variables → Actions → **Variables** (tiene prioridad sobre el default) y reconstruir la imagen — es build-arg, no basta cambiarla en EasyPanel.

El paquete de GHCR nace privado: hay que dar acceso de lectura al VPS con un token, o marcarlo público si no hay inconveniente (la imagen no contiene secretos, pero sí todo el código).

## 4. Servicio en EasyPanel (planificado, NO en uso)

El VPS aloja otros proyectos (`postgres`, `whatsfull`, `whatsful`). **Crear un proyecto nuevo y aislado** — no reutilizar los existentes.

### Por qué un servicio Compose y no una App (decisión 2026-09-11)

Tras la migración a autoalojado hay que desplegar **dos** contenedores, no uno: la aplicación y su Postgres. Las tres opciones y por qué se descartaron dos:

| Opción | Por qué no / sí |
|---|---|
| App desde imagen + Postgres gestionado por EasyPanel | Obliga a reescribir `apply-migrations.sh`, `backup-daily.sh` y `restore-verify.sh`, que hacen `docker compose exec -T db`. Son las herramientas donde un error se paga con datos perdidos: no es donde conviene improvisar |
| `compose.yaml` tal cual por SSH, con Caddy | Caddy pide los puertos 80/443, que EasyPanel ya ocupa sirviendo a los otros clientes del VPS. Tumbaría lo que ya está en producción |
| **Servicio tipo Compose en EasyPanel** ✅ | EasyPanel pone dominio y TLS; la pila conserva el servicio `db` y los scripts de operación siguen funcionando sin tocarlos |

### Pasos

1. Proyecto nuevo: `mizar-compras`.
2. Servicio tipo **Compose**, pegando [`ops/compose.easypanel.yaml`](../ops/compose.easypanel.yaml). Es `compose.yaml` **sin Caddy** (lo reemplaza el proxy de EasyPanel) y con `image:` de GHCR en vez de `build:`, para desplegar exactamente la imagen que pasó CI.
3. Credenciales de registro si el paquete de GHCR es privado.
4. Variables de entorno del servicio: la tabla de ejecución de arriba. No hay `.env.production` — las inyecta EasyPanel.
5. Dominio apuntando al servicio `app`, puerto `3000`. Certificado TLS gestionado por EasyPanel.
6. Recursos: 512 MB de RAM bastan para el volumen esperado (17 obras, <30 usuarios).

Los scripts de operación localizan el contenedor con `docker compose exec` desde `COMPOSE_DIR`, que por defecto es `/opt/mizar`. Con EasyPanel hay que **apuntar `COMPOSE_DIR` al directorio del proyecto de EasyPanel** (donde vive su `docker-compose.yml` generado) en el entorno del cron y al correr las migraciones a mano. Los nombres de servicio (`db`, `app`) son los mismos, así que no hay nada más que cambiar.

`compose.yaml` + `ops/Caddyfile` se conservan como la pila **independiente y completa**: sirven para un VPS dedicado sin EasyPanel y son la base del entorno de desarrollo (con `compose.local.yaml` encima). No se usan en este despliegue.

### Lo que Caddy hacía y EasyPanel debe cubrir

Dos cosas dejan de estar garantizadas al quitar Caddy. Los demás encabezados de seguridad (CSP, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, `X-Content-Type-Options`) los pone Next.js en [next.config.ts](../next.config.ts) y siguen intactos.

1. **`Strict-Transport-Security` (HSTS)** lo añadía solo Caddy. **Resuelto el 18-sep-2026:** lo pone `next.config.ts`. Hasta esa fecha producción servía sin HSTS.
2. **La IP del cliente para los limitadores, que es de seguridad, no cosmética.** Se suponía que el proxy sobrescribía `X-Real-IP`. Caddy sí lo hace; **el Traefik de EasyPanel no**: el 18-sep-2026 se comprobó contra producción que, rotando una `X-Real-IP` falsa, el limitador del portal dejaba de frenar. Con eso la contraseña del portal podía adivinarse sin techo, y cada intento cuesta un bcrypt en un VPS compartido. **Resuelto** con [lib/security/client-ip.ts](../lib/security/client-ip.ts): los limitadores de login, portal y MCP toman la ÚLTIMA entrada de `X-Forwarded-For`, la que añade el proxy, y ya no leen ninguna cabecera que escriba el cliente. El supuesto es un único proxy delante y sin CDN; si se pone Cloudflare, hay que revisarlo. Se comprueba con el paso 6.4.

## 5. Webhook de Kapso

Una vez el dominio esté en pie:

1. En Kapso, apuntar el webhook de la línea MIZAR a `https://comprasmizar.sixteam.pro/api/kapso`.
2. Registrar el **mismo** `KAPSO_WEBHOOK_SECRET`. Si no coincide, la firma no valida y todo evento se rechaza — que es el comportamiento correcto, pero parecerá que "no llega nada".
3. Verificar la entrega con el MCP de Kapso (`https://api.kapso.ai/mcp`) antes de dar por buena la integración.

Nota: los adjuntos del Flow ya se copian server-side: el webhook descarga cada `attachmentUrl` desde Kapso (bearer `KAPSO_API_KEY`), valida la firma binaria real (pdf/jpeg/png/webp) y el tamaño, y guarda el archivo en el bucket privado `requisicion-adjuntos`. Si la descarga o la copia falla, la requisición se crea igual y el fallo queda registrado en `whatsapp_eventos` y `auditoria` (evento `ADJUNTO_KAPSO_FALLIDO`) para reintento manual — no hay reintento automático vía webhook.

## 6. Verificación posterior al despliegue

Ninguno de estos pasos requiere datos reales de Mizar:

1. `GET /api/health` responde configurado (no `unconfigured`).
2. `GET /` sin sesión redirige a `/login` (fallo cerrado de Auth).
3. La base no es alcanzable desde fuera: `nc -z <ip-del-vps> 5432` debe fallar. El servicio `db` no publica puerto a propósito; si responde, revisa que nadie le haya añadido un `ports:`.
4. **Una IP falsa no estrena cupo en los limitadores** (ver §4). `POST /api/public/access` responde `{ok:false}` con 200 tanto si la contraseña es mala como si el limitador frena, así que lo que delata al limitador es el **tiempo**: una petición limitada no paga el bcrypt y llega unos 200 ms antes. Primero se agota el cupo real y después se prueba con cabeceras falsas:
   ```bash
   U=https://comprasmizar.sixteam.pro/api/public/access
   H=(-H 'content-type: application/json' -H 'Origin: https://comprasmizar.sixteam.pro')
   for i in $(seq 1 23); do curl -s -o /dev/null -w '%{time_starttransfer} ' -X POST $U "${H[@]}" -d '{"code":"x"}'; done; echo
   for i in $(seq 1 6); do curl -s -o /dev/null -w '%{time_starttransfer} ' -X POST $U "${H[@]}" -H "X-Real-IP: 10.9.8.$i" -H "X-Forwarded-For: 10.9.8.$i" -d '{"code":"x"}'; done; echo
   ```
   Lo correcto es que la segunda tanda salga **rápida**, como las últimas de la primera: sigue limitada. Si sale lenta (~0,5 s, igual que las primeras de la primera tanda), alguna cabecera del cliente está moviendo la clave del limitador. Así se detectó el fallo el 18-sep-2026.
5. El arnés SQL pasa contra la base desplegada (revierte sin dejar datos).
6. Login con un usuario real de `auth.users` vinculado en `public.usuarios`. Si los datos vienen del volcado de Supabase, la contraseña de siempre funciona sin cambios (ver [migración](migracion-autoalojado.md)).
7. Subir un adjunto y volver a descargarlo: prueba de punta a punta del almacenamiento propio.

## 7. Reversión

```bash
docker pull ghcr.io/samuelbf2001/comprasmizar:<sha-anterior>
```

Cambiar la etiqueta del servicio en EasyPanel al `<sha>` anterior y redesplegar. Como las migraciones son aditivas, revertir la imagen no exige revertir el esquema; si una migración futura fuera destructiva, hay que planear su reversión aparte.

## 8. Respaldo

Ya no hay respaldo gestionado por un tercero: lo hacemos nosotros. [`ops/backup-daily.sh`](../ops/backup-daily.sh) corre por cron a las 03:00 hora Colombia, vuelca la base, empaqueta los adjuntos del volumen, cifra ambos con AES-256-GCM y los sube a Google Drive con retención de 35 días. La instalación paso a paso está en [docs/migracion-autoalojado.md](migracion-autoalojado.md); el detalle operativo, en [docs/runbook-operacion.md](runbook-operacion.md).

Dos reglas que no se negocian: la `BACKUP_PASSPHRASE` vive **fuera** del VPS (si se pierde con el servidor, los respaldos cifrados no sirven de nada), y [`ops/restore-verify.sh`](../ops/restore-verify.sh) debe ejecutarse antes de considerar el sistema en producción y luego cada trimestre. Un backup que nunca se restauró no es un backup.
