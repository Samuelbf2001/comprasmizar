# Plan de revisión final — salida a producción real

**Fecha:** 18 de septiembre de 2026
**Base:** estado de producción **medido hoy** en el VPS (solo lectura, 15:33), `docs/ESTADO-Y-PENDIENTES.md` (17-sep), la adenda `PRD-pagos-y-caja-menor.md` y `docs/gates-externos.md`.

---

## 0. Veredicto

**Actualización 21-sep:** respaldos en marcha desde el 18-sep y `main` desplegado el 21-sep (B1 y B3 casi cerrados). Faltan los datos del día cero (B4), el UAT (B5) y la cuenta de monitoreo.

**Al 18-sep no estaba lista para operación real.** El producto está completo para el alcance acordado; lo que falta es de **operación**, no de funcionalidades:

1. **No hay respaldos.** Ningún cron los ejecuta. Si el VPS se pierde hoy, se pierde todo. Además es un compromiso que se le hizo al cliente el 11-sep.
2. **Producción va 5 días atrás** (`f9a7e00`, 13-sep): toda la adenda de pagos, los permisos editables y los 13 arreglos del QA siguen solo en `main` local. En producción **sigue vivo el error 500 al descargar cualquier adjunto**.
3. **Los usuarios y los datos son de demostración.** Los 7 usuarios activos son cuentas `*.demo@mizar.test`, las 17 obras vienen de la demo y las requisiciones reales de prueba están mezcladas con las inventadas.

Ninguno de los tres es grande. El orden de trabajo está en la §6.

### Avance del 18-sep (tarde), rama `chore/salida-produccion`

- ✅ Next 16.3.5 + `npm audit fix`: 0 vulnerabilidades en las dependencias de producción.
- ✅ HSTS en `next.config.ts`; la CSP deja de autorizar Supabase.
- ✅ **Fallo real encontrado y corregido:** Traefik **no** sobrescribe `X-Real-IP`. Rotándola desde fuera, el limitador del portal dejaba de frenar (comprobado contra producción midiendo tiempos). Login, portal y MCP pasan a usar `lib/security/client-ip.ts`. Falta verificarlo tras el despliegue (paso 6.4 de `docs/despliegue.md`).
- ✅ **Segundo hueco corregido:** ningún error 500 del servidor se registraba en ninguna parte (el log del contenedor estaba vacío). Ahora quedan en `docker logs` y, opcionalmente, en Better Stack (`lib/observability/report-error.ts`, `instrumentation.ts`).
- ✅ El portal ya no pierde adjuntos en silencio: cada descarte queda en la auditoría y en el log.
- ✅ Latidos de los dos cron (respaldo y despachador) hacia un monitor externo. El stack de monitoreo está decidido: Better Stack, ver [monitoreo.md](monitoreo.md).
- ✅ Flows **publicados** en Meta con el visto bueno de Ernesto: pago `4695777257373991`, captura v4 `2180911365805386`. Entran a producción al cambiar las variables en el despliegue.
- ✅ Suite: lint 0, typecheck 0, 100 archivos / 1232 pruebas en verde, build de producción OK. E2E no se corrió en esta rama.
- **Decidido por Ernesto:** en producción no hay ninguna requisición real, todo fueron simulaciones. Se **recrea la base** el día cero. `mizar-preview` es de otro proyecto y no se toca.

---

## 1. Lo que se verificó hoy en producción

