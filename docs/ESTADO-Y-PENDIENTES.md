# Estado y pendientes — Plataforma de Requisiciones Mizar

**Actualizado:** 26 de agosto de 2026
**Repo:** https://github.com/Samuelbf2001/comprasmizar · rama `main` · 18 commits
**Verificable ahora:** 286 pruebas en verde, lint y typecheck limpios, build de producción OK.

---

## 1. ¿En qué etapa estamos?

**Construcción avanzada, verificada localmente y contra servicios reales, pero AÚN NO desplegada a producción.**

En términos del plan de 8 semanas del PRD, el código cubre las Fases 1–4 casi completas: el ciclo completo de requisición (captura → revisión → aprobación → orden → gasto), más los módulos del Alcance Completo (división por proveedor, WhatsApp, autoservicio, reportes, MCP). Lo que falta no es tanto *escribir* código, sino **conectar el mundo real**: desplegar, cargar los datos verdaderos de Mizar y validar con el equipo.

| Capa | Estado |
|------|--------|
| Código de la plataforma | ✅ Construido (16 rutas API, 12 módulos, 286 pruebas) |
| Base de datos Supabase | ✅ Migrada y viva (28 objetos, RLS, 46 funciones, 2 buckets) |
| Seguridad (RLS, permisos, auditoría) | ✅ Implementada y verificada contra la BD real |
| Identidad visual de Mizar | ✅ Aplicada (navy, rojo del logo, Fraunces/DM Sans) |
| Percepción de carga (skeletons) | ✅ Implementada |
| WhatsApp Flow | ✅ Diseñado, validado por Meta, probado en vivo (borrador) |
| **Despliegue a producción** | ❌ Pendiente |
| **Datos reales de Mizar** | ❌ Pendiente (hoy solo datos de prueba) |
| **Validación con el equipo (UAT)** | ❌ Pendiente |

---

## 2. Lo que YA funciona (verificado, no solo escrito)

- **Login real** contra Supabase con roles y RLS. Probado en navegador.
- **Captura de requisición** web: crea en la BD real, con consecutivo y auditoría. Probado con una cantidad fraccionaria en m³ (el caso que antes reventaba).
- **Bandeja de revisión** con filtros (obra, estado, canal, fecha, etiqueta), poblada con catálogo real.
- **Migraciones y arnés SQL** (132 aserciones) pasan contra el Supabase de Mizar.
- **Seguridad probada contra la base real:** un cliente anónimo no ve ni escribe nada (deniega a nivel de GRANT, no solo RLS).
- **WhatsApp Flow:** el borrador real en Meta (`1972861836748301`) valida sin errores; se envió a un WhatsApp real (HTTP 200) y se recorrió el formulario. Diseño: 6 pantallas, un artículo por pantalla, foto por artículo, identidad por número de WhatsApp.

---

## 3. Lo que falta — PENDIENTES

### 3.1 Despliegue (bloquea el uso real) — responsable: Sixteam

- [ ] **Apuntar el DNS** de `compras.grupomizar.com.co` al VPS `72.60.67.214`.
- [ ] **Crear el proyecto en EasyPanel** (aislado; el VPS ya aloja otros clientes) con la imagen de GHCR. Guía completa en [docs/despliegue.md](despliegue.md).
- [ ] Definir las variables de entorno de producción (Supabase, peppers, Kapso, secretos internos).
- [ ] Definir la variable de build `NEXT_PUBLIC_APP_URL` en GitHub Actions.
- [ ] Verificación post-despliegue: `/api/health` configurado, `/` redirige a login, RLS bloquea anónimos, restore de backup de prueba.

### 3.2 Datos reales de Mizar (bloquea el UAT) — responsable: Sixteam + Mizar

- [ ] Cargar las **17 obras reales** con su sociedad (hoy hay 3 de prueba).
- [ ] Cargar el **catálogo de ítems** real desde los Excel de Mizar (importador ya construido: `scripts/import-master-data.ts`).
- [ ] Cargar **proveedores** reales con sus documentos.
- [ ] Crear los **usuarios reales** (Daniel, Nelson, Claudia, Juliana…) con sus roles, vinculados a cuentas de Supabase Auth.
- [ ] ⚠️ **Cargar la lista blanca de teléfonos autorizados** (`obra_solicitantes_autorizados`). **Hoy está vacía**: con el nuevo modelo de identidad del Flow, ningún número puede solicitar hasta que se registren los teléfonos permitidos por obra. Sin esto, el WhatsApp Flow rechaza todas las solicitudes.

