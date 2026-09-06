import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

// ---------------------------------------------------------------------------
// Hoisted mock fns we want to reconfigure per-test.
// ---------------------------------------------------------------------------
const { checkProjectAccess, deleteProjectsByIds } = vi.hoisted(() => ({
    checkProjectAccess: vi.fn(),
    deleteProjectsByIds: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Configurable Supabase stub. Each test seeds `supabaseState` in beforeEach;
// terminal query operations (.single()/.maybeSingle()/thenable) resolve to the
// per-table result, and rpc() resolves to a per-call result. Insert payloads
// are recorded so tests can assert on normalisation (lowercasing / dedupe).
// ---------------------------------------------------------------------------
type QueryResult = { data: unknown; error: unknown };

let supabaseState: {
    rpc: QueryResult;
    tables: Record<string, QueryResult>;
    inserts: { table: string; payload: unknown }[];
};

function resetSupabaseState() {
    supabaseState = {
        rpc: { data: [], error: null },
        tables: {},
        inserts: [],
    };
}
resetSupabaseState();

function resultForTable(table: string): QueryResult {
    return supabaseState.tables[table] ?? { data: null, error: null };
}

function makeQuery(table: string) {
    const q: Record<string, unknown> = {};
    const chain = [
    "select",
    "update",
    "delete",
    "upsert",
    "eq",
    "neq",
    "in",
    "is",
    "or",
    "not",
    "lt",
    "gt",
    "gte",
    "lte",
    "filter",
    "order",
    "limit",
    "range",
    "contains",
    ];
    for (const m of chain) q[m] = vi.fn(() => q);
    q.insert = vi.fn((payload: unknown) => {
        supabaseState.inserts.push({ table, payload });
        return q;
    });
    q.single = vi.fn(() => Promise.resolve(resultForTable(table)));
    q.maybeSingle = vi.fn(() => Promise.resolve(resultForTable(table)));
  q.then = (
    resolve: (v: unknown) => unknown,
    reject?: (e: unknown) => unknown,
  ) => Promise.resolve(resultForTable(table)).then(resolve, reject);
    return q;
}

function mockSupabase() {
    return {
        from: vi.fn((table: string) => makeQuery(table)),
        rpc: vi.fn(() => Promise.resolve(supabaseState.rpc)),
        auth: {
            getUser: () =>
                Promise.resolve({ data: { user: { id: "u1" } }, error: null }),
        },
    };
}

vi.mock("../../lib/supabase", () => ({
    createServerSupabase: vi.fn(() => mockSupabase()),
}));

vi.mock("../../middleware/auth", () => ({
    requireAuth: (
        _req: unknown,
        res: { locals: Record<string, unknown> },
        next: () => void,
    ) => {
        res.locals.userId = "u1";
        res.locals.userEmail = "u1@test.local";
        next();
    },
    requireMfaIfEnrolled: (_req: unknown, _res: unknown, next: () => void) =>
        next(),
}));

// Every export of lib/access must be present — other routers (chat, documents,
// downloads, tabular) import from it at app load.
vi.mock("../../lib/access", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../lib/access")>()),
    checkProjectAccess: (...args: unknown[]) => checkProjectAccess(...args),
    ensureDocAccess: vi.fn(async () => ({ ok: true, isOwner: true })),
    ensureReviewAccess: vi.fn(async () => ({ ok: true, isOwner: true })),
    filterAccessibleDocumentIds: vi.fn(async (ids: string[]) => ids),
    listAccessibleProjectIds: vi.fn(async () => []),
    getOrgRole: vi.fn(async () => null),
    resolveContentOrgId: vi.fn(async () => null),
}));

// user router imports all four cleanup helpers at module load.
vi.mock("../../lib/userDataCleanup", () => ({
    deleteProjectsByIds: (...args: unknown[]) => deleteProjectsByIds(...args),
    deleteAllUserChats: vi.fn(async () => {}),
    deleteAllUserTabularReviews: vi.fn(async () => {}),
    deleteUserAccountData: vi.fn(async () => {}),
}));

// Version-path enrichment hits the DB in real life; no-op it so the route
// responses are driven purely by the documents/projects table stubs.
vi.mock("../../lib/documentVersions", () => ({
    attachActiveVersionPaths: vi.fn(async () => {}),
    attachLatestVersionNumbers: vi.fn(async () => {}),
    contentSha256: vi.fn(() => "0".repeat(64)),
    loadActiveVersion: vi.fn(async () => null),
}));

import { app } from "../../app";
import crypto from "crypto";
import { manifestPublicKey } from "../../lib/manifestSigning";
import { createServerSupabase } from "../../lib/supabase";

const SIGNING_KEY = "3b".repeat(32);

const AUTH = ["Authorization", "Bearer test"] as const;

// Wraps mockSupabase()'s rpc so the next request's exact RPC call args can be
// asserted on — the shared mock otherwise only lets tests control the
// *response*, not inspect what was sent.
function captureRpcArgs(): { args: unknown; name: string | undefined } {
  const captured: { args: unknown; name: string | undefined } = {
    args: undefined,
    name: undefined,
  };
    vi.mocked(createServerSupabase).mockImplementationOnce(() => {
        const db = mockSupabase();
        const originalRpc = db.rpc;
        db.rpc = vi.fn((name: string, args: unknown) => {
      captured.name = name;
            captured.args = args;
            return originalRpc(name, args as never);
        });
        return db as unknown as ReturnType<typeof createServerSupabase>;
    });
    return captured;
}

describe("projects.routes", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetSupabaseState();
        checkProjectAccess.mockResolvedValue({
            ok: true,
            isCreator: true,
            orgRole: null,
            projectRole: "owner",
            project: { id: "p1", user_id: "u1", org_id: null },
        });
        deleteProjectsByIds.mockResolvedValue(1);
    });

    // ── GET /projects (overview) ──────────────────────────────────────────
    describe("GET /projects", () => {
        it("returns the overview rows from the RPC", async () => {
            supabaseState.rpc = {
                data: [
                    {
                        id: "p1",
                        name: "Alpha",
                        org_id: "org-1",
                        access_scope: "organization",
                        organization_name: "Elite Law LLP",
                    },
                ],
                error: null,
            };

      const res = await request(app)
        .get("/projects")
        .set(...AUTH);

            expect(res.status).toBe(200);
            expect(res.body).toEqual([
                {
                    id: "p1",
                    name: "Alpha",
                    org_id: "org-1",
                    access_scope: "organization",
                    organization_name: "Elite Law LLP",
                    memory_enabled: true,
                },
            ]);
        });

        it("backfills organization access when the overview RPC is stale", async () => {
            supabaseState.rpc = {
                data: [{ id: "p1", name: "Firm matter", is_owner: true }],
                error: null,
            };
            supabaseState.tables.projects = {
                data: [{ id: "p1", org_id: "org-1" }],
                error: null,
            };
            supabaseState.tables.project_access_grants = {
                data: [],
                error: null,
            };
            supabaseState.tables.organizations = {
                data: [{ id: "org-1", name: "Elite Law LLP" }],
                error: null,
            };

            const res = await request(app).get("/projects").set(...AUTH);

            expect(res.status).toBe(200);
            expect(res.body).toEqual([
                {
                    id: "p1",
                    name: "Firm matter",
                    is_owner: true,
                    org_id: "org-1",
                    access_scope: "organization",
                    organization_name: "Elite Law LLP",
                    memory_enabled: true,
                },
            ]);
        });

        it("includes documents and subfolders in the batched directory response", async () => {
            supabaseState.rpc = {
                data: [{ id: "p1", name: "Alpha" }],
                error: null,
            };
            supabaseState.tables.documents = {
                data: [
                    {
                        id: "d1",
                        project_id: "p1",
                        folder_id: "f1",
                        filename: "Agreement.pdf",
                    },
                ],
                error: null,
            };
            supabaseState.tables.project_subfolders = {
                data: [
                    {
                        id: "f1",
                        project_id: "p1",
                        parent_folder_id: null,
                        name: "Closing",
                    },
                ],
                error: null,
            };

            const res = await request(app)
                .get("/projects?include=documents")
                .set(...AUTH);

            expect(res.status).toBe(200);
            expect(res.body[0]).toMatchObject({
                id: "p1",
                documents: [{ id: "d1", folder_id: "f1" }],
                folders: [{ id: "f1", name: "Closing" }],
            });
        });

        it("returns 500 with detail when the RPC errors", async () => {
            supabaseState.rpc = { data: null, error: { message: "boom" } };

      const res = await request(app)
        .get("/projects")
        .set(...AUTH);

            expect(res.status).toBe(500);
            expect(res.body.detail).toBe("Something went wrong. Please try again.");
        });

    // Regression guard: legacy project pickers call GET /projects with no
    // query params and need the full, unpaginated list back.
        it("calls the legacy 2-arg RPC shape when no pagination params are present", async () => {
            const captured = captureRpcArgs();
            supabaseState.rpc = { data: [], error: null };

      await request(app)
        .get("/projects")
        .set(...AUTH);

            expect(captured.args).toEqual({
                p_user_id: "u1",
                p_user_email: "u1@test.local",
            });
        });

        it("calls the paginated RPC shape with every filter parsed once any pagination param is present", async () => {
            const captured = captureRpcArgs();
            supabaseState.rpc = { data: [], error: null };

            await request(app)
                .get(
                    "/projects?limit=10&scope=mine&sort_key=name&sort_direction=asc" +
                        "&search=acme&practice=Litigation&owner_user_id=u2",
                )
                .set(...AUTH);

            expect(captured.args).toEqual({
                p_user_id: "u1",
                p_user_email: "u1@test.local",
                p_scope: "mine",
                p_limit: 10,
                p_offset: 0,
                p_search_term: "acme",
                p_sort_key: "name",
                p_sort_direction: "asc",
                p_practice: "Litigation",
                p_owner_user_id: "u2",
            });
        });

    it("uses the lightweight summary RPC for view=summary", async () => {
      const captured = captureRpcArgs();
      supabaseState.rpc = {
        data: [{ id: "p1", name: "Recently updated" }],
        error: null,
      };

      const res = await request(app)
        .get("/projects?view=summary&limit=11&offset=10")
        .set(...AUTH);

      expect(res.status).toBe(200);
      expect(res.body).toEqual([
        { id: "p1", name: "Recently updated", memory_enabled: true },
      ]);
      expect(captured.name).toBe("get_project_summaries");
      expect(captured.args).toEqual({
        p_user_id: "u1",
        p_user_email: "u1@test.local",
        p_limit: 11,
        p_offset: 10,
      });
    });

    it("uses the projects collection for directory search", async () => {
      const res = await request(app)
        .get("/projects?view=directory-search")
        .set(...AUTH);

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it("no longer exposes a separate project directory search route", async () => {
      const res = await request(app)
        .get("/projects/directory/search?search=Agreement")
        .set(...AUTH);

      expect(res.status).toBe(404);
    });
    });

    // ── GET /projects/ids (select-all-matching support) ──────────────────
    describe("GET /projects/ids", () => {
        it("pages through the RPC until an empty page is returned", async () => {
            const rpcMock = vi
                .fn()
                .mockResolvedValueOnce({
                    data: [{ id: "p1", user_id: "u1" }],
                    error: null,
                })
                .mockResolvedValueOnce({ data: [], error: null });
            vi.mocked(createServerSupabase).mockImplementationOnce(() => {
                const db = mockSupabase();
                db.rpc = rpcMock;
                return db as unknown as ReturnType<typeof createServerSupabase>;
            });

      const res = await request(app)
        .get("/projects/ids")
        .set(...AUTH);

            expect(res.status).toBe(200);
            expect(res.body).toEqual([{ id: "p1", user_id: "u1" }]);
            expect(rpcMock).toHaveBeenCalledTimes(2);
            expect(rpcMock.mock.calls[0][0]).toBe("get_project_ids_overview");
        });

        it("returns 500 with detail when the RPC errors", async () => {
            supabaseState.rpc = { data: null, error: { message: "boom" } };

      const res = await request(app)
        .get("/projects/ids")
        .set(...AUTH);

            expect(res.status).toBe(500);
            expect(res.body.detail).toBe("Something went wrong. Please try again.");
        });
    });

  describe("GET /projects/filter-options", () => {
    it("returns lightweight practice and owner facets", async () => {
      const captured = captureRpcArgs();
      supabaseState.rpc = {
        data: [
          {
            practices: ["Litigation"],
            owners: [{ value: "u1", label: "Me" }],
          },
        ],
        error: null,
      };

      const res = await request(app)
        .get("/projects/filter-options")
        .set(...AUTH);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        practices: ["Litigation"],
        owners: [{ value: "u1", label: "Me" }],
      });
      expect(captured.args).toEqual({
        p_user_id: "u1",
        p_user_email: "u1@test.local",
      });
    });
  });

  describe("Library query endpoints", () => {
    it("returns the ancestor path for a Library folder", async () => {
      supabaseState.tables.library_folders = {
        data: [
          {
            id: "nested",
            name: "Nested",
            parent_folder_id: "parent",
          },
          {
            id: "unrelated",
            name: "Unrelated",
            parent_folder_id: null,
          },
          {
            id: "parent",
            name: "Parent",
            parent_folder_id: null,
          },
        ],
        error: null,
      };

      const res = await request(app)
        .get("/library/templates/folders/nested")
        .set(...AUTH);

      expect(res.status).toBe(200);
      expect(res.body.folders.map((folder: { id: string }) => folder.id)).toEqual([
        "parent",
        "nested",
      ]);
    });

    it("returns 404 for a Library folder outside the requested collection", async () => {
      supabaseState.tables.library_folders = { data: [], error: null };

      const res = await request(app)
        .get("/library/files/folders/missing")
        .set(...AUTH);

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ detail: "Folder not found" });
    });

    it("returns a flat paginated search result", async () => {
      const captured = captureRpcArgs();
      supabaseState.rpc = {
        data: [
          { id: "d1", filename: "Agreement.docx" },
          { id: "d2", filename: "Agreement schedule.docx" },
        ],
        error: null,
      };

      const res = await request(app)
        .get(
          "/library/templates?view=search&limit=1&offset=2&search=Agreement" +
            "&file_type=docx&sort_key=name&sort_direction=asc",
        )
        .set(...AUTH);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        documents: [
          {
            id: "d1",
            filename: "Agreement.docx",
            folder_id: null,
          },
        ],
        documentsHasMore: true,
      });
      expect(captured.name).toBe("search_library_documents");
      expect(captured.args).toEqual({
        p_user_id: "u1",
        p_library_kind: "template",
        p_limit: 2,
        p_offset: 2,
        p_search_term: "Agreement",
        p_file_type: "docx",
        p_sort_key: "name",
        p_sort_direction: "asc",
      });
    });

    it("no longer exposes a separate Library search route", async () => {
      const res = await request(app)
        .get("/library/templates/search?search=Agreement")
        .set(...AUTH);

      expect(res.status).toBe(404);
    });

    it("returns only the file-type facet payload", async () => {
      const captured = captureRpcArgs();
      supabaseState.rpc = {
        data: [{ file_types: ["docx", "pdf"] }],
        error: null,
      };

      const res = await request(app)
        .get("/library/files/filter-options")
        .set(...AUTH);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ fileTypes: ["docx", "pdf"] });
      expect(captured.name).toBe("get_library_filter_options");
      expect(captured.args).toEqual({
        p_user_id: "u1",
        p_library_kind: "file",
      });
    });
  });

  describe("folder upload path resolution", () => {
    it("resolves a project path through the atomic RPC", async () => {
      const captured = captureRpcArgs();
      supabaseState.rpc = {
        data: {
          conflict: false,
          folder_id: "folder-2",
          resolved_name: "NDAs (2)",
          folders: [],
        },
        error: null,
      };

      const res = await request(app)
        .post("/projects/p1/folder-paths/resolve")
        .set(...AUTH)
        .send({
          segments: ["NDAs"],
          base_folder_id: null,
          conflict_resolution: "rename",
        });

      expect(res.status).toBe(200);
      expect(res.body.resolved_name).toBe("NDAs (2)");
      expect(captured.name).toBe("resolve_project_folder_path");
      expect(captured.args).toEqual({
        target_project_id: "p1",
        target_user_id: "u1",
        base_folder_id: null,
        path_segments: ["NDAs"],
        conflict_resolution: "rename",
      });
    });

    // "Resolve" names a lookup, but the RPC behind it creates any folder in
    // the path that does not exist yet. A viewer's tier is read-only, so the
    // route has to refuse before it reaches the RPC — not merely return an
    // empty answer.
    it("refuses a viewer, who would otherwise create folders by resolving a path", async () => {
      const captured = captureRpcArgs();
      checkProjectAccess.mockResolvedValue({
        ok: true,
        isCreator: false,
        orgRole: null,
        projectRole: "viewer",
        project: {
          id: "p1",
          user_id: "u2",
          org_id: null,
        },
      });

      const res = await request(app)
        .post("/projects/p1/folder-paths/resolve")
        .set(...AUTH)
        .send({
          segments: ["NDAs"],
          base_folder_id: null,
          conflict_resolution: "rename",
        });

      expect(res.status).toBe(404);
      expect(captured.name).toBeUndefined();
    });

    it("returns project folder conflicts without replacement permissions", async () => {
      checkProjectAccess.mockResolvedValue({
        ok: true,
        isCreator: false,
        orgRole: null,
        projectRole: "editor",
        project: { id: "p1", user_id: "u2", org_id: null },
      });
      supabaseState.rpc = {
        data: {
          conflict: true,
          folder_name: "NDAs",
          existing_folder_id: "folder-1",
          suggested_name: "NDAs (2)",
        },
        error: null,
      };

      const res = await request(app)
        .post("/projects/p1/folder-paths/resolve")
        .set(...AUTH)
        .send({ segments: ["NDAs"] });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        conflict: true,
        folder_name: "NDAs",
        existing_folder_id: "folder-1",
        suggested_name: "NDAs (2)",
      });
      expect(res.body).not.toHaveProperty("can_replace");
    });

    it("returns library folder conflicts without replacement permissions", async () => {
      supabaseState.rpc = {
        data: {
          conflict: true,
          folder_name: "NDAs",
          existing_folder_id: "folder-1",
          suggested_name: "NDAs (3)",
        },
        error: null,
      };

      const res = await request(app)
        .post("/library/files/folder-paths/resolve")
        .set(...AUTH)
        .send({ segments: ["NDAs"] });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        conflict: true,
        folder_name: "NDAs",
        existing_folder_id: "folder-1",
        suggested_name: "NDAs (3)",
      });
      expect(res.body).not.toHaveProperty("can_replace");
    });

    it.each([
      ["project", "/projects/p1/folder-paths/resolve"],
      ["library", "/library/files/folder-paths/resolve"],
    ])("does not expose raw %s folder RPC errors", async (_scope, path) => {
      const rawError =
        "Could not find resolve_project_folder_path in the schema cache";
      supabaseState.rpc = {
        data: null,
        error: { message: rawError },
      };
      const consoleError = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});

      const res = await request(app)
        .post(path)
        .set(...AUTH)
        .send({ segments: ["NDAs"] });

      expect(res.status).toBe(500);
      expect(res.body).toMatchObject({
        code: "internal_error",
        detail: "Something went wrong. Please try again.",
      });
      expect(res.body.request_id).toEqual(expect.any(String));
      expect(JSON.stringify(res.body)).not.toContain(rawError);
      expect(consoleError).toHaveBeenCalled();
      consoleError.mockRestore();
    });

    it("rejects malformed path segments before calling the RPC", async () => {
      const captured = captureRpcArgs();

      const res = await request(app)
        .post("/library/files/folder-paths/resolve")
        .set(...AUTH)
        .send({ segments: ["NDAs", 42] });

      expect(res.status).toBe(400);
      expect(res.body.detail).toBe("Invalid folder path");
      expect(captured.name).toBeUndefined();
    });
  });

    // ── POST /projects (create) ───────────────────────────────────────────
    describe("POST /projects", () => {
        it("returns 400 when name is missing/blank", async () => {
            const res = await request(app)
                .post("/projects")
                .set(...AUTH)
                .send({ name: "   " });

            expect(res.status).toBe(400);
            expect(res.body.detail).toBe("name is required");
        });

        it("rejects the retired shared_with input", async () => {
            const res = await request(app)
                .post("/projects")
                .set(...AUTH)
                .send({ name: "Beta", shared_with: ["U1@Test.Local"] });

            expect(res.status).toBe(400);
            expect(res.body.detail).toBe(
                "shared_with is no longer supported; use the project access endpoints.",
            );
        });

        it("creates the project with normalized project details", async () => {
            supabaseState.rpc = {
                data: {
                    id: "p9",
                    name: "Gamma",
                    user_id: "u1",
                },
                error: null,
            };

            const res = await request(app)
                .post("/projects")
                .set(...AUTH)
                .send({
                    name: "  Gamma  ",
                    practice: "  litigation  ",
                });

            expect(res.status).toBe(201);
            expect(res.body).toMatchObject({
                id: "p9",
                documents: [],
                access_scope: "private",
                organization_name: null,
            });

            const db = vi.mocked(createServerSupabase).mock.results.at(-1)
                ?.value as ReturnType<typeof mockSupabase>;
            expect(db.rpc).toHaveBeenCalledWith("create_project_with_memory", {
                p_user_id: "u1",
                p_name: "Gamma",
                p_cm_number: null,
                p_practice: "litigation",
                p_org_id: null,
                p_memory_enabled: true,
            });
        });

        it("commits an explicit memory opt-out in the same project transaction", async () => {
            supabaseState.rpc = {
                data: { id: "p10", name: "Private", user_id: "u1" },
                error: null,
            };
            const res = await request(app)
                .post("/projects")
                .set(...AUTH)
                .send({ name: "Private", memory_enabled: false });
            expect(res.status).toBe(201);
            expect(res.body.memory_enabled).toBe(false);
            const db = vi.mocked(createServerSupabase).mock.results.at(-1)
                ?.value as ReturnType<typeof mockSupabase>;
            expect(db.rpc).toHaveBeenCalledWith(
                "create_project_with_memory",
                expect.objectContaining({ p_memory_enabled: false }),
            );
            expect(supabaseState.inserts).toEqual([]);
        });

        it("returns 500 when the insert errors", async () => {
            supabaseState.rpc = {
                data: null,
                error: { message: "insert failed" },
            };

            const res = await request(app)
                .post("/projects")
                .set(...AUTH)
                .send({ name: "Delta" });

            expect(res.status).toBe(500);
            expect(res.body.detail).toBe("Something went wrong. Please try again.");
        });
    });

    // ── GET /projects/:projectId (detail, shared access helper) ───────────
    describe("GET /projects/:projectId", () => {
        it("returns 404 when the project does not exist", async () => {
            supabaseState.tables.projects = { data: null, error: null };

      const res = await request(app)
        .get("/projects/p1")
        .set(...AUTH);

            expect(res.status).toBe(404);
            expect(res.body.detail).toBe("Project not found");
        });

        it("returns 404 when the caller is neither owner nor shared", async () => {
            checkProjectAccess.mockResolvedValue({ ok: false });
            supabaseState.tables.projects = {
                data: {
                    id: "p1",
                    user_id: "someone-else",
                },
                error: null,
            };

      const res = await request(app)
        .get("/projects/p1")
        .set(...AUTH);

            expect(res.status).toBe(404);
            expect(res.body.detail).toBe("Project not found");
            expect(checkProjectAccess).toHaveBeenCalledWith(
                "p1",
                "u1",
                "u1@test.local",
                expect.anything(),
            );
        });

        it("grants direct access via the case-insensitive helper (member role)", async () => {
            checkProjectAccess.mockResolvedValue({
                ok: true,
                isCreator: false,
                orgRole: null,
                projectRole: "editor",
                project: {
                    id: "p1",
                    user_id: "someone-else",
                },
            });
            supabaseState.tables.projects = {
                data: {
                    id: "p1",
                    user_id: "someone-else",
                },
                error: null,
            };
            supabaseState.tables.documents = { data: [], error: null };
            supabaseState.tables.project_subfolders = { data: [], error: null };

      const res = await request(app)
        .get("/projects/p1")
        .set(...AUTH);

            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({
                id: "p1",
                is_owner: false,
                access_role: "editor",
            });
            expect(checkProjectAccess).toHaveBeenCalledTimes(1);
        });

        it("returns 200 with documents/folders/is_owner when owned", async () => {
            supabaseState.tables.projects = {
                data: { id: "p1", user_id: "u1" },
                error: null,
            };
            supabaseState.tables.documents = {
                data: [{ id: "d1", user_id: "u1" }],
                error: null,
            };
            supabaseState.tables.project_subfolders = {
                data: [{ id: "f1" }],
                error: null,
            };

      const res = await request(app)
        .get("/projects/p1")
        .set(...AUTH);

            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({
                id: "p1",
                is_owner: true,
                documents: [{ id: "d1" }],
                folders: [{ id: "f1" }],
            });
        });
    });

    // ── GET /projects/:projectId/people ─────────────────────────────────
    // The roster is readable at every tier, viewers included. It is the same
    // list GET /chat/:chatId/people and GET /tabular-review/:reviewId/people
    // already serve for a project-owned row, so tiering it here only meant
    // the collaborator list was one request away. What stays owner-only is
    // the MANAGEMENT surface, GET /projects/:projectId/access.
    describe("GET /projects/:projectId/people", () => {
        const seedDirectProject = (projectRole: string) => {
            checkProjectAccess.mockResolvedValue({
                ok: true,
                isCreator: false,
                orgRole: null,
                projectRole,
                project: { id: "p1", user_id: "creator", org_id: null },
            });
            supabaseState.tables.user_profiles = {
                data: [
                    {
                        user_id: "creator",
                        email: "creator@test.local",
                        display_name: "Creator",
                    },
                    {
                        user_id: "u2",
                        email: "colleague@test.local",
                        display_name: "Colleague",
                    },
                ],
                error: null,
            };
            supabaseState.tables.project_access_grants = {
                data: [
                    {
                        id: "g1",
                        project_id: "p1",
                        email: "colleague@test.local",
                        role: "editor",
                    },
                ],
                error: null,
            };
        };

        it.each(["viewer", "editor", "owner"])(
            "serves the full collaborator roster to a %s",
            async (projectRole) => {
                seedDirectProject(projectRole);

                const res = await request(app)
                    .get("/projects/p1/people")
                    .set(...AUTH);

                expect(res.status).toBe(200);
                expect(res.body.scope).toBe("direct");
                expect(res.body.owner).toMatchObject({
                    user_id: "creator",
                    role: "owner",
                });
                expect(res.body.members).toEqual([
                    {
                        email: "colleague@test.local",
                        display_name: "Colleague",
                        role: "editor",
                    },
                ]);
            },
        );

        it("still refuses somebody with no access at all", async () => {
            checkProjectAccess.mockResolvedValue({ ok: false });

            const res = await request(app)
                .get("/projects/p1/people")
                .set(...AUTH);

            expect(res.status).toBe(404);
            expect(res.body.detail).toBe("Project not found");
        });

        it("keeps the management surface owner-only", async () => {
            seedDirectProject("viewer");

            const res = await request(app)
                .get("/projects/p1/access")
                .set(...AUTH);

            expect(res.status).toBe(403);
            expect(res.body.detail).toBe(
                "Only a project owner can change who has access.",
            );
        });
    });

    // ── DELETE /projects/:projectId/folders/:folderId (role ladder) ──────
    // Organizing documents and folders is member work (Will's review): a
    // collaborator who may upload and delete documents is not meaningfully
    // restrained by being unable to remove the folder holding them. Only
    // viewers are refused.
    describe("DELETE /projects/:projectId/folders/:folderId", () => {
        const roleAccess = (projectRole: string) => ({
            ok: true,
            isCreator: projectRole === "owner",
            orgRole: null,
            projectRole,
            project: { id: "p1", user_id: "u1", org_id: null },
        });

        beforeEach(() => {
            supabaseState.tables.project_subfolders = {
                data: [{ id: "f1", parent_folder_id: null }],
                error: null,
            };
            supabaseState.tables.documents = { data: [], error: null };
        });

        it("allows a project owner (204)", async () => {
            const res = await request(app)
                .delete("/projects/p1/folders/f1")
                .set(...AUTH);
            expect(res.status).toBe(204);
        });

        it("allows an editor — folder work is editor-level (204)", async () => {
            checkProjectAccess.mockResolvedValue(roleAccess("editor"));
            const res = await request(app)
                .delete("/projects/p1/folders/f1")
                .set(...AUTH);
            expect(res.status).toBe(204);
        });

        it("blocks a viewer (404)", async () => {
            checkProjectAccess.mockResolvedValue(roleAccess("viewer"));
            const res = await request(app)
                .delete("/projects/p1/folders/f1")
                .set(...AUTH);
            expect(res.status).toBe(404);
        });
    });

    // ── GET /projects/:projectId/chats ────────────────────────────────────
    // The list has to say what the caller may DO with each chat, or the
    // client is left gating on `user_id === me` — which this PR's model makes
    // wrong in both directions.
    describe("GET /projects/:projectId/chats", () => {
        const seedChats = () => {
            supabaseState.tables.chats = {
                data: [
                    { id: "c-mine", user_id: "u1" },
                    { id: "c-theirs", user_id: "u2" },
                    { id: "c-shared", user_id: "u2" },
                ],
                error: null,
            };
            supabaseState.tables.chat_access_grants = {
                data: [{ chat_id: "c-shared", role: "editor" }],
                error: null,
            };
            supabaseState.tables.user_profiles = { data: [], error: null };
        };

        it("labels each chat with the caller's role for it", async () => {
            seedChats();
            // A project MEMBER: content collaboration, not administration.
            checkProjectAccess.mockResolvedValue({
                ok: true,
                isCreator: false,
                orgRole: "member",
                projectRole: "editor",
                project: { id: "p1", user_id: "u2", org_id: "org-1" },
            });

            const res = await request(app)
                .get("/projects/p1/chats")
                .set(...AUTH);

            expect(res.status).toBe(200);
            expect(
                (res.body as { id: string; access_role: string; is_owner: boolean }[]).map(
                    ({ id, access_role, is_owner }) => ({
                        id,
                        access_role,
                        is_owner,
                    }),
                ),
            ).toEqual([
                // Project children inherit the project verdict exactly, even
                // when the caller created a particular child row.
                { id: "c-mine", access_role: "editor", is_owner: true },
                // A colleague's: readable and writable, not deletable.
                { id: "c-theirs", access_role: "editor", is_owner: false },
                // Child grants do not alter inherited access.
                { id: "c-shared", access_role: "editor", is_owner: false },
            ]);
        });

        it("never demotes a project admin on a colleague's chat", async () => {
            seedChats();
            checkProjectAccess.mockResolvedValue({
                ok: true,
                isCreator: false,
                orgRole: "admin",
                projectRole: "owner",
                project: { id: "p1", user_id: "u2", org_id: "org-1" },
            });

            const res = await request(app)
                .get("/projects/p1/chats")
                .set(...AUTH);

            expect(
                (res.body as { access_role: string }[]).map((c) => c.access_role),
            ).toEqual(["owner", "owner", "owner"]);
        });

        it("labels every chat viewer when the caller only views the project", async () => {
            seedChats();
            checkProjectAccess.mockResolvedValue({
                ok: true,
                isCreator: false,
                orgRole: null,
                projectRole: "viewer",
                project: { id: "p1", user_id: "u2", org_id: null },
            });

            const res = await request(app)
                .get("/projects/p1/chats")
                .set(...AUTH);

            // Child rows inherit the project role; child grants are ignored.
            expect(
                (res.body as { access_role: string }[]).map((c) => c.access_role),
            ).toEqual(["viewer", "viewer", "viewer"]);
        });
    });

    // ── GET /projects/:projectId/documents (checkProjectAccess guard) ─────
    describe("GET /projects/:projectId/documents", () => {
        it("returns 404 when checkProjectAccess denies access", async () => {
            checkProjectAccess.mockResolvedValue({ ok: false });

            const res = await request(app)
                .get("/projects/p1/documents")
                .set(...AUTH);

            expect(res.status).toBe(404);
            expect(res.body.detail).toBe("Project not found");
            expect(checkProjectAccess).toHaveBeenCalledTimes(1);
        });

        it("returns 200 with documents when access is granted", async () => {
            supabaseState.tables.documents = {
                data: [{ id: "d1" }, { id: "d2" }],
                error: null,
            };

            const res = await request(app)
                .get("/projects/p1/documents")
                .set(...AUTH);

            expect(res.status).toBe(200);
            expect(res.body).toEqual([{ id: "d1" }, { id: "d2" }]);
            expect(checkProjectAccess).toHaveBeenCalledTimes(1);
        });
    });

    // ── PATCH /projects/:projectId ───────────────────────────────────────
    describe("PATCH /projects/:projectId", () => {
        it("rejects the retired shared_with input", async () => {
            const res = await request(app)
                .patch("/projects/p1")
                .set(...AUTH)
                .send({ shared_with: ["u1@test.local"] });

            expect(res.status).toBe(400);
            expect(res.body.detail).toBe(
                "shared_with is no longer supported; use the project access endpoints.",
            );
        });

        it("returns 404 when the update matches no owned project", async () => {
            supabaseState.tables.projects = { data: null, error: null };

            const res = await request(app)
                .patch("/projects/p1")
                .set(...AUTH)
                .send({ name: "Renamed" });

            expect(res.status).toBe(404);
            expect(res.body.detail).toBe("Project not found");
        });
    });

    // ── DELETE /projects/:projectId ───────────────────────────────────────
    // Pins the `container.delete` row of the matrix on the project container:
    // owner tier deletes, everything below it is refused with a 403 (a
    // stranger, who fails the access check outright, still gets 404).
    describe("DELETE /projects/:projectId", () => {
        it("returns 404 when nothing was deleted", async () => {
            deleteProjectsByIds.mockResolvedValue(0);

      const res = await request(app)
        .delete("/projects/p1")
        .set(...AUTH);

            expect(res.status).toBe(404);
            expect(res.body.detail).toBe("Project not found");
        });

        it("returns 204 when an org Admin deletes another creator's project", async () => {
            deleteProjectsByIds.mockResolvedValue(1);
            checkProjectAccess.mockResolvedValue({
                ok: true,
                isCreator: false,
                orgRole: "admin",
                projectRole: "owner",
                project: { id: "p1", user_id: "u2", org_id: "org-1" },
            });

      const res = await request(app)
        .delete("/projects/p1")
        .set(...AUTH);

            expect(res.status).toBe(204);
            // Deleted by id, with no owner filter: the capability check is
            // what authorised this, and an organization project may have no
            // creator left to scope by.
      expect(deleteProjectsByIds).toHaveBeenCalledWith(expect.anything(), [
        "p1",
      ]);
        });

        it.each(["member", "viewer"] as const)(
            "returns 403 when a %s tries to delete the project",
            async (projectRole) => {
                checkProjectAccess.mockResolvedValue({
                    ok: true,
                    isCreator: false,
                    orgRole: null,
                    projectRole,
                    project: { id: "p1", user_id: "owner", org_id: null },
                });

                const res = await request(app)
                    .delete("/projects/p1")
                    .set(...AUTH);

                expect(res.status).toBe(403);
                expect(res.body.detail).toBe(
                    "Only a project owner can delete this project.",
                );
                // Refused before the cascade could run.
                expect(deleteProjectsByIds).not.toHaveBeenCalled();
            },
        );

        it("returns 404 when the caller has no access at all", async () => {
            checkProjectAccess.mockResolvedValue({ ok: false });

            const res = await request(app)
                .delete("/projects/p1")
                .set(...AUTH);

            expect(res.status).toBe(404);
            expect(res.body.detail).toBe("Project not found");
            expect(deleteProjectsByIds).not.toHaveBeenCalled();
        });

        it("returns 500 when deletion throws", async () => {
            deleteProjectsByIds.mockRejectedValue(new Error("cascade failed"));

      const res = await request(app)
        .delete("/projects/p1")
        .set(...AUTH);

            expect(res.status).toBe(500);
            expect(res.body.detail).toBe("Something went wrong. Please try again.");
        });
    });
    // ── GET /projects/:projectId/export (tamper-evident manifest) ─────────
    describe("GET /projects/:projectId/export", () => {
        function seedProjectWithOneVersion() {
            supabaseState.tables.projects = {
                data: {
                    id: "p1",
                    name: "Alpha",
                    cm_number: "CM-1",
                    created_at: "2026-01-01T00:00:00Z",
                },
                error: null,
            };
            supabaseState.tables.documents = {
                data: [
                    {
                        id: "d1",
                        project_id: "p1",
                        status: "ready",
                        current_version_id: "v1",
                        created_at: "2026-01-02T00:00:00Z",
                    },
                ],
                error: null,
            };
            supabaseState.tables.document_versions = {
                data: [
                    {
                        id: "v1",
                        document_id: "d1",
                        version_number: 1,
                        source: "upload",
                        filename: "lease.docx",
                        file_type: "docx",
                        size_bytes: 12,
                        content_sha256: "a".repeat(64),
                        deleted_at: null,
                        created_at: "2026-01-02T00:00:00Z",
                    },
                ],
                error: null,
            };
            supabaseState.tables.document_edits = {
                data: [
                    {
                        id: "e1",
                        document_id: "d1",
                        version_id: "v1",
                        change_id: "c1",
                        status: "accepted",
                        created_at: "2026-01-03T00:00:00Z",
                        resolved_at: "2026-01-03T01:00:00Z",
                    },
                ],
                error: null,
            };
        }

        it("returns 404 when the caller cannot access the project", async () => {
            checkProjectAccess.mockResolvedValue({ ok: false });

            const res = await request(app)
                .get("/projects/p1/export")
                .set(...AUTH);

            expect(res.status).toBe(404);
            expect(res.body.detail).toBe("Project not found");
        });

        it("returns the version hashes and the edit trail as an attachment", async () => {
            seedProjectWithOneVersion();

            const res = await request(app)
                .get("/projects/p1/export")
                .set(...AUTH);

            expect(res.status).toBe(200);
            expect(res.headers["content-disposition"]).toMatch(
                /attachment; filename="mike-project-manifest-p1-/,
            );
            expect(res.body.manifest_version).toBe(1);
            expect(res.body.project.name).toBe("Alpha");
            const doc = res.body.documents[0];
            expect(doc.versions[0].content_sha256).toBe("a".repeat(64));
            expect(doc.edits[0].status).toBe("accepted");
        });

        it("carries a digest and no signature when signing is not configured", async () => {
            seedProjectWithOneVersion();

            const res = await request(app)
                .get("/projects/p1/export")
                .set(...AUTH);

            expect(res.body.signature).toBeNull();
            expect(res.body.digest.algorithm).toBe("sha256");
            expect(res.body.digest.value).toMatch(/^[0-9a-f]{64}$/);
        });

        it("signs the digest when MANIFEST_SIGNING_KEY is set", async () => {
            process.env.MANIFEST_SIGNING_KEY = SIGNING_KEY;
            try {
                seedProjectWithOneVersion();

                const res = await request(app)
                    .get("/projects/p1/export")
                    .set(...AUTH);

                // Checked the way a recipient would: pin the published key,
                // rebuild the signed payload, verify with plain Ed25519.
                const published = manifestPublicKey()!;
                expect(res.body.signature.algorithm).toBe("ed25519");
                expect(res.body.signature.public_key).toBe(published.public_key);
                const spki = Buffer.concat([
                    Buffer.from("302a300506032b6570032100", "hex"),
                    Buffer.from(published.public_key, "hex"),
                ]);
                const payload = Buffer.concat([
                    Buffer.from("mike-project-manifest-v1\0", "utf8"),
                    Buffer.from(res.body.digest.value, "hex"),
                ]);
                expect(
                    crypto.verify(
                        null,
                        payload,
                        crypto.createPublicKey({
                            key: spki,
                            format: "der",
                            type: "spki",
                        }),
                        Buffer.from(res.body.signature.value, "hex"),
                    ),
                ).toBe(true);
            } finally {
                delete process.env.MANIFEST_SIGNING_KEY;
            }
        });

        it("does not leak the underlying error when the manifest build fails", async () => {
            supabaseState.tables.projects = {
                data: null,
        error: { message: 'relation "projects" does not exist' },
            };

            const res = await request(app)
                .get("/projects/p1/export")
                .set(...AUTH);

            expect(res.status).toBe(500);
      expect(res.body.detail).toBe("Something went wrong. Please try again.");
        });
    });
});
