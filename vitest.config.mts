import path from "node:path"
import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname),
      // `server-only` throws outside the react-server condition; unit tests run plain Node.
      "server-only": path.resolve(import.meta.dirname, "tests/unit/server-only-stub.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts", "tests/integration/**/*.test.ts"],
    testTimeout: 30_000,
    env: {
      GANTRY_SECRET: "unit-test-secret-unit-test-secret-0123456789",
      DATA_DIR: ".test-data/unit",
      SESSION_TTL_HOURS: "12",
    },
  },
})
