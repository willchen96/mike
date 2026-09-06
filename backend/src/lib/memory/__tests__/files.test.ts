import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { assertStorageConfigured, uploadFile, downloadFileStrict, deleteFile } =
  vi.hoisted(() => ({
    assertStorageConfigured: vi.fn(),
    uploadFile: vi.fn(),
    downloadFileStrict: vi.fn(),
    deleteFile: vi.fn(),
  }));

vi.mock("../../storage", () => ({
  assertStorageConfigured: (...args: unknown[]) =>
    assertStorageConfigured(...args),
  uploadFile: (...args: unknown[]) => uploadFile(...args),
  downloadFileStrict: (...args: unknown[]) => downloadFileStrict(...args),
  deleteFile: (...args: unknown[]) => deleteFile(...args),
}));

import {
  ensureMemoryFile,
  memoryVersionContent,
  normalizeMemoryMarkdown,
  wipeMemoryFile,
  writeMemoryFile,
  type MemoryFileRow,
} from "../files";

const file: MemoryFileRow = {
  id: "file-1",
  scope: "user",
  user_id: "user-1",
  project_id: null,
  enabled: true,
  epoch: 9,
  version: 3,
  current_version_id: "version-3",
  status: "idle",
  last_error_code: null,
  learning_cutoff_at: "2026-09-05T00:00:00.000Z",
  last_source: null,
  updated_by: null,
  created_at: "2026-09-05T00:00:00.000Z",
  updated_at: "2026-09-05T00:00:00.000Z",
};

function query(result: unknown) {
  const builder: Record<string, unknown> = {};
  for (const name of ["select", "eq", "order", "limit", "delete", "update", "in"]) {
    builder[name] = () => builder;
  }
  builder.maybeSingle = async () => ({ data: result, error: null });
  builder.single = async () => ({ data: result, error: null });
  return builder;
}

beforeEach(() => {
  vi.clearAllMocks();
  assertStorageConfigured.mockReturnValue(undefined);
  deleteFile.mockResolvedValue(undefined);
});

