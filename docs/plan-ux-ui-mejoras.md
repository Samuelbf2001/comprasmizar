# Plan de mejora UX/UI — Plataforma Mizar

> Orquestado con subagentes. Rol de esta sesión (cuenta 1): **evaluador** — no implementa,
> reparte el trabajo, revisa cada entrega (typecheck, diff, contraste) y valida.
> Estado actualizado a medida que avanza.

## Objetivo
Elevar la UX/UI de la plataforma **dentro de la identidad de marca**, priorizando impacto/riesgo.
La base ya es de nivel producto (tokens, `prefers-reduced-motion`, skeletons, 3 breakpoints,
foco en modales, gráficos accesibles): se **pule con criterio**, no se rehace.

## Fuente de verdad de marca (VALIDADO contra `C:\Users\samue\mizar-entrega`)
El CSS real del home (`site/src/landing/index.css`) + `docs/identidad-mizar.md` son la verdad.
La plataforma **ya alinea**: navy `#0a2342`, crimson `#d12e45`, dorado discreto `#c8933a`,
crema `#f5f0e8`, superficie `#f6f4f1`, Fraunces + DM Sans, sombras idénticas.

**Reglas duras (no romper):**
- ❌ NO seguir `context/PALETA_MIZAR_REAL.md` (recomendación NO adoptada: `#E74C3C`/`#F5F5F5`/`#D4AF37`).
- ❌ NO reemplazar la crema `#f5f0e8` por gris neutro, ni el crimson por `#E74C3C`.
- ❌ Los tonos teal/verde del CSS son temas por proyecto inmobiliario, no la marca maestra.
- ✅ Colores semánticos (ámbar/azul/verde/rojo de estado) se mantienen aparte del rojo de marca.

## Hallazgos validados