| Qué | Estado real | Impacto |
|---|---|---|
| Versión desplegada | `f9a7e00` (13-sep). `main` local va **57 commits adelante, sin `git push`** | Nada de lo del 15–17 sep está en producción |
| Migraciones | Última aplicada `202609120003`; **faltan 7** (`202609150001`…`0006`, `202609170002`) | Todas son aditivas (la `…0005` recrea un índice) |
| Descarga de adjuntos | **500 en producción** (arreglado en `7c4afe7`, sin desplegar) | Comprobantes, fotos y documentos de proveedor no se pueden abrir |
| Respaldos | **Sin cron**, falta `GDRIVE_FOLDER_ID`, no existe la marca `ultimo-exito`. Solo hay 4 volcados manuales del 11–12 sep, guardados **en el mismo VPS** | Riesgo de pérdida total de datos |
| HSTS | La respuesta no trae `Strict-Transport-Security` (antes lo ponía Caddy, y Caddy ya no está) | Hardening básico pendiente |
| Dependencias | `next 16.3.2` con aviso **crítico** (RCE en el optimizador de imágenes con AVIF; el optimizador viene activo por defecto), `sharp` alto, `qs`/`hono` moderados. Se arregla subiendo a `next 16.3.5` y con `npm audit fix` | Hay que actualizar antes de exponer más |
| Datos | 16 requisiciones (10 de demo y unas 6 de prueba real), 7 usuarios (todos demo), 17 obras de demo, 6 proveedores, 7 órdenes | Hay que decidir el «día cero» (§5) |
| Dominio | `compras.grupomizar.com.co` no resuelve. El embed de Kapso («Mensajes de WhatsApp») tiene autorizado ese origen, no `comprasmizar.sixteam.pro` | Hay que verificar que el inbox cargue |
| Salud | `/api/health` → `ok`, `origin:true`, 0 WhatsApp fallidos en 24 h. Carga del VPS 0,24, disco al 16 % | Bien |
| Locale de Postgres | `en_US.utf8` | Cierra el riesgo 9 del ESTADO (el `lower()` con tildes funciona bien) |
| Contenedor ajeno | `mizar-preview` (nginx, creado el 17-sep a las 22:22) está corriendo en el VPS | Averiguar de quién es y apagarlo si sobra |
| Árbol local | En `main` hay 25 archivos sin commitear y 4 nuevos (estados de carga y errores amigables, 17-sep a las 22:1x) | Decidir si entran en esta salida |

> La suite (lint, typecheck, 1220 pruebas, E2E 51/0) está en verde **según el ESTADO del 17-sep**. No se volvió a correr hoy.

---

## 2. Bloqueantes: sin esto no se sale

### B1. Respaldos que funcionen y una restauración probada
- [x] **Hecho el 18-sep-2026.** Consentimiento OAuth de Google Drive con Ernesto@sixteam.pro: proyecto de Google Cloud `respaldos-mizar` (organización sixteam.pro), Drive API habilitada, pantalla de consentimiento **Interna** (no Externa: en modo prueba el token caduca a los 7 días), cliente «App de escritorio». Carpeta «Respaldos Mizar» creada por la API; las cuatro variables `GDRIVE_*` están en `/opt/mizar/.env.backup` (modo 600).
- [x] **Hecho el 18-sep-2026.** Cron `0 8 * * *` (03:00 Colombia) instalado en el crontab de root. Primer respaldo a mano: subió `mizar-*.dump.enc` (315 KB), `soportes-*.tar.enc` (371 KB) y `mizar-*.sha256`, y se escribió `/var/backups/mizar/ultimo-exito`.
- [x] **Decisión de Ernesto, 18-sep-2026: respaldos SIN cifrar por ahora** (`BACKUP_ENCRYPT=no`). La frase solo vivía en el VPS y perderla con el servidor era perder los datos; el destino es su Drive privado. Consecuencia: los volcados (hashes de contraseñas, teléfonos, adjuntos) quedan legibles para quien entre a esa cuenta de Google; la carpeta no se comparte. El primer respaldo cifrado sigue en Drive y se purga solo a los 35 días.
- [x] **Hecho el 18-sep-2026.** `ops/restore-verify.sh` bajó el respaldo en claro de Drive, verificó el checksum y lo restauró en base desechable (17 migraciones, 7 usuarios, 17 obras). Fecha anotada en `docs/runbook-operacion.md`. Falta desempaquetar el `.tar` de soportes en un ensayo (el guion solo restaura la base).
- [x] ~~Confirmar que `BACKUP_PASSPHRASE` está fuera del VPS~~ — ya no aplica mientras no se cifre.
- [ ] Alerta si `ultimo-exito` tiene más de 48 h (ver M1).
- [ ] **Decisión:** qué significa «entregar los backups al cliente». Un volcado cifrado no le sirve a Mizar. Propuesta: una exportación mensual legible (Excel + adjuntos en carpetas por requisición) en una carpeta compartida con ellos.

