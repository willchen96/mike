import { describe, expect, it, vi } from "vitest";

// deleteUserAccountData reaches storage on its way through the cascade. The
// refusal test below asserts it never gets there, so these have to be
// observable no-ops rather than real calls.
vi.mock("../storage", () => ({
    deleteFile: vi.fn(async () => {}),
    listFiles: vi.fn(async () => [] as string[]),
    extractedTextKey: (versionId: string) => `extracted-text/${versionId}.txt`,
}));

import { deleteFile, listFiles } from "../storage";
import { NonRetryableJobError } from "../dbq/runner";
import {
    deleteUserAccountData,
    deleteUserOrganizations,
    deleteUserProjects,
    listOrgsBlockingAccountDeletion,
} from "../userDataCleanup";

type Row = Record<string, unknown>;

/**
 * Await a rejection and hand back the error itself, so one call can be
 * asserted on twice — its CLASS (which decides whether the queue retries it)
 * and its message. `rejects.toThrow` would have to run the cleanup twice to
 * check both.
 */
async function rejection(promise: PromiseLike<unknown>): Promise<unknown> {
    return Promise.resolve(promise).then(
        () => {
            throw new Error("expected a rejection, but the call resolved");
        },
        (error: unknown) => error,
    );
}

/**
 * Wraps a db fake so every write it is asked to perform is recorded. Used to
 * prove a refusal happened BEFORE anything was destroyed, which a surviving
 * row count cannot: a delete that matched nothing leaves the same table
 * behind as a delete that was never issued.
 */
function recordWrites(db: any) {
    const writes: string[] = [];
    const from = db.from.bind(db);
    return {
        db: {
            ...db,
            from(table: string) {
                const builder: any = from(table);
                return new Proxy(builder, {
                    get(target, prop, receiver) {
                        if (
                            prop === "delete" ||
                            prop === "update" ||
                            prop === "insert" ||
                            prop === "upsert"
                        )
                            writes.push(`${String(prop)} ${table}`);
                        return Reflect.get(target, prop, receiver);
                    },
                });
            },
        } as any,
        writes,
    };
}

