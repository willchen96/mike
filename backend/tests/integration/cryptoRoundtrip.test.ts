/**
 * CLEAN-05 — Bytea round-trip via supabase-js (Pitfall 3).
 *
 * Verifies that the encrypted API-key columns (`claude_api_key_ciphertext`,
 * `claude_api_key_iv`, `claude_api_key_auth_tag`) survive insert/select
 * without byte corruption when written and read via `@supabase/supabase-js`.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { encryptApiKey, decryptApiKey } from "../../src/lib/crypto";

const supabaseUrl = process.env.SUPABASE_URL ?? "";
const serviceKey = process.env.SUPABASE_SECRET_KEY ?? "";
const TEST_USER_A_ID = process.env.TEST_USER_A_ID ?? "";

function decodeBytea(value: string): Buffer {
    return value.startsWith("\\x")
        ? Buffer.from(value.slice(2), "hex")
        : Buffer.from(value, "base64");
}

describe("bytea round-trip via supabase-js (Pitfall 3)", () => {
    let db: ReturnType<typeof createClient>;

    beforeAll(async () => {
        db = createClient(supabaseUrl, serviceKey, {
            auth: { persistSession: false },
        });
    });

    afterAll(async () => {
        // Clean up: clear the ciphertext columns after tests
        await db.from("user_profiles").update({
            claude_api_key_ciphertext: null,
            claude_api_key_iv: null,
            claude_api_key_auth_tag: null,
        }).eq("user_id", TEST_USER_A_ID);
    });

    it("bytea round-trip via supabase-js: written buffer === read buffer (Pitfall 3)", async () => {
        // Encrypt a known plaintext to get buffers
        const enc = encryptApiKey("sk-ant-roundtrip-test-key-abcd1234");

        // Write the three bytea columns (Buffer → supabase-js → PostgREST)
        const { error: updateErr } = await db
            .from("user_profiles")
            .update({
                claude_api_key_ciphertext: `\\x${enc.ciphertext.toString("hex")}`,
                claude_api_key_iv: `\\x${enc.iv.toString("hex")}`,
                claude_api_key_auth_tag: `\\x${enc.authTag.toString("hex")}`,
            })
            .eq("user_id", TEST_USER_A_ID);
        expect(updateErr).toBeNull();

        // Read back
        const { data, error: selectErr } = await db
            .from("user_profiles")
            .select("claude_api_key_ciphertext, claude_api_key_iv, claude_api_key_auth_tag")
            .eq("user_id", TEST_USER_A_ID)
            .single();
        expect(selectErr).toBeNull();
        expect(data).not.toBeNull();

        // Decode using base64 (the PostgREST/supabase-js wire format for bytea columns)
        const ciphertextRead = decodeBytea(data!.claude_api_key_ciphertext as string);
        const ivRead = decodeBytea(data!.claude_api_key_iv as string);
        const authTagRead = decodeBytea(data!.claude_api_key_auth_tag as string);

        // Assert each buffer matches what we wrote
        expect(Buffer.compare(enc.ciphertext, ciphertextRead)).toBe(0);
        expect(Buffer.compare(enc.iv, ivRead)).toBe(0);
        expect(Buffer.compare(enc.authTag, authTagRead)).toBe(0);
    });

    it("bytea round-trip via supabase-js: ciphertext + iv + auth_tag survive insert/select", async () => {
        const plaintext = "AIza-roundtrip-gemini-test-key-5678";

        // Full encrypt → write → read → decrypt round-trip
        const enc = encryptApiKey(plaintext);

        const { error: updateErr } = await db
            .from("user_profiles")
            .update({
                claude_api_key_ciphertext: `\\x${enc.ciphertext.toString("hex")}`,
                claude_api_key_iv: `\\x${enc.iv.toString("hex")}`,
                claude_api_key_auth_tag: `\\x${enc.authTag.toString("hex")}`,
            })
            .eq("user_id", TEST_USER_A_ID);
        expect(updateErr).toBeNull();

        const { data, error: selectErr } = await db
            .from("user_profiles")
            .select("claude_api_key_ciphertext, claude_api_key_iv, claude_api_key_auth_tag")
            .eq("user_id", TEST_USER_A_ID)
            .single();
        expect(selectErr).toBeNull();
        expect(data).not.toBeNull();

        const decrypted = decryptApiKey({
            ciphertext: decodeBytea(data!.claude_api_key_ciphertext as string),
            iv: decodeBytea(data!.claude_api_key_iv as string),
            authTag: decodeBytea(data!.claude_api_key_auth_tag as string),
        });

        // The plaintext must survive the full round-trip
        expect(decrypted).toBe(plaintext);
    });
});
