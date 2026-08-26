import type { CustomProjectConfig } from 'lost-pixel';

/**
 * Regresión visual (Lost Pixel, modo OSS: sin cuenta, sin API key, sin Docker).
 *
 * Por qué existe: el código de UI que sale de un agente pasa lint, tipos y los tests de
 * `npm test`, y aun así rompe cosas que solo existen en el navegador — un card desalineado,
 * un token de color que cambió, un breakpoint que colapsa. Nada de eso falla en CI hoy.
 * Esto compara píxeles contra una línea base aprobada y falla cuando algo se movió.
 *
 * Requiere el servidor arriba EN MODO DEMO, si no todas las rutas privadas redirigen a
 * /login y las capturas no valen nada:
 *
 *   npm run dev:demo          (en otra terminal)
 *   npm run visual:baseline   una vez, para aprobar el estado actual
 *   npm run visual:check      en cada cambio; sale con código != 0 si hay diferencias
 *
 * Las imágenes de `.lostpixel/baseline/` SÍ se commitean: son el contrato. `current/` y
 * `difference/` no (ver .gitignore).
 */
export const config: CustomProjectConfig = {
  pageShots: {
    // Override con LOST_PIXEL_BASE_URL para apuntar a otro puerto o a un preview desplegado.
    baseUrl: process.env.LOST_PIXEL_BASE_URL ?? 'http://localhost:3000',

    // Un ancho por breakpoint real de la app: móvil, tablet y escritorio.
    // Cada página se captura en los tres, así que son 15 rutas x 3 = 45 imágenes.
    breakpoints: [390, 820, 1440],

    pages: [
      // Públicas: se ven sin sesión, son la primera impresión del producto.
      { path: '/login', name: 'ingreso' },
      { path: '/recuperar-clave', name: 'recuperar-clave' },
      { path: '/requisiciones/publica', name: 'portal-publico' },
      { path: '/pantalla', name: 'modo-pantalla' },

      // Privadas: requieren NEXT_PUBLIC_DEMO_MODE=true. En demo el rol es Revisor,
      // que es el único que ve todas las entradas del menú.
      { path: '/', name: 'inicio-tablero' },
      { path: '/requisiciones/nueva', name: 'requisicion-nueva' },
      { path: '/requisiciones/mis', name: 'requisiciones-mias' },
      { path: '/revision', name: 'revision' },
      { path: '/aprobaciones', name: 'aprobaciones' },
      { path: '/ordenes', name: 'ordenes' },
      { path: '/gastos', name: 'gastos-caja-menor' },
      { path: '/catalogos', name: 'catalogos' },
      { path: '/proveedores', name: 'proveedores' },
      { path: '/mensajes', name: 'mensajes-kapso' },
      { path: '/reportes', name: 'reportes' },
    ],
  },

  // Modo OSS. `generateOnly` sigue siendo obligatorio para que `lost-pixel update`
  // funcione, pese a que los tipos lo marquen como deprecado.
  generateOnly: true,
  failOnDifference: true,

  // Ratio, no píxeles: los valores entre 0 y 1 son porcentaje de la imagen. 0.005 deja
  // pasar el antialiasing y el subpixel rendering, y atrapa cualquier cambio de layout.
  threshold: 0.005,

  imagePathBaseline: '.lostpixel/baseline',
  imagePathCurrent: '.lostpixel/current',
  imagePathDifference: '.lostpixel/difference',

  // El dev server de Next hidrata y luego repinta; sin esta espera el diff es puro ruido.
  waitBeforeScreenshot: 1500,
  browser: 'chromium',
};