// Stateful fake with a minimal simulation of the ON DELETE CASCADE from
// org_members → organizations, so deleting an org also drops its membership
// rows (as Postgres would). Supports the query subset the cleanup uses:
// select/eq/neq/in/order/limit/delete/update + thenable.
//
// `options.lastAdminTrigger` additionally simulates the database trigger
// org_members_protect_last_admin (migration 20260902_01): deleting an
// organization's last admin raises SQLSTATE 23514, EXCEPT when the org row
// is already gone or the member's auth.users row is already gone. Seed an
// `auth_users` table to say which accounts still exist — without the trigger
// the account-deletion path can only be tested against a mocked cascade,
// which is precisely the assumption that was wrong.
function makeDb(
    initial: Record<string, Row[]>,
    options: {
        lastAdminTrigger?: boolean;
        selectErrors?: Record<string, string>;
    } = {},
) {
    const tables: Record<string, Row[]> = {};
    for (const [k, v] of Object.entries(initial)) tables[k] = v.map((r) => ({ ...r }));

    function query(table: string) {
        const filters: (
            | { type: "eq"; col: string; val: unknown }
            | { type: "neq"; col: string; val: unknown }
            | { type: "in"; col: string; vals: unknown[] }
        )[] = [];
        let op: "select" | "update" | "delete" = "select";
        let payload: Row | null = null;
        let orderCol: string | null = null;
        let orderAsc = true;
        let limitN: number | null = null;

        const ensure = () => (tables[table] ??= []);
        const matches = (rows: Row[]) =>
            rows.filter((r) =>
                filters.every((f) => {
                    if (f.type === "eq") return r[f.col] === f.val;
                    if (f.type === "neq") return r[f.col] !== f.val;
                    return f.vals.includes(r[f.col]);
                }),
            );

        function resolveMany(): Promise<{
            data: Row[] | null;
            error: { message: string; code?: string } | null;
        }> {
            const arr = ensure();
            const matched = matches(arr);
            if (op === "select" && options.selectErrors?.[table]) {
                return Promise.resolve({
                    data: null,
                    error: { message: options.selectErrors[table] },
                });
            }
            if (op === "delete" && table === "org_members") {
                const blocked = matched.find((r) => {
                    if (r.role !== "admin") return false;
                    const orgGone = !(tables.organizations ?? []).some(
                        (o) => o.id === r.org_id,
                    );
                    const authGone = !(tables.auth_users ?? []).some(
                        (u) => u.id === r.user_id,
                    );
                    if (orgGone || authGone) return false;
                    return !(tables.org_members ?? []).some(
                        (o) =>
                            o.org_id === r.org_id &&
                            o.role === "admin" &&
                            o.user_id !== r.user_id,
                    );
                });
                if (options.lastAdminTrigger && blocked) {
                    return Promise.resolve({
                        data: null,
                        error: {
                            message:
                                "An organization must keep at least one admin",
                            code: "23514",
                        },
                    });
                }
            }
            if (op === "update") {
                for (const r of matched) Object.assign(r, payload as Row);
                return Promise.resolve({ data: matched, error: null });
            }
            if (op === "delete") {
                tables[table] = arr.filter((r) => !matched.includes(r));
                if (table === "organizations") {
                    // Simulate the FK cascade to org_members.
                    const goneOrgIds = new Set(matched.map((r) => r.id));
                    tables.org_members = (tables.org_members ?? []).filter(
                        (m) => !goneOrgIds.has(m.org_id),
                    );
                }
                return Promise.resolve({ data: matched, error: null });
            }
            let out = [...matched];
            if (orderCol) {
                const col = orderCol;
                out.sort((a, b) =>
                    ((a[col] as number) > (b[col] as number) ? 1 : -1) *
                    (orderAsc ? 1 : -1),
                );
            }
            if (limitN != null) out = out.slice(0, limitN);
            return Promise.resolve({ data: out, error: null });
        }

        const builder: Record<string, unknown> = {
            select: () => builder,
            eq: (col: string, val: unknown) => {
                filters.push({ type: "eq", col, val });
                return builder;
            },
            neq: (col: string, val: unknown) => {
                filters.push({ type: "neq", col, val });
                return builder;
            },
            order: (col: string, opts?: { ascending?: boolean }) => {
                orderCol = col;
                orderAsc = opts?.ascending !== false;
                return builder;
            },
            limit: (n: number) => {
                limitN = n;
                return builder;
            },
            update: (p: Row) => {
                op = "update";
                payload = p;
                return builder;
            },
            delete: () => {
                op = "delete";
                return builder;
            },
            in: (col: string, vals: unknown[]) => {
                filters.push({ type: "in", col, vals });
                return builder;
            },
            maybeSingle: async () => {
                const { data, error } = await resolveMany();
                return { data: data?.[0] ?? null, error };
            },
            then: (
                resolve: (v: {
                    data: Row[] | null;
                    error: { message: string; code?: string } | null;
                }) => unknown,
                reject?: (e: unknown) => unknown,
            ) => resolveMany().then(resolve, reject),
        };
        return builder;
    }

    return { from: (t: string) => query(t), _tables: tables } as any;
}

