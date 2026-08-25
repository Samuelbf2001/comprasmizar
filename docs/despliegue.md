# Despliegue

La aplicación se despliega como **imagen Docker** publicada por CI en GitHub Container Registry (GHCR) y consumida por EasyPanel en el VPS. Los datos (Postgres, Auth, Storage) viven en Supabase gestionado; el VPS solo sirve la aplicación.

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
                                         Supabase (Postgres/Auth/Storage)
```

Por qué imagen y no build en el servidor: la imagen que se despliega es **exactamente** la que pasó CI, la etiqueta por commit permite revertir a una versión concreta, y el VPS no necesita toolchain de Node ni recursos para compilar.

## 1. Variables: build vs ejecución

Distinción crítica de Next.js. Las `NEXT_PUBLIC_*` se **incrustan en el bundle del navegador durante el build**; no se leen en ejecución. Si faltan al construir la imagen, quedan `undefined` en el cliente por más que se definan luego en EasyPanel.

**Se pasan como build-args** (en `.github/workflows/ci.yml`, desde *Variables* del repositorio — nunca *Secrets*, porque acaban siendo públicas en el bundle):

| Variable | Valor | Efecto si falta |
|---|---|---|
| `NEXT_PUBLIC_APP_URL` | `https://compras.grupomizar.com.co` | Enlaces de recuperación de contraseña rotos |
| `NEXT_PUBLIC_DEMO_MODE` | `false` (fijo en CI) | Falla cerrado hacia Auth — es el default seguro |

> La URL del inbox de Kapso **no** es build-arg a propósito: es una credencial portadora (abre las conversaciones de la línea sin login, verificado contra el servicio real). Va como `KAPSO_EMBED_URL` en el entorno de ejecución y la sirve `/api/kapso-embed` solo a sesiones autenticadas con rol Revisor o Administrador.

**Se definen en EasyPanel como entorno del servicio** (secretos reales, nunca en la imagen ni en el repo):

| Variable | Notas |
|---|---|
| `DATABASE_URL` | Session pooler de Supabase. La contraseña va **URL-encoded** (`!` → `%21`) |
| `NEXT_PUBLIC_SUPABASE_URL` | Solo se usa server-side; aun así defínela aquí |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Clave publicable |
| `SUPABASE_SERVICE_ROLE_KEY` | **Secreto fuerte.** Acceso total a los datos |
| `PUBLIC_FORM_CODE_PEPPER` | ≥32 caracteres. Generar con `crypto.randomBytes(32)` |
| `MCP_KEY_PEPPER` | ≥32 caracteres |
| `KAPSO_API_KEY` | Clave del proyecto Kapso |
| `KAPSO_WEBHOOK_SECRET` | ≥32 caracteres. **Debe coincidir** con el registrado en Kapso |
| `KAPSO_PHONE_NUMBER_ID` | `1221974497672719` (línea MIZAR) |
| `KAPSO_EMBED_URL` | URL del inbox embebido (embed `fab3fa49…`, alcance: solo línea MIZAR, orígenes: compras.grupomizar.com.co y localhost). Credencial portadora: tratar como secreto; para rotarla, DELETE del embed y crear otro |
| `NOTIFICATION_DISPATCH_SECRET` | ≥32 caracteres. Candado del endpoint interno que envía las notificaciones pendientes; el cron del VPS lo pasa en `x-dispatch-secret`. Sin él, el endpoint responde 503 |

El validador ([lib/security/env.ts](../lib/security/env.ts)) exige estas formas y **falla cerrado**: sin variables completas, `/api/health` responde `unconfigured` y los endpoints rechazan sin filtrar secretos.

## 2. Publicar la imagen

Ya automatizado: cada push a `main` que pase calidad y E2E publica `ghcr.io/samuelbf2001/comprasmizar` con dos etiquetas — `:<sha>` (inmutable, para revertir) y `:main` (móvil).

