import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

// ---------------------------------------------------------------------------
// DELETE /single-documents/:documentId — the container's rule, not `user_id`.
//
// This route used to scope its lookup with `.eq("user_id", userId)`, which
// answered "Document not found" for anything the caller had not personally
// uploaded. Two consequences:
//
//   * an organization admin could not remove a colleague's document from a
//     matter the firm owns, and
//   * once account deletion started blanking documents.user_id instead of
//     destroying organization content, NOBODY could remove a departed
//     colleague's document — the row was stranded in a project the
//     organization is supposed to control.
//
// It now resolves the document through ensureDocAccess and applies the same
// creator-scoped rule as DELETE .../versions/:versionId.
// ---------------------------------------------------------------------------

const { ensureDocAccess } = vi.hoisted(() => ({ ensureDocAccess: vi.fn() }));

type Row = Record<string, unknown>;

// FILTER-AWARE, deliberately. The previous stub answered per TABLE and threw
// every `.eq()` away, so a route that scoped its lookup with
// `.eq("user_id", userId)` and a route that did not returned the same row —
// which is precisely the difference these tests exist to see. Honouring
// eq/in/is is what makes "an org admin may delete a colleague's document"
// and "the creator scope is gone" observable at all.
let rows: Record<string, Row[]>;
let errors: Record<string, { message: string } | undefined>;
/** Tables a delete was issued against, in order. */
const deletes: string[] = [];
/** Update payloads, so a soft-delete can be asserted on. */
const updates: { table: string; payload: Row }[] = [];

function makeQuery(table: string) {
    const filters: {
        kind: "eq" | "in" | "is";
        column: string;
        value: unknown;
    }[] = [];
    let op: "select" | "delete" | "update" = "select";
    let payload: Row = {};

    const q: Record<string, unknown> = {};
    for (const m of ["select", "upsert", "insert", "or", "not", "order", "limit"])
        q[m] = vi.fn(() => q);
    for (const kind of ["eq", "in", "is"] as const)
        q[kind] = vi.fn((column: string, value: unknown) => {
            filters.push({ kind, column, value });
            return q;
        });
    q.update = vi.fn((value: Row) => {
        op = "update";
        payload = value;
        return q;
    });
    q.delete = vi.fn(() => {
        op = "delete";
        return q;
    });

    const matches = () =>
        (rows[table] ?? []).filter((row) =>
            filters.every((filter) => {
                if (filter.kind === "in")
                    return (filter.value as unknown[]).includes(
                        row[filter.column],
                    );
                // A missing column and an explicit null mean the same thing
                // here, exactly as they do in the column itself.
                return (row[filter.column] ?? null) === (filter.value ?? null);
            }),
        );

    const settle = () => {
        const error = errors[table];
        if (error) return { data: null, error };
        const hits = matches();
        if (op === "delete") {
            deletes.push(table);
            rows[table] = (rows[table] ?? []).filter(
                (row) => !hits.includes(row),
            );
            return { data: hits, error: null };
        }
        if (op === "update") {
            updates.push({ table, payload });
            for (const row of hits) Object.assign(row, payload);
            return { data: hits, error: null };
        }
        return { data: hits, error: null };
    };

    q.single = vi.fn(async () => {
        const { data, error } = settle();
        return { data: (data as Row[] | null)?.[0] ?? null, error };
    });
    q.maybeSingle = q.single;
    q.then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve(settle()).then(resolve);
    return q;
}

