import { defineConfig } from "@playwright/test";

/**
 * Regresión visual. Separada de playwright.config.ts a propósito: los E2E prueban
 * comportamiento y deben correr en cada push; esto compara píxeles y solo tiene sentido
 * contra una línea base aprobada a mano.
 *
 * Por qué existe: el código de UI que sale de un agente pasa lint, tipos y `npm test`,
 * y aun así rompe cosas que solo existen en el navegador — un card desalineado, un token
 * de color que cambió, un breakpoint que colapsa. Nada de eso falla en CI hoy.
 *
 *   npm run visual:baseline   una vez, para aprobar el estado actual
 *   npm run visual:check      en cada cambio; falla si algo se movió
 *   npm run visual:report     abre el reporte con las tres imágenes (base/actual/diff)
 *
 * Las imágenes de tests/visual/__screenshots__/ SÍ se commitean: son el contrato.
 */
export default defineConfig({
  testDir: "./tests/visual",
  fullyParallel: true,
  retries: 0,
  reporter: [["html", { outputFolder: "playwright-report-visual", open: "never" }], ["list"]],
  outputDir: "test-results/visual",

  // Una carpeta por perfil de dispositivo, para que el diff no mezcle anchos.
  snapshotPathTemplate: "{testDir}/__screenshots__/{projectName}/{arg}{ext}",

  use: {
    baseURL: process.env.VISUAL_BASE_URL ?? "http://localhost:3000",
    // Fija todo lo que puede mover píxeles entre máquinas.
    locale: "es-CO",
    timezoneId: "America/Bogota",
    colorScheme: "light",
    deviceScaleFactor: 1,
  },

  expect: {
    toHaveScreenshot: {
      // Ratio, no píxeles: tolera antialiasing y subpixel rendering, atrapa layout.
      maxDiffPixelRatio: 0.005,
      // Umbral por píxel en el espacio YIQ; el default (0.2) deja pasar cambios de color sutiles.
      threshold: 0.15,
      animations: "disabled",
      caret: "hide",
      scale: "css",
      // Oculta el indicador de dev de Next, que flota sobre el sidebar y cambia solo.
      stylePath: "./tests/visual/hide-dev-overlays.css",
    },
  },

  // Los tres breakpoints reales de la app.
  projects: [
    { name: "movil", use: { viewport: { width: 390, height: 844 } } },
    { name: "tablet", use: { viewport: { width: 820, height: 1180 } } },
    { name: "escritorio", use: { viewport: { width: 1440, height: 900 } } },
  ],

  // Modo demo obligatorio: sin él las 11 rutas privadas redirigen a /login y la base no vale nada.
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3000",
    env: { NEXT_PUBLIC_DEMO_MODE: "true" },
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
