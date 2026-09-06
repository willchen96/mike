import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  checkProjectAccess: vi.fn(),
  ensureMemoryFile: vi.fn(),
  getMemoryCurrent: vi.fn(),
  listMemoryVersions: vi.fn(),
  memoryVersionContent: vi.fn(),
  restoreMemoryVersion: vi.fn(),
  wipeMemoryFile: vi.fn(),
  writeMemoryFile: vi.fn(),
  enableMemoryFile: vi.fn(),
}));

vi.mock("../../middleware/auth", () => ({
  requireAuth: (
    _req: unknown,
    res: { locals: Record<string, unknown> },
    next: () => void,
  ) => {
    res.locals.userId = "00000000-0000-4000-8000-000000000001";
    res.locals.userEmail = "user@example.com";
    next();
  },
}));

vi.mock("../../lib/supabase", () => ({
  createServerSupabase: () => ({ marker: "db" }),
}));

vi.mock("../../lib/access", () => ({
  checkProjectAccess: (...args: unknown[]) => mocks.checkProjectAccess(...args),
}));

vi.mock("../../lib/memory/files", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../lib/memory/files")>();
  return {
    ...original,
    ensureMemoryFile: (...args: unknown[]) => mocks.ensureMemoryFile(...args),
    getMemoryCurrent: (...args: unknown[]) => mocks.getMemoryCurrent(...args),
    listMemoryVersions: (...args: unknown[]) =>
      mocks.listMemoryVersions(...args),
    memoryVersionContent: (...args: unknown[]) =>
      mocks.memoryVersionContent(...args),
    restoreMemoryVersion: (...args: unknown[]) =>
      mocks.restoreMemoryVersion(...args),
    wipeMemoryFile: (...args: unknown[]) => mocks.wipeMemoryFile(...args),
    writeMemoryFile: (...args: unknown[]) => mocks.writeMemoryFile(...args),
    enableMemoryFile: (...args: unknown[]) => mocks.enableMemoryFile(...args),
  };
});

import { projectMemoryRouter, userMemoryRouter } from "../../routes/memory";
import { MemoryVersionConflictError } from "../../lib/memory/files";

const file = {
  id: "00000000-0000-4000-8000-000000000010",
  scope: "user" as const,
  user_id: "00000000-0000-4000-8000-000000000001",
  project_id: null,
  enabled: true,
  epoch: 0,
  version: 2,
  learning_cutoff_at: "2026-09-05T00:00:00.000Z",
  current_version_id: "00000000-0000-4000-8000-000000000011",
  status: "idle" as const,
  last_error_code: null,
  last_source: null,
  updated_by: null,
  created_at: "2026-09-05T00:00:00.000Z",
  updated_at: "2026-09-05T00:00:00.000Z",
};

const current = {
  enabled: true,
  content: "# Memory",
  version: 2,
  hash: "a".repeat(64),
  updated_at: "2026-09-05T00:00:00.000Z",
  updated_by: "00000000-0000-4000-8000-000000000001",
  status: "idle" as const,
};

function testApp() {
  const app = express();
  app.use(express.json());
  app.use("/user/memory", userMemoryRouter);
  app.use("/projects/:projectId/memory", projectMemoryRouter);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.ensureMemoryFile.mockResolvedValue(file);
  mocks.getMemoryCurrent.mockResolvedValue({ current, file });
  mocks.writeMemoryFile.mockResolvedValue({ current, applied: true });
  mocks.wipeMemoryFile.mockResolvedValue({
    ...current,
    content: "",
    version: 0,
    hash: null,
    updated_at: null,
    updated_by: null,
  });
  mocks.enableMemoryFile.mockResolvedValue(current);
  mocks.listMemoryVersions.mockResolvedValue([]);
  mocks.memoryVersionContent.mockResolvedValue("# Earlier memory");
  mocks.restoreMemoryVersion.mockResolvedValue(current);
  mocks.checkProjectAccess.mockResolvedValue({
    ok: true,
    projectRole: "owner",
  });
});

