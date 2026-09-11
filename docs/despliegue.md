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

## 2. Publicar la imagen

Ya automatizado: cada push a `main` que pase calidad y E2E publica `ghcr.io/samuelbf2001/comprasmizar` con dos etiquetas — `:<sha>` (inmutable, para revertir) y `:main` (móvil).

Antes del primer despliegue, en GitHub → Settings → Secrets and variables → Actions → **Variables**, definir `NEXT_PUBLIC_APP_URL`.

El paquete de GHCR nace privado: hay que dar acceso de lectura al VPS con un token, o marcarlo público si no hay inconveniente (la imagen no contiene secretos, pero sí todo el código).

## 3. Servicio en EasyPanel

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

1. **`Strict-Transport-Security` (HSTS)** lo añadía solo Caddy. Configurarlo en EasyPanel, o añadirlo a `next.config.ts`.
2. **La sobrescritura de `X-Real-IP`, que es de seguridad, no cosmética.** El limitador de intentos de login, el del formulario público ([app/api/public/requisitions/route.ts](../app/api/public/requisitions/route.ts)) y el del MCP ([app/mcp/route.ts](../app/mcp/route.ts)) confían en ese encabezado. El código lo dice explícitamente: *"Caddy must overwrite X-Real-IP; never parse a client-supplied X-Forwarded-For chain here"*. Si el proxy de EasyPanel **no** lo sobrescribe, un atacante manda su propio `X-Real-IP` y se salta esos tres límites rotando el valor. **Hay que comprobarlo con la prueba del paso 5.4, no darlo por hecho.**

## 4. Webhook de Kapso

Una vez el dominio esté en pie:

1. En Kapso, apuntar el webhook de la línea MIZAR a `https://comprasmizar.sixteam.pro/api/kapso`.
2. Registrar el **mismo** `KAPSO_WEBHOOK_SECRET`. Si no coincide, la firma no valida y todo evento se rechaza — que es el comportamiento correcto, pero parecerá que "no llega nada".
3. Verificar la entrega con el MCP de Kapso (`https://api.kapso.ai/mcp`) antes de dar por buena la integración.

Nota: los adjuntos del Flow ya se copian server-side: el webhook descarga cada `attachmentUrl` desde Kapso (bearer `KAPSO_API_KEY`), valida la firma binaria real (pdf/jpeg/png/webp) y el tamaño, y guarda el archivo en el bucket privado `requisicion-adjuntos`. Si la descarga o la copia falla, la requisición se crea igual y el fallo queda registrado en `whatsapp_eventos` y `auditoria` (evento `ADJUNTO_KAPSO_FALLIDO`) para reintento manual — no hay reintento automático vía webhook.

## 5. Verificación posterior al despliegue

Ninguno de estos pasos requiere datos reales de Mizar:

1. `GET /api/health` responde configurado (no `unconfigured`).
2. `GET /` sin sesión redirige a `/login` (fallo cerrado de Auth).
3. La base no es alcanzable desde fuera: `nc -z <ip-del-vps> 5432` debe fallar. El servicio `db` no publica puerto a propósito; si responde, revisa que nadie le haya añadido un `ports:`.
4. **El proxy sobrescribe `X-Real-IP`** (ver §3). Comprobación directa, mandando una IP falsa desde fuera:
   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' -H 'X-Real-IP: 1.2.3.4' https://comprasmizar.sixteam.pro/api/health
   ```
   Repetir el formulario público con `X-Real-IP` distinto en cada intento: si el limitador **nunca** responde 429, el encabezado del cliente está llegando crudo a la aplicación y los tres límites de tasa son evadibles. En ese caso hay que forzar la sobrescritura en el proxy de EasyPanel antes de exponer el sitio.
5. El arnés SQL pasa contra la base desplegada (revierte sin dejar datos).
6. Login con un usuario real de `auth.users` vinculado en `public.usuarios`. Si los datos vienen del volcado de Supabase, la contraseña de siempre funciona sin cambios (ver [migración](migracion-autoalojado.md)).
7. Subir un adjunto y volver a descargarlo: prueba de punta a punta del almacenamiento propio.

## 6. Reversión

```bash
docker pull ghcr.io/samuelbf2001/comprasmizar:<sha-anterior>
```

Cambiar la etiqueta del servicio en EasyPanel al `<sha>` anterior y redesplegar. Como las migraciones son aditivas, revertir la imagen no exige revertir el esquema; si una migración futura fuera destructiva, hay que planear su reversión aparte.

## 7. Respaldo

Ya no hay respaldo gestionado por un tercero: lo hacemos nosotros. [`ops/backup-daily.sh`](../ops/backup-daily.sh) corre por cron a las 03:00 hora Colombia, vuelca la base, empaqueta los adjuntos del volumen, cifra ambos con AES-256-GCM y los sube a Google Drive con retención de 35 días. La instalación paso a paso está en [docs/migracion-autoalojado.md](migracion-autoalojado.md); el detalle operativo, en [docs/runbook-operacion.md](runbook-operacion.md).

Dos reglas que no se negocian: la `BACKUP_PASSPHRASE` vive **fuera** del VPS (si se pierde con el servidor, los respaldos cifrados no sirven de nada), y [`ops/restore-verify.sh`](../ops/restore-verify.sh) debe ejecutarse antes de considerar el sistema en producción y luego cada trimestre. Un backup que nunca se restauró no es un backup.
