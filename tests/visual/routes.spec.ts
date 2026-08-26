import { test, expect, type Page } from "@playwright/test";

/**
 * Una captura de página completa por ruta y por breakpoint (15 x 3 = 45 comparaciones).
 * Requiere NEXT_PUBLIC_DEMO_MODE=true, que playwright.visual.config.ts le pasa al webServer.
 * En demo el rol es Revisor, el único que ve todas las entradas del menú.
 */
const routes = [
  // Públicas: se ven sin sesión, son la primera impresión del producto.
  { path: "/login", name: "ingreso" },
  { path: "/recuperar-clave", name: "recuperar-clave" },
  { path: "/requisiciones/publica", name: "portal-publico" },
  { path: "/pantalla", name: "modo-pantalla" },

  // Privadas: dependen del modo demo.
  { path: "/", name: "inicio-tablero" },
  { path: "/requisiciones/nueva", name: "requisicion-nueva" },
  { path: "/requisiciones/mis", name: "requisiciones-mias" },
  { path: "/revision", name: "revision" },
  { path: "/aprobaciones", name: "aprobaciones" },
  { path: "/ordenes", name: "ordenes" },
  { path: "/gastos", name: "gastos-caja-menor" },
  { path: "/catalogos", name: "catalogos" },
  { path: "/proveedores", name: "proveedores" },
  { path: "/mensajes", name: "mensajes-kapso" },
  { path: "/reportes", name: "reportes" },
] as const;

/**
 * Nada de terceros. Dos razones, ambas obligatorias:
 *
 * 1. Determinismo: si una imagen o un widget externo cambia, la línea base se rompe sin que
 *    nadie haya tocado el código, y el diff deja de significar algo.
 * 2. /mensajes incrusta la bandeja REAL de Kapso (KAPSO_EMBED_URL apunta a inbox.kapso.ai).
 *    Sin bloquearla, cada corrida golpea producción y el iframe mantiene la red viva, así
 *    que `networkidle` nunca se cumple y el test expira.
 */
test.beforeEach(async ({ page }) => {
  await page.route("**/*", (route) => {
    const { hostname } = new URL(route.request().url());
    if (hostname === "localhost" || hostname === "127.0.0.1") return route.continue();
    // Se responde vacío en vez de abortar: un `abort()` sobre el documento de un iframe deja
    // la petición colgada y la página nunca termina de cargar.
    return route.fulfill({ status: 200, contentType: "text/html", body: "" });
  });
});

/**
 * El dev server de Next hidrata y luego repinta. Sin esperar a que la fuente esté lista, el
 * diff es puro ruido de timing en vez de cambios reales de diseño.
 *
 * A propósito NO se usa `networkidle`: la propia documentación de Playwright lo desaconseja,
 * y aquí colgaba /mensajes indefinidamente por el iframe incrustado.
 */
async function settle(page: Page) {
  await page.waitForLoadState("load").catch(() => {});
  await page.evaluate(() => document.fonts.ready).catch(() => {});
  await page.waitForTimeout(600);
}

for (const route of routes) {
  test(`${route.name} no cambió visualmente`, async ({ page }) => {
    const response = await page.goto(route.path, { waitUntil: "domcontentloaded" });
    expect(response?.status(), `${route.path} debe responder 200`).toBeLessThan(400);

    // Una ruta privada que redirige a /login significa que el modo demo no está activo:
    // fallar aquí es mucho mejor que aprobar una base llena de pantallas de ingreso.
    if (route.path !== "/login") {
      expect(new URL(page.url()).pathname, `${route.path} no debería redirigir a /login`).not.toBe("/login");
    }

    await settle(page);
    // El contenido de un iframe de terceros no es nuestro diseño: se enmascara para que su
    // interior no entre al diff, pero su caja sí, que ahí sí hay layout que puede romperse.
    await expect(page).toHaveScreenshot(`${route.name}.png`, {
      fullPage: true,
      mask: [page.locator("iframe")],
    });
  });
}
