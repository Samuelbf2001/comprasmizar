import { defineConfig, devices } from "@playwright/test";

// El puerto se puede cambiar con E2E_PORT: Docker Desktop escucha en localhost:3000 y, como
// `reuseExistingServer` da por bueno cualquier cosa que responda ahí, las pruebas se ejecutaban
// contra Docker y fallaban todas sin que hubiera nada roto en la aplicación.
const port = Number(process.env.E2E_PORT ?? 3000);
const baseURL = `http://localhost:${port}`;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL,
    trace: "on-first-retry"
  },
  webServer: {
    command: `npm run dev -- -p ${port}`,
    url: baseURL,
    env: { NEXT_PUBLIC_DEMO_MODE: "true" },
    reuseExistingServer: !process.env.CI,
    timeout: 120_000
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } }
  ]
});
