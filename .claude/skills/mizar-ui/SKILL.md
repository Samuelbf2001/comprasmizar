---
name: mizar-ui
description: Sistema de diseño UI de la Plataforma Mizar. Cruza los principios de Apple (Designing Fluid Interfaces / Principles of Great Design) con el detector anti-slop de Impeccable, aterrizado a este repo (Next.js + CSS plano, sin Tailwind). Úsalo SIEMPRE que se edite UI, CSS, componentes de pantalla, o se revise el diseño de la plataforma.
---

# Mizar UI — Apple × Impeccable

Objetivo: que la plataforma se vea **hecha por un equipo de producto**, no generada.
Referencia de estética: **HubSpot** (SaaS grande, funcional, denso pero respirable).
Referencia de *feel*: **Apple** (respuesta inmediata, movimiento con intención).

## 0. Contrato de marca (NO negociable)

| Token | Valor | Regla |
|---|---|---|
| `--navy` | `#0a2342` | Sidebar, títulos, foco. Identidad. |
| `--rojo` | `#d12e45` | CTA primario y solo eso. Identidad. |
| `--ivory` | `#ffffff` | Fondo de página. **Blanco, no crema.** |
| `--surface` | `#f5f8fa` | Superficie alterna (gris frío). |
| `--line` | `#dfe3eb` | Bordes. |
| `--ink` / `--muted` | `#2c2f36` / `#5a6472` | Texto primario / secundario. |

- ❌ **PROHIBIDO: dorado** (`--dorado*`, `#c8933a`, `#8a6423`, `#d4af37`). Eliminado de la plataforma.
- ❌ **PROHIBIDO: serif** en la UI (Fraunces fuera). Todo DM Sans (`--font-body` y `--font-display`).
- ❌ **PROHIBIDO: crema** `#f5f0e8` como fondo de plataforma.
- ✅ El home/landing de `mizar-entrega` SÍ conserva crema/serif/dorado. Marketing ≠ producto. No los unifiques.

## 1. Anti-slop (Impeccable) — 12 detectores para este repo

Rechaza y corrige si encuentras:

