import path from "node:path"

import { defineConfig, devices } from "@playwright/test"

const PORT = Number(process.env.E2E_PORT ?? 3100)
// The fake OpenID provider tests/e2e/sso.spec.ts starts (tests/helpers/fake-oidc.ts).
const OIDC_PORT = Number(process.env.E2E_OIDC_PORT ?? PORT + 1)
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
// E2E_DB=mysql runs the server on MySQL instead: E2E_MYSQL_URL names a
// throwaway database, emptied before the server starts (all tables dropped).
const mysql = process.env.E2E_DB === "mysql"
const mysqlUrl = process.env.E2E_MYSQL_URL
if (mysql && !mysqlUrl && !external) throw new Error("E2E_DB=mysql needs E2E_MYSQL_URL (mysql://user:pass@host:port/db, wiped)")
const serve = [
  `rm -rf "${dataDir}"`,
  ...(mysql ? ["node tests/helpers/reset-e2e-mysql.mjs"] : []),
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
        // Includes `next build`, which takes several minutes on a busy host.
        timeout: 900_000,
        env: {
          HOSTNAME: "127.0.0.1",
          PORT: String(PORT),
          ...(mysql ? { DB_DRIVER: "mysql", DATABASE_URL: mysqlUrl!, E2E_MYSQL_URL: mysqlUrl! } : { DB_DRIVER: "sqlite" }),
          DATA_DIR: dataDir,
          GANTRY_SECRET: "e2e-test-secret-e2e-test-secret-0123456789",
          COOKIE_SECURE: "false",
          GANTRY_SETUP_TOKEN: "e2e-setup-token-0123456789abcdef",
          // Tests trigger update checks themselves.
          UPDATE_CHECK_INTERVAL_HOURS: "0",
          // Resource alerts need a few samples; keep the e2e run short.
          METRICS_INTERVAL_SECONDS: "10",
          // git-stacks.spec.ts serves its repository over http on 127.0.0.1.
          GANTRY_TEST_ALLOW_HTTP_GIT: "1",
          // Single sign-on against the fake provider sso.spec.ts runs on OIDC_PORT;
          // nothing contacts it until a test clicks "Sign in with SSO".
          GANTRY_URL: baseURL,
          OIDC_ISSUER: `http://127.0.0.1:${OIDC_PORT}`,
          OIDC_CLIENT_ID: "gantry-e2e",
          OIDC_CLIENT_SECRET: "gantry-e2e-oidc-secret",
          OIDC_AUTO_CREATE: "true",
          OIDC_ADMIN_GROUPS: "gantry-admins",
        },
      },
})
