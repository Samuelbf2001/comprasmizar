# Identidad visual de Mizar

Paleta y tipografía **reales** de la marca, extraídas de `C:\Users\samue\mizar-lp`
(el sitio de Mizar): `context/PALETA_MIZAR_REAL.md`, el bloque `@theme` de
`site/src/landing/index.css` y el *Manual de Identidad Mizar*. Los colores del
logo son el **crimson** y la **montaña metálica**.

## Paleta

| Rol | Token | Hex | Uso |
|---|---|---|---|
| Navy corporativo | `--color-navy` | `#0a2342` | Fondos oscuros, barra lateral, títulos, texto principal |
| Navy claro | `--color-navy-light` | `#16335c` | Hover sobre navy, bordes activos |
| Navy oscuro | `--color-navy-dark` | `#061629` | Profundidad, sombras sólidas |
| **Rojo Mizar** | `--color-rojo` | `#d12e45` | **Color del logo.** Acciones principales, urgencia |
| Rojo claro | `--color-rojo-light` | `#e85c70` | Estados hover suaves |
| Rojo oscuro | `--color-rojo-dark` | `#a4123a` | Hover del botón principal |
| Gris oscuro | `--color-gris-oscuro` | `#333333` | Texto de párrafos |
| Gris medio | `--color-gris-medio` | `#7c8696` | Texto secundario, metadatos |
| Gris claro | `--color-gris-claro` | `#f6f4f1` | Fondos alternos, bordes sutiles |
| Crema | `--color-crema` | `#f5f0e8` | Fondo base de página |
| Blanco | `--color-blanco` | `#ffffff` | Tarjetas, paneles |
| Dorado | `--color-dorado` | `#c8933a` | **Discreto.** Cifras destacadas, detalle de valor |

Regla de la marca: el dorado es un acento, no un color de superficie. El verde
**no** pertenece a la identidad de Mizar (la plataforma nació con una paleta
verde bosque que no corresponde a la marca).

## Tipografía

```
--font-serif: "Fraunces Variable", "Fraunces", Georgia, serif;   /* títulos */
--font-sans:  "DM Sans Variable", "DM Sans", system-ui, sans-serif; /* cuerpo */
```

La plataforma usa hoy `Georgia, serif` en títulos y `Arial` en cuerpo, que son
los sustitutos del sistema para esa pareja. Georgia es un reemplazo aceptable de
Fraunces; para fidelidad total habría que cargar las dos familias.

## Aplicación en la plataforma

| Elemento | Color |
|---|---|
| Fondo de página | Crema `#f5f0e8` |
| Barra lateral | Navy `#0a2342` |
| Tarjetas y paneles | Blanco, borde gris claro |
| Botón principal | Rojo Mizar `#d12e45`, hover `#a4123a` |
| Botón secundario | Navy, borde gris |
| Enlaces y foco | Navy `#0a2342` |
| Cifras destacadas | Dorado `#c8933a`, con moderación |
| Sección alterna | Gris claro `#f6f4f1` |

Los colores **semánticos** (ámbar de pendiente, azul de información, rojo de
error, verde de éxito) se conservan aparte de la paleta de marca: comunican
estado, no identidad, y mezclarlos con el rojo del logo haría ambiguo si un
elemento es "de marca" o "de alerta".
