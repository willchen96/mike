import crypto from "crypto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

beforeEach(() => {
    process.env.USER_API_KEYS_ENCRYPTION_SECRET = "test-secret-32-bytes-long-enough!!";
});

afterEach(() => {
    delete process.env.USER_API_KEYS_ENCRYPTION_SECRET;
});

// Import after env is set via dynamic import in each test suite
describe("userApiKeys crypto", () => {
    it("encrypt produces a salt field", async () => {
        const { encryptKey } = await import("../userApiKeys.js");
        const row = encryptKey("sk-test-value");
        expect(row.salt).toBeTruthy();
        expect(typeof row.salt).toBe("string");
        expect(Buffer.from(row.salt!, "base64").length).toBe(16);
    });

    it("each encrypt call produces a unique salt", async () => {
        const { encryptKey } = await import("../userApiKeys.js");
        const a = encryptKey("value");
        const b = encryptKey("value");
        expect(a.salt).not.toBe(b.salt);
        expect(a.iv).not.toBe(b.iv);
    });

    it("decryptKey reverses encryptKey (HKDF path)", async () => {
        const { encryptKey, decryptKey } = await import("../userApiKeys.js");
        const row = { provider: "claude" as const, ...encryptKey("sk-ant-secret") };
        expect(decryptKey(row)).toBe("sk-ant-secret");
    });

    it("decryptKey returns null for tampered auth tag", async () => {
        const { encryptKey, decryptKey } = await import("../userApiKeys.js");
        const row = { provider: "claude" as const, ...encryptKey("value") };
        row.auth_tag = Buffer.alloc(16).toString("base64");
        expect(decryptKey(row)).toBeNull();
    });

    it("decryptKey handles legacy rows (null salt, SHA-256 key)", async () => {
        const { decryptKey } = await import("../userApiKeys.js");
        const secret = process.env.USER_API_KEYS_ENCRYPTION_SECRET!;
        const legacyKey = crypto.createHash("sha256").update(secret).digest();
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv("aes-256-gcm", legacyKey, iv);
        const encrypted = Buffer.concat([cipher.update("legacy-value", "utf8"), cipher.final()]);
        const row = {
            provider: "openai" as const,
            encrypted_key: encrypted.toString("base64"),
            iv: iv.toString("base64"),
            auth_tag: cipher.getAuthTag().toString("base64"),
            salt: null,
        };
        expect(decryptKey(row)).toBe("legacy-value");
    });
});
