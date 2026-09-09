import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

// ---------------------------------------------------------------------------
// Hoisted mock fns reconfigured per-test. Access helpers + model settings are
// mocked so the tests drive review-access decisions, document-access filtering
// and the missing-API-key guard without touching real Supabase / LLM IO. The
// streaming endpoints (chat/generate) are only exercised up to their GUARDS —
// the SSE loop itself is never reached in these tests.
// ---------------------------------------------------------------------------
const {
    ensureReviewAccess,
    checkProjectAccess,
    filterAccessibleDocumentIds,
    getUserModelSettings,
    resolveContentOrgId,
} = vi.hoisted(() => ({
    ensureReviewAccess: vi.fn(),
    checkProjectAccess: vi.fn(),
    filterAccessibleDocumentIds: vi.fn(),
    getUserModelSettings: vi.fn(),
    resolveContentOrgId: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Configurable Supabase stub (mirrors projects.routes.test). Each test seeds
// `supabaseState` in beforeEach; terminal query operations resolve to the
// per-table result, rpc() resolves to a per-call result. Insert payloads are
// recorded so tests can assert on what got persisted.
// ---------------------------------------------------------------------------
type QueryResult = { data: unknown; error: unknown };

// A table entry may be a queue of results: each query consumes the next one,
// and the last repeats (same idiom as user.routes.test). Lets a test drive a
// route that hits the SAME table twice with different outcomes — e.g. DELETE
// /tabular-review/:reviewId, which now reads the row to derive the caller's
// role before deleting it.
let supabaseState: {
    rpc: QueryResult;
    rpcCalls: { fn: string; args: unknown }[];
    operations: string[];
    tables: Record<string, QueryResult | QueryResult[]>;
    inserts: { table: string; payload: unknown }[];
    updates: { table: string; payload: unknown }[];
};

function resetSupabaseState() {
    supabaseState = {
        rpc: { data: [], error: null },
        rpcCalls: [],
        operations: [],
        tables: {},
        inserts: [],
        updates: [],
    };
}
resetSupabaseState();

function resultForTable(table: string): QueryResult {
    const entry = supabaseState.tables[table];
    const resolved = Array.isArray(entry)
        ? entry.length > 1
            ? (entry.shift() as QueryResult)
            : (entry[0] ?? { data: null, error: null })
        : (entry ?? { data: null, error: null });
    if (
        table === "tabular_reviews" &&
        resolved.data &&
        typeof resolved.data === "object" &&
        !Array.isArray(resolved.data) &&
        !("model" in resolved.data)
    ) {
        return {
            ...resolved,
            data: { ...resolved.data, model: "claude-sonnet-5" },
        };
    }
    return resolved;
}

function makeQuery(table: string) {
    const q: Record<string, unknown> = {};
    const chain = [
    "select",
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
    // Update payloads are recorded alongside inserts: what a route writes on
    // a mutation is exactly as much a part of its contract as what it writes
    // on a create, and a denormalized column can only be checked here.
    q.update = vi.fn((payload: unknown) => {
        supabaseState.updates.push({ table, payload });
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
        from: vi.fn((table: string) => {
            supabaseState.operations.push(`from:${table}`);
            return makeQuery(table);
        }),
        rpc: vi.fn((fn: string, args: unknown) => {
            supabaseState.operations.push(`rpc:${fn}`);
            supabaseState.rpcCalls.push({ fn, args });
            return Promise.resolve(supabaseState.rpc);
        }),
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

vi.mock("../../lib/access", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../lib/access")>()),
    ensureReviewAccess: (...args: unknown[]) => ensureReviewAccess(...args),
    checkProjectAccess: (...args: unknown[]) => checkProjectAccess(...args),
    filterAccessibleDocumentIds: (...args: unknown[]) =>
        filterAccessibleDocumentIds(...args),
    ensureDocAccess: vi.fn(async () => ({ ok: true, isCreator: true })),
    listAccessibleProjectIds: vi.fn(async () => []),
    getOrgRole: vi.fn(async () => null),
    resolveContentOrgId: (...args: unknown[]) => resolveContentOrgId(...args),
}));

vi.mock("../../lib/userSettings", () => ({
    getUserModelSettings: (...args: unknown[]) => getUserModelSettings(...args),
    getUserApiKeys: vi.fn(async () => ({})),
    persistLastSelectedChatModel: vi.fn(async () => null),
    persistLastSelectedReasoningLevel: vi.fn(async () => null),
}));

// Version-path enrichment hits the DB in real life; no-op it so route
// responses are driven purely by the table stubs.
vi.mock("../../lib/documentVersions", () => ({
    attachActiveVersionPaths: vi.fn(async () => {}),
    attachLatestVersionNumbers: vi.fn(async () => {}),
}));

import { app } from "../../app";
import { REVIEW_EDIT_FORBIDDEN } from "../../routes/tabular";

const AUTH = ["Authorization", "Bearer test"] as const;

describe("tabular.routes", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetSupabaseState();
        // Default: caller is the owner with full access.
        ensureReviewAccess.mockResolvedValue({
            ok: true,
            isCreator: true,
            orgRole: null,
            projectRole: "owner",
        });
        checkProjectAccess.mockResolvedValue({
            ok: true,
            isCreator: true,
            orgRole: null,
            projectRole: "owner",
            project: { id: "p1", user_id: "u1" },
        });
        // Default: personal content — no tenant to inherit.
        resolveContentOrgId.mockResolvedValue({ ok: true, orgId: null });
        // Default: every requested doc is accessible (identity passthrough).
        filterAccessibleDocumentIds.mockImplementation(
            async (ids: string[]) => ids,
        );
        getUserModelSettings.mockResolvedValue({
            title_model: "claude-haiku-4-5",
            tabular_model: "claude-sonnet-5",
            last_selected_chat_model: "claude-sonnet-5",
            last_selected_reasoning_level: "high",
            legal_research_us: false,
            api_keys: { claude: "sk-test" },
        });
    });

    // ── GET /tabular-review (overview) ────────────────────────────────────
    describe("GET /tabular-review", () => {
        it("returns the overview rows from the RPC", async () => {
            supabaseState.rpc = {
                data: [{ id: "r1", title: "Alpha" }],
                error: null,
            };

      const res = await request(app)
        .get("/tabular-review")
        .set(...AUTH);

            expect(res.status).toBe(200);
            expect(res.body).toEqual([{ id: "r1", title: "Alpha" }]);
        });

        it("returns 500 with detail when the RPC errors", async () => {
            supabaseState.rpc = { data: null, error: { message: "boom" } };

      const res = await request(app)
        .get("/tabular-review")
        .set(...AUTH);

            expect(res.status).toBe(500);
            expect(res.body.detail).toBe("Something went wrong. Please try again.");
        });
    });

    // ── POST /tabular-review (create) ─────────────────────────────────────
    describe("POST /tabular-review", () => {
        it("rejects creation without an explicit model", async () => {
            const res = await request(app)
                .post("/tabular-review")
                .set(...AUTH)
                .send({ document_ids: [], columns_config: [] });

            expect(res.status).toBe(400);
            expect(res.body.code).toBe("model_required");
            expect(
                supabaseState.inserts.some(
                    (insert) => insert.table === "tabular_reviews",
                ),
            ).toBe(false);
        });

        it("rejects standalone organization scope", async () => {
            const res = await request(app)
                .post("/tabular-review")
                .set(...AUTH)
                .send({
                    title: "Firm review",
                    document_ids: [],
                    columns_config: [],
                    model: "claude-sonnet-5",
                    org_id: "org-1",
                });

            expect(res.status).toBe(400);
            expect(res.body.detail).toBe(
                "Tabular reviews cannot be organization-scoped. Create the review inside an organization project instead.",
            );
            expect(
                supabaseState.inserts.some(
                    (insert) => insert.table === "tabular_reviews",
                ),
            ).toBe(false);
        });

        it("creates a review (201) and only persists accessible documents", async () => {
            supabaseState.tables.tabular_reviews = {
                data: { id: "r9", title: "Gamma", document_ids: ["d1"] },
                error: null,
            };
            supabaseState.tables.documents = {
                data: [
                    {
                        id: "d1",
                        filename: "Agreement.pdf",
                        file_type: "pdf",
                        folder_id: null,
                    },
                ],
                error: null,
            };
            supabaseState.tables.tabular_review_rows = {
                data: [
                    {
                        id: "row-1",
                        review_id: "r9",
                        label: "Agreement.pdf",
                        row_type: "document",
                        folder_id: null,
                        document_id: "d1",
                        sort_index: 0,
                    },
                ],
                error: null,
            };
            // d2 is not accessible — it must be filtered out of the insert.
            filterAccessibleDocumentIds.mockResolvedValue(["d1"]);

            const res = await request(app)
                .post("/tabular-review")
                .set(...AUTH)
                .send({
                    title: "Gamma",
                    document_ids: ["d1", "d2"],
                    columns_config: [{ index: 0, name: "Col", prompt: "p" }],
                    model: "claude-sonnet-5",
                });

            expect(res.status).toBe(201);
            expect(res.body).toMatchObject({ id: "r9" });

            const reviewInsert = supabaseState.inserts.find(
                (i) => i.table === "tabular_reviews",
            );
            expect(reviewInsert?.payload).toMatchObject({
                document_ids: ["d1"],
                org_id: null,
            });
            // Cells are created for accessible review rows × columns only (1 × 1).
            const cellInsert = supabaseState.inserts.find(
                (i) => i.table === "tabular_cells",
            );
            expect(cellInsert?.payload).toEqual([
                {
                    review_id: "r9",
                    row_id: "row-1",
                    document_id: "d1",
                    column_index: 0,
                    status: "pending",
                },
            ]);
        });

        it("groups project-folder documents into one review row", async () => {
            supabaseState.tables.tabular_reviews = {
                data: { id: "r10", title: "Grouped", document_ids: ["d1", "d2", "d3"] },
                error: null,
            };
            supabaseState.tables.documents = {
                data: [
          {
            id: "d1",
            filename: "A.pdf",
            file_type: "pdf",
            project_id: "p1",
            folder_id: "f1",
          },
          {
            id: "d2",
            filename: "B.pdf",
            file_type: "pdf",
            project_id: "p1",
            folder_id: "f1",
          },
          {
            id: "d3",
            filename: "Loose.pdf",
            file_type: "pdf",
            project_id: "p1",
            folder_id: null,
          },
                ],
                error: null,
            };
            supabaseState.tables.project_subfolders = {
                data: [{ id: "f1", name: "Contracts", parent_folder_id: null }],
                error: null,
            };
            supabaseState.tables.tabular_review_rows = {
                data: [
                    {
                        id: "row-folder",
                        review_id: "r10",
                        label: "Contracts",
                        row_type: "folder",
                        folder_id: "f1",
                        library_folder_id: null,
                        document_id: null,
                        sort_index: 0,
                    },
                    {
                        id: "row-document",
                        review_id: "r10",
                        label: "Loose.pdf",
                        row_type: "document",
                        folder_id: null,
                        library_folder_id: null,
                        document_id: "d3",
                        sort_index: 1,
                    },
                ],
                error: null,
            };

            const res = await request(app)
                .post("/tabular-review")
                .set(...AUTH)
                .send({
                    title: "Grouped",
                    project_id: "p1",
                    document_ids: ["d1", "d2", "d3"],
                    document_grouping: "folder",
                    columns_config: [{ index: 0, name: "Col", prompt: "p" }],
                    model: "claude-sonnet-5",
                });

            expect(res.status).toBe(201);
      expect(
        supabaseState.inserts.find((i) => i.table === "tabular_reviews")
          ?.payload,
      ).toMatchObject({ document_grouping: "folder" });
      expect(
        supabaseState.inserts.find((i) => i.table === "tabular_review_rows")
          ?.payload,
      ).toEqual([
                    {
                        review_id: "r10",
                        label: "Contracts",
                        row_type: "folder",
                        folder_id: "f1",
                        library_folder_id: null,
                        document_id: null,
                        sort_index: 0,
                    },
                    {
                        review_id: "r10",
                        label: "Loose.pdf",
                        row_type: "document",
                        folder_id: null,
                        library_folder_id: null,
                        document_id: "d3",
                        sort_index: 1,
                    },
                ]);
      expect(
        supabaseState.inserts.find(
          (i) => i.table === "tabular_review_row_sources",
        )?.payload,
      ).toEqual([
                    { row_id: "row-folder", document_id: "d1", sort_index: 0 },
                    { row_id: "row-folder", document_id: "d2", sort_index: 1 },
                    { row_id: "row-document", document_id: "d3", sort_index: 0 },
                ]);
      expect(
        supabaseState.inserts.find((i) => i.table === "tabular_cells")?.payload,
      ).toEqual([
                    {
                        review_id: "r10",
                        row_id: "row-folder",
                        document_id: null,
                        column_index: 0,
                        status: "pending",
                    },
                    {
                        review_id: "r10",
                        row_id: "row-document",
                        document_id: "d3",
                        column_index: 0,
                        status: "pending",
                    },
                ]);
        });

        it("groups library file-folder documents into one review row", async () => {
            supabaseState.tables.tabular_reviews = {
                data: { id: "r11", title: "Library grouped" },
                error: null,
            };
            supabaseState.tables.documents = {
                data: [
                    {
                        id: "d1",
                        filename: "A.pdf",
                        file_type: "pdf",
                        project_id: null,
                        folder_id: null,
                        library_folder_id: "lf1",
                    },
                    {
                        id: "d2",
                        filename: "B.pdf",
                        file_type: "pdf",
                        project_id: null,
                        folder_id: null,
                        library_folder_id: "lf1",
                    },
                ],
                error: null,
            };
            supabaseState.tables.library_folders = {
                data: [
                    {
                        id: "lf1",
                        name: "Precedents",
                        parent_folder_id: null,
                    },
                ],
                error: null,
            };
            supabaseState.tables.tabular_review_rows = {
                data: [
                    {
                        id: "row-library-folder",
                        review_id: "r11",
                        label: "Precedents",
                        row_type: "folder",
                        folder_id: null,
                        library_folder_id: "lf1",
                        document_id: null,
                        sort_index: 0,
                    },
                ],
                error: null,
            };

            const res = await request(app)
                .post("/tabular-review")
                .set(...AUTH)
                .send({
                    title: "Library grouped",
                    document_ids: ["d1", "d2"],
                    document_grouping: "folder",
                    columns_config: [{ index: 0, name: "Col", prompt: "p" }],
                    model: "claude-sonnet-5",
                });

            expect(res.status).toBe(201);
            expect(
                supabaseState.inserts.find(
                    (insert) => insert.table === "tabular_review_rows",
                )?.payload,
            ).toEqual([
                {
                    review_id: "r11",
                    label: "Precedents",
                    row_type: "folder",
                    folder_id: null,
                    library_folder_id: "lf1",
                    document_id: null,
                    sort_index: 0,
                },
            ]);
            expect(
                supabaseState.inserts.find(
                    (insert) => insert.table === "tabular_review_row_sources",
                )?.payload,
            ).toEqual([
                {
                    row_id: "row-library-folder",
                    document_id: "d1",
                    sort_index: 0,
                },
                {
                    row_id: "row-library-folder",
                    document_id: "d2",
                    sort_index: 1,
                },
            ]);
        });

        it("returns 404 when project access is denied", async () => {
            checkProjectAccess.mockResolvedValue({ ok: false });

            const res = await request(app)
                .post("/tabular-review")
                .set(...AUTH)
                .send({
                    project_id: "p-nope",
                    document_ids: [],
                    columns_config: [],
                    model: "claude-sonnet-5",
                });

            expect(res.status).toBe(404);
            expect(res.body.detail).toBe("Project not found");
        });

        it("returns 500 when the review insert errors", async () => {
            supabaseState.tables.tabular_reviews = {
                data: null,
                error: { message: "insert failed" },
            };

            const res = await request(app)
                .post("/tabular-review")
                .set(...AUTH)
                .send({
                    document_ids: [],
                    columns_config: [],
                    model: "claude-sonnet-5",
                });

            expect(res.status).toBe(500);
            expect(res.body.detail).toBe("Something went wrong. Please try again.");
        });
    });

    // ── GET /tabular-review/:reviewId (detail) ────────────────────────────
    describe("GET /tabular-review/:reviewId", () => {
        it("returns 404 when the review does not exist", async () => {
            supabaseState.tables.tabular_reviews = { data: null, error: null };

            const res = await request(app)
                .get("/tabular-review/r1")
                .set(...AUTH);

            expect(res.status).toBe(404);
            expect(res.body.detail).toBe("Review not found");
        });

        it("returns 404 when review access is denied", async () => {
            supabaseState.tables.tabular_reviews = {
                data: { id: "r1", user_id: "other", project_id: null },
                error: null,
            };
            ensureReviewAccess.mockResolvedValue({ ok: false });

            const res = await request(app)
                .get("/tabular-review/r1")
                .set(...AUTH);

            expect(res.status).toBe(404);
            expect(res.body.detail).toBe("Review not found");
        });

        it("returns 200 with review/cells/documents + is_owner", async () => {
            supabaseState.tables.tabular_reviews = {
                data: {
                    id: "r1",
                    user_id: "u1",
                    project_id: null,
                    document_ids: ["d1"],
                    columns_config: [],
                    active_generation_id: "generation-1",
                    generation_lease_expires_at: "2099-01-01T00:00:00.000Z",
                },
                error: null,
            };
            supabaseState.tables.tabular_cells = {
                data: [
                    {
                        id: "c1",
                        document_id: "d1",
                        column_index: 0,
                        content: null,
                        status: "pending",
                    },
                ],
                error: null,
            };
            supabaseState.tables.documents = {
                data: [{ id: "d1", current_version_id: null }],
                error: null,
            };

            const res = await request(app)
                .get("/tabular-review/r1")
                .set(...AUTH);

            expect(res.status).toBe(200);
            expect(res.body.review).toMatchObject({
                id: "r1",
                is_owner: true,
                is_running: true,
            });
            expect(res.body.cells).toHaveLength(1);
            expect(res.body.documents).toEqual([
                { id: "d1", current_version_id: null },
            ]);
        });
    });

    describe("tabular review access grants", () => {
        it("returns the role-aware grant list to an admin", async () => {
            supabaseState.tables.tabular_reviews = {
                data: {
                    id: "r1",
                    user_id: "u1",
                    project_id: null,
                    org_id: null,
                },
                error: null,
            };
            supabaseState.tables.tabular_review_access_grants = {
                data: [
                    {
                        id: "rg1",
                        tabular_review_id: "r1",
                        email: "viewer@example.com",
                        role: "viewer",
                    },
                ],
                error: null,
            };

            const res = await request(app)
                .get("/tabular-review/r1/access")
                .set(...AUTH);

            expect(res.status).toBe(200);
            expect(res.body.grants).toEqual([
                expect.objectContaining({
                    email: "viewer@example.com",
                    role: "viewer",
                }),
            ]);
        });

        it("rejects a grant addressed to the caller", async () => {
            supabaseState.tables.tabular_reviews = {
                data: {
                    id: "r1",
                    user_id: "u1",
                    project_id: null,
                    org_id: null,
                },
                error: null,
            };

            const res = await request(app)
                .post("/tabular-review/r1/access")
                .set(...AUTH)
                .send({ email: " U1@Test.Local ", role: "editor" });

            expect(res.status).toBe(400);
            expect(res.body.detail).toBe(
                "You cannot share a tabular review with yourself.",
            );
        });
    });

    // ── PATCH /tabular-review/:reviewId ───────────────────────────────────
    describe("PATCH /tabular-review/:reviewId", () => {
        it("returns 400 when project_id is an invalid type", async () => {
            const res = await request(app)
                .patch("/tabular-review/r1")
                .set(...AUTH)
                .send({ project_id: 123 });

            expect(res.status).toBe(400);
            expect(res.body.detail).toBe(
                "project_id must be a non-empty string or null",
            );
        });

        it("rejects the retired shared_with input", async () => {
            const res = await request(app)
                .patch("/tabular-review/r1")
                .set(...AUTH)
                .send({ shared_with: ["U1@Test.Local"] });

            expect(res.status).toBe(400);
            expect(res.body.detail).toBe(
                "shared_with is no longer supported; use the tabular review access endpoints.",
            );
        });

        it("returns 404 when the review does not exist", async () => {
            supabaseState.tables.tabular_reviews = { data: null, error: null };

            const res = await request(app)
                .patch("/tabular-review/r1")
                .set(...AUTH)
                .send({ title: "Renamed" });

            expect(res.status).toBe(404);
            expect(res.body.detail).toBe("Review not found");
        });

        it("returns 403 when a viewer edits columns_config", async () => {
            // Reshaping a review's grid is content work, so members may do it
            // (Will's review: members "use chats and reviews"). Only viewers,
            // who are read-only by definition, are refused.
            supabaseState.tables.tabular_reviews = {
                data: { id: "r1", user_id: "other", project_id: "p1" },
                error: null,
            };
            ensureReviewAccess.mockResolvedValue({
                ok: true,
                isCreator: false,
                orgRole: null,
                projectRole: "viewer",
            });

            const res = await request(app)
                .patch("/tabular-review/r1")
                .set(...AUTH)
                .send({ columns_config: [{ index: 0, name: "X", prompt: "p" }] });

            expect(res.status).toBe(403);
            expect(res.body.detail).toBe("Only a review editor can change columns");
        });

        // `tabular_reviews.org_id` is a denormalized copy of the project's
        // tenant for lifecycle handling. Access comes from the project, but a
        // stale copy can still cause account cleanup to retain or delete the
        // wrong data.
        const seedMove = (reviewOrgId: string | null) => {
            supabaseState.tables.tabular_reviews = [
                {
                    data: {
                        id: "r1",
                        user_id: "u1",
                        project_id: "p-from",
                        org_id: reviewOrgId,
                    },
                    error: null,
                },
                {
                    data: {
                        id: "r1",
                        user_id: "u1",
                        project_id: "p-to",
                        document_ids: [],
                        columns_config: [],
                    },
                    error: null,
                },
            ];
            checkProjectAccess.mockResolvedValue({
                ok: true,
                isCreator: true,
                orgRole: null,
                projectRole: "owner",
            });
        };
        const movePayload = () =>
            supabaseState.updates.find((u) => u.table === "tabular_reviews")
                ?.payload as Record<string, unknown> | undefined;

        it("clears org_id when a review moves into a personal project", async () => {
            // The leak: without restamping, a review carried out of an org
            // project into somebody's personal project must not keep the old
            // organization's lifecycle stamp.
            seedMove("org-1");
            resolveContentOrgId.mockResolvedValue({ ok: true, orgId: null });

            const res = await request(app)
                .patch("/tabular-review/r1")
                .set(...AUTH)
                .send({ project_id: "p-to" });

            expect(res.status).toBe(200);
            expect(movePayload()).toMatchObject({
                project_id: "p-to",
                org_id: null,
            });
        });

        it("refuses the move when the tenant lookup fails, instead of guessing", async () => {
            // ok:false must never collapse into "personal": org_id null is
            // the encoding of personal content, and a mis-stamped review
            // either leaks to an org it left or hides from the org that owns
            // it — and personal content is what account deletion destroys.
            seedMove("org-1");
            resolveContentOrgId.mockResolvedValue({
                ok: false,
                detail: "connection reset",
            });

            const res = await request(app)
                .patch("/tabular-review/r1")
                .set(...AUTH)
                .send({ project_id: "p-to" });

            expect(res.status).toBe(500);
            expect(res.body.detail).not.toContain("connection reset");
            expect(movePayload()).toBeUndefined();
        });

        it("restamps org_id from the destination project", async () => {
            seedMove(null);
            resolveContentOrgId.mockResolvedValue({ ok: true, orgId: "org-2" });

            const res = await request(app)
                .patch("/tabular-review/r1")
                .set(...AUTH)
                .send({ project_id: "p-to" });

            expect(res.status).toBe(200);
            expect(movePayload()).toMatchObject({
                project_id: "p-to",
                org_id: "org-2",
            });
            expect(resolveContentOrgId).toHaveBeenCalledWith(
                expect.anything(),
                { projectId: "p-to" },
            );
        });

        it("leaves org_id alone when the move is not part of the request", async () => {
            // Only a move restamps. A rename must not silently re-derive the
            // tenant, or an unrelated PATCH becomes a permission change.
            seedMove("org-1");

            const res = await request(app)
                .patch("/tabular-review/r1")
                .set(...AUTH)
                .send({ title: "Renamed" });

            expect(res.status).toBe(200);
            expect(movePayload()).not.toHaveProperty("org_id");
        });
    });

    // ── DELETE /tabular-review/:reviewId ──────────────────────────────────
    // Pins the `container.delete` row of the matrix on the review container:
    // owner tier deletes, everything below it is refused. The allow case is
    // the one the old `.eq("user_id", userId)` filter got wrong.
    describe("DELETE /tabular-review/:reviewId", () => {
        const seedReview = (rows: QueryResult[]) => {
            supabaseState.tables.tabular_reviews = rows;
        };
        const ownedRow = {
            data: { id: "r1", user_id: "u1", project_id: "p1" },
            error: null,
        };

        it("returns 204 when the review's own owner deletes it", async () => {
            seedReview([ownedRow, { data: null, error: null }]);
            ensureReviewAccess.mockResolvedValue({
                ok: true,
                isCreator: true,
                orgRole: null,
                projectRole: "owner",
            });

            const res = await request(app)
                .delete("/tabular-review/r1")
                .set(...AUTH);

            expect(res.status).toBe(204);
        });

        it("returns 204 when the project owner deletes a member's review", async () => {
            // Review row belongs to someone else, but the caller owns the
            // project it lives in — ensureReviewAccess hands back "owner", so
            // container.delete passes and the delete is NOT scoped to the
            // caller's user_id (the old filter made this a silent no-op).
            seedReview([
                {
                    data: { id: "r1", user_id: "member", project_id: "p1" },
                    error: null,
                },
                { data: null, error: null },
            ]);
            ensureReviewAccess.mockResolvedValue({
                ok: true,
                isCreator: false,
                orgRole: null,
                projectRole: "owner",
            });

            const res = await request(app)
                .delete("/tabular-review/r1")
                .set(...AUTH);

            expect(res.status).toBe(204);
        });

        it.each(["manager", "editor", "viewer"] as const)(
            "returns 403 when a %s tries to delete the review",
            async (projectRole) => {
                seedReview([
                    {
                        data: { id: "r1", user_id: "other", project_id: "p1" },
                        error: null,
                    },
                    { data: null, error: null },
                ]);
                ensureReviewAccess.mockResolvedValue({
                    ok: true,
                    isCreator: false,
                    orgRole: null,
                    projectRole,
                });

                const res = await request(app)
                    .delete("/tabular-review/r1")
                    .set(...AUTH);

                expect(res.status).toBe(403);
                expect(res.body.detail).toBe(
                    "You do not have permission to delete this review",
                );
                // Refused before any destructive statement ran.
                expect(supabaseState.operations).toEqual(["from:tabular_reviews"]);
            },
        );

        it("returns 404 when the review is missing", async () => {
            seedReview([{ data: null, error: null }]);

            const res = await request(app)
                .delete("/tabular-review/r1")
                .set(...AUTH);

            expect(res.status).toBe(404);
            expect(res.body.detail).toBe("Review not found");
        });

        it("returns 404 when the caller has no access at all", async () => {
            seedReview([ownedRow, { data: null, error: null }]);
            ensureReviewAccess.mockResolvedValue({ ok: false });

            const res = await request(app)
                .delete("/tabular-review/r1")
                .set(...AUTH);

            expect(res.status).toBe(404);
            expect(res.body.detail).toBe("Review not found");
        });

        it("returns 500 when the delete errors", async () => {
            seedReview([
                ownedRow,
                { data: null, error: { message: "delete failed" } },
            ]);
            ensureReviewAccess.mockResolvedValue({
                ok: true,
                isCreator: true,
                orgRole: null,
                projectRole: "owner",
            });

            const res = await request(app)
                .delete("/tabular-review/r1")
                .set(...AUTH);

            expect(res.status).toBe(500);
            expect(res.body.detail).toBe("Something went wrong. Please try again.");
        });
    });

    // ── POST /tabular-review/:reviewId/clear-cells ────────────────────────
    describe("POST /tabular-review/:reviewId/clear-cells", () => {
        it("returns 400 when row_ids is missing", async () => {
            const res = await request(app)
                .post("/tabular-review/r1/clear-cells")
                .set(...AUTH)
                .send({});

            expect(res.status).toBe(400);
            expect(res.body.detail).toBe("row_ids is required");
        });

        it("returns 404 when review access is denied", async () => {
            supabaseState.tables.tabular_reviews = {
                data: { id: "r1", user_id: "other", project_id: null },
                error: null,
            };
            ensureReviewAccess.mockResolvedValue({ ok: false });

            const res = await request(app)
                .post("/tabular-review/r1/clear-cells")
                .set(...AUTH)
                .send({ row_ids: ["row-1"] });

            expect(res.status).toBe(404);
            expect(res.body.detail).toBe("Review not found");
        });

        it("returns 403 for a viewer — clearing cells is member+", async () => {
            supabaseState.tables.tabular_reviews = {
                data: { id: "r1", user_id: "other", project_id: "p1" },
                error: null,
            };
            ensureReviewAccess.mockResolvedValue({
                ok: true,
                isCreator: false,
                orgRole: null,
                projectRole: "viewer",
            });

            const res = await request(app)
                .post("/tabular-review/r1/clear-cells")
                .set(...AUTH)
                .send({ row_ids: ["row-1"] });

            expect(res.status).toBe(403);
            expect(res.body.detail).toBe("Only a review editor can clear cells");
        });

        it("rejects clearing cells while generation holds the review lease", async () => {
            supabaseState.tables.tabular_reviews = {
                data: {
                    id: "r1",
                    user_id: "u1",
                    project_id: null,
                    active_generation_id: "00000000-0000-4000-8000-000000000001",
                    generation_lease_expires_at: "2099-01-01T00:00:00.000Z",
                },
                error: null,
            };

            const res = await request(app)
                .post("/tabular-review/r1/clear-cells")
                .set(...AUTH)
                .send({ row_ids: ["row-1"] });

            expect(res.status).toBe(409);
            expect(res.body).toEqual({
                code: "review_running",
                detail: "This tabular review is currently running.",
            });
            expect(supabaseState.operations).not.toContain("from:tabular_cells");
        });

        it("atomically rejects clearing when a run starts after the review read", async () => {
            supabaseState.tables.tabular_reviews = {
                data: {
                    id: "r1",
                    user_id: "u1",
                    project_id: null,
                    updated_at: "2026-08-22T10:00:00.000Z",
                },
                error: null,
            };
            supabaseState.rpc = { data: "running", error: null };

            const res = await request(app)
                .post("/tabular-review/r1/clear-cells")
                .set(...AUTH)
                .send({ row_ids: ["row-1"] });

            expect(res.status).toBe(409);
            expect(res.body.code).toBe("review_running");
            expect(supabaseState.rpcCalls[0]?.fn).toBe(
                "begin_tabular_review_generation",
            );
            expect(supabaseState.operations).not.toContain("from:tabular_cells");
        });

        it("returns 204 on success", async () => {
            supabaseState.tables.tabular_reviews = {
                data: {
                    id: "r1",
                    user_id: "u1",
                    project_id: null,
                    updated_at: "2026-08-22T10:00:00.000Z",
                },
                error: null,
            };
            supabaseState.rpc = { data: "started", error: null };

            const res = await request(app)
                .post("/tabular-review/r1/clear-cells")
                .set(...AUTH)
                .send({ row_ids: ["row-1"] });

            expect(res.status).toBe(204);
            expect(supabaseState.rpcCalls.map(({ fn }) => fn)).toEqual([
                "begin_tabular_review_generation",
                "finish_tabular_review_generation",
            ]);
        });
    });

    // ── POST /tabular-review/:reviewId/regenerate-cell ────────────────────
    describe("POST /tabular-review/:reviewId/regenerate-cell", () => {
        it("returns 400 when row_id / column_index are missing", async () => {
            const res = await request(app)
                .post("/tabular-review/r1/regenerate-cell")
                .set(...AUTH)
                .send({});

            expect(res.status).toBe(400);
      expect(res.body.detail).toBe("row_id and column_index are required");
        });

        it("returns 404 when review access is denied", async () => {
            supabaseState.tables.tabular_reviews = {
                data: { id: "r1", user_id: "other", project_id: null },
                error: null,
            };
            ensureReviewAccess.mockResolvedValue({ ok: false });

            const res = await request(app)
                .post("/tabular-review/r1/regenerate-cell")
                .set(...AUTH)
                .send({ row_id: "row-1", column_index: 0 });

            expect(res.status).toBe(404);
            expect(res.body.detail).toBe("Review not found");
        });

        it("rejects cell regeneration while generation holds the review lease", async () => {
            supabaseState.tables.tabular_reviews = {
                data: {
                    id: "r1",
                    user_id: "u1",
                    project_id: null,
                    active_generation_id: "00000000-0000-4000-8000-000000000001",
                    generation_lease_expires_at: "2099-01-01T00:00:00.000Z",
                    columns_config: [{ index: 0, name: "Col", prompt: "p" }],
                },
                error: null,
            };

            const res = await request(app)
                .post("/tabular-review/r1/regenerate-cell")
                .set(...AUTH)
                .send({ row_id: "row-1", column_index: 0 });

            expect(res.status).toBe(409);
            expect(res.body).toEqual({
                code: "review_running",
                detail: "This tabular review is currently running.",
            });
            expect(supabaseState.operations).not.toContain(
                "from:tabular_review_rows",
            );
        });

        it("atomically rejects regeneration when a run starts after the review read", async () => {
            supabaseState.tables.tabular_reviews = {
                data: {
                    id: "r1",
                    user_id: "u1",
                    project_id: null,
                    updated_at: "2026-08-22T10:00:00.000Z",
                    columns_config: [{ index: 0, name: "Col", prompt: "p" }],
                },
                error: null,
            };
            supabaseState.tables.tabular_review_rows = {
                data: [
                    {
                        id: "row-1",
                        review_id: "r1",
                        label: "Document",
                        row_type: "document",
                        document_id: "d1",
                        sort_index: 0,
                    },
                ],
                error: null,
            };
            supabaseState.tables.tabular_review_row_sources = {
                data: [{ row_id: "row-1", document_id: "d1" }],
                error: null,
            };
            supabaseState.rpc = { data: "running", error: null };

            const res = await request(app)
                .post("/tabular-review/r1/regenerate-cell")
                .set(...AUTH)
                .send({ row_id: "row-1", column_index: 0 });

            expect(res.status).toBe(409);
            expect(res.body.code).toBe("review_running");
            expect(supabaseState.rpcCalls[0]?.fn).toBe(
                "begin_tabular_review_generation",
            );
            expect(supabaseState.operations).not.toContain("from:tabular_cells");
        });

        it("returns 400 when the column is not configured", async () => {
            supabaseState.tables.tabular_reviews = {
                data: {
                    id: "r1",
                    user_id: "u1",
                    project_id: null,
                    columns_config: [{ index: 5, name: "Other", prompt: "p" }],
                },
                error: null,
            };

            const res = await request(app)
                .post("/tabular-review/r1/regenerate-cell")
                .set(...AUTH)
                .send({ row_id: "row-1", column_index: 0 });

            expect(res.status).toBe(400);
            expect(res.body.detail).toBe("Column not found");
        });

        it("returns 404 when a row source document is not accessible", async () => {
            supabaseState.tables.tabular_reviews = {
                data: {
                    id: "r1",
                    user_id: "u1",
                    project_id: null,
                    columns_config: [{ index: 0, name: "Col", prompt: "p" }],
                },
                error: null,
            };
            supabaseState.tables.tabular_review_rows = {
                data: [
                    {
                        id: "row-forbidden",
                        review_id: "r1",
                        label: "Forbidden",
                        row_type: "document",
                        document_id: "d-forbidden",
                        sort_index: 0,
                    },
                ],
                error: null,
            };
            supabaseState.tables.tabular_review_row_sources = {
                data: [
                    {
                        row_id: "row-forbidden",
                        document_id: "d-forbidden",
                    },
                ],
                error: null,
            };
            filterAccessibleDocumentIds.mockResolvedValue([]);

            const res = await request(app)
                .post("/tabular-review/r1/regenerate-cell")
                .set(...AUTH)
                .send({ row_id: "row-forbidden", column_index: 0 });

            expect(res.status).toBe(404);
            expect(res.body.detail).toBe("Review row not found");
        });

        it("returns 422 with missing_api_key when the model key is absent", async () => {
            supabaseState.tables.tabular_reviews = {
                data: {
                    id: "r1",
                    user_id: "u1",
                    project_id: null,
                    columns_config: [{ index: 0, name: "Col", prompt: "p" }],
                },
                error: null,
            };
            supabaseState.tables.tabular_review_rows = {
                data: [
                    {
                        id: "row-1",
                        review_id: "r1",
                        label: "Document",
                        row_type: "document",
                        document_id: "d1",
                        sort_index: 0,
                    },
                ],
                error: null,
            };
            supabaseState.tables.tabular_review_row_sources = {
                data: [{ row_id: "row-1", document_id: "d1" }],
                error: null,
            };
            getUserModelSettings.mockResolvedValue({
                title_model: "claude-haiku-4-5",
                tabular_model: "claude-sonnet-5",
                legal_research_us: false,
                api_keys: {},
            });

            const res = await request(app)
                .post("/tabular-review/r1/regenerate-cell")
                .set(...AUTH)
                .send({ row_id: "row-1", column_index: 0 });

            expect(res.status).toBe(422);
            expect(res.body.code).toBe("missing_api_key");
            expect(res.body.provider).toBe("claude");
        });
    });

    // ── POST /tabular-review/:reviewId/generate (streaming GUARDS only) ───
    describe("POST /tabular-review/:reviewId/generate", () => {
        it("returns 404 when the review does not exist", async () => {
            supabaseState.tables.tabular_reviews = { data: null, error: null };

            const res = await request(app)
                .post("/tabular-review/r1/generate")
                .set(...AUTH);

            expect(res.status).toBe(404);
            expect(res.body.detail).toBe("Review not found");
        });

        it("returns 404 when review access is denied", async () => {
            supabaseState.tables.tabular_reviews = {
                data: { id: "r1", user_id: "other", project_id: null },
                error: null,
            };
            ensureReviewAccess.mockResolvedValue({ ok: false });

            const res = await request(app)
                .post("/tabular-review/r1/generate")
                .set(...AUTH);

            expect(res.status).toBe(404);
            expect(res.body.detail).toBe("Review not found");
        });

        // ── the write gate ────────────────────────────────────────────────
        // GENERATION IS A WRITE: it claims the review's generation lease,
        // spends the caller's model credit, persists a cell per column per
        // row and stamps an audit event in the caller's name. `access.ok`
        // alone let a review VIEWER do all of that.
        it("refuses a viewer with 403, not 404, and starts nothing", async () => {
            supabaseState.tables.tabular_reviews = {
                data: {
                    id: "r1",
                    user_id: "other",
                    project_id: "p1",
                    columns_config: [{ index: 0, name: "Col", prompt: "p" }],
                },
                error: null,
            };
            ensureReviewAccess.mockResolvedValue({
                ok: true,
                isCreator: false,
                orgRole: "member",
                projectRole: "viewer",
            });

            const res = await request(app)
                .post("/tabular-review/r1/generate")
                .set(...AUTH)
                .send({ expected_updated_at: new Date().toISOString() });

            // 403 with a reason, because the viewer CAN see this review —
            // telling them it does not exist is a lie the UI then repeats.
            expect(res.status).toBe(403);
            expect(res.body.detail).toBe(REVIEW_EDIT_FORBIDDEN);
            // And no side effects: no generation lease, no cells, no audit.
            expect(supabaseState.rpcCalls).toEqual([]);
            expect(supabaseState.inserts).toEqual([]);
            expect(supabaseState.updates).toEqual([]);
        });

        it("lets an editor past the gate", async () => {
            // Empty columns_config, so the next guard in prepareTabularGenerate
            // answers — which is how the test proves the WRITE gate was
            // passed without entering the streaming loop.
            supabaseState.tables.tabular_reviews = {
                data: {
                    id: "r1",
                    user_id: "other",
                    project_id: "p1",
                    columns_config: [],
                },
                error: null,
            };
            ensureReviewAccess.mockResolvedValue({
                ok: true,
                isCreator: false,
                orgRole: "member",
                projectRole: "editor",
            });

            const res = await request(app)
                .post("/tabular-review/r1/generate")
                .set(...AUTH);

            expect(res.status).toBe(400);
            expect(res.body.detail).toBe("No columns configured");
        });

        it("still answers 404 to a caller with no verdict at all", async () => {
            // The split must keep the 404 for a non-member: 403 would confirm
            // the review exists to somebody who cannot see it.
            supabaseState.tables.tabular_reviews = {
                data: {
                    id: "r1",
                    user_id: "other",
                    project_id: "p1",
                    columns_config: [{ index: 0, name: "Col", prompt: "p" }],
                },
                error: null,
            };
            ensureReviewAccess.mockResolvedValue({ ok: false });

            const res = await request(app)
                .post("/tabular-review/r1/generate")
                .set(...AUTH);

            expect(res.status).toBe(404);
            expect(res.body.detail).toBe("Review not found");
        });

        it("refuses a viewer on the reconnect stream as well", async () => {
            // The reconnect stream resumes a run this caller was entitled to
            // START, and a viewer never was. Leaving it open would have made
            // the POST gate cosmetic: the same generation channel, one URL
            // away.
            supabaseState.tables.tabular_reviews = {
                data: {
                    id: "r1",
                    user_id: "other",
                    project_id: "p1",
                    columns_config: [{ index: 0, name: "Col", prompt: "p" }],
                },
                error: null,
            };
            ensureReviewAccess.mockResolvedValue({
                ok: true,
                isCreator: false,
                orgRole: "member",
                projectRole: "viewer",
            });

            const res = await request(app)
                .get("/tabular-review/r1/generate/stream")
                .set(...AUTH);

            expect(res.status).toBe(403);
            expect(res.body.detail).toBe(REVIEW_EDIT_FORBIDDEN);
            expect(supabaseState.rpcCalls).toEqual([]);
        });

        it("blocks a run when the review has no selected model", async () => {
            supabaseState.tables.tabular_reviews = {
                data: {
                    id: "r1",
                    user_id: "u1",
                    project_id: null,
                    columns_config: [{ index: 0, name: "Col", prompt: "p" }],
                    model: null,
                },
                error: null,
            };

            const res = await request(app)
                .post("/tabular-review/r1/generate")
                .set(...AUTH)
                .send({ expected_updated_at: new Date().toISOString() });

            expect(res.status).toBe(409);
            expect(res.body.code).toBe("model_required");
            expect(supabaseState.rpcCalls).toHaveLength(0);
        });

        it("returns 400 when no columns are configured", async () => {
            supabaseState.tables.tabular_reviews = {
                data: {
                    id: "r1",
                    user_id: "u1",
                    project_id: null,
                    columns_config: [],
                },
                error: null,
            };

            const res = await request(app)
                .post("/tabular-review/r1/generate")
                .set(...AUTH);

            expect(res.status).toBe(400);
            expect(res.body.detail).toBe("No columns configured");
        });

        it("returns 422 missing_api_key before streaming when the key is absent", async () => {
            supabaseState.tables.tabular_reviews = {
                data: {
                    id: "r1",
                    user_id: "u1",
                    project_id: null,
                    columns_config: [{ index: 0, name: "Col", prompt: "p" }],
                },
                error: null,
            };
            supabaseState.tables.tabular_cells = { data: [], error: null };
            getUserModelSettings.mockResolvedValue({
                title_model: "claude-haiku-4-5",
                tabular_model: "claude-sonnet-5",
                legal_research_us: false,
                api_keys: {},
            });

            const res = await request(app)
                .post("/tabular-review/r1/generate")
                .set(...AUTH);

            expect(res.status).toBe(422);
            expect(res.body.code).toBe("missing_api_key");
        });

        it("requires the version currently loaded by the client", async () => {
            supabaseState.tables.tabular_reviews = {
                data: {
                    id: "r1",
                    user_id: "u1",
                    project_id: null,
                    updated_at: "2026-08-22T10:00:00.000Z",
                    columns_config: [{ index: 0, name: "Col", prompt: "p" }],
                },
                error: null,
            };
            supabaseState.tables.tabular_cells = { data: [], error: null };

            const res = await request(app)
                .post("/tabular-review/r1/generate")
                .set(...AUTH)
                .send({});

            expect(res.status).toBe(400);
            expect(res.body.detail).toBe(
                "expected_updated_at must be a valid timestamp",
            );
        });

        it("claims the lease before loading rows and cells", async () => {
            supabaseState.tables.tabular_reviews = {
                data: {
                    id: "r1",
                    user_id: "u1",
                    project_id: null,
                    updated_at: "2026-08-22T10:00:00.000Z",
                    columns_config: [{ index: 0, name: "Col", prompt: "p" }],
                },
                error: null,
            };
            supabaseState.tables.tabular_review_rows = {
                data: [],
                error: null,
            };
            supabaseState.tables.tabular_cells = {
                data: null,
                error: { message: "cell snapshot failed" },
            };
            supabaseState.rpc = { data: "started", error: null };

            const res = await request(app)
                .post("/tabular-review/r1/generate")
                .set(...AUTH)
                .send({
                    expected_updated_at: "2026-08-22T10:00:00.000Z",
                });

            expect(res.status).toBe(500);
            expect(res.body.detail).toBe(
                "Something went wrong. Please try again.",
            );
            const beginIndex = supabaseState.operations.indexOf(
                "rpc:begin_tabular_review_generation",
            );
            const rowsIndex = supabaseState.operations.indexOf(
                "from:tabular_review_rows",
            );
            const cellsIndex = supabaseState.operations.indexOf(
                "from:tabular_cells",
            );
            expect(beginIndex).toBeGreaterThanOrEqual(0);
            expect(rowsIndex).toBeGreaterThan(beginIndex);
            expect(cellsIndex).toBeGreaterThan(rowsIndex);
            expect(supabaseState.rpcCalls.at(-1)?.fn).toBe(
                "finish_tabular_review_generation",
            );
        });

        it.each([
            [
                "running",
                "review_running",
                "This tabular review is already running elsewhere.",
            ],
            [
                "stale",
                "review_stale",
                "A newer version of this tabular review is available.",
            ],
        ])(
            "returns a distinct conflict when the atomic start result is %s",
            async (startResult, code, detail) => {
                supabaseState.tables.tabular_reviews = {
                    data: {
                        id: "r1",
                        user_id: "u1",
                        project_id: null,
                        updated_at: "2026-08-22T10:00:00.000Z",
                        columns_config: [
                            { index: 0, name: "Col", prompt: "p" },
                        ],
                    },
                    error: null,
                };
                supabaseState.tables.tabular_cells = {
                    data: [],
                    error: null,
                };
                supabaseState.rpc = { data: startResult, error: null };

                const res = await request(app)
                    .post("/tabular-review/r1/generate")
                    .set(...AUTH)
                    .send({
                        expected_updated_at: "2026-08-22T10:00:00.000Z",
                    });

                expect(res.status).toBe(409);
                expect(res.body).toEqual({ code, detail });
                expect(supabaseState.rpcCalls[0]).toMatchObject({
                    fn: "begin_tabular_review_generation",
                    args: {
                        target_review_id: "r1",
                        expected_updated_at: "2026-08-22T10:00:00.000Z",
                    },
                });
            },
        );
    });

    // ── POST /tabular-review/:reviewId/chat (streaming GUARDS only) ───────
    describe("POST /tabular-review/:reviewId/chat", () => {
        it("returns 400 when no user message is present", async () => {
            const res = await request(app)
                .post("/tabular-review/r1/chat")
                .set(...AUTH)
                .send({ messages: [{ role: "assistant", content: "hi" }] });

            expect(res.status).toBe(400);
            expect(res.body.detail).toBe("messages must include a user message");
        });

        it("returns 404 when review access is denied", async () => {
            supabaseState.tables.tabular_reviews = {
                data: { id: "r1", user_id: "other", project_id: null },
                error: null,
            };
            ensureReviewAccess.mockResolvedValue({ ok: false });

            const res = await request(app)
                .post("/tabular-review/r1/chat")
                .set(...AUTH)
                .send({ messages: [{ role: "user", content: "hello" }] });

            expect(res.status).toBe(404);
            expect(res.body.detail).toBe("Review not found");
        });

        it("refuses a viewer with 403 rather than claiming the review is gone", async () => {
            // Review chat writes: it persists messages and can reshape the
            // review. A viewer used to be told "Review not found" for a
            // review sitting open on their screen.
            supabaseState.tables.tabular_reviews = {
                data: { id: "r1", user_id: "other", project_id: "p1" },
                error: null,
            };
            ensureReviewAccess.mockResolvedValue({
                ok: true,
                isCreator: false,
                orgRole: "member",
                projectRole: "viewer",
            });

            const res = await request(app)
                .post("/tabular-review/r1/chat")
                .set(...AUTH)
                .send({ messages: [{ role: "user", content: "hello" }] });

            expect(res.status).toBe(403);
            expect(res.body.detail).toBe(REVIEW_EDIT_FORBIDDEN);
            expect(supabaseState.inserts).toEqual([]);
        });

        it("returns 422 missing_api_key before streaming when the key is absent", async () => {
            supabaseState.tables.tabular_reviews = {
                data: {
                    id: "r1",
                    user_id: "u1",
                    project_id: null,
                    columns_config: [],
                },
                error: null,
            };
            supabaseState.tables.tabular_cells = { data: [], error: null };
            getUserModelSettings.mockResolvedValue({
                title_model: "claude-haiku-4-5",
                tabular_model: "claude-sonnet-5",
                legal_research_us: false,
                api_keys: {},
            });

            const res = await request(app)
                .post("/tabular-review/r1/chat")
                .set(...AUTH)
                .send({
                    messages: [{ role: "user", content: "hello" }],
                    model: "claude-sonnet-5",
                });

            expect(res.status).toBe(422);
            expect(res.body.code).toBe("missing_api_key");
        });
    });

    describe("PATCH /tabular-review/:reviewId/chats/:chatId", () => {
        it("persists the chat model and reasoning independently", async () => {
            supabaseState.tables.tabular_reviews = {
                data: { id: "r1", user_id: "u1", project_id: null },
                error: null,
            };
            ensureReviewAccess.mockResolvedValue({
                ok: true,
                isCreator: true,
                orgRole: null,
                projectRole: "owner",
            });
            supabaseState.tables.tabular_review_chats = {
                data: {
                    id: "chat-1",
                    title: "Chat",
                    model: "claude-sonnet-5",
                    reasoning_level: "high",
                    review_id: "r1",
                    user_id: "u1",
                },
                error: null,
            };
            getUserModelSettings.mockResolvedValue({
                title_model: "claude-haiku-4-5",
                tabular_model: "claude-sonnet-5",
                last_selected_chat_model: "claude-sonnet-5",
                last_selected_reasoning_level: "high",
                legal_research_us: false,
                api_keys: { openai: "sk-test" },
            });

            const res = await request(app)
                .patch("/tabular-review/r1/chats/chat-1")
                .set(...AUTH)
                .send({ model: "gpt-5.6-sol", reasoningLevel: "low" });

            expect(res.status).toBe(200);
            expect(supabaseState.updates).toContainEqual({
                table: "tabular_review_chats",
                payload: expect.objectContaining({
                    model: "gpt-5.6-sol",
                    reasoning_level: "low",
                }),
            });
        });
    });

    // ── GET /tabular-review/:reviewId/chats ───────────────────────────────
    describe("GET /tabular-review/:reviewId/chats", () => {
        it("returns 404 when review access is denied", async () => {
            supabaseState.tables.tabular_reviews = {
                data: { id: "r1", user_id: "other", project_id: null },
                error: null,
            };
            ensureReviewAccess.mockResolvedValue({ ok: false });

            const res = await request(app)
                .get("/tabular-review/r1/chats")
                .set(...AUTH);

            expect(res.status).toBe(404);
            expect(res.body.detail).toBe("Review not found");
        });

        it("returns the chat list when access is granted", async () => {
            supabaseState.tables.tabular_reviews = {
                data: { id: "r1", user_id: "u1", project_id: null },
                error: null,
            };
            supabaseState.tables.tabular_review_chats = {
                data: [{ id: "chat-1", title: "T", user_id: "u1" }],
                error: null,
            };

            const res = await request(app)
                .get("/tabular-review/r1/chats")
                .set(...AUTH);

            expect(res.status).toBe(200);
      expect(res.body).toEqual([{ id: "chat-1", title: "T", user_id: "u1" }]);
        });
    });

    // ── DELETE / PATCH /tabular-review/:reviewId/chats/:chatId ────────────
    // Both writes share one preamble: the review in the URL must exist and be
    // accessible, and the chat must actually belong to THAT review. Without
    // it, any chat id could be reached through any (or a nonexistent) review
    // path — the ownership filter on the write was the only thing standing
    // between a caller and someone else's thread.
    describe("review-chat writes", () => {
        const CHAT_IN_R1 = {
            data: { id: "chat-1", review_id: "r1", user_id: "u1" },
            error: null,
        };

        it("returns 404 when the review does not exist", async () => {
            supabaseState.tables.tabular_reviews = { data: null, error: null };
            supabaseState.tables.tabular_review_chats = CHAT_IN_R1;

            const del = await request(app)
                .delete("/tabular-review/r-missing/chats/chat-1")
                .set(...AUTH);
            expect(del.status).toBe(404);
            expect(del.body.detail).toBe("Review not found");

            const rename = await request(app)
                .patch("/tabular-review/r-missing/chats/chat-1")
                .set(...AUTH)
                .send({ title: "Renamed" });
            expect(rename.status).toBe(404);
            expect(rename.body.detail).toBe("Review not found");
        });

        it("returns 404 when the caller has no access to the review", async () => {
            supabaseState.tables.tabular_reviews = {
                data: { id: "r1", user_id: "other", project_id: null },
                error: null,
            };
            supabaseState.tables.tabular_review_chats = CHAT_IN_R1;
            ensureReviewAccess.mockResolvedValue({ ok: false });

            const del = await request(app)
                .delete("/tabular-review/r1/chats/chat-1")
                .set(...AUTH);
            expect(del.status).toBe(404);
            expect(del.body.detail).toBe("Review not found");

            const rename = await request(app)
                .patch("/tabular-review/r1/chats/chat-1")
                .set(...AUTH)
                .send({ title: "Renamed" });
            expect(rename.status).toBe(404);
            expect(rename.body.detail).toBe("Review not found");
        });

        it("returns 404 when the chat belongs to a different review", async () => {
            supabaseState.tables.tabular_reviews = {
                data: { id: "r1", user_id: "u1", project_id: null },
                error: null,
            };
            supabaseState.tables.tabular_review_chats = {
                data: { id: "chat-1", review_id: "r2" },
                error: null,
            };

            const del = await request(app)
                .delete("/tabular-review/r1/chats/chat-1")
                .set(...AUTH);
            expect(del.status).toBe(404);
            expect(del.body.detail).toBe("Chat not found");

            const rename = await request(app)
                .patch("/tabular-review/r1/chats/chat-1")
                .set(...AUTH)
                .send({ title: "Renamed" });
            expect(rename.status).toBe(404);
            expect(rename.body.detail).toBe("Chat not found");
        });

        it("returns 404 when the chat does not exist", async () => {
            supabaseState.tables.tabular_reviews = {
                data: { id: "r1", user_id: "u1", project_id: null },
                error: null,
            };
            supabaseState.tables.tabular_review_chats = {
                data: null,
                error: null,
            };

            const res = await request(app)
                .delete("/tabular-review/r1/chats/chat-missing")
                .set(...AUTH);

            expect(res.status).toBe(404);
            expect(res.body.detail).toBe("Chat not found");
        });

        it("returns 403 for a collaborator who is not the chat's creator", async () => {
            // The review IS accessible (shared/org collaborator), but the
            // chat belongs to someone else. Before the owner check lived in
            // the gate, this returned a success-shaped 204 while the
            // user_id-scoped write silently matched zero rows.
            supabaseState.tables.tabular_reviews = {
                data: { id: "r1", user_id: "other", project_id: null },
                error: null,
            };
            supabaseState.tables.tabular_review_chats = {
                data: { id: "chat-1", review_id: "r1", user_id: "other" },
                error: null,
            };

            const rename = await request(app)
                .patch("/tabular-review/r1/chats/chat-1")
                .set(...AUTH)
                .send({ title: "Renamed" });
            expect(rename.status).toBe(403);
            expect(rename.body.detail).toBe(
                "Only the chat's creator can modify it",
            );

            const del = await request(app)
                .delete("/tabular-review/r1/chats/chat-1")
                .set(...AUTH);
            expect(del.status).toBe(403);
            expect(del.body.detail).toBe(
                "Only the chat's creator can modify it",
            );
        });

        // A departed creator leaves `user_id` NULL (the FK is ON DELETE SET
        // NULL since 20260902_01). "Only the creator may act" would then mean
        // NOBODY may act, and the thread would sit in the organization's
        // review forever with no way to rename or remove it. #267's
        // `creatorScopedAllowed` exists for exactly this: an authorship-scoped
        // operation falls through to the container's admins once the author
        // is gone.
        const ORPHANED_CHAT = {
            data: { id: "chat-1", review_id: "r1", user_id: null },
            error: null,
        };

        it("lets an admin modify a chat whose creator's account was deleted", async () => {
            supabaseState.tables.tabular_reviews = {
                data: { id: "r1", user_id: null, project_id: "p1" },
                error: null,
            };
            supabaseState.tables.tabular_review_chats = ORPHANED_CHAT;
            ensureReviewAccess.mockResolvedValue({
                ok: true,
                isCreator: false,
                orgRole: "admin",
                projectRole: "owner",
            });

            const rename = await request(app)
                .patch("/tabular-review/r1/chats/chat-1")
                .set(...AUTH)
                .send({ title: "Renamed" });
            expect(rename.status).toBe(200);

            const del = await request(app)
                .delete("/tabular-review/r1/chats/chat-1")
                .set(...AUTH);
            expect(del.status).toBe(204);
        });

        it("still refuses a plain member the same orphaned chat", async () => {
            // Inheriting an authorship-scoped operation is an ADMIN power —
            // the tier that could already delete the whole container. A
            // member gains nothing from the creator's departure.
            supabaseState.tables.tabular_reviews = {
                data: { id: "r1", user_id: null, project_id: "p1" },
                error: null,
            };
            supabaseState.tables.tabular_review_chats = ORPHANED_CHAT;
            ensureReviewAccess.mockResolvedValue({
                ok: true,
                isCreator: false,
                orgRole: "member",
                projectRole: "editor",
            });

            const rename = await request(app)
                .patch("/tabular-review/r1/chats/chat-1")
                .set(...AUTH)
                .send({ title: "Renamed" });
            expect(rename.status).toBe(403);
            expect(rename.body.detail).toBe(
                "Only the chat's creator can modify it",
            );

            const del = await request(app)
                .delete("/tabular-review/r1/chats/chat-1")
                .set(...AUTH);
            expect(del.status).toBe(403);
        });

        it("does not let an admin touch a LIVE colleague's chat", async () => {
            // The relaxation is scoped to the creator being GONE. While one
            // exists, an admin still may not rename their thread — which is
            // what stops `creatorScopedAllowed` from quietly becoming
            // "admins can do anything".
            supabaseState.tables.tabular_reviews = {
                data: { id: "r1", user_id: "other", project_id: "p1" },
                error: null,
            };
            supabaseState.tables.tabular_review_chats = {
                data: { id: "chat-1", review_id: "r1", user_id: "other" },
                error: null,
            };
            ensureReviewAccess.mockResolvedValue({
                ok: true,
                isCreator: false,
                orgRole: "admin",
                projectRole: "owner",
            });

            const rename = await request(app)
                .patch("/tabular-review/r1/chats/chat-1")
                .set(...AUTH)
                .send({ title: "Renamed" });
            expect(rename.status).toBe(403);
        });

        it("returns 204 for the owner once the review and chat line up", async () => {
            supabaseState.tables.tabular_reviews = {
                data: { id: "r1", user_id: "u1", project_id: null },
                error: null,
            };
            supabaseState.tables.tabular_review_chats = CHAT_IN_R1;

            const rename = await request(app)
                .patch("/tabular-review/r1/chats/chat-1")
                .set(...AUTH)
                .send({ title: "Renamed" });
            expect(rename.status).toBe(200);

            const del = await request(app)
                .delete("/tabular-review/r1/chats/chat-1")
                .set(...AUTH);
            expect(del.status).toBe(204);
        });
    });
});
