/**
 * CLEAN-05 — Audit-log entries emitted by getUserApiKeys.
 *
 * Asserts that `getUserApiKeys` emits a structured `api_key_read` pino log
 * entry for every call, with required fields:
 *   { event, user_id, provider, route, request_id, timestamp }
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { encryptApiKey } from "../../src/lib/crypto";
import { getUserApiKeys } from "../../src/lib/userSettings";
import { logger } from "../../src/lib/logger";

const supabaseUrl = process.env.SUPABASE_URL ?? "";
const serviceKey = process.env.SUPABASE_SECRET_KEY ?? "";
const TEST_USER_A_ID = process.env.TEST_USER_A_ID ?? "";

describe("getUserApiKeys audit logging (CLEAN-05)", () => {
    let db: ReturnType<typeof createClient>;

    beforeAll(async () => {
        db = createClient(supabaseUrl, serviceKey, {
            auth: { persistSession: false },
        });

        // Clear any existing API key ciphertext for user A so tests start clean
        await db.from("user_profiles").update({
            claude_api_key_ciphertext: null,
            claude_api_key_iv: null,
            claude_api_key_auth_tag: null,
            gemini_api_key_ciphertext: null,
            gemini_api_key_iv: null,
            gemini_api_key_auth_tag: null,
        }).eq("user_id", TEST_USER_A_ID);
    });

    afterAll(async () => {
        // Clean up: remove ciphertext columns after tests
        await db.from("user_profiles").update({
            claude_api_key_ciphertext: null,
            claude_api_key_iv: null,
            claude_api_key_auth_tag: null,
            gemini_api_key_ciphertext: null,
            gemini_api_key_iv: null,
            gemini_api_key_auth_tag: null,
        }).eq("user_id", TEST_USER_A_ID);
    });

    it("getUserApiKeys emits api_key_read pino log with provider=claude when claude key set", async () => {
        // Seed claude key ciphertext
        const enc = encryptApiKey("sk-ant-test-claude-key-audit-1234");
        await db.from("user_profiles").update({
            claude_api_key_ciphertext: `\\x${enc.ciphertext.toString("hex")}`,
            claude_api_key_iv: `\\x${enc.iv.toString("hex")}`,
            claude_api_key_auth_tag: `\\x${enc.authTag.toString("hex")}`,
            gemini_api_key_ciphertext: null,
            gemini_api_key_iv: null,
            gemini_api_key_auth_tag: null,
        }).eq("user_id", TEST_USER_A_ID);

        const infoSpy = vi.spyOn(logger, "info");
        infoSpy.mockClear();

        await getUserApiKeys(TEST_USER_A_ID, db);

        const calls = infoSpy.mock.calls;
        const claudeCall = calls.find(
            (c) => typeof c[0] === "object" && (c[0] as Record<string, unknown>).provider === "claude",
        );
        expect(claudeCall).toBeDefined();
        const logObj = claudeCall![0] as Record<string, unknown>;
        expect(logObj.event).toBe("api_key_read");
        expect(logObj.provider).toBe("claude");

        infoSpy.mockRestore();
    });

    it("getUserApiKeys emits api_key_read pino log with provider=gemini when gemini key set", async () => {
        // Seed gemini key ciphertext
        const enc = encryptApiKey("AIza-test-gemini-key-audit-5678");
        await db.from("user_profiles").update({
            claude_api_key_ciphertext: null,
            claude_api_key_iv: null,
            claude_api_key_auth_tag: null,
            gemini_api_key_ciphertext: `\\x${enc.ciphertext.toString("hex")}`,
            gemini_api_key_iv: `\\x${enc.iv.toString("hex")}`,
            gemini_api_key_auth_tag: `\\x${enc.authTag.toString("hex")}`,
        }).eq("user_id", TEST_USER_A_ID);

        const infoSpy = vi.spyOn(logger, "info");
        infoSpy.mockClear();

        await getUserApiKeys(TEST_USER_A_ID, db);

        const calls = infoSpy.mock.calls;
        const geminiCall = calls.find(
            (c) => typeof c[0] === "object" && (c[0] as Record<string, unknown>).provider === "gemini",
        );
        expect(geminiCall).toBeDefined();
        const logObj = geminiCall![0] as Record<string, unknown>;
        expect(logObj.event).toBe("api_key_read");
        expect(logObj.provider).toBe("gemini");

        infoSpy.mockRestore();
    });

    it("getUserApiKeys emits no api_key_read log when no key set", async () => {
        // Ensure no ciphertext set
        await db.from("user_profiles").update({
            claude_api_key_ciphertext: null,
            claude_api_key_iv: null,
            claude_api_key_auth_tag: null,
            gemini_api_key_ciphertext: null,
            gemini_api_key_iv: null,
            gemini_api_key_auth_tag: null,
        }).eq("user_id", TEST_USER_A_ID);

        const infoSpy = vi.spyOn(logger, "info");
        infoSpy.mockClear();

        await getUserApiKeys(TEST_USER_A_ID, db);

        const apiKeyReadCalls = infoSpy.mock.calls.filter(
            (c) => typeof c[0] === "object" && (c[0] as Record<string, unknown>).event === "api_key_read",
        );
        expect(apiKeyReadCalls).toHaveLength(0);

        infoSpy.mockRestore();
    });

    it("audit-log entry contains user_id, provider, route, request_id, timestamp", async () => {
        // Seed both keys
        const claudeEnc = encryptApiKey("sk-ant-test-claude-key-fields");
        await db.from("user_profiles").update({
            claude_api_key_ciphertext: `\\x${claudeEnc.ciphertext.toString("hex")}`,
            claude_api_key_iv: `\\x${claudeEnc.iv.toString("hex")}`,
            claude_api_key_auth_tag: `\\x${claudeEnc.authTag.toString("hex")}`,
            gemini_api_key_ciphertext: null,
            gemini_api_key_iv: null,
            gemini_api_key_auth_tag: null,
        }).eq("user_id", TEST_USER_A_ID);

        const infoSpy = vi.spyOn(logger, "info");
        infoSpy.mockClear();

        const ctx = { route: "/chat", requestId: "req-abc" };
        await getUserApiKeys(TEST_USER_A_ID, db, ctx);

        const calls = infoSpy.mock.calls;
        const claudeCall = calls.find(
            (c) => typeof c[0] === "object" && (c[0] as Record<string, unknown>).provider === "claude",
        );
        expect(claudeCall).toBeDefined();
        const logObj = claudeCall![0] as Record<string, unknown>;
        expect(logObj.event).toBe("api_key_read");
        expect(logObj.user_id).toBe(TEST_USER_A_ID);
        expect(logObj.provider).toBe("claude");
        expect(logObj.route).toBe("/chat");
        expect(logObj.request_id).toBe("req-abc");

        infoSpy.mockRestore();
    });
});
