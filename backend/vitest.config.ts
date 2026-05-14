import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "node",
    // Stub non-Supabase env vars so env.ts validation passes at test-app import time.
    // Real Supabase keys must still be supplied via backend/.env for tests to run.
    env: {
      DOWNLOAD_SIGNING_SECRET: "test-secret-placeholder-32-chars-ok",
      FRONTEND_URL: "http://localhost:3000",
      R2_ENDPOINT_URL: "http://localhost:9000",
      R2_ACCESS_KEY_ID: "test",
      R2_SECRET_ACCESS_KEY: "test",
      R2_BUCKET_NAME: "test-bucket",
    },
    globalSetup: [
      "./tests/cross-tenant/setup.ts",
      "./tests/cross-tenant/teardown.ts",
    ],
    include: [
      "./tests/cross-tenant/**/*.test.ts",
      "./tests/auth-hardening/**/*.test.ts",
      "./tests/saga/**/*.test.ts",
      "./tests/integration/**/*.test.ts",
    ],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    reporters: ["verbose"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
