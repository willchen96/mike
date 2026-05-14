import { defineConfig } from "vitest/config";
import path from "path";

/**
 * Standalone vitest config for Phase 7 docxTrackedChanges round-trip tests.
 *
 * Pure in-process / no-DB. Tests live under tests/docx-round-trip/ and verify
 * that applyTrackedEdits → resolveTrackedChange("accept"/"reject") is a
 * semantic no-op across ≥20 DOCX fixture files (CLEAN-31 / CLEAN-36).
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
        include: ["./tests/docx-round-trip/**/*.test.ts"],
        testTimeout: 30_000,
        reporters: ["verbose"],
    },
    resolve: {
        alias: {
            "@": path.resolve(__dirname, "./src"),
        },
    },
});