### B2. Seguridad mínima
- [x] `next` → 16.3.5 y `npm audit fix` (sharp, qs, hono). Después, la suite completa.
- [x] HSTS en `next.config.ts` (`max-age=31536000; includeSubDomains`).
- [x] Prueba de `X-Real-IP` contra Traefik: **la dejaba pasar** (18-sep). Corregido en código; falta **verificarlo tras el despliegue** con el paso 6.4.
- [ ] Aplicar el mismo arreglo en `app/api/public/companies/route.ts`, cuando se integre el trabajo sin commitear que ese archivo tiene en `main`.
- [ ] Rotar la contraseña del portal público (circuló en texto plano) y las credenciales que se compartieron por chat (clave de Kapso, EasyPanel, secretos internos).
- [ ] Desactivar las 7 cuentas `*.demo@mizar.test` en cuanto existan los usuarios reales. Admin Sixteam queda como cuenta nominal de Ernesto o Samuel.

### B3. Desplegar `main` actual — **HECHO el 21-sep-2026, 19:05–19:13 (Colombia)**
- [x] El trabajo de UI sin commitear (estados de carga, errores amigables) **no entró**: se desplegó el árbol de `origin/main`. Antes se commitearon (`c5d257c`) los cambios de los guiones de respaldo del 18-sep, que ya corrían en el VPS con el mismo hash, para que el despliegue no los pisara.
- [x] CI de GitHub en verde para `421ae17` (calidad, E2E demo, contenedor). No se hizo el QA manual contra `scripts/dev-db.ts`: lo sustituyen las pruebas de humo contra producción de abajo y el UAT.
- [x] Receta de `docs/despliegue.md` §2: volcado previo (`/var/backups/mizar/pre-c5d257c-20260922-000537.dump`) y copia de `.env.production`; simulacro de `sync-arbol` (solo borró `public-photos` y `cash-service` con sus pruebas); build (2 min); 7 migraciones aplicadas; `up` + `network connect`.
- [x] Verificado: `/api/health` con `commit` = SHA y `origin:true`; HSTS presente; POST sin sesión → 401; raíz sin sesión → 307 a `/login`; una `X-Real-IP` o `X-Forwarded-For` falsa **ya no** abre cupo nuevo en el limitador (paso 6.4).
- [x] **Descarga de adjuntos: la prueba encontró que SEGUÍA ROTA.** El arreglo del 16-sep resolvía el `Location` contra `request.url`, que detrás de Traefik es `https://0.0.0.0:3000`: el navegador acababa en una dirección inalcanzable. Se corrigió con un `Location` relativo (`d32ce56`), se redesplegó (sin migraciones) y se verificó con una sesión de administrador de 10 minutos, borrada al terminar: los dos documentos de proveedor bajan con 200, son PDF reales y salen como descarga forzada.
- [x] Flows en producción: `WHATSAPP_FLOW_ID=2180911365805386` (captura v4) y `WHATSAPP_FLOW_PAGO_ID=4695777257373991` (pago), sin `_MODE=draft`.
- [x] El despachador de avisos quedó corriendo con el guion nuevo (con latido), cada minuto con 200.
- [ ] Comprobar que «Mensajes de WhatsApp» carga el inbox con el dominio actual (necesita un navegador con sesión: va en el UAT, §4 E5). Si no carga, crear un embed nuevo con el origen `comprasmizar.sixteam.pro`.
- [ ] Recorrer en navegador los casos ⚠ de la §4 (UAT).

