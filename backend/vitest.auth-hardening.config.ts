import { defineConfig } from "vitest/config";
import path from "path";

/**
 * Separate vitest config for auth-hardening tests.
 *
 * Auth-hardening tests that need real Supabase users share the same
 * globalSetup as cross-tenant tests (mints two test users, sets TEST_JWT_A etc.).
 * Tests that only inspect source files (static-source assertions) skip setup
 * gracefully when env vars are absent.
 */
export default defineConfig({
    test: {
        environment: "node",
        // Stub non-Supabase env vars so env.ts validation passes at test-app import time.
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
        include: ["./tests/auth-hardening/**/*.test.ts"],
        exclude: [
            "./tests/auth-hardening/authCache.test.ts",
            "./tests/auth-hardening/emptyEmail.test.ts",
            "./tests/auth-hardening/randomUuidImport.test.ts",
        ],
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