describe("deleteUserOrganizations", () => {
    it("refuses rather than promoting an heir when members remain", async () => {
        // The old behaviour promoted "the earliest remaining member": a firm's
        // administration handed to whoever joined first, with no audit row and
        // no consent — and cleanup_org_admin_access_overrides then deleted the
        // new admin's `deny` overrides, so a person deliberately walled off
        // from a matter became its owner because somebody else closed their
        // account. The route refuses with a 409 long before this runs; this
        // throw is the defense-in-depth copy on the durable job path.
        const db = makeDb({
            organizations: [{ id: "shared1", name: "Acme" }],
            org_members: [
                {
                    id: "m1",
                    org_id: "shared1",
                    user_id: "u1",
                    role: "admin",
                    created_at: 1,
                },
                {
                    id: "m2",
                    org_id: "shared1",
                    user_id: "u2",
                    role: "member",
                    created_at: 2,
                },
                {
                    id: "m3",
                    org_id: "shared1",
                    user_id: "u3",
                    role: "member",
                    created_at: 3,
                },
            ],
        });

        const error = await rejection(deleteUserOrganizations(db, "u1"));
        // NonRetryableJobError, not Error: no number of retries gives an
        // organization a second admin, and a plain Error burned the whole
        // retry budget re-deriving the same refusal.
        expect(error).toBeInstanceOf(NonRetryableJobError);
        expect((error as Error).message).toMatch(/only admin of organization shared1/);

        // Nothing moved: no promotion, no departure, no deletion.
        expect(db._tables.organizations).toHaveLength(1);
        const members = db._tables.org_members as Row[];
        expect(members.map((m) => m.user_id)).toEqual(["u1", "u2", "u3"]);
        expect(members.find((m) => m.user_id === "u2")?.role).toBe("member");
    });

    it("leaves a co-admin's org untouched", async () => {
        const db = makeDb({
            organizations: [{ id: "o1", name: "Acme" }],
            org_members: [
                { id: "m1", org_id: "o1", user_id: "u1", role: "admin", created_at: 1 },
                { id: "m2", org_id: "o1", user_id: "u2", role: "admin", created_at: 2 },
            ],
        });
        await deleteUserOrganizations(db, "u1");
        const members = db._tables.org_members as Row[];
        expect(members).toHaveLength(1);
        expect(members[0]).toMatchObject({ user_id: "u2", role: "admin" });
    });

    it("deletes an org only when nobody and nothing is left in it", async () => {
        const db = makeDb({
            organizations: [{ id: "empty", name: "Empty" }],
            org_members: [
                { id: "m1", org_id: "empty", user_id: "u1", role: "admin", created_at: 1 },
            ],
            projects: [],
        });
        await deleteUserOrganizations(db, "u1");
        expect(db._tables.organizations).toHaveLength(0);
    });

    it("keeps a projectless org that still owns workflows", async () => {
        // Workflows (and documents, and tabular reviews) are filed under an
        // org independently of any project, and the cleanup detaches them —
        // user_id → NULL, kept for the firm — a few steps before this
        // decision. Judging "the org owns nothing" on projects alone deleted
        // the org anyway; its ON DELETE SET NULL FK then blanked org_id on
        // the just-detached workflows, leaving rows with no creator and no
        // org: invisible to every list, reachable by no access branch,
        // deletable by nobody.
        const db = makeDb({
            organizations: [{ id: "o1", name: "Acme" }],
            org_members: [
                { id: "m1", org_id: "o1", user_id: "u1", role: "admin", created_at: 1 },
            ],
            projects: [],
            workflows: [{ id: "w1", org_id: "o1", user_id: null }],
        });
        const error = await rejection(deleteUserOrganizations(db, "u1"));
        // NonRetryableJobError, not Error: no number of retries gives an
        // organization a second admin, and a plain Error burned the whole
        // retry budget re-deriving the same refusal.
        expect(error).toBeInstanceOf(NonRetryableJobError);
        expect((error as Error).message).toMatch(/only admin of organization o1/);
        expect(db._tables.organizations).toHaveLength(1);
        expect(db._tables.workflows).toEqual([
            { id: "w1", org_id: "o1", user_id: null },
        ]);
    });

    it("counts an org's chats as content", async () => {
        // The account-deletion probe used to omit `chats`, so an org whose
        // last remaining content was a chat looked empty and was deleted —
        // while deleteOrg refused the identical delete over the API. Both now
        // read ORG_CONTENT_TABLES.
        const db = makeDb({
            organizations: [{ id: "o1", name: "Acme" }],
            org_members: [
                { id: "m1", org_id: "o1", user_id: "u1", role: "admin", created_at: 1 },
            ],
            projects: [],
            documents: [],
            chats: [{ id: "c1", org_id: "o1", user_id: null }],
        });
        const error = await rejection(deleteUserOrganizations(db, "u1"));
        // NonRetryableJobError, not Error: no number of retries gives an
        // organization a second admin, and a plain Error burned the whole
        // retry budget re-deriving the same refusal.
        expect(error).toBeInstanceOf(NonRetryableJobError);
        expect((error as Error).message).toMatch(/only admin of organization o1/);
        expect(db._tables.organizations).toHaveLength(1);
    });

    it("refuses when the org still holds the firm's projects", async () => {
        // The org cannot be deleted (its content FKs are ON DELETE RESTRICT)
        // and the sole admin cannot leave it memberless, so the only honest
        // answer is to refuse the account deletion.
        const db = makeDb({
            organizations: [{ id: "o1", name: "Acme" }],
            org_members: [
                { id: "m1", org_id: "o1", user_id: "u1", role: "admin", created_at: 1 },
            ],
            projects: [{ id: "p1", org_id: "o1", user_id: "u1" }],
        });
        const error = await rejection(deleteUserOrganizations(db, "u1"));
        // NonRetryableJobError, not Error: no number of retries gives an
        // organization a second admin, and a plain Error burned the whole
        // retry budget re-deriving the same refusal.
        expect(error).toBeInstanceOf(NonRetryableJobError);
        expect((error as Error).message).toMatch(/only admin of organization o1/);
        expect(db._tables.organizations).toHaveLength(1);
        expect(db._tables.projects).toHaveLength(1);
    });

    it("does not leave the last admin's membership for a cascade that never comes", async () => {
        // The half-finished-deletion bug, and the reason the product now
        // refuses. Leaving the row for auth.users to cascade produced a
        // memberless organization in theory; in practice the cascade never
        // ran — org_member_protect_resource_ownership refuses to remove a
        // member who still owns the org's projects — so the durable job
        // failed forever while the user, sessions revoked and sent to the
        // login page, could log straight back in.
        const db = makeDb(
            {
                organizations: [{ id: "o1", name: "Acme" }],
                org_members: [
                    {
                        id: "m1",
                        org_id: "o1",
                        user_id: "u1",
                        role: "admin",
                        created_at: 1,
                    },
                ],
                projects: [{ id: "p1", org_id: "o1", user_id: "u1" }],
                auth_users: [{ id: "u1" }],
            },
            { lastAdminTrigger: true },
        );

        const error = await rejection(deleteUserOrganizations(db, "u1"));
        // NonRetryableJobError, not Error: no number of retries gives an
        // organization a second admin, and a plain Error burned the whole
        // retry budget re-deriving the same refusal.
        expect(error).toBeInstanceOf(NonRetryableJobError);
        expect((error as Error).message).toMatch(/only admin of organization o1/);
        expect(db._tables.org_members).toHaveLength(1);
        expect(db._tables.organizations).toHaveLength(1);
        expect(db._tables.projects).toHaveLength(1);
    });

    it("still deletes a membership the trigger has no reason to refuse", async () => {
        // The other admin is the trigger's own escape: with a co-admin left,
        // the explicit delete is legal and remains the tidier path.
        const db = makeDb(
            {
                organizations: [{ id: "o1", name: "Acme" }],
                org_members: [
                    { id: "m1", org_id: "o1", user_id: "u1", role: "admin", created_at: 1 },
                    { id: "m2", org_id: "o1", user_id: "u2", role: "admin", created_at: 2 },
                ],
                auth_users: [{ id: "u1" }, { id: "u2" }],
            },
            { lastAdminTrigger: true },
        );
        await deleteUserOrganizations(db, "u1");
        expect((db._tables.org_members as Row[]).map((m) => m.user_id)).toEqual([
            "u2",
        ]);
    });

    it("refuses to delete an org because a lookup failed", async () => {
        // The three org-shaping reads destructured `data` only, so a transient
        // error read as "no projects here" — and the difference between "this
        // org holds nothing" and "the database did not answer" is the
        // difference between tidying up and deleting a firm's tenant.
        const db = makeDb(
            {
                organizations: [{ id: "o1", name: "Acme" }],
                org_members: [
                    { id: "m1", org_id: "o1", user_id: "u1", role: "admin", created_at: 1 },
                ],
                projects: [{ id: "p1", org_id: "o1", user_id: "u1" }],
            },
            { selectErrors: { projects: "connection reset" } },
        );

        await expect(deleteUserOrganizations(db, "u1")).rejects.toThrow(
            /Failed to load org projects/,
        );
        expect(db._tables.organizations).toHaveLength(1);
    });

    it("cancels invitations still addressed to the departing account", async () => {
        const db = makeDb({
            organizations: [{ id: "o1", name: "Acme" }],
            org_members: [],
            org_invitations: [
                {
                    id: "i1",
                    org_id: "o1",
                    email: "gone@example.com",
                    status: "pending",
                },
                {
                    id: "i2",
                    org_id: "o1",
                    email: "other@example.com",
                    status: "pending",
                },
            ],
        });
        await deleteUserOrganizations(db, "u1", " Gone@Example.com ");
        const invites = db._tables.org_invitations as Row[];
        expect(invites.find((i) => i.id === "i1")?.status).toBe("cancelled");
        expect(invites.find((i) => i.id === "i2")?.status).toBe("pending");
    });
});

