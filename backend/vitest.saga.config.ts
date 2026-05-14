/**
 * Vitest config for saga unit tests only.
 *
 * Saga tests are pure unit tests with no Supabase dependency — they mock the
 * db client and storage functions directly. This config intentionally omits
 * the cross-tenant globalSetup so the tests run without a live database.
 */
import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "node",
    env: {
      DOWNLOAD_SIGNING_SECRET: "test-secret-placeholder-32-chars-ok",
      FRONTEND_URL: "http://localhost:3000",
      R2_ENDPOINT_URL: "http://localhost:9000",
      R2_ACCESS_KEY_ID: "test",
      R2_SECRET_ACCESS_KEY: "test",
      R2_BUCKET_NAME: "test-bucket",
      SUPABASE_URL: "https://test.supabase.co",
      SUPABASE_ANON_KEY: "test-anon-key",
      SUPABASE_SECRET_KEY: "test-service-role-key",
      HUGO_MASTER_KEY: "00".repeat(32),
      HUGO_RESTORE_TOKEN_SECRET: "test-restore-secret-placeholder-ok",
    },
    include: [
      "./tests/saga/**/*.test.ts",
    ],
    reporters: ["verbose"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
