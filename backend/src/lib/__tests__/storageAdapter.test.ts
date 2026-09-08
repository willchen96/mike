import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { StorageAdapter } from "../storage";

let storage: typeof import("../storage");

function fakeAdapter(overrides: Partial<StorageAdapter> = {}): StorageAdapter {
  return {
    enabled: true,
    configurationHint: "FAKE_STORAGE_URL must be set",
    uploadFile: vi.fn(async () => undefined),
    uploadFileFromPath: vi.fn(async () => undefined),
    downloadFile: vi.fn(async () => new ArrayBuffer(4)),
    downloadFileStream: vi.fn(async function* () {
      yield new Uint8Array([1, 2, 3]);
    }),
    headFile: vi.fn(async () => ({
      size: 4,
      etag: null,
      contentType: null,
    })),
    copyFile: vi.fn(async () => undefined),
    listFiles: vi.fn(async () => ["a", "b"]),
    deleteFile: vi.fn(async () => undefined),
    getSignedUrl: vi.fn(async () => "https://signed.example.test/object"),
    getSignedUploadUrl: vi.fn(
      async () => "https://signed.example.test/upload",
    ),
    ...overrides,
  };
}

// The facade holds module-level adapter state, so re-import it fresh for each
// test instead of restoring the default S3 adapter by hand.
beforeEach(async () => {
  vi.resetModules();
  storage = await import("../storage");
});

afterEach(() => {
  vi.resetModules();
});

describe("setStorageAdapter", () => {
  it("routes every operation through the injected adapter", async () => {
    const adapter = fakeAdapter();
    storage.setStorageAdapter(adapter);

    const content = new ArrayBuffer(8);
    await storage.uploadFile("k", content, "application/pdf");
    expect(adapter.uploadFile).toHaveBeenCalledWith(
      "k",
      content,
      "application/pdf",
    );

    await expect(storage.downloadFile("k")).resolves.toBeInstanceOf(
      ArrayBuffer,
    );
    await expect(storage.listFiles("pre/")).resolves.toEqual(["a", "b"]);
    await storage.deleteFile("k");
    expect(adapter.deleteFile).toHaveBeenCalledWith("k");
  });

  it("updates the live storageEnabled binding", () => {
    storage.setStorageAdapter(fakeAdapter({ enabled: true }));
    expect(storage.storageEnabled).toBe(true);
    storage.setStorageAdapter(fakeAdapter({ enabled: false }));
    expect(storage.storageEnabled).toBe(false);
  });

  it("builds the Content-Disposition header before the adapter sees it", async () => {
    const adapter = fakeAdapter();
    storage.setStorageAdapter(adapter);

    await storage.getSignedUrl("k", 60, "Contract v2.pdf");
    expect(adapter.getSignedUrl).toHaveBeenCalledWith(
      "k",
      60,
      `attachment; filename="Contract v2.pdf"; filename*=UTF-8''Contract%20v2.pdf`,
    );

    await storage.getSignedUrl("k", 60);
    expect(adapter.getSignedUrl).toHaveBeenLastCalledWith("k", 60, undefined);
  });
});

describe("not-configured degradation (shared policy)", () => {
  it("throws the adapter's configuration hint on upload", async () => {
    const adapter = fakeAdapter({ enabled: false });
    storage.setStorageAdapter(adapter);

    await expect(
      storage.uploadFile("k", new ArrayBuffer(1), "text/plain"),
    ).rejects.toThrow("FAKE_STORAGE_URL must be set");
    expect(adapter.uploadFile).not.toHaveBeenCalled();
  });

  it("returns null/empty for reads and skips deletes", async () => {
    const adapter = fakeAdapter({ enabled: false });
    storage.setStorageAdapter(adapter);

    await expect(storage.downloadFile("k")).resolves.toBeNull();
    await expect(storage.listFiles("pre/")).resolves.toEqual([]);
    await expect(storage.getSignedUrl("k")).resolves.toBeNull();
    await expect(storage.deleteFile("k")).resolves.toBeUndefined();
    expect(adapter.downloadFile).not.toHaveBeenCalled();
    expect(adapter.deleteFile).not.toHaveBeenCalled();
  });

  it("logs and swallows adapter failures on download and signing", async () => {
    const adapter = fakeAdapter({
      downloadFile: vi.fn(async () => {
        throw new Error("boom");
      }),
      getSignedUrl: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    storage.setStorageAdapter(adapter);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(storage.downloadFile("k")).resolves.toBeNull();
    await expect(storage.getSignedUrl("k")).resolves.toBeNull();
    expect(log).toHaveBeenCalledTimes(2);
    log.mockRestore();
  });
});