describe("listOrgsBlockingAccountDeletion", () => {
    it("blocks a sole admin whose org still has members", async () => {
        const db = makeDb({
            organizations: [{ id: "o1", name: "Acme LLP" }],
            org_members: [
                { id: "m1", org_id: "o1", user_id: "u1", role: "admin", created_at: 1 },
                { id: "m2", org_id: "o1", user_id: "u2", role: "member", created_at: 2 },
            ],
        });
        await expect(
            listOrgsBlockingAccountDeletion(db, "u1"),
        ).resolves.toEqual([
            { org_id: "o1", name: "Acme LLP", reason: "members" },
        ]);
    });

    it("blocks a sole admin whose empty org still owns content", async () => {
        // Nobody is left to promote, and the org cannot be deleted either:
        // its content foreign keys are ON DELETE RESTRICT.
        const db = makeDb({
            organizations: [{ id: "o1", name: "Solo LLP" }],
            org_members: [
                { id: "m1", org_id: "o1", user_id: "u1", role: "admin", created_at: 1 },
            ],
            projects: [{ id: "p1", org_id: "o1", user_id: "u1" }],
        });
        await expect(
            listOrgsBlockingAccountDeletion(db, "u1"),
        ).resolves.toEqual([
            { org_id: "o1", name: "Solo LLP", reason: "content" },
        ]);
    });

    it("does not block an empty org with no other members", async () => {
        // deleteUserOrganizations deletes this one outright, so the account
        // deletion may proceed.
        const db = makeDb({
            organizations: [{ id: "o1", name: "Empty" }],
            org_members: [
                { id: "m1", org_id: "o1", user_id: "u1", role: "admin", created_at: 1 },
            ],
            projects: [],
        });
        await expect(listOrgsBlockingAccountDeletion(db, "u1")).resolves.toEqual(
            [],
        );
    });

    it("does not block when another admin can take over", async () => {
        const db = makeDb({
            organizations: [{ id: "o1", name: "Acme" }],
            org_members: [
                { id: "m1", org_id: "o1", user_id: "u1", role: "admin", created_at: 1 },
                { id: "m2", org_id: "o1", user_id: "u2", role: "admin", created_at: 2 },
            ],
            projects: [{ id: "p1", org_id: "o1", user_id: "u1" }],
        });
        await expect(listOrgsBlockingAccountDeletion(db, "u1")).resolves.toEqual(
            [],
        );
    });

    it("does not block a plain member of somebody else's org", async () => {
        const db = makeDb({
            organizations: [{ id: "o1", name: "Acme" }],
            org_members: [
                { id: "m1", org_id: "o1", user_id: "u1", role: "member", created_at: 1 },
                { id: "m2", org_id: "o1", user_id: "u2", role: "admin", created_at: 2 },
            ],
            projects: [{ id: "p1", org_id: "o1", user_id: "u1" }],
        });
        await expect(listOrgsBlockingAccountDeletion(db, "u1")).resolves.toEqual(
            [],
        );
    });

    it("reports every blocking org, not just the first", async () => {
        const db = makeDb({
            organizations: [
                { id: "o1", name: "Org A" },
                { id: "o2", name: "Org B" },
            ],
            org_members: [
                { id: "m1", org_id: "o1", user_id: "u1", role: "admin", created_at: 1 },
                { id: "m2", org_id: "o1", user_id: "u2", role: "member", created_at: 2 },
                { id: "m3", org_id: "o2", user_id: "u1", role: "admin", created_at: 3 },
            ],
            chats: [{ id: "c1", org_id: "o2" }],
        });
        await expect(
            listOrgsBlockingAccountDeletion(db, "u1"),
        ).resolves.toEqual([
            { org_id: "o1", name: "Org A", reason: "members" },
            { org_id: "o2", name: "Org B", reason: "content" },
        ]);
    });

    it("refuses to answer 'not blocking' because a lookup failed", async () => {
        // "The database did not answer" must never read as "this org holds
        // nothing" — that is the difference between refusing an account
        // deletion and quietly deleting a firm's tenant.
        const db = makeDb(
            {
                organizations: [{ id: "o1", name: "Acme" }],
                org_members: [
                    { id: "m1", org_id: "o1", user_id: "u1", role: "admin", created_at: 1 },
                ],
                projects: [{ id: "p1", org_id: "o1", user_id: "u1" }],
            },
            { selectErrors: { projects: "connection reset" } },
        );
        await expect(listOrgsBlockingAccountDeletion(db, "u1")).rejects.toThrow(
            /Failed to load org projects/,
        );
    });
});

