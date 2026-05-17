import { defineConfig } from "vitest/config";
import path from "path";

/**
 * Standalone vitest config for pure-mock / no-DB tests.
 *
 * No globalSetup — these tests mock Supabase at the function level and do not
 * require a live Supabase instance. Covers:
 *   - auth-hardening: authCache.test.ts and emptyEmail.test.ts (CLEAN-13 / CLEAN-14)
 *   - unit: crypto, env, restoreTokens, redaction stubs (CLEAN-05 / CLEAN-44)
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
            // CLEAN-05: AES-256-GCM master key (64 hex chars = 32 bytes, all-zeros test key)
            HUGO_MASTER_KEY: "00".repeat(32),
            // CLEAN-44: HMAC secret for restore tokens (min 32 chars)
            HUGO_RESTORE_TOKEN_SECRET: "test-restore-secret-placeholder-ok",
        },
        include: [
            "./tests/auth-hardening/authCache.test.ts",
            "./tests/auth-hardening/emptyEmail.test.ts",
            "./tests/auth-hardening/authFailureModes.test.ts",
            "./tests/unit/logger.test.ts",
            "./tests/unit/geminiDebugGate.test.ts",
            "./tests/unit/validate.test.ts",
            "./tests/unit/rateLimiter.test.ts",
            "./tests/integration/hardening.test.ts",
            "./tests/integration/documentsUploadValidation.test.ts",
            "./tests/integration/documentVersionConcurrency.test.ts",
            "./tests/integration/chatStreamFailures.test.ts",
            "./tests/integration/tabularGenerateFailures.test.ts",
            "./tests/integration/tabularRegenerateRace.test.ts",
            "./tests/unit/**/*.test.ts",
            "./tests/integration/generateTitle.test.ts",
            "./tests/integration/downloadZip.test.ts",
            "./tests/integration/tabularList.test.ts",
            "./tests/integration/workflowsBuiltin.test.ts",
            "./tests/integration/modelsEndpoint.test.ts",
            "./tests/unit/replicateCap.test.ts",
            "./tests/integration/apiKeys.test.ts",
            "./tests/integration/authDeleted.test.ts",
            "./tests/integration/deleteAccount.test.ts",
            "./tests/integration/restoreAccount.test.ts",
            "./tests/integration/worker.test.ts",
        ],
        testTimeout: 30_000,
        fileParallelism: false,
        reporters: ["verbose"],
    },
    resolve: {
        alias: {
            "@": path.resolve(__dirname, "./src"),
        },
    },
});