describe("memory object durability and integrity", () => {
  it("creates a missing project memory file enabled by default", async () => {
    const projectFile: MemoryFileRow = {
      ...file,
      id: "project-file-1",
      scope: "project",
      user_id: null,
      project_id: "project-1",
      current_version_id: null,
      version: 0,
    };
    const maybeSingle = vi
      .fn()
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: projectFile, error: null });
    const builder: Record<string, ReturnType<typeof vi.fn>> = {};
    builder.select = vi.fn(() => builder);
    builder.eq = vi.fn(() => builder);
    builder.upsert = vi.fn(() => builder);
    builder.maybeSingle = maybeSingle;
    const db = { from: vi.fn(() => builder) };

    await expect(
      ensureMemoryFile(db as never, "project", "project-1"),
    ).resolves.toEqual(projectFile);
    expect(builder.upsert).toHaveBeenCalledWith(
      {
        scope: "project",
        project_id: "project-1",
        enabled: true,
      },
      { onConflict: "project_id", ignoreDuplicates: true },
    );
  });

  it("rejects executable HTML but preserves Markdown hard breaks", () => {
    expect(normalizeMemoryMarkdown("first  \r\nsecond   \n")).toBe(
      "first  \nsecond  \n",
    );
    expect(() => normalizeMemoryMarkdown('<img src="x" onerror="run()">'))
      .toThrow("content contains executable HTML");
    expect(() => normalizeMemoryMarkdown("<script>alert(1)</script>"))
      .toThrow("content contains executable HTML");
    expect(() => normalizeMemoryMarkdown('<a href="javascript:run()">x</a>'))
      .toThrow("content contains executable HTML");
  });

  it("persists a candidate and cleanup job before attempting the object PUT", async () => {
    const old = "# Old";
    const oldHash = createHash("sha256").update(old).digest("hex");
    const rpc = vi.fn(async (name: string) => {
      if (name === "begin_memory_file_upload") {
        return { data: [{ candidate_id: "candidate" }], error: null };
      }
      throw new Error(`unexpected RPC ${name}`);
    });
    const db = {
      rpc,
      from: vi.fn((table: string) => {
        if (table === "memory_files") return query(file);
        if (table === "memory_file_versions") {
          return query({
            id: "version-3",
            memory_file_id: file.id,
            version: 3,
            storage_path: "old.md",
            size_bytes: old.length,
            content_sha256: oldHash,
            source: "manual",
            updated_by: null,
            model: null,
            source_surface: null,
            source_chat_id: null,
            source_turn_id: null,
            source_job_id: null,
            created_at: file.updated_at,
          });
        }
        throw new Error(`unexpected table ${table}`);
      }),
    };
    downloadFileStrict.mockResolvedValue(Buffer.from(old));
    uploadFile.mockRejectedValueOnce(new Error("ambiguous provider failure"));

    await expect(
      writeMemoryFile({
        db: db as never,
        file,
        content: "# New",
        expectedVersion: 3,
        expectedEpoch: 9,
        source: "curator",
        updatedBy: "user-1",
      }),
    ).rejects.toThrow("Failed to upload memory");
    expect(rpc.mock.calls[0]?.[0]).toBe("begin_memory_file_upload");
    expect(uploadFile).toHaveBeenCalledTimes(1);
    expect(rpc).not.toHaveBeenCalledWith("advance_memory_file", expect.anything());
  });

  it("retains the durable candidate pointer when storage configuration disappears", async () => {
    const old = "# Old";
    const oldHash = createHash("sha256").update(old).digest("hex");
    const candidateDelete = vi.fn(async () => ({ data: null, error: null }));
    const rpc = vi.fn(async (name: string) => {
      if (name === "begin_memory_file_upload") {
        return { data: [{ candidate_id: "candidate" }], error: null };
      }
      if (name === "advance_memory_file") {
        return {
          data: null,
          error: { message: "memory_version_conflict" },
        };
      }
      throw new Error(`unexpected RPC ${name}`);
    });
    const db = {
      rpc,
      from: vi.fn((table: string) => {
        if (table === "memory_files") return query(file);
        if (table === "memory_file_versions") {
          return query({
            id: "version-3",
            memory_file_id: file.id,
            version: 3,
            storage_path: "old.md",
            size_bytes: old.length,
            content_sha256: oldHash,
            source: "manual",
            updated_by: null,
            model: null,
            source_surface: null,
            source_chat_id: null,
            source_turn_id: null,
            source_job_id: null,
            created_at: file.updated_at,
          });
        }
        if (table === "memory_object_candidates") {
          return {
            update: () => ({
              eq: () => ({
                in: () => ({
                  select: () => ({
                    maybeSingle: async () => ({
                      data: { id: "candidate" },
                      error: null,
                    }),
                  }),
                }),
              }),
            }),
            delete: () => ({ eq: candidateDelete }),
          };
        }
        throw new Error(`unexpected table ${table}`);
      }),
    };
    downloadFileStrict.mockResolvedValue(Buffer.from(old));
    uploadFile.mockResolvedValue(undefined);
    assertStorageConfigured.mockImplementationOnce(() => {
      throw new Error("Object storage is not configured");
    });

    await expect(
      writeMemoryFile({
        db: db as never,
        file,
        content: "# New",
        expectedVersion: 3,
        expectedEpoch: 9,
        source: "manual",
        updatedBy: "user-1",
      }),
    ).rejects.toThrow("Memory version changed");

    expect(assertStorageConfigured).toHaveBeenCalledOnce();
    expect(deleteFile).not.toHaveBeenCalled();
    expect(candidateDelete).not.toHaveBeenCalled();
  });

  it("rejects corrupt historical objects before download or restore can use them", async () => {
    const db = {
      from: vi.fn(() =>
        query({
          id: "version-old",
          memory_file_id: file.id,
          version: 2,
          storage_path: "old.md",
          size_bytes: 7,
          content_sha256: "not-the-real-hash",
          source: "manual",
          updated_by: null,
          model: null,
          source_surface: null,
          source_chat_id: null,
          source_turn_id: null,
          source_job_id: null,
          created_at: file.updated_at,
        }),
      ),
    };
    downloadFileStrict.mockResolvedValue(Buffer.from("tampered"));
    await expect(
      memoryVersionContent(db as never, file.id, "version-old"),
    ).rejects.toThrow("Memory object checksum mismatch");
  });

  it("uses the lock-resolved enable state and monotonic CAS token after wipe", async () => {
    const db = {
      rpc: vi.fn(async () => ({
        data: [
          {
            storage_paths: [],
            new_epoch: 10,
            new_version: 4,
            effective_enabled: false,
          },
        ],
        error: null,
      })),
    };
    const current = await wipeMemoryFile({
      db: db as never,
      file,
      enabled: null,
      updatedBy: "user-1",
    });
    expect(current).toMatchObject({ enabled: false, version: 4, content: "" });
    expect(db.rpc).toHaveBeenCalledWith("wipe_memory_file", {
      p_memory_file_id: file.id,
      p_enabled: null,
      p_updated_by: "user-1",
      p_source: "wipe",
      p_require_no_candidates: false,
    });
  });

  it("deletes only immutable object paths captured by the durable wipe", async () => {
    const db = {
      rpc: vi.fn(async () => ({
        data: [
          {
            storage_paths: ["memories/users/user-1/versions/known/memory.md"],
            new_epoch: 10,
            new_version: 4,
            effective_enabled: true,
          },
        ],
        error: null,
      })),
    };
    await wipeMemoryFile({
      db: db as never,
      file,
      enabled: null,
      updatedBy: "user-1",
    });
    expect(deleteFile).toHaveBeenCalledOnce();
    expect(deleteFile).toHaveBeenCalledWith(
      "memories/users/user-1/versions/known/memory.md",
    );
  });

  it("does not acknowledge object erasure when the queue is disabled", async () => {
    const previous = process.env.DB_JOBS_ENABLED;
    process.env.DB_JOBS_ENABLED = "false";
    const db = {
      rpc: vi.fn(async () => ({
        data: [{ storage_paths: [], new_epoch: 10, new_version: 4 }],
        error: null,
      })),
    };
    try {
      await expect(
        wipeMemoryFile({
          db: db as never,
          file,
          enabled: false,
          updatedBy: "user-1",
        }),
      ).rejects.toThrow("Memory persistence is unavailable");
      expect(db.rpc).not.toHaveBeenCalled();
      expect(deleteFile).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.DB_JOBS_ENABLED;
      else process.env.DB_JOBS_ENABLED = previous;
    }
  });
});