describe("deleteUserProjects and organization ownership", () => {
    const seed = () =>
        makeDb({
            projects: [
                { id: "personal", user_id: "u1", org_id: null },
                { id: "firm", user_id: "u1", org_id: "o1" },
            ],
            documents: [
                { id: "d-personal", project_id: "personal" },
                { id: "d-firm", project_id: "firm" },
            ],
            chats: [],
            tabular_reviews: [],
            project_subfolders: [],
            document_versions: [],
        });

    it("destroys personal projects but detaches organization ones", async () => {
        const db = seed();
        // The count reports what was actually destroyed, so a caller deleting
        // only an org project is told nothing was removed.
        await expect(deleteUserProjects(db, "u1")).resolves.toBe(1);

        const projects = db._tables.projects as Row[];
        expect(projects.map((p) => p.id)).toEqual(["firm"]);
        // The organization's project survives its creator, with no creator.
        expect(projects[0].user_id).toBeNull();
        expect(projects[0].org_id).toBe("o1");
        // …and so does the content inside it.
        expect((db._tables.documents as Row[]).map((d) => d.id)).toEqual([
            "d-firm",
        ]);
    });

    it("detaches an organization project even when named explicitly", async () => {
        const db = seed();
        await expect(deleteUserProjects(db, "u1", ["firm"])).resolves.toBe(0);
        const projects = db._tables.projects as Row[];
        expect(projects).toHaveLength(2);
        expect(projects.find((p) => p.id === "firm")?.user_id).toBeNull();
    });
});

