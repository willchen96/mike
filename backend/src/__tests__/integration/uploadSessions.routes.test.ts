import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  getSignedUploadUrl: vi.fn(),
  ensureDocAccess: vi.fn(),
  /** The row the `documents` read answers with. */
  documentRow: { data: null as unknown, error: null as unknown },
}));

vi.mock("../../middleware/auth", () => ({
  requireAuth: (
    _req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    res.locals.userId = "11111111-1111-4111-8111-111111111111";
    res.locals.userEmail = "owner@example.com";
    next();
  },
}));

vi.mock("../../lib/supabase", () => ({
  createServerSupabase: () => ({
    rpc: mocks.rpc,
    // Enough of a builder for the destination checks: they read one row and
    // then hand the verdict to lib/access.
    from: () => {
      const query: Record<string, unknown> = {};
      for (const method of ["select", "eq", "in", "is", "order", "limit"])
        query[method] = () => query;
      query.maybeSingle = async () => mocks.documentRow;
      query.single = query.maybeSingle;
      query.then = (resolve: (value: unknown) => unknown) =>
        Promise.resolve({ data: [], error: null }).then(resolve);
      return query;
    },
  }),
}));

// Only the verdict is stubbed. creatorScopedAllowed and `can` stay real,
// because the rule under test is how those two combine.
vi.mock("../../lib/access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/access")>()),
  ensureDocAccess: (...args: unknown[]) => mocks.ensureDocAccess(...args),
}));

vi.mock("../../lib/storage", () => ({
  storageEnabled: true,
  getSignedUploadUrl: mocks.getSignedUploadUrl,
  copyFile: vi.fn(),
  deleteFile: vi.fn(),
  headFile: vi.fn(),
}));

import { uploadSessionsRouter } from "../../routes/uploadSessions";

const app = express();
app.use(express.json());
app.use("/upload-sessions", uploadSessionsRouter);

function manifest(fileCount = 1) {
  return {
    purpose: "document_create",
    destination: { scope: "standalone" },
    files: Array.from({ length: fileCount }, (_, index) => ({
      client_id: `client-${index}`,
      filename: `contract-${index}.pdf`,
      size_bytes: 1234,
    })),
  };
}