### A. Contraste / legibilidad (sistémico, alto impacto, on-brand)
`--muted:#5a6472` cumple AA (6.0:1 blanco, 5.29:1 crema), pero el texto secundario usa ~40
grises neutros **hardcodeados** (#82–#9a) que **fallan WCAG AA** (3.0–3.6:1) a 11–13px.
Regla de arreglo: todo gris neutro de *texto* → `var(--muted)`; solo ≥18px decorativo puede ser
más claro (`--muted-soft` documentado); placeholders → token `--placeholder` ≥4.5:1.
Subir texto secundario real de 11px (`--text-3xs`) a 12px (`--text-2xs`) donde aplique.

### B. Affordances / heurística (Nielsen)
- **P1** Campana de notificaciones muerta con punto rojo (se ve en producción).
- **P1** Botón de perfil muerto con chevron; logout enterrado.
- **P1** Datos demo en sidebar de producción (badges 12/4, "Revisión de Daniel").
- **P1** Cumplimiento de orden: `select` irreversible en 1 clic, sin confirmar/deshacer.
- **P2** Aprobar genera OC/OP + gasto sin confirmación; declinar sin confirmación.
- **P2** Breadcrumb/ítem activo se quedan en "Inicio" al abrir un detalle.
- **P2** Validación solo al enviar, mensaje genérico que no señala el ítem; `aria-invalid` sin `aria-describedby`.
- **P2** Estados internos crudos ("en aprobacion"); controles/exportaciones muertos en pantallas demo.
- **P3** Crumb "Plataforma" inerte, marca de requeridos inconsistente, `ArrowRight` para "Volver",
  fecha permite pasado, scrim sin teclado, cambio de estado sin confirmación de éxito, tabs sin `role=tablist`.

### C. Deriva de color en React → **RESUELTO**
Solo 3 valores en `connected.tsx` (recharts) → ya apuntan a `var(--green)/--blue/--line)`.

## Fases y reparto (subagentes; archivos disjuntos → paralelo)

| Fase | Alcance | Archivos | Agente | Estado |
|---|---|---|---|---|
| 0 | Análisis: mapa de contraste, deriva de color, auditoría heurística | (lectura) | A1/A2/A3 | ✅ hecho |
| 1a | Consolidar 45 grises → `var(--muted)`; token `--placeholder` | `app/globals.css` | D | ✅ evaluado: 79 reemplazos verificados + 2 residuos cerrados por el evaluador (`.kanban-id`, `.remove-line`) |
| 1b | Subir texto de datos 11→12px (requiere verificación de layout) | `app/globals.css` | — | diferido (evaluar layout) |
| 2a | Affordance en pantallas demo (honestos, ArrowLeft, tablist) | `workflow/operations/reports-admin.tsx` | A | ✅ evaluado y aprobado |
| 2b | Shell: campana honesta, menú de perfil, crumb, gating demo, scrim | `app-shell.tsx`, `lib/demo-data.ts` | B | ✅ aprobado · pendiente migrar inline→CSS |
| 2b-css | Migrar estilos inline de B a `globals.css` (`.breadcrumb-root`, `.profile-menu*` con `:hover`/`:focus-visible` + `@media` móvil del crumb) | `app/globals.css` | evaluador | ✅ hecho (typecheck OK, CSS balanceado, 0 inline) |
| 2c | Flujos: confirmaciones en aprobar/declinar/cumplir, `aria-describedby`, etiquetas de estado, `min` de fecha | `connected.tsx` | C | ⏳ ejecutando |
| 2c | Flujos: confirmaciones, etiquetas de estado, aria-describedby, min fecha | `connected.tsx` | C | ✅ evaluado y aprobado |
| 3 | Fixes de la evaluación visual en navegador (ver tabla abajo) | varios | E/F/G | ✅ todos evaluados, verificados en navegador |

## Fase 5 — Restyle SaaS (decisión del usuario 2026-08-26)
Nueva dirección de la PLATAFORMA (el home/landing no cambia): estética de SaaS grande, referencia HubSpot.
- Tipografía **sin serif**: DM Sans en todo; Fraunces eliminada de la UI.
- **Fondo blanco** (`--ivory→#ffffff`) + neutrales fríos (`--surface:#f5f8fa`, bordes `#dfe3eb`).
- **Cero dorado**: `--dorado*` eliminados; eyebrows→muted, badges→rojo, estados en curso→ámbar semántico.
- Botones rectangulares redondeados (radius-sm), no píldora.
- Se conservan navy (sidebar) y crimson (CTA) como identidad.
Registrado en memoria para que ninguna sesión "restaure" crema/Fraunces/dorado en la plataforma.

## Fase 6 — Skill de diseño propia (2026-08-26)
Se creó `.claude/skills/mizar-ui/SKILL.md`: cruce de **Apple** (Designing Fluid Interfaces +
Principles of Great Design: respuesta inmediata, interrumpibilidad, tracking por tamaño,
materiales, 8 principios) con **Impeccable** (detector anti-slop: fuentes genéricas, grises
muertos, card nesting, bounce decorativo, negro puro, etc.), aterrizado a este repo
(CSS plano, sin Tailwind/Framer) y a la estética HubSpot.
Contiene el contrato de marca (blanco, sans, sin dorado, navy+crimson), 12 detectores
anti-slop, escala de tracking/leading, reglas de movimiento realistas para CSS, elevación,
accesibilidad AA y un checklist de salida. **Toda edición de UI debe leerla primero.**

### Fase 6 — resultado
Restyle completado y skill aplicada por subagentes, evaluado en navegador:
- **Sans total** (DM Sans; Fraunces = 0), **fondo blanco**, **dorado = 0** (tokens eliminados).
- Tracking por tamaño (h1 700/−.02em, h2–h3 −.01em, cuerpo 0), números tabulares en KPIs.
- Botones rectangulares (6px); chips siguen en píldora. `:active` scale(.97/.99) para feedback inmediato.
- Iconografía: glifos `!`/`—`/`×` → lucide con semántica correcta (vacío ≠ filtrado); 120+ iconos `aria-hidden`.
- **Foco accesible (WCAG 2.4.11)**: los `outline:none` de inputs anulaban el anillo; restaurado
  `outline:2px var(--navy)` (15.77:1) y `--focus-ring` subido de .38 (2.32:1 ❌) a .6 (4.32:1 ✅).
- Grises sueltos → tokens; contraste verificado incluso contra el gradiente del sidebar.
Gate: typecheck ✅ · eslint ✅ · **286/286** ✅ · llaves 963=963 ✅ · overflow 375px = 0 ✅

## Cierre Fases 0–3 (2026-08-26)
Todos los fixes F1–F9 aplicados y verificados en navegador por el evaluador:
rol demo persiste (sessionStorage), breadcrumb correcto en detalle ("REQ-2026-0147" + ítem activo),
overflow móvil 0px (antes 61px), disabled visibles (opacity .55), toggle Lista/Kanban dinámico,
request-id en dos líneas, picker de foto a ancho completo, fechas en horario local (helper `localTodayISO`).
Gate final: typecheck ✅ · eslint ✅ · 284/284 tests ✅.
Pendiente opcional (decisión de negocio, Fase 4): panel de notificaciones real, command palette,
modo oscuro, cablear exportaciones, baseline de regresión visual (lost-pixel) con el nuevo estado.

## Evaluación visual en navegador (desktop 1440px + móvil 375px, chrome-devtools)
Lint ✅ · 284/284 tests ✅ · pantallas revisadas: dashboard, nueva requisición, bandeja (lista/kanban), detalle, aprobaciones, gastos+form, proveedores, reportes, login, /pantalla, drawer móvil.

| # | Hallazgo | Severidad | Fix |
|---|---|---|---|
| F1 | Rol demo se pierde al navegar (vuelve a Revisor); imposible llegar a Configuración | P1 | Agente E (sessionStorage) |
| F2 | Breadcrumb/sidebar marcan "Inicio" en rutas de detalle | P2 | Agente E |
| F3 | Controles `disabled` se ven 100% activos (Exportar Excel en rojo primario, filtros, búsquedas) | P2 | Agente F (CSS :disabled) |
| F4 | Móvil 375px: 61px de overflow horizontal; botón "Nueva requisición" cortado | P2 | Agente F (flex-wrap) |
| F5 | Toggle Lista/Kanban: "Lista" queda activa en vista Kanban (is-active hardcodeado) | P2 | Agente G |
| F6 | Bandeja: "REQ-2026-0147Cemento gris…" ID y descripción pegados | P3 | Agente G |
| F7 | "Foto del ítem": caja comprimida, texto palabra/línea | P3 | Agente G |
| F8 | `min` de fecha usa UTC (falla 7pm–12am Colombia) | P3 | Agente G |
| F9 | Kanban demo: contador de columna = índice, "+ Agregar" muerto | P3 | Agente G |
| OK | Login, /pantalla (gate), proveedores, drawer móvil, timeline detalle, ArrowLeft: correctos | — | — |

## Fase 4 — apuestas mayores (requieren decisión del usuario, NO incluidas aún)
Panel de notificaciones real · buscador/command palette global · modo oscuro de la app ·
cablear exportaciones (PDF/Excel/Helisa) a backend.

## Criterios de evaluación (los aplica esta sesión a cada entrega)
1. `npm run typecheck` sin errores nuevos.
2. `git diff` revisado: cambios mínimos, sin tocar marca, sin regresiones de layout.
3. Contraste recomputado (Fase 1): 0 grises de texto por debajo de 4.5:1.
4. Coherencia con patrones existentes (clases, `role`/`aria`).
5. Verificación en navegador cuando el cambio sea observable (si el panel de vista previa está visible).