### B4. Datos del «día cero»
- [x] **Decidido (Ernesto, 18-sep): se recrea la base.** No hay ninguna requisición real; todo fueron simulaciones. Los consecutivos arrancan en 0001, como se prometió el 11-sep, y la `auditoria`, que es inmutable, no arrastra la demo.
- [ ] Sixteam prepara y **ensaya en local** un guion de día cero: base vacía + migraciones + maestros reales, sin `seed.sql` de demo (`scripts/import-master-data.ts`).
- [ ] Maestros de Daniel: centros de costo reales, obras, catálogo de ítems, proveedores (revisar la lista del 15-sep) y teléfonos de los maestros de obra en `solicitantes_autorizados` (sin ellos el Flow de captura los rechaza).
- [ ] Usuarios reales con sus roles: Daniel, Juliana, Claudia, Luis Miguel, los aprobadores y los que falten. Cada uno con clave temporal y cambio obligatorio.
- [ ] Contraseña nueva del portal. Enlace, contraseña y número de WhatsApp se comunican a los maestros por un canal controlado.

### B5. UAT firmado
Los recorridos de la §4, hechos por personas de Mizar en sus propios teléfonos, con un acta firmada por Daniel y Ernesto.

---

## 3. Mejoras recomendadas (no bloquean; en orden de valor)

| # | Mejora | Por qué |
|---|---|---|
| M1 | **Monitoreo externo**: código listo (latidos + health). **Falta que Ernesto cree la cuenta de Better Stack** y cargar las URLs ([monitoreo.md](monitoreo.md) §2) | Hoy nadie se enteraría de una caída ni de un respaldo que dejó de correr |
| M2 | **Registro de errores**: hecho en código (18-sep). Se activa el envío a Better Stack con `LOG_INGEST_URL`/`LOG_INGEST_TOKEN` | La primera semana los errores hay que verlos antes de que los reporte Daniel |
| M3 | Adjunto descartado: ya se registra (auditoría + log). **Falta:** mostrárselo al revisor en el detalle, y el rechazo silencioso del Flow (riesgo 8 del ESTADO) | El maestro cree que envió y quien revisa no se entera |
| M4 | Dominio definitivo `compras.grupomizar.com.co` + diagnosticar el **Wi-Fi Claro de la oficina** (§7) | Juliana entra con datos móviles; en operación diaria eso no aguanta |
| M5 | PDF de OC/OP con logos y membretes reales (P4) y decidir qué empresa encabeza la OP (QA H10) | Es lo primero que ve un proveedor |
| M6 | Deuda del ESTADO §5: `paymentStatus` duplicado entre SQL y TS, `workId=""` como centinela, `lookupSupplierByIdentification` que descarga todo el directorio | Hoy no duele; con volumen, sí |
| M7 | Limpieza: tipos y esquemas muertos de caja menor y unos 20 worktrees viejos. `mizar-preview` es de otro proyecto: no se toca | Higiene |

---

## 4. Qué debe probar un humano (UAT)

**Reglas:** en producción, **después** del despliegue B3 y **antes** del día cero B4 (lo que se cree se borra al recrear la base). En teléfonos reales (Android e iPhone), una persona por rol, anotando para cada caso OK, FALLA o DUDA con captura. Los casos marcados ⚠ nunca se han recorrido en un navegador contra el backend real.

### A. Solicitante externo (maestro de obra o proveedor), en el celular
1. Portal, **compra**: contraseña mala → dice «Contraseña incorrecta»; contraseña buena → 3 ítems, uno con foto → llega el acuse por WhatsApp.
2. ⚠ Portal, **pago**: beneficiario nuevo con cédula y soporte en **PDF**; repetirlo con **Excel**. Los dos llegan y se descargan.
3. WhatsApp «hola» → menú de 3 botones → Flow de captura v4 con fotos → la requisición aparece en la bandeja.
4. WhatsApp → «Solicitar un pago» → Flow de pago → aparece como OP con el beneficiario enlazado o pendiente.
5. Desde un número **no autorizado**: ¿qué ve la persona? (hoy nada). ¿Es aceptable?
6. Desde la red **Wi-Fi de la oficina**.

