import { defineConfig } from "vitest/config";
import path from "path";

/**
 * Standalone vitest config for Phase 8 golden-log SSE fixture tests.
 *
 * Pure-mock / no-DB. Tests live under tests/golden-log/ and verify that
 * runLLMStream emits a byte-identical SSE event sequence before and
 * after the chatTools.ts split (Pitfall 1 mitigation).
 */
export default defineConfig({
    test: {
        environment: "node",
        env: {
            SUPABASE_URL: "http://localhost:54321",
            SUPABASE_SECRET_KEY: "test-service-role-key",
            DOWNLOAD_SIGNING_SECRET: "test-secret-placeholder-32-chars-ok",
            FRONTEND_URL: "http://localhost:3000",
            R2_ENDPOINT_URL: "http://localhost:9000",
            R2_ACCESS_KEY_ID: "test",
            R2_SECRET_ACCESS_KEY: "test",
            R2_BUCKET_NAME: "test-bucket",
            HUGO_MASTER_KEY: "00".repeat(32),
            HUGO_RESTORE_TOKEN_SECRET: "test-restore-secret-placeholder-ok",
        },
        include: ["./tests/golden-log/**/*.test.ts"],
        testTimeout: 30_000,
        reporters: ["verbose"],
    },
    resolve: {
        alias: {
            "@": path.resolve(__dirname, "./src"),
        },
    },
});