describe("upload session routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rpc.mockResolvedValue({ error: null });
    mocks.getSignedUploadUrl.mockResolvedValue("https://upload.example/signed");
  });

  it("creates one atomic session reservation and returns direct PUT URLs", async () => {
    const response = await request(app)
      .post("/upload-sessions")
      .send(manifest(2));

    expect(response.status).toBe(201);
    expect(response.body.session).toMatchObject({
      expected_file_count: 2,
      expected_total_bytes: 2468,
      status: "pending_upload",
    });
    expect(response.body.files).toHaveLength(2);
    expect(response.body.files[0].upload).toMatchObject({
      method: "PUT",
      headers: { "Content-Type": "application/pdf" },
    });
    expect(mocks.rpc).toHaveBeenCalledOnce();
    expect(mocks.rpc).toHaveBeenCalledWith(
      "create_upload_session",
      expect.objectContaining({ target_hourly_session_limit: 50 }),
    );
    expect(mocks.getSignedUploadUrl).toHaveBeenCalledTimes(2);
    // The declared byte count is signed into the URL; the browser supplies the
    // matching Content-Length itself, so it is not echoed in the descriptor.
    expect(mocks.getSignedUploadUrl).toHaveBeenCalledWith(
      expect.any(String),
      "application/pdf",
      1234,
      expect.any(Number),
    );
    expect(response.body.files[0].upload.headers).not.toHaveProperty(
      "Content-Length",
    );
  });

  it("rejects more than 50 files without touching the database or storage", async () => {
    const response = await request(app)
      .post("/upload-sessions")
      .send(manifest(51));

    expect(response.status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.getSignedUploadUrl).not.toHaveBeenCalled();
  });

  it("rejects unsupported file extensions before reserving a session", async () => {
    const requestBody = manifest();
    requestBody.files[0].filename = "notes.txt";

    const response = await request(app)
      .post("/upload-sessions")
      .send(requestBody);

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      code: "invalid_upload_session",
      detail: expect.stringContaining("Unsupported file type: txt"),
    });
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.getSignedUploadUrl).not.toHaveBeenCalled();
  });

  it("returns an explicit 413 when a declared file exceeds 100 MB", async () => {
    const requestBody = manifest();
    requestBody.files[0].size_bytes = 100 * 1024 * 1024 + 1;

    const response = await request(app)
      .post("/upload-sessions")
      .send(requestBody);

    expect(response.status).toBe(413);
    expect(response.body.code).toBe("upload_file_too_large");
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.getSignedUploadUrl).not.toHaveBeenCalled();
  });

  it("blocks a concurrent upload that targets the same mutable item", async () => {
    mocks.rpc.mockResolvedValue({ error: { message: "upload_target_busy" } });

    const response = await request(app)
      .post("/upload-sessions")
      .send(manifest());

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("upload_target_busy");
    expect(mocks.getSignedUploadUrl).not.toHaveBeenCalled();
  });

  it("applies the upload rate limit to sessions instead of individual files", async () => {
    mocks.rpc.mockResolvedValue({
      error: { message: "upload_session_rate_limit_exceeded" },
    });

    const response = await request(app)
      .post("/upload-sessions")
      .send(manifest(50));

    expect(response.status).toBe(429);
    expect(response.body.code).toBe("upload_session_rate_limit_exceeded");
    expect(mocks.rpc).toHaveBeenCalledOnce();
    expect(mocks.getSignedUploadUrl).not.toHaveBeenCalled();
  });

  it("returns 404 for an invalid session id before querying the database", async () => {
    const response = await request(app).get("/upload-sessions/not-a-uuid");

    expect(response.status).toBe(404);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// validateDestinationAccess — the version-upload destination.
//
// This branch collapsed "you cannot see this document" and "you may see it
// but not write to it" into the same 404, so a Viewer who tried to add a
// version was told their document had disappeared — while it went on
// rendering in the list behind the dialog. The project branch above already
// splits the two; this one now does too.
// ---------------------------------------------------------------------------

const DOCUMENT_ID = "33333333-3333-4333-8333-333333333333";
const VERSION_ID = "44444444-4444-4444-8444-444444444444";

function versionManifest(
  purpose: "document_version_create" | "document_version_replace",
) {
  return {
    purpose,
    destination:
      purpose === "document_version_replace"
        ? { document_id: DOCUMENT_ID, version_id: VERSION_ID }
        : { document_id: DOCUMENT_ID },
    files: [
      {
        client_id: "client-0",
        filename: "contract.pdf",
        size_bytes: 1234,
      },
    ],
  };
}

describe("upload session destination access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rpc.mockResolvedValue({ error: null });
    mocks.getSignedUploadUrl.mockResolvedValue("https://upload.example/signed");
    mocks.documentRow = {
      data: {
        id: DOCUMENT_ID,
        // A colleague's document in a shared matter.
        user_id: "22222222-2222-4222-8222-222222222222",
        project_id: "p1",
        org_id: "o1",
        workflow_id: null,
      },
      error: null,
    };
  });

  it("refuses a viewer by name instead of hiding the document", async () => {
    mocks.ensureDocAccess.mockResolvedValue({
      ok: true,
      isCreator: false,
      orgRole: "member",
      projectRole: "viewer",
    });

    const response = await request(app)
      .post("/upload-sessions")
      .send(versionManifest("document_version_create"));

    expect(response.status).toBe(403);
    expect(response.body.detail).toBe(
      "You do not have permission to edit content in this project.",
    );
    // No session was reserved and no upload URL was minted.
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.getSignedUploadUrl).not.toHaveBeenCalled();
  });

  it("keeps 404 for a caller with no verdict at all", async () => {
    // A non-member must not be able to tell an existing document from a
    // missing one, so this half of the split stays a 404.
    mocks.ensureDocAccess.mockResolvedValue({ ok: false });

    const response = await request(app)
      .post("/upload-sessions")
      .send(versionManifest("document_version_create"));

    expect(response.status).toBe(404);
    expect(response.body.detail).toBe("Document not found");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("names the narrower rule when an editor may write but not replace", async () => {
    // Replacing a version is creator-scoped; editing content is not. Two
    // different refusals, so they say two different things.
    mocks.ensureDocAccess.mockResolvedValue({
      ok: true,
      isCreator: false,
      orgRole: "member",
      projectRole: "editor",
    });

    const response = await request(app)
      .post("/upload-sessions")
      .send(versionManifest("document_version_replace"));

    expect(response.status).toBe(403);
    expect(response.body.detail).toBe(
      "You do not have permission to replace this version.",
    );
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("lets an editor open a version-create session", async () => {
    mocks.ensureDocAccess.mockResolvedValue({
      ok: true,
      isCreator: false,
      orgRole: "member",
      projectRole: "editor",
    });

    const response = await request(app)
      .post("/upload-sessions")
      .send(versionManifest("document_version_create"));

    expect(response.status).toBe(201);
    expect(mocks.rpc).toHaveBeenCalledOnce();
  });
});