### B. Daniel (revisor y usuario maestro)
1. Revisar una requisición del portal: asignar obra, centro de costo, empresa facturada, proveedor y aprobadores por ítem; editar un monto → se ve «Valor original».
2. ⚠ «Beneficiario pendiente de completar» → «Completar ficha» (H5).
3. ⚠ «Aprobar yo mismo» y **aprobar por encima de Juliana** → el historial dice a quién se saltó (H3 + 17-sep).
4. Caja menor: radica → se auto-aprueba → registra el pago con medio **caja** y comprobante → «Cierre de caja» del viernes por rango → Excel.
5. Pagos parciales: 2 pagos → anular uno con motivo (queda tachado) → «Pagar saldo».
6. Devolver con comentario y declinar con motivo (desaparece de activas y queda en el filtro de declinadas, sin orden ni gasto).
7. Catálogos sin ayuda de Sixteam: crear un centro de costo, una obra, un ítem y un proveedor, y editar los teléfonos autorizados.

### C. Aprobadores (Juliana, Nelson, Claudia)
1. Le llega la plantilla por WhatsApp → aprueba desde el Flow → la plataforma lo refleja.
2. Aprobar un ítem desde la web y declinar otro con motivo; aprobar varios desde la lista con selección múltiple.
3. Devolver con comentario.
4. Juliana: reporte del mes con «lo aprobado por mí», con filtros por obra y centro de costo, y exportar el Excel.

### D. Contabilidad (Luis Miguel)
1. Contabilizar una OC y una OP; descargar sus **PDF** (¿el formato sirve?).
2. ⚠ Descargar comprobantes y documentos de proveedor (hoy dan 500 en producción).
3. ⚠ Confirmar que **no** puede registrar ni anular pagos, y que si Admin se lo concede en Configuración aparecen los botones.
4. **Paridad:** cargar un mes real de `GASTOS EN OBRAS.xlsx` y cuadrarlo al peso contra el Excel de la plataforma. ¿Lo puede subir a Helisa? (P1)

### E. Administración (Ernesto o Samuel)
1. ⚠ Matriz de permisos: quitar un permiso y dar otro, y ver el efecto en pantalla; comprobar que no se le puede quitar `config:manage` a Admin Sixteam.
2. Alta de usuario → clave temporal → cambio obligatorio al entrar.
3. Abrir por URL directa una ruta sin permiso → debe salir rechazo, no una pantalla vacía.
4. MCP: lee y administra, pero **no** aprueba.
5. «Mensajes de WhatsApp» carga y solo muestra la línea MIZAR.
6. Modo pantalla (TV), si se va a usar.

### F. Transversal
- Dos personas trabajando a la vez sobre la misma requisición.
- Los avisos llegan con estado «entregado» (no solo «enviado»).
- Técnico: el simulacro de restauración de B1.

**Criterio de salida:** B1–B4 cerrados, UAT sin fallas críticas ni altas abiertas y acta firmada.

---

## 5. Decisiones pendientes y quién las toma

| Quién | Decisión |
|---|---|
| **Ernesto** | Recrear la base o convivir con la mezcla (B4) · formato de «entrega de backups» al cliente · visto bueno para publicar los Flows · dominio definitivo · qué empresa encabeza la OP (H10) · P5 propiedad de la plataforma · P6 plan de Kapso y quién paga Meta |
| **Daniel** | Centros de costo, ítems, proveedores y teléfonos reales · RUT obligatorio o no |
| **Luis Miguel** | Formato de carga a Helisa (P1) · validar la paridad |
| **Claudia** | Logos y membretes de los PDF (P4) |
| **Aplazado a conciencia** | Nómina P9 · ingresos (fase 2, P12) · cruce bancario (§12 de la adenda) · cierre de caja con bloqueo |

---

## 6. Secuencia propuesta