Antes del primer despliegue, en GitHub → Settings → Secrets and variables → Actions → **Variables**, definir `NEXT_PUBLIC_APP_URL`.

El paquete de GHCR nace privado: hay que dar acceso de lectura al VPS con un token, o marcarlo público si no hay inconveniente (la imagen no contiene secretos, pero sí todo el código).

## 3. Servicio en EasyPanel

El VPS aloja otros proyectos (`postgres`, `whatsfull`, `whatsful`). **Crear un proyecto nuevo y aislado** — no reutilizar los existentes.

1. Proyecto nuevo: `mizar-compras`.
2. Servicio tipo **App** desde imagen: `ghcr.io/samuelbf2001/comprasmizar:main` (con credenciales de registro si el paquete es privado).
3. Puerto interno: `3000`.
4. Variables de entorno: la tabla de ejecución de arriba.
5. Dominio + certificado TLS gestionado por EasyPanel.
6. Health check: `GET /api/health`. La imagen ya trae `HEALTHCHECK` propio.
7. Recursos: 512 MB de RAM bastan para el volumen esperado (17 obras, <30 usuarios).

`compose.yaml` y `ops/Caddyfile` son la alternativa autoalojada equivalente (Caddy con TLS automático) por si algún día se sale de EasyPanel. Con EasyPanel no se usan: él resuelve proxy y TLS.

## 4. Webhook de Kapso

Una vez el dominio esté en pie:

1. En Kapso, apuntar el webhook de la línea MIZAR a `https://compras.grupomizar.com.co/api/kapso`.
2. Registrar el **mismo** `KAPSO_WEBHOOK_SECRET`. Si no coincide, la firma no valida y todo evento se rechaza — que es el comportamiento correcto, pero parecerá que "no llega nada".
3. Verificar la entrega con el MCP de Kapso (`https://api.kapso.ai/mcp`) antes de dar por buena la integración.

Nota: los adjuntos del Flow ya se copian server-side: el webhook descarga cada `attachmentUrl` desde Kapso (bearer `KAPSO_API_KEY`), valida la firma binaria real (pdf/jpeg/png/webp) y el tamaño, y guarda el archivo en el bucket privado `requisicion-adjuntos`. Si la descarga o la copia falla, la requisición se crea igual y el fallo queda registrado en `whatsapp_eventos` y `auditoria` (evento `ADJUNTO_KAPSO_FALLIDO`) para reintento manual — no hay reintento automático vía webhook.

## 5. Verificación posterior al despliegue

Ninguno de estos pasos requiere datos reales de Mizar:

1. `GET /api/health` responde configurado (no `unconfigured`).
2. `GET /` sin sesión redirige a `/login` (fallo cerrado de Auth).
3. Con la clave publicable, ninguna tabla devuelve filas: debe dar `42501 permission denied`. Script: [`tmp/probe-rls-anon.mjs`](../tmp/probe-rls-anon.mjs) del checkout local.
4. El arnés SQL pasa contra la base desplegada (revierte sin dejar datos).
5. Login con un usuario real creado en Supabase Auth y vinculado en `public.usuarios`.

## 6. Reversión

```bash
docker pull ghcr.io/samuelbf2001/comprasmizar:<sha-anterior>
```

Cambiar la etiqueta del servicio en EasyPanel al `<sha>` anterior y redesplegar. Como las migraciones son aditivas, revertir la imagen no exige revertir el esquema; si una migración futura fuera destructiva, hay que planear su reversión aparte.

## 7. Respaldo

Supabase hace backups automáticos diarios. Además, [`ops/backup-postgres.ps1`](../ops/backup-postgres.ps1) genera la copia fría propia y [`ops/restore-verify.ps1`](../ops/restore-verify.ps1) verifica que se pueda restaurar. **Ninguno está programado todavía**: falta el cron. Un backup que nunca se restauró no es un backup — la primera restauración de prueba es requisito antes de considerar el sistema en producción.