describe("deleteUserAccountData refuses before it destroys", () => {
    it("throws NonRetryableJobError without issuing a single write", async () => {
        // THE ORDERING BUG. The sole-admin question used to be asked by
        // deleteUserOrganizations, at the very END of the cascade — so the
        // refusal was real, but it arrived after the account's projects,
        // documents, storage objects and audit rows had already been
        // destroyed, and the failed job could never put them back. Asking
        // first costs nothing; asking last cost everything the check was
        // meant to protect.
        vi.mocked(deleteFile).mockClear();
        vi.mocked(listFiles).mockClear();
        const { db, writes } = recordWrites(
            makeDb({
                organizations: [{ id: "o1", name: "Acme LLP" }],
                org_members: [
                    {
                        id: "m1",
                        org_id: "o1",
                        user_id: "u1",
                        role: "admin",
                        created_at: 1,
                    },
                    {
                        id: "m2",
                        org_id: "o1",
                        user_id: "u2",
                        role: "member",
                        created_at: 2,
                    },
                ],
                projects: [
                    { id: "personal", user_id: "u1", org_id: null },
                    { id: "firm", user_id: "u1", org_id: "o1" },
                ],
                documents: [{ id: "d1", project_id: "personal" }],
                chats: [],
                tabular_reviews: [],
                audit_events: [{ id: "a1", user_id: "u1" }],
            }),
        );

        const error = await rejection(
            deleteUserAccountData(db, "u1", "u1@example.com"),
        );

        // Non-retryable: the org does not acquire a second admin because the
        // queue asks twenty more times over the next few hours.
        expect(error).toBeInstanceOf(NonRetryableJobError);
        expect((error as Error).message).toMatch(/only admin of o1 \(members\)/);
        // Nothing was written — not a delete, not the org-project detach.
        expect(writes).toEqual([]);
        // ...and nothing was removed from storage either.
        expect(deleteFile).not.toHaveBeenCalled();
        expect(listFiles).not.toHaveBeenCalled();
        // The rows are all still there, which is the point of asking first.
        expect(db._tables.projects).toHaveLength(2);
        expect(db._tables.documents).toHaveLength(1);
        expect(db._tables.audit_events).toHaveLength(1);
    });
});