vi.mock("../../lib/supabase", () => ({
    createServerSupabase: vi.fn(() => ({
        from: vi.fn((table: string) => makeQuery(table)),
        rpc: vi.fn(async () => ({ data: null, error: null })),
        auth: {
            getUser: async () => ({ data: { user: { id: "u1" } }, error: null }),
        },
    })),
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

// Only the verdict is stubbed; creatorScopedAllowed stays real, because the
// rule under test IS that helper's "the creator is gone, so the container's
// Owners inherit" branch.
vi.mock("../../lib/access", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../lib/access")>()),
    ensureDocAccess: (...args: unknown[]) => ensureDocAccess(...args),
}));

vi.mock("../../lib/dbq/enqueue", () => ({
    enqueueStorageCleanup: vi.fn(async () => {}),
    enqueueDbJob: vi.fn(async () => ({ ok: true })),
}));

import { app } from "../../app";

const AUTH = ["Authorization", "Bearer test"] as const;
const DOC = "11111111-1111-4111-8111-111111111111";

const access = (projectRole: string, isCreator: boolean) => ({
    ok: true,
    isCreator,
    orgRole: "admin",
    projectRole,
});

describe("DELETE /single-documents/:documentId", () => {
    beforeEach(() => {
        deletes.length = 0;
        updates.length = 0;
        errors = {};
        rows = {
            documents: [
                {
                    id: DOC,
                    user_id: "u2",
                    project_id: "p1",
                    org_id: "o1",
                    workflow_id: null,
                },
            ],
            document_versions: [],
        };
        ensureDocAccess.mockResolvedValue(access("owner", false));
    });

    it("deletes a detached document nobody else could reach", async () => {
        // user_id NULL: the uploader's account is gone, so "only the creator
        // may delete" would mean nobody ever can.
        rows.documents = [
            {
                id: DOC,
                user_id: null,
                project_id: "p1",
                org_id: "o1",
                workflow_id: null,
            },
        ];

        const res = await request(app)
            .delete(`/single-documents/${DOC}`)
            .set(...AUTH);

        expect(res.status).toBe(204);
        expect(deletes).toContain("documents");
    });

    it("deletes the caller's own document", async () => {
        ensureDocAccess.mockResolvedValue(access("owner", true));

        const res = await request(app)
            .delete(`/single-documents/${DOC}`)
            .set(...AUTH);

        expect(res.status).toBe(204);
    });

    it("refuses a live colleague's document with 403, not a fake 404", async () => {
        const res = await request(app)
            .delete(`/single-documents/${DOC}`)
            .set(...AUTH);

        expect(res.status).toBe(403);
        expect(res.body.detail).toBe(
            "You do not have permission to delete this document.",
        );
        expect(deletes).not.toContain("documents");
    });

    it("keeps 404 for a document the caller cannot see at all", async () => {
        ensureDocAccess.mockResolvedValue({ ok: false });

        const res = await request(app)
            .delete(`/single-documents/${DOC}`)
            .set(...AUTH);

        expect(res.status).toBe(404);
        expect(deletes).not.toContain("documents");
    });

    it("lets an organization admin delete a departed colleague's document", async () => {
        // The stub now honours `.eq()`, so a `.eq("user_id", userId)` scope on
        // the lookup would hand this route a null row and a 404 — which is
        // exactly what it used to do. Account deletion blanks
        // documents.user_id rather than destroying organization content, so
        // under the old scope NOBODY could remove this row: it sat stranded
        // in a matter the firm is supposed to control.
        rows.documents = [
            {
                id: DOC,
                user_id: null,
                project_id: "p1",
                org_id: "o1",
                workflow_id: null,
            },
        ];
        ensureDocAccess.mockResolvedValue(access("owner", false));

        const res = await request(app)
            .delete(`/single-documents/${DOC}`)
            .set(...AUTH);

        expect(res.status).toBe(204);
        // The row is really gone, not merely "no error".
        expect(rows.documents).toEqual([]);
    });

    it("refuses a non-creator editor deleting a live colleague's document", async () => {
        // Widening the lookup past `user_id` must not widen the RULE: the
        // creator-scoped check still applies, and an Editor who did not
        // upload this file may not delete it.
        ensureDocAccess.mockResolvedValue(access("editor", false));

        const res = await request(app)
            .delete(`/single-documents/${DOC}`)
            .set(...AUTH);

        expect(res.status).toBe(403);
        expect(res.body.detail).toBe(
            "You do not have permission to delete this document.",
        );
        expect(rows.documents).toHaveLength(1);
    });

    it("lets a workflow asset be removed by anyone who may edit the workflow", async () => {
        rows.documents = [
            {
                id: DOC,
                user_id: "u2",
                project_id: null,
                org_id: "o1",
                workflow_id: "w1",
            },
        ];
        ensureDocAccess.mockResolvedValue(access("editor", false));

        const res = await request(app)
            .delete(`/single-documents/${DOC}`)
            .set(...AUTH);

        expect(res.status).toBe(204);
    });
});

// ---------------------------------------------------------------------------
// DELETE /single-documents/:documentId/versions/:versionId
//
// The same split as the whole-document DELETE: no verdict at all is a 404,
// and a caller who can OPEN the document but may not delete this version is
// refused by name. Collapsing both into 404 told a Viewer their version had
// vanished — and then the document list re-rendered it.
// ---------------------------------------------------------------------------

const V1 = "22222222-2222-4222-8222-222222222221";
const V2 = "22222222-2222-4222-8222-222222222222";

describe("DELETE /single-documents/:documentId/versions/:versionId", () => {
    beforeEach(() => {
        deletes.length = 0;
        updates.length = 0;
        errors = {};
        rows = {
            documents: [
                {
                    id: DOC,
                    user_id: "u2",
                    project_id: "p1",
                    org_id: "o1",
                    workflow_id: null,
                    current_version_id: V2,
                },
            ],
            document_versions: [
                {
                    id: V1,
                    document_id: DOC,
                    storage_path: null,
                    pdf_storage_path: null,
                    version_number: 1,
                    created_at: "2026-09-01T00:00:00Z",
                    deleted_at: null,
                },
                {
                    id: V2,
                    document_id: DOC,
                    storage_path: null,
                    pdf_storage_path: null,
                    version_number: 2,
                    created_at: "2026-09-02T00:00:00Z",
                    deleted_at: null,
                },
            ],
        };
        ensureDocAccess.mockResolvedValue(access("editor", false));
    });

    it("refuses a non-creator editor with 403 and a reason", async () => {
        const res = await request(app)
            .delete(`/single-documents/${DOC}/versions/${V2}`)
            .set(...AUTH);

        expect(res.status).toBe(403);
        expect(res.body.detail).toBe(
            "You do not have permission to delete this version.",
        );
        // Nothing was soft-deleted and current_version_id did not move.
        expect(updates).toEqual([]);
        expect(rows.documents[0].current_version_id).toBe(V2);
    });

    it("keeps 404 for a caller with no verdict at all", async () => {
        // A non-member must not learn that the document exists.
        ensureDocAccess.mockResolvedValue({ ok: false });

        const res = await request(app)
            .delete(`/single-documents/${DOC}/versions/${V2}`)
            .set(...AUTH);

        expect(res.status).toBe(404);
        expect(res.body.detail).toBe("Document not found");
        expect(updates).toEqual([]);
    });

    it("lets the version's creator through the gate", async () => {
        ensureDocAccess.mockResolvedValue(access("editor", true));
        rows.documents[0].user_id = "u1";

        const res = await request(app)
            .delete(`/single-documents/${DOC}/versions/${V2}`)
            .set(...AUTH);

        expect(res.status).toBe(200);
        expect(res.body.deleted_version_id).toBe(V2);
        // The current version fell back to the newest survivor.
        expect(res.body.current_version_id).toBe(V1);
        expect(
            updates.some((update) => update.table === "document_versions"),
        ).toBe(true);
    });
});