describe("scoped memory routes", () => {
  it("returns the locked snake_case current representation", async () => {
    const response = await request(testApp()).get("/user/memory").expect(200);
    expect(response.body).toEqual(current);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(mocks.ensureMemoryFile).toHaveBeenCalledWith(
      expect.anything(),
      "user",
      "00000000-0000-4000-8000-000000000001",
      true,
    );
  });

  it("uses expected_version CAS and returns the current value on conflict", async () => {
    mocks.writeMemoryFile.mockRejectedValueOnce(
      new MemoryVersionConflictError("changed"),
    );
    const response = await request(testApp())
      .put("/user/memory")
      .send({ content: "next", expected_version: 2 })
      .expect(409);
    expect(response.body).toMatchObject({
      code: "memory_version_conflict",
      current,
    });
  });

  it("destructively disables but DELETE preserves the enable state", async () => {
    await request(testApp())
      .patch("/user/memory/settings")
      .send({ enabled: false })
      .expect(200);
    expect(mocks.wipeMemoryFile).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false }),
    );

    await request(testApp()).delete("/user/memory").expect(200);
    expect(mocks.wipeMemoryFile).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: null }),
    );
  });

  it("allows project viewers to read but only editors to write", async () => {
    mocks.checkProjectAccess.mockResolvedValue({
      ok: true,
      projectRole: "viewer",
    });
    const base = "/projects/00000000-0000-4000-8000-000000000020/memory";
    const versionId = "00000000-0000-4000-8000-000000000021";

    await request(testApp()).get(base).expect(200);
    await request(testApp()).get(`${base}/versions`).expect(200);
    await request(testApp())
      .get(`${base}/versions/${versionId}/memory.md`)
      .expect(200);
    await request(testApp())
      .put(base)
      .send({ content: "next", expected_version: 2 })
      .expect(403);
    await request(testApp())
      .post(`${base}/versions/${versionId}/restore`)
      .send({ expected_version: 2 })
      .expect(403);
    await request(testApp())
      .patch(`${base}/settings`)
      .send({ enabled: false })
      .expect(403);
    await request(testApp()).delete(base).expect(403);

    expect(mocks.memoryVersionContent).toHaveBeenCalledOnce();
    expect(mocks.writeMemoryFile).not.toHaveBeenCalled();
    expect(mocks.restoreMemoryVersion).not.toHaveBeenCalled();
    expect(mocks.wipeMemoryFile).not.toHaveBeenCalled();
  });

  it("opens a project's first memory file enabled", async () => {
    mocks.checkProjectAccess.mockResolvedValue({
      ok: true,
      projectRole: "viewer",
    });
    const projectId = "00000000-0000-4000-8000-000000000020";

    await request(testApp()).get(`/projects/${projectId}/memory`).expect(200);

    // Project memory is on by default: a project whose row predates the
    // memory tables must not be created opted out by the first read.
    expect(mocks.ensureMemoryFile).toHaveBeenCalledWith(
      { marker: "db" },
      "project",
      projectId,
      true,
    );
    expect(mocks.getMemoryCurrent).toHaveBeenCalledWith(
      { marker: "db" },
      "project",
      projectId,
      true,
    );
  });

  it("returns 404 for every project operation when access is absent", async () => {
    mocks.checkProjectAccess.mockResolvedValue({ ok: false, status: 404 });
    const base = "/projects/00000000-0000-4000-8000-000000000020/memory";
    const versionId = "00000000-0000-4000-8000-000000000021";

    await request(testApp()).get(base).expect(404);
    await request(testApp()).get(`${base}/versions`).expect(404);
    await request(testApp())
      .put(base)
      .send({ content: "next", expected_version: 2 })
      .expect(404);
    await request(testApp())
      .post(`${base}/versions/${versionId}/restore`)
      .send({ expected_version: 2 })
      .expect(404);
    await request(testApp())
      .patch(`${base}/settings`)
      .send({ enabled: false })
      .expect(404);
    await request(testApp()).delete(base).expect(404);

    expect(mocks.writeMemoryFile).not.toHaveBeenCalled();
    expect(mocks.restoreMemoryVersion).not.toHaveBeenCalled();
    expect(mocks.wipeMemoryFile).not.toHaveBeenCalled();
  });

  it("lets editors edit and restore but reserves destructive controls for owners", async () => {
    mocks.checkProjectAccess.mockResolvedValue({
      ok: true,
      projectRole: "editor",
    });
    const base = "/projects/00000000-0000-4000-8000-000000000020/memory";
    const versionId = "00000000-0000-4000-8000-000000000021";

    await request(testApp())
      .put(base)
      .send({ content: "next", expected_version: 2 })
      .expect(200);
    await request(testApp())
      .post(`${base}/versions/${versionId}/restore`)
      .send({ expected_version: 2 })
      .expect(200);
    await request(testApp())
      .patch(`${base}/settings`)
      .send({ enabled: false })
      .expect(403);
    await request(testApp()).delete(base).expect(403);

    expect(mocks.writeMemoryFile).toHaveBeenCalledOnce();
    expect(mocks.restoreMemoryVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        file,
        versionId,
        expectedVersion: 2,
      }),
    );
    expect(mocks.wipeMemoryFile).not.toHaveBeenCalled();
  });

  it("allows project owners to disable and wipe shared memory", async () => {
    const base = "/projects/00000000-0000-4000-8000-000000000020/memory";

    await request(testApp())
      .patch(`${base}/settings`)
      .send({ enabled: false })
      .expect(200);
    await request(testApp()).delete(base).expect(200);

    expect(mocks.wipeMemoryFile).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ enabled: false, source: "settings" }),
    );
    expect(mocks.wipeMemoryFile).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ enabled: null, source: "wipe" }),
    );
  });

  it("binds version reads to the authorized memory file", async () => {
    const versionId = "00000000-0000-4000-8000-000000000021";
    const response = await request(testApp())
      .get(`/user/memory/versions/${versionId}/memory.md`)
      .expect(200);

    expect(response.text).toBe("# Earlier memory");
    expect(mocks.memoryVersionContent).toHaveBeenCalledWith(
      expect.anything(),
      file.id,
      versionId,
    );
  });

  it("rejects malformed version IDs without querying storage metadata", async () => {
    await request(testApp())
      .get("/user/memory/versions/not-a-uuid/memory.md")
      .expect(404);
    await request(testApp())
      .post("/user/memory/versions/not-a-uuid/restore")
      .send({ expected_version: 2 })
      .expect(404);

    expect(mocks.memoryVersionContent).not.toHaveBeenCalled();
    expect(mocks.restoreMemoryVersion).not.toHaveBeenCalled();
  });

  it("serves literal Markdown as an attachment", async () => {
    const response = await request(testApp())
      .get("/user/memory/memory.md")
      .expect(200);
    expect(response.headers["content-type"]).toMatch(/^text\/markdown/);
    expect(response.headers["content-disposition"]).toBe(
      'attachment; filename="memory.md"',
    );
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.text).toBe("# Memory");
  });
});
