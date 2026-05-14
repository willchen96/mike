import { describe, it, expect } from "vitest";
import { envSchema } from "../../src/env";

/**
 * Unit tests for the zod env schema.
 *
 * These tests call `envSchema.safeParse({...})` directly — they do NOT import
 * the live `env` export, which would execute the boot-time validation and throw
 * if HUGO_MASTER_KEY etc. are absent from the test runner's process.env.
 *
 * CLEAN-05: HUGO_MASTER_KEY must be 64 hex chars (32 bytes for AES-256-GCM).
 */

/** Minimum valid env for the schema to accept. */
const validEnv = {
    SUPABASE_URL: "http://localhost:54321",
    SUPABASE_SECRET_KEY: "test-service-role-key",
    DOWNLOAD_SIGNING_SECRET: "test-signing-secret-min-32-chars-ok",
    FRONTEND_URL: "http://localhost:3000",
    R2_ENDPOINT_URL: "http://localhost:9000",
    R2_ACCESS_KEY_ID: "test-access-key",
    R2_SECRET_ACCESS_KEY: "test-secret-key",
    R2_BUCKET_NAME: "test-bucket",
    HUGO_MASTER_KEY: "00".repeat(32),           // 64 hex chars — valid
    HUGO_RESTORE_TOKEN_SECRET: "a".repeat(32),  // 32 chars — valid
};

describe("envSchema — HUGO_MASTER_KEY validation", () => {
    it("fails when HUGO_MASTER_KEY is missing", () => {
        const { HUGO_MASTER_KEY: _omit, ...rest } = validEnv;
        const result = envSchema.safeParse(rest);
        expect(result.success).toBe(false);
    });

    it("fails when HUGO_MASTER_KEY is not hex (contains non-hex char)", () => {
        const result = envSchema.safeParse({
            ...validEnv,
            HUGO_MASTER_KEY: "zz" + "00".repeat(31), // 'z' is not hex
        });
        expect(result.success).toBe(false);
    });

    it("fails when HUGO_MASTER_KEY is 63 hex chars (one char short)", () => {
        const result = envSchema.safeParse({
            ...validEnv,
            HUGO_MASTER_KEY: "0".repeat(63),
        });
        expect(result.success).toBe(false);
    });

    it("fails when HUGO_RESTORE_TOKEN_SECRET is shorter than 32 chars", () => {
        const result = envSchema.safeParse({
            ...validEnv,
            HUGO_RESTORE_TOKEN_SECRET: "a".repeat(31), // 31 chars — one short
        });
        expect(result.success).toBe(false);
    });

    it("succeeds with a valid 64-hex master key and 32-char restore secret", () => {
        const result = envSchema.safeParse(validEnv);
        expect(result.success).toBe(true);
    });

    it("parsed env does NOT contain HUGO_DELETE_GRACE_DAYS (grace-days is a constant, not an env var per D-04)", () => {
        const result = envSchema.safeParse(validEnv);
        expect(result.success).toBe(true);
        expect("HUGO_DELETE_GRACE_DAYS" in result.data!).toBe(false);
    });
});