### 3.3 WhatsApp / Kapso — responsable: Sixteam + decisión de Mizar

- [ ] **Publicar el Flow** (hoy es borrador). Es una acción de una sola vía (queda inmutable); requiere el "sí" de Mizar. Comando en `integrations/whatsapp-flow/README.md`.
- [ ] **Conectar el webhook de Kapso** a `https://compras.grupomizar.com.co/api/kapso` con el `KAPSO_WEBHOOK_SECRET`. Hasta que el sitio esté desplegado, la vuelta completa (respuesta del Flow → requisición en la plataforma) no se puede probar: Kapso no alcanza `localhost`.
- [ ] **Plantillas de mensaje** (aprobación de Meta) para: notificar al solicitante (recibida/aprobada/devuelta) y a los aprobadores, e iniciar la conversación fuera de la ventana de 24 h. Yo las redacto; Meta las aprueba.
- [ ] Confirmar el **plan de Kapso** y quién asume las tarifas de conversación de Meta.

### 3.4 Validación contable (bloquea producción) — responsable: Sixteam + contabilidad Mizar

- [ ] **Prueba de paridad:** replicar un mes real de GASTOS EN OBRAS.xlsx en la plataforma y cuadrar al 100%.
- [ ] Validar el **formato de export a Excel** contra lo que Helisa necesita.
- [ ] Cerrar el **desglose de impuestos** (¿solo IVA? ¿retenciones?) con contabilidad — hoy hay una decisión provisional.

### 3.5 Módulos con brecha conocida (no bloquean el arranque)

- [ ] **Modo pantalla (kiosco):** construido a nivel de servicio y ruta; falta un uso real si se quiere el dashboard en un TV.
- [ ] **PDF por ítem:** el Flow permite foto o link por artículo, pero no subir un PDF específico (límite de Meta: no se pueden combinar selectores de foto y documento en una pantalla). Un PDF de cotización se pega como link.
- [ ] **Reportes ejecutivos** y **dashboard**: implementados; conviene validarlos con datos reales.

### 3.6 Decisiones abiertas del PRD (P1–P7) — responsable: Ernesto + Samuel/Mizar

- [ ] **P5 — Propiedad de la plataforma:** la propuesta escrita dice "propiedad de Sixteam por suscripción"; en la demo se dijo "después del año es de ustedes". **Alinear antes de firmar.**
- [ ] P1 impuestos · P2 acceso público · P3 gastos compartidos · P6 costos WhatsApp · P7 alcance contratado (ver [docs/decisiones-provisionales.md](decisiones-provisionales.md)).

### 3.7 Higiene técnica (menor)

- [ ] **RLS como segunda barrera no se ejecuta:** la app se conecta con un rol que evade RLS; la autorización real vive en la capa de servicio + triggers (que sí funcionan). Decidir si se conecta por rol `authenticated` o se corrige el PRD para no prometer una barrera que hoy es inerte.
- [ ] **Rotar credenciales** compartidas por chat (Supabase, contraseña BD, EasyPanel, Kapso).
- [ ] Región de Supabase quedó en **us-east-2 (Ohio)**, no São Paulo; barato de mover mientras la base esté casi vacía.
- [ ] Programar el **backup automático** (`backup.yml` existe; falta crear el secreto `DATABASE_URL` en GitHub Actions).

---

## 4. Ruta crítica para salir a producción

El orden que desbloquea todo lo demás:

1. **Desplegar** (DNS + EasyPanel + variables) → habilita el sitio y el webhook.
2. **Cargar datos reales** de Mizar (obras, ítems, proveedores, usuarios, teléfonos autorizados).
3. **Conectar el webhook de Kapso** y publicar el Flow → cierra el canal WhatsApp de punta a punta.
4. **Prueba de paridad contable** → único gate que bloquea considerar el sistema "en producción".
5. **Capacitación por rol** y acompañamiento de la primera semana.

Todo lo anterior a estos pasos (el código) ya está hecho y probado.
