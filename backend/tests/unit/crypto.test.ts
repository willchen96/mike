/**
 * Unit tests for the AES-256-GCM crypto helper (CLEAN-05).
 *
 * The test key is `"00".repeat(32)` (64 hex chars = 32 zero bytes). This is
 * valid for AES-256-GCM and fine for unit testing — operators must supply a
 * cryptographically random key in production (openssl rand -hex 32).
 *
 * The vitest.no-db.config.ts already sets HUGO_MASTER_KEY = "00".repeat(32)
 * so these tests can import the production module directly.
 */
import { describe, it, expect } from "vitest";
import { encryptApiKey, decryptApiKey } from "../../src/lib/crypto";

describe("AES-256-GCM crypto helper", () => {
    it("round-trips plaintext through encrypt → decrypt", () => {
        const plaintext = "sk-ant-test-key-abcdefgh1234567890";
        const enc = encryptApiKey(plaintext);
        const result = decryptApiKey(enc);
        expect(result).toBe(plaintext);
    });

    it("returns null when ciphertext is tampered", () => {
        const enc = encryptApiKey("secret");
        const tampered = { ...enc, ciphertext: Buffer.from([enc.ciphertext[0] ^ 0xff, ...enc.ciphertext.slice(1)]) };
        const result = decryptApiKey(tampered);
        expect(result).toBeNull();
    });

    it("returns null when authTag is tampered", () => {
        const enc = encryptApiKey("secret");
        const tampered = { ...enc, authTag: Buffer.from([enc.authTag[0] ^ 0xff, ...enc.authTag.slice(1)]) };
        const result = decryptApiKey(tampered);
        expect(result).toBeNull();
    });

    it("returns null when IV is tampered", () => {
        const enc = encryptApiKey("secret");
        const tampered = { ...enc, iv: Buffer.from([enc.iv[0] ^ 0xff, ...enc.iv.slice(1)]) };
        const result = decryptApiKey(tampered);
        expect(result).toBeNull();
    });

    it("produces 1000 distinct IVs across 1000 encryptions of the same plaintext", () => {
        const ivs = new Set(
            Array.from({ length: 1000 }, () => encryptApiKey("x").iv.toString("hex")),
        );
        expect(ivs.size).toBe(1000);
    });

    it("produces a 12-byte IV and 16-byte authTag", () => {
        const enc = encryptApiKey("test");
        expect(enc.iv.length).toBe(12);
        expect(enc.authTag.length).toBe(16);
    });
});
