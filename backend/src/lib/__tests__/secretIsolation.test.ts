import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { signDownload, verifyDownload } from "../downloadTokens";
import { saveUserApiKey } from "../userApiKeys";
import { assertSecretIsolation } from "../startup";

const ENV_KEYS = [
    "DOWNLOAD_SIGNING_SECRET",
    "USER_API_KEYS_ENCRYPTION_SECRET",
    "API_KEYS_ENCRYPTION_SECRET",
    "SUPABASE_SECRET_KEY",
];

type EnvSnapshot = Record<string, string | undefined>;
let savedEnv: EnvSnapshot = {};

beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
    for (const [key, val] of Object.entries(savedEnv)) {
        if (val === undefined) delete process.env[key];
        else process.env[key] = val;
    }
});

const mockDb = {
    from: (_table: string) => ({
        upsert: (_data: unknown, _opts: unknown) =>
            Promise.resolve({ error: null }),
        delete: () => ({
            eq: () => ({
                eq: () => Promise.resolve({ error: null }),
            }),
        }),
    }),
};

describe("downloadTokens secret isolation", () => {
    it("throws when DOWNLOAD_SIGNING_SECRET is absent even if SUPABASE_SECRET_KEY is set", () => {
        process.env.SUPABASE_SECRET_KEY = "supabase-service-key";
        expect(() => signDownload("/docs/brief.pdf", "brief.pdf")).toThrow();
    });

    it("signs and verifies a token when DOWNLOAD_SIGNING_SECRET is set", () => {
        process.env.DOWNLOAD_SIGNING_SECRET = "dedicated-download-secret-32ch!!";
        const token = signDownload("/docs/brief.pdf", "brief.pdf");
        expect(verifyDownload(token)).toEqual({
            path: "/docs/brief.pdf",
            filename: "brief.pdf",
        });
    });

    it("returns null for a tampered token", () => {
        process.env.DOWNLOAD_SIGNING_SECRET = "dedicated-download-secret-32ch!!";
        const token = signDownload("/docs/brief.pdf", "brief.pdf");
        expect(verifyDownload(token + "x")).toBeNull();
    });
});

describe("userApiKeys encryption secret isolation", () => {
    it("throws when USER_API_KEYS_ENCRYPTION_SECRET is absent even if SUPABASE_SECRET_KEY is set", async () => {
        process.env.SUPABASE_SECRET_KEY = "supabase-service-key";
        await expect(
            saveUserApiKey("user-id", "claude", "sk-ant-valid", mockDb as never),
        ).rejects.toThrow();
    });

    it("encrypts and saves a key when USER_API_KEYS_ENCRYPTION_SECRET is set", async () => {
        process.env.USER_API_KEYS_ENCRYPTION_SECRET =
            "dedicated-encryption-secret-32ch";
        await expect(
            saveUserApiKey("user-id", "claude", "sk-ant-valid", mockDb as never),
        ).resolves.not.toThrow();
    });
});

describe("assertSecretIsolation", () => {
    it("throws when DOWNLOAD_SIGNING_SECRET is missing", () => {
        process.env.USER_API_KEYS_ENCRYPTION_SECRET = "enc-secret";
        expect(() => assertSecretIsolation()).toThrow(/DOWNLOAD_SIGNING_SECRET/);
    });

    it("throws when USER_API_KEYS_ENCRYPTION_SECRET is missing", () => {
        process.env.DOWNLOAD_SIGNING_SECRET = "dl-secret";
        expect(() => assertSecretIsolation()).toThrow(
            /USER_API_KEYS_ENCRYPTION_SECRET/,
        );
    });

    it("throws when DOWNLOAD_SIGNING_SECRET equals SUPABASE_SECRET_KEY", () => {
        process.env.SUPABASE_SECRET_KEY = "shared-secret";
        process.env.DOWNLOAD_SIGNING_SECRET = "shared-secret";
        process.env.USER_API_KEYS_ENCRYPTION_SECRET = "enc-secret";
        expect(() => assertSecretIsolation()).toThrow(/DOWNLOAD_SIGNING_SECRET/);
    });

    it("throws when USER_API_KEYS_ENCRYPTION_SECRET equals SUPABASE_SECRET_KEY", () => {
        process.env.SUPABASE_SECRET_KEY = "shared-secret";
        process.env.DOWNLOAD_SIGNING_SECRET = "dl-secret";
        process.env.USER_API_KEYS_ENCRYPTION_SECRET = "shared-secret";
        expect(() => assertSecretIsolation()).toThrow(
            /USER_API_KEYS_ENCRYPTION_SECRET/,
        );
    });

    it("passes when all secrets are set and distinct", () => {
        process.env.SUPABASE_SECRET_KEY = "supabase-secret";
        process.env.DOWNLOAD_SIGNING_SECRET = "download-secret";
        process.env.USER_API_KEYS_ENCRYPTION_SECRET = "encryption-secret";
        expect(() => assertSecretIsolation()).not.toThrow();
    });
});
