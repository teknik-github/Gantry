import path from "node:path"

import { defineConfig, devices } from "@playwright/test"

const PORT = Number(process.env.E2E_PORT ?? 3100)
// Point at an already running, freshly set up Gantry instead of starting one.
const external = process.env.E2E_BASE_URL
const baseURL = external ?? `http://127.0.0.1:${PORT}`

// Production build (standalone, like the Docker image) with a fresh SQLite
// database. `next build` may run next to `next dev` (dev uses .next/dev), but
// a second `next dev` must not: two dev servers rewrite next-env.d.ts for each
// other and reload-loop. Set E2E_SKIP_BUILD=1 to reuse the last build.
// Absolute: the standalone server chdirs into .next/standalone, so a relative
// DATA_DIR would land (and survive between runs) there.
const dataDir = path.resolve(".test-data/e2e")
const serve = [
  `rm -rf "${dataDir}"`,
  process.env.E2E_SKIP_BUILD ? "true" : "pnpm build",
  "cp -r .next/static .next/standalone/.next/",
  "cp -r public .next/standalone/",
  "node .next/standalone/server.js",
].join(" && ")

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    launchOptions: {
      // Chromium refuses to sandbox as root (e.g. inside containers).
      chromiumSandbox: process.getuid?.() !== 0,
    },
  },
  projects: [
    // login.spec.ts starts from an empty database and creates the admin...
    { name: "login", testMatch: /login\.spec\.ts/, use: { ...devices["Desktop Chrome"] } },
    // ...which the remaining suites sign in with.
    {
      name: "app",
      testIgnore: /login\.spec\.ts/,
      dependencies: ["login"],
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: external
    ? undefined
    : {
        command: serve,
        url: `${baseURL}/api/health`,
        reuseExistingServer: false,
        timeout: 300_000,
        env: {
          HOSTNAME: "127.0.0.1",
          PORT: String(PORT),
          DB_DRIVER: "sqlite",
          DATA_DIR: dataDir,
          GANTRY_SECRET: "e2e-test-secret-e2e-test-secret-0123456789",
          COOKIE_SECURE: "false",
          GANTRY_SETUP_TOKEN: "e2e-setup-token-0123456789abcdef",
        },
      },
})
