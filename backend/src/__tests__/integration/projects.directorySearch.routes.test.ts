import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

// ---------------------------------------------------------------------------
// GET /projects?view=directory-search — the document picker's own access
// branches.
//
// This route resolves the same project three different ways (created by me,
// granted to me, in one of my orgs) and the shared per-table stub used by
// projects.routes.test.ts cannot tell those reads apart. So this file drives
// a FILTER-AWARE db instead, and records the filters each read was issued
// with — the shape of the override query is itself one of the things under
// test, not just its answer.
// ---------------------------------------------------------------------------

function mockSupabase() {
    return {
        from: vi.fn(() => {
            const q: Record<string, unknown> = {};
            for (const method of [
                "select",
                "update",
                "delete",
                "upsert",
                "insert",
                "eq",
                "neq",
                "in",
                "is",
                "or",
                "not",
                "ilike",
                "order",
                "limit",
                "range",
            ])
                q[method] = vi.fn(() => q);
            q.single = vi.fn(() => Promise.resolve({ data: null, error: null }));
            q.maybeSingle = q.single;
            q.then = (resolve: (v: unknown) => unknown) =>
                Promise.resolve({ data: [], error: null }).then(resolve);
            return q;
        }),
        rpc: vi.fn(() => Promise.resolve({ data: [], error: null })),
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

// Every export of lib/access must survive — the other routers mounted by the
// app import from it at load time.
vi.mock("../../lib/access", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../lib/access")>()),
    checkProjectAccess: vi.fn(async () => ({ ok: false })),
    ensureDocAccess: vi.fn(async () => ({ ok: true, isOwner: true })),
    ensureReviewAccess: vi.fn(async () => ({ ok: true, isOwner: true })),
    filterAccessibleDocumentIds: vi.fn(async (ids: string[]) => ids),
    listAccessibleProjectIds: vi.fn(async () => []),
    getOrgRole: vi.fn(async () => null),
    resolveContentOrgId: vi.fn(async () => null),
}));

vi.mock("../../lib/userDataCleanup", () => ({
    deleteProjectsByIds: vi.fn(async () => 0),
    deleteAllUserChats: vi.fn(async () => {}),
    deleteAllUserTabularReviews: vi.fn(async () => {}),
    deleteUserAccountData: vi.fn(async () => {}),
    deleteUserProjects: vi.fn(async () => 0),
    listOrgsBlockingAccountDeletion: vi.fn(async () => []),
}));

vi.mock("../../lib/documentVersions", () => ({
    attachActiveVersionPaths: vi.fn(async () => {}),
    attachLatestVersionNumbers: vi.fn(async () => {}),
    contentSha256: vi.fn(() => "0".repeat(64)),
    loadActiveVersion: vi.fn(async () => null),
}));

import { app } from "../../app";
import { createServerSupabase } from "../../lib/supabase";

const AUTH = ["Authorization", "Bearer test"] as const;

type Project = Record<string, unknown>;

/**
 * A db that answers per (table, filters) and records what it was asked.
 * `reads` holds one entry per query with its filters in the order they were
 * applied, which is how the override-query shape is asserted.
 */
function directorySearchDb(options: {
    /** Rows the `projects` read scoped by `eq:user_id` returns. */
    created?: Project[];
    /** Rows the `projects` read scoped by `in:org_id` returns. */
    orgProjects?: Project[];
    memberships?: { org_id: string; role: string }[];
    denies?: string[];
}) {
    const created = options.created ?? [];
    const orgProjects = options.orgProjects ?? [];
    const memberships = options.memberships ?? [];
    const denied = new Set(options.denies ?? []);
    const reads: { table: string; filters: string[] }[] = [];

    const build = (
        table: string,
        resolve: (filters: Record<string, unknown>) => unknown[],
    ) => {
        const filters: Record<string, unknown> = {};
        const record = { table, filters: [] as string[] };
        reads.push(record);
        const b: Record<string, unknown> = {};
        for (const method of ["select", "order", "limit", "range", "ilike"])
            b[method] = () => b;
        b.is = () => b;
        b.eq = (column: string, value: unknown) => {
            filters[`eq:${column}`] = value;
            record.filters.push(`eq:${column}`);
            return b;
        };
        b.in = (column: string, value: unknown) => {
            filters[`in:${column}`] = value;
            record.filters.push(`in:${column}`);
            return b;
        };
        b.single = () =>
            Promise.resolve({ data: resolve(filters)[0] ?? null, error: null });
        b.maybeSingle = b.single;
        b.then = (onResolve: (v: unknown) => unknown) =>
            Promise.resolve({ data: resolve(filters), error: null }).then(
                onResolve,
            );
        return b;
    };

    const db = {
        from: (table: string) => {
            if (table === "projects")
                return build(table, (filters) => {
                    if (filters["in:org_id"]) return orgProjects;
                    if (filters["in:id"]) return [];
                    return created;
                });
            if (table === "project_org_access_overrides")
                return build(table, (filters) => {
                    const orgIds =
                        (filters["in:org_id"] as string[] | undefined) ?? [];
                    return orgProjects
                        .filter(
                            (project) =>
                                denied.has(project.id as string) &&
                                orgIds.includes(project.org_id as string),
                        )
                        .map((project) => ({ project_id: project.id }));
                });
            if (table === "org_members") return build(table, () => memberships);
            return build(table, () => []);
        },
        rpc: () => Promise.resolve({ data: [], error: null }),
        auth: {
            getUser: () =>
                Promise.resolve({
                    data: { user: { id: "u1" } },
                    error: null,
                }),
        },
    };
    return { db, reads };
}

