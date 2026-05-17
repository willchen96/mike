import { describe, it, expect, vi } from "vitest";

describe("storage module", () => {
    it("storageEnabled is false when R2 env vars are missing", async () => {
        const savedEndpoint = process.env.R2_ENDPOINT_URL;
        const savedKey = process.env.R2_ACCESS_KEY_ID;
        const savedSecret = process.env.R2_SECRET_ACCESS_KEY;

        delete process.env.R2_ENDPOINT_URL;
        delete process.env.R2_ACCESS_KEY_ID;
        delete process.env.R2_SECRET_ACCESS_KEY;

        vi.resetModules();
        const { storageEnabled } = await import("../storage.js");
        expect(storageEnabled).toBe(false);

        if (savedEndpoint) process.env.R2_ENDPOINT_URL = savedEndpoint;
        if (savedKey) process.env.R2_ACCESS_KEY_ID = savedKey;
        if (savedSecret) process.env.R2_SECRET_ACCESS_KEY = savedSecret;
    });

    it("downloadFile returns null when storage is disabled", async () => {
        vi.resetModules();
        delete process.env.R2_ENDPOINT_URL;
        delete process.env.R2_ACCESS_KEY_ID;
        delete process.env.R2_SECRET_ACCESS_KEY;

        const { downloadFile } = await import("../storage.js");
        const result = await downloadFile("some/path.pdf");
        expect(result).toBeNull();
    });

    it("getSignedUrl returns null when storage is disabled", async () => {
        vi.resetModules();
        delete process.env.R2_ENDPOINT_URL;
        delete process.env.R2_ACCESS_KEY_ID;
        delete process.env.R2_SECRET_ACCESS_KEY;

        const { getSignedUrl } = await import("../storage.js");
        const result = await getSignedUrl("some/path.pdf");
        expect(result).toBeNull();
    });
});