1. **Sixteam, en local:** decidir el trabajo sin commitear → `next 16.3.5` + `npm audit fix` → HSTS → suite + QA con backend real → `git push` → CI en verde.
2. **Ernesto (10 min con navegador):** OAuth de Drive → Sixteam instala el cron, corre el primer respaldo y el simulacro de restauración.
3. **Fin de semana (fuera de horario, una build):** despliegue B3 + verificaciones + publicación de los Flows.
4. **UAT (§4):** una sesión guiada con Daniel y los aprobadores (~1,5 h) y otra con el contador.
5. Arreglar lo que salga del UAT → **un** segundo despliegue.
6. **Día cero:** respaldo final → base nueva → maestros y usuarios reales → contraseña del portal nueva → aviso a los maestros de obra.
7. **Semana 1 de acompañamiento:** revisar a diario errores, `whatsapp_fallidos_24h` y la marca del respaldo; reunión corta el viernes con Daniel después de su primer cierre de caja real.

---

## 7. El Wi-Fi de Claro en la oficina de Mizar

**Qué se sabe.** Lo contó el cliente en la reunión del 11-sep: con el Wi-Fi nuevo de Claro no abre `comprasmizar.sixteam.pro`, y con datos móviles sí. **Nadie lo ha diagnosticado.** El dato clave, verificado el 18-sep: el certificado del subdominio se emitió **ese mismo 11-sep a las 08:33**, así que el nombre tenía horas de vida cuando lo probaron. Hoy resuelve bien (72.60.67.214) en Google, Cloudflare, Quad9, OpenDNS y en los DNS filtrados más comunes. `sixteam.pro` existe desde nov-2024 y tiene renovación automática.

**Causas probables, de más a menos:**
1. **Un filtro de contenidos que bloquea dominios nuevos o sin categoría.** Claro Empresas vende «Internet Seguro Corporativo» con filtrado por categorías; los FortiGate marcan un dominio visto por primera vez como *Newly Observed* y luego *Not Rated*, y muchas políticas bloquean lo que no tiene categoría. Un nombre como «comprasmizar» en un dominio ajeno a la empresa también puede parecer phishing.
2. **Un «no existe» guardado en la caché del DNS** del router o de Claro, si alguien abrió el enlace antes de que existiera el registro. Esto se habría arreglado solo en horas.
3. **Control parental del router o antivirus de los PC.**
4. Poco probable: reputación de la IP compartida de Hostinger, inspección TLS o bloqueo del TLD `.pro`.

**Primero:** preguntar si **todavía** pasa. Ya pasó una semana y la causa 2 se resuelve sola.

**Si sigue pasando, que alguien de la oficina, conectado al Wi-Fi:**
1. Abra `https://comprasmizar.sixteam.pro/api/health` y haga captura del mensaje exacto:
   - Página de Claro o Fortinet que menciona una «categoría» → causa 1.
   - `DNS_PROBE_FINISHED_NXDOMAIN` → causa 2 o 3.
   - `ERR_CONNECTION_RESET` o `TIMED_OUT` → firewall o IP.
   - `NET::ERR_CERT_…` → inspección TLS.
2. En `cmd`, corra `nslookup comprasmizar.sixteam.pro` y después `nslookup comprasmizar.sixteam.pro 1.1.1.1`. Las dos deben dar `72.60.67.214`; si solo falla la primera, el problema es el DNS de la oficina.
3. Anote el tipo de plan (Hogar o Empresas) y el modelo del router.

**Arreglos:**
- **Filtro de Claro:** pedir a soporte de Claro Empresas que pongan en lista blanca `comprasmizar.sixteam.pro` (y más adelante `compras.grupomizar.com.co`). Además, Ernesto puede pedir la recategorización como «Business» en FortiGuard y Cisco Talos; son formularios que tiene que enviar él.
- **DNS:** `ipconfig /flushdns`, reiniciar el router, o poner `1.1.1.1` / `8.8.8.8` como DNS del router.
- **Antivirus o control parental:** añadir la exclusión o desactivarlo.
- **De fondo:** pasar a `compras.grupomizar.com.co` con redirección desde el dominio actual. Hereda la reputación de un dominio que ya existe y la lista blanca queda en manos del cliente.