1. **Grises muertos.** Todo neutro va tintado en frío (azulado), nunca `#888`, `#999`, `#ccc`, `gray`. Usa `--muted`, `--line`, `--surface`.
2. **Fuente genérica.** Arial/Inter/`system-ui` como fuente de marca. Aquí es **DM Sans**; el fallback existe pero no es el diseño.
3. **Negro puro / blanco puro para texto.** El texto es `--ink` (#2c2f36), nunca `#000`.
4. **Card nesting.** Tarjeta dentro de tarjeta dentro de tarjeta. Máximo un nivel: `.panel` contiene contenido, no otro `.panel` con borde+sombra.
5. **Bounce/elastic decorativo.** `cubic-bezier` con overshoot en hovers y entradas. Solo hay bounce si hubo gesto con momentum (aquí: casi nunca).
6. **Gradientes morado→azul, glows oscuros, sombras de colores.** Las sombras son navy translúcido, ya definidas en `--shadow-*`.
7. **Padding apretado.** Zonas táctiles < 44px de alto en móvil; celdas de tabla sin aire.
8. **Line length** > 75 caracteres en párrafos de lectura (usa `max-width` en `ch` o px).
9. **Jerarquía de headings saltada** (h1 → h3) y headings que son solo `<b>` grande.
10. **Emoji como iconografía.** Aquí se usa `lucide-react`, tamaño coherente (15–18px en UI densa).
11. **Texto centrado en bloques largos** y todo-mayúsculas fuera de eyebrows/labels.
12. **Placeholder como label.** El label existe siempre; el placeholder es ejemplo, no instrucción.

## 2. Tipografía (Apple §15) — el detalle que separa

- **Tracking depende del tamaño.** Nunca un `letter-spacing` único:
  - Display / h1 (≥28px): `-0.02em`
  - h2 / h3 (18–24px): `-0.01em`
  - Cuerpo (14–16px): `0`
  - Labels/eyebrow (≤12px, uppercase): `+0.06em` a `+0.13em`
- **Leading inverso al tamaño.** Títulos `1.05–1.2`; cuerpo `1.5–1.6`; UI densa `1.35–1.45`.
- **Jerarquía = peso + tamaño + leading**, no solo tamaño. En sans, un título necesita **700** donde el serif se bastaba con 600.
- **Números tabulares** en toda cifra de dinero o columna comparable: `font-variant-numeric: tabular-nums`.
- Escala en `rem`; el espaciado acompaña al texto.

## 3. Movimiento (Apple §1–§11) — adaptado a CSS plano

Este repo **no tiene** librería de springs. Reglas realistas:

- **Feedback en `pointer-down`, no en release.** Todo control interactivo necesita `:active`:
  ```css
  .button:active { transform: scale(.97); transition: transform 100ms ease-out; }
  ```
- **Solo `transform` y `opacity`** se animan (compositor). Nunca `width`/`height`/`top`/`left`/`box-shadow` en transición de gesto.
- **Duraciones:** `--duration-fast` (.15s) para hover/estado; `--duration-base` (.22s) para entradas/paneles. Nada por encima de 300ms en UI de trabajo.
- **Easing:** `--ease: cubic-bezier(.4,0,.2,1)` para entradas. En transiciones reversibles, **espeja la curva** (salida = inversa de entrada).
- **Consistencia espacial (§7):** lo que entra por la derecha, sale por la derecha. El drawer de proveedores entra desde la derecha → se va a la derecha. Popovers y menús con `transform-origin` en su disparador.
- **Sin bounce decorativo.** Overshoot solo tras un gesto con momentum; aquí no hay drag, así que damping crítico siempre.
- **`prefers-reduced-motion`** ya está implementado globalmente: no lo rompas añadiendo animaciones fuera de ese guard.

## 4. Materiales y profundidad (Apple §12) — con sobriedad SaaS

- Fondo blanco: las tarjetas **se definen por borde** (`1px solid var(--line)`), no por sombra pesada. Sombra solo para elementos *flotantes* (menús, drawers, modales).
- Escala de elevación: contenido plano → `--shadow-xs` (tarjeta) → `--shadow-sm` (hover) → `--shadow-lg` (overlay). No inventes sombras nuevas.
- El `topbar` translúcido con `backdrop-filter` se mantiene: el contenido pasa por debajo.
- **Nunca** apiles dos superficies translúcidas.
- Modal bloqueante = scrim + sombra profunda. Panel paralelo (no bloqueante) = sin scrim.

## 5. Principios de producto (Apple §16)

- **Agencia + perdón.** Undo fácil; diálogo de confirmación **solo** para lo irreversible (aprobar orden, declinar, cumplimiento). Ya implementado — no lo diluyas añadiendo confirmaciones triviales.
- **Feedback de 4 tipos:** estado, finalización, advertencia, error. Validación **inline**, no al enviar.
- **Wayfinding:** cada pantalla responde dónde estoy / a dónde voy / cómo salgo. El breadcrumb y el ítem activo deben ser correctos incluso en rutas de detalle.
- **Etiquetas específicas** ("Requisiciones", "Aprobaciones"), nunca genéricas ("Home", "Datos").
- **Mapeo y proximidad:** el control vive junto a lo que afecta. Si necesitas una leyenda para explicar un control, el mapeo está mal.
- **Simplicidad ≠ minimalismo.** Camino común primero; lo avanzado un nivel más abajo. A veces *añadir* contexto simplifica.
- **Honestidad:** un control sin backend va `disabled` + `aria-disabled` + `title`, nunca fingiendo funcionar.

## 6. Accesibilidad (piso, no extra)

- Contraste **AA**: 4.5:1 texto normal, 3:1 ≥18px y objetos gráficos. Todo neutro de texto ya resuelto vía `--muted`; no reintroduzcas hex sueltos.
- Foco visible siempre (`:focus-visible` con anillo navy). Nunca `outline:none` sin reemplazo.
- Zona táctil ≥44px en móvil.
- `aria-describedby` enlazando campo inválido con su mensaje; `role="status"` para éxito, `role="alert"` para error.
- Iconos decorativos `aria-hidden`; iconos con significado llevan label.

## 7. Checklist de salida (correr SIEMPRE antes de dar por hecho)

```bash
npm run typecheck && npm run lint && npm test
```
- [ ] `grep -c "dorado" app/globals.css` → **0**
- [ ] Sin serif en UI: `grep -ci "fraunces" app/layout.tsx app/globals.css` → **0**
- [ ] Sin hex de gris neutro nuevo en `color:` (usar `--muted`/`--ink`)
- [ ] Sin `#000`/`gray`/`#999` en el diff
- [ ] Overflow horizontal en 375px = **0px**
- [ ] Llaves balanceadas en `globals.css`
- [ ] Verificación **visual en navegador** (desktop 1440 + móvil 375), no solo tests

## 8. Cómo trabajar

1. Lee el token/regla existente antes de crear uno nuevo. **Reutiliza**: hay ~40 reglas que ya consumen `--font-display`.
2. Cambios quirúrgicos. No reescribas bloques enteros de CSS para un ajuste.
3. Si un fix necesita CSS y no puedes tocar `globals.css`, **repórtalo** como "CSS requerido: <regla>"; no metas estilos inline permanentes (no soportan `:hover`/`:focus-visible`/media queries).
4. Cada valor debe ser defendible. Si no sabes por qué es 14px y no 13px, es slop.