function useDb(handle: { db: unknown }) {
    vi.mocked(createServerSupabase).mockImplementationOnce(
        () => handle.db as ReturnType<typeof createServerSupabase>,
    );
}

const search = () =>
    request(app).get("/projects?view=directory-search&search=Matter").set(...AUTH);

// The caller created this org matter and then left the firm. The
// projects.user_id row survives their departure; their access does not.
const CREATED_ORG_PROJECT = {
    id: "p-firm",
    name: "Matter Firm",
    cm_number: "2026-0001",
    org_id: "o1",
    user_id: "u1",
    updated_at: "2026-09-01T00:00:00Z",
};

describe("GET /projects?view=directory-search", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("hides an org project whose creator has left the organization", async () => {
        // "I created it" is not a verdict on its own. checkProjectAccess —
        // which every other read path uses — answers "no access" for a
        // non-member, so the picker was the one surface still offering a
        // matter that 404s the moment it is opened.
        const handle = directorySearchDb({
            created: [CREATED_ORG_PROJECT],
            memberships: [],
        });
        useDb(handle);

        const res = await search();

        expect(res.status).toBe(200);
        expect(res.body).toEqual([]);
    });

    it("keeps that project while its creator is still a member", async () => {
        // The control. The org branch re-admits it, so leaving the org is
        // what removes it — not the change itself.
        const handle = directorySearchDb({
            created: [CREATED_ORG_PROJECT],
            orgProjects: [CREATED_ORG_PROJECT],
            memberships: [{ org_id: "o1", role: "member" }],
        });
        useDb(handle);

        const res = await search();

        expect(res.status).toBe(200);
        expect(res.body.map((project: { id: string }) => project.id)).toEqual([
            "p-firm",
        ]);
    });

    it("keeps a personal project the caller created, org membership or not", async () => {
        const handle = directorySearchDb({
            created: [
                {
                    id: "p-personal",
                    name: "Matter Personal",
                    org_id: null,
                    user_id: "u1",
                    updated_at: "2026-09-01T00:00:00Z",
                },
            ],
            memberships: [],
        });
        useDb(handle);

        const res = await search();

        expect(res.status).toBe(200);
        expect(res.body.map((project: { id: string }) => project.id)).toEqual([
            "p-personal",
        ]);
    });

    it("asks for the deny overrides by org, never by a list of project ids", async () => {
        // The candidate-id list grows with the firm's matters and is spliced
        // verbatim into the PostgREST query string, so a large tenant sent a
        // URL past the server's request-line limit; the read then failed and
        // the picker — which fails closed — went blank. org_id is bounded by
        // the caller's memberships instead.
        const handle = directorySearchDb({
            created: [],
            orgProjects: [CREATED_ORG_PROJECT],
            memberships: [{ org_id: "o1", role: "member" }],
        });
        useDb(handle);

        const res = await search();

        expect(res.status).toBe(200);
        const overrideReads = handle.reads.filter(
            (read) => read.table === "project_org_access_overrides",
        );
        expect(overrideReads).toHaveLength(1);
        expect(overrideReads[0].filters).toEqual([
            "in:org_id",
            "eq:user_id",
            "eq:role",
        ]);
        expect(overrideReads[0].filters).not.toContain("in:project_id");
    });
});
