import { describe, expect, it } from "vitest";
import {
    checkProjectAccess,
    checkWorkflowAccess,
    creatorScopedAllowed,
    ensureChatAccess,
    ensureDocAccess,
    ensureReviewAccess,
    filterAccessibleDocumentIds,
    listAccessibleProjectIds,
    orgRoleToProjectRole,
    resolveContentOrgId,
} from "../access";

type Row = Record<string, unknown>;

function makeDb(
    tables: Record<string, Row[]>,
    options: { selectErrors?: Record<string, string> } = {},
) {
    return {
        from(table: string) {
            let rows = [...(tables[table] ?? [])];
            const failure = options.selectErrors?.[table]
                ? { message: options.selectErrors[table] }
                : null;
            const query = {
                select: () => query,
                order: () => query,
                limit: (n: number) => {
                    rows = rows.slice(0, n);
                    return query;
                },
                // Paged reads: `.range(from, to)` is inclusive at both ends,
                // and returning a short page is what stops the caller's loop.
                range: (from: number, to: number) => {
                    rows = rows.slice(from, to + 1);
                    return query;
                },
                eq: (column: string, value: unknown) => {
                    rows = rows.filter((row) => row[column] === value);
                    return query;
                },
                is: (column: string, value: unknown) => {
                    rows = rows.filter((row) => row[column] === value);
                    return query;
                },
                neq: (column: string, value: unknown) => {
                    rows = rows.filter((row) => row[column] !== value);
                    return query;
                },
                in: (column: string, values: unknown[]) => {
                    rows = rows.filter((row) => values.includes(row[column]));
                    return query;
                },
                filter: (column: string, operator: string, value: string) => {
                    if (operator !== "cs") return query;
                    const expected = JSON.parse(value) as string[];
                    rows = rows.filter((row) => {
                        const actual = row[column];
                        return (
                            Array.isArray(actual) &&
                            expected.every((item) => actual.includes(item))
                        );
                    });
                    return query;
                },
                single: async () =>
                    failure
                        ? { data: null, error: failure }
                        : { data: rows[0] ?? null, error: null },
                maybeSingle: async () =>
                    failure
                        ? { data: null, error: failure }
                        : { data: rows[0] ?? null, error: null },
                then: (
                    resolve: (value: {
                        data: Row[] | null;
                        error: { message: string } | null;
                    }) => unknown,
                    reject?: (reason: unknown) => unknown,
                ) =>
                    Promise.resolve(
                        failure
                            ? { data: null, error: failure }
                            : { data: rows, error: null },
                    ).then(resolve, reject),
            };
            return query;
        },
    } as any;
}

describe("access helpers", () => {
    const db = makeDb({
        projects: [
            { id: "own-project", user_id: "owner", org_id: null },
            { id: "granted-project", user_id: "other-owner", org_id: null },
            { id: "private-project", user_id: "other-owner", org_id: null },
        ],
        project_access_grants: [
            {
                project_id: "granted-project",
                email: "reviewer@example.com",
                role: "editor",
            },
        ],
        documents: [
            { id: "own-doc", user_id: "owner", project_id: null },
            {
                id: "granted-doc",
                user_id: "other-owner",
                project_id: "granted-project",
            },
            {
                id: "private-doc",
                user_id: "other-owner",
                project_id: "private-project",
            },
        ],
        workflow_shares: [
            {
                workflow_id: "shared-workflow",
                shared_with_email: "reviewer@example.com",
                role: "viewer",
            },
            {
                workflow_id: "editable-workflow",
                shared_with_email: "reviewer@example.com",
                role: "editor",
            },
        ],
        workflows: [
            {
                id: "shared-workflow",
                user_id: "other-owner",
                org_id: null,
            },
            {
                id: "editable-workflow",
                user_id: "other-owner",
                org_id: null,
            },
        ],
        tabular_review_access_grants: [
            {
                tabular_review_id: "review-direct",
                email: "reviewer@example.com",
                role: "editor",
            },
        ],
    });

    it("makes the project's creator an owner", async () => {
        const access = await checkProjectAccess(
            "own-project",
            "owner",
            "owner@example.com",
            db,
        );
        expect(access).toMatchObject({
            ok: true,
            isCreator: true,
            projectRole: "owner",
        });
    });

    it("gives a direct grantee exactly the role they were granted", async () => {
        const access = await checkProjectAccess(
            "granted-project",
            "reviewer",
            "reviewer@example.com",
            db,
        );
        expect(access).toMatchObject({
            ok: true,
            isCreator: false,
            projectRole: "editor",
        });
    });

    it("matches grant emails case-insensitively", async () => {
        const access = await checkProjectAccess(
            "granted-project",
            "reviewer",
            "  Reviewer@Example.com ",
            db,
        );
        expect(access.ok).toBe(true);
    });

    it("denies a project the caller has no route into", async () => {
        await expect(
            checkProjectAccess(
                "private-project",
                "reviewer",
                "reviewer@example.com",
                db,
            ),
        ).resolves.toEqual({ ok: false });
    });

    it("allows document creators and readers of the containing project", async () => {
        await expect(
            ensureDocAccess(
                { user_id: "owner", project_id: null },
                "owner",
                "owner@example.com",
                db,
            ),
        ).resolves.toMatchObject({ ok: true, projectRole: "owner" });
        await expect(
            ensureDocAccess(
                { user_id: "other-owner", project_id: "granted-project" },
                "reviewer",
                "reviewer@example.com",
                db,
            ),
        ).resolves.toMatchObject({ ok: true, projectRole: "editor" });
        await expect(
            ensureDocAccess(
                { user_id: "other-owner", project_id: "private-project" },
                "reviewer",
                "reviewer@example.com",
                db,
            ),
        ).resolves.toEqual({ ok: false });
    });

    it("applies workflow share edit permissions to workflow assets", async () => {
        await expect(
            ensureDocAccess(
                {
                    user_id: "other-owner",
                    project_id: null,
                    workflow_id: "shared-workflow",
                },
                "reviewer",
                " REVIEWER@EXAMPLE.COM ",
                db,
            ),
        ).resolves.toMatchObject({ ok: true, projectRole: "viewer" });
        await expect(
            ensureDocAccess(
                {
                    user_id: "other-owner",
                    project_id: null,
                    workflow_id: "editable-workflow",
                },
                "reviewer",
                "reviewer@example.com",
                db,
            ),
        ).resolves.toMatchObject({ ok: true, projectRole: "editor" });
    });

    it("allows direct review sharing without project access", async () => {
        await expect(
            ensureReviewAccess(
                {
                    id: "review-direct",
                    user_id: "other-owner",
                    project_id: null,
                },
                "reviewer",
                "reviewer@example.com",
                db,
            ),
        ).resolves.toMatchObject({ ok: true, projectRole: "editor" });
    });

    it("does not grant organization access to a standalone review", async () => {
        const orgDb = makeDb({
            org_members: [
                { org_id: "org-1", user_id: "reviewer", role: "admin" },
            ],
            tabular_review_access_grants: [],
        });
        await expect(
            ensureReviewAccess(
                {
                    id: "legacy-org-review",
                    user_id: "other-owner",
                    project_id: null,
                    org_id: "org-1",
                },
                "reviewer",
                "reviewer@example.com",
                orgDb,
            ),
        ).resolves.toEqual({ ok: false });
    });

    it("lists projects reached by creation and by grant", async () => {
        await expect(
            listAccessibleProjectIds("owner", "owner@example.com", db),
        ).resolves.toEqual(["own-project"]);
        await expect(
            listAccessibleProjectIds("reviewer", "reviewer@example.com", db),
        ).resolves.toEqual(["granted-project"]);
    });

    it("filters user-supplied document IDs to accessible documents only", async () => {
        await expect(
            filterAccessibleDocumentIds(
                ["own-doc", "granted-doc", "private-doc"],
                "reviewer",
                "reviewer@example.com",
                db,
            ),
        ).resolves.toEqual(["granted-doc"]);
    });
});

// ---------------------------------------------------------------------------
// Organization inheritance
// ---------------------------------------------------------------------------

describe("org role inheritance", () => {
    it("maps org Admin to Owner and org Member to Editor", () => {
        expect(orgRoleToProjectRole("admin")).toBe("owner");
        expect(orgRoleToProjectRole("member")).toBe("editor");
    });

    const db = makeDb({
        projects: [
            { id: "org-project", user_id: "founder", org_id: "org-1" },
            { id: "other-org-project", user_id: "stranger", org_id: "org-2" },
            { id: "personal-project", user_id: "founder", org_id: null },
        ],
        org_members: [
            { org_id: "org-1", user_id: "founder", role: "admin" },
            { org_id: "org-1", user_id: "boss", role: "admin" },
            { org_id: "org-1", user_id: "staffer", role: "member" },
            { org_id: "org-2", user_id: "outsider", role: "admin" },
        ],
        project_access_grants: [
            // A viewer grant handed to people who already have stronger
            // standing through the org — it must not demote them.
            { project_id: "org-project", email: "boss@firm.example", role: "viewer" },
            {
                project_id: "org-project",
                email: "staffer@firm.example",
                role: "viewer",
            },
            // An outside individual: no org membership at all.
            {
                project_id: "org-project",
                email: "counsel@outside.example",
                role: "owner",
            },
        ],
        documents: [],
    });

    it("inherits Owner for an org Admin", async () => {
        await expect(
            checkProjectAccess("org-project", "boss", "nobody@firm.example", db),
        ).resolves.toMatchObject({
            ok: true,
            isCreator: false,
            orgRole: "admin",
            projectRole: "owner",
        });
    });

    it("inherits Editor for a plain org Member", async () => {
        await expect(
            checkProjectAccess(
                "org-project",
                "staffer",
                "nobody@firm.example",
                db,
            ),
        ).resolves.toMatchObject({
            ok: true,
            orgRole: "member",
            projectRole: "editor",
        });
    });

    it("keeps Admin as Owner while applying overrides to Members", async () => {
        const overrideDb = makeDb({
            projects: [
                { id: "overridden", user_id: "founder", org_id: "org-1" },
            ],
            org_members: [
                { org_id: "org-1", user_id: "founder", role: "admin" },
                { org_id: "org-1", user_id: "admin-editor", role: "admin" },
                { org_id: "org-1", user_id: "member-viewer", role: "member" },
                { org_id: "org-1", user_id: "member-denied", role: "member" },
            ],
            project_org_access_overrides: [
                {
                    project_id: "overridden",
                    org_id: "org-1",
                    user_id: "admin-editor",
                    role: "editor",
                },
                {
                    project_id: "overridden",
                    org_id: "org-1",
                    user_id: "member-viewer",
                    role: "viewer",
                },
                {
                    project_id: "overridden",
                    org_id: "org-1",
                    user_id: "member-denied",
                    role: "deny",
                },
            ],
            workflows: [
                { id: "workflow-overridden", user_id: "founder", org_id: "org-1" },
            ],
            workflow_org_access_overrides: [
                {
                    workflow_id: "workflow-overridden",
                    org_id: "org-1",
                    user_id: "admin-editor",
                    role: "deny",
                },
            ],
        });
        await expect(
            checkProjectAccess("overridden", "admin-editor", null, overrideDb),
        ).resolves.toMatchObject({
            ok: true,
            orgRole: "admin",
            projectRole: "owner",
        });
        await expect(
            checkWorkflowAccess(
                "workflow-overridden",
                "admin-editor",
                null,
                overrideDb,
            ),
        ).resolves.toMatchObject({
            ok: true,
            orgRole: "admin",
            projectRole: "owner",
        });
        await expect(
            checkProjectAccess("overridden", "member-viewer", null, overrideDb),
        ).resolves.toMatchObject({ ok: true, projectRole: "viewer" });
        await expect(
            checkProjectAccess("overridden", "member-denied", null, overrideDb),
        ).resolves.toEqual({ ok: false });
    });

    it("ignores direct grants for organization projects", async () => {
        // Org Admin + viewer direct grant stays Owner.
        await expect(
            checkProjectAccess("org-project", "boss", "boss@firm.example", db),
        ).resolves.toMatchObject({ projectRole: "owner" });
        // Org Member + viewer direct grant stays Editor.
        await expect(
            checkProjectAccess(
                "org-project",
                "staffer",
                "staffer@firm.example",
                db,
            ),
        ).resolves.toMatchObject({ projectRole: "editor" });
    });

    it("does not let a direct grant promote an organization member", async () => {
        await expect(
            checkProjectAccess(
                "org-project",
                "staffer",
                "counsel@outside.example",
                db,
            ),
        ).resolves.toMatchObject({ projectRole: "editor" });
    });

    it("denies an outsider despite a legacy direct grant", async () => {
        const access = await checkProjectAccess(
            "org-project",
            "outside-counsel",
            "counsel@outside.example",
            db,
        );
        expect(access).toEqual({ ok: false });
    });

    it("isolates users across orgs (cross-tenant denial)", async () => {
        await expect(
            checkProjectAccess(
                "org-project",
                "outsider",
                "outsider@elsewhere.example",
                db,
            ),
        ).resolves.toEqual({ ok: false });
    });

    it("keeps personal projects out of every org's reach", async () => {
        await expect(
            checkProjectAccess(
                "personal-project",
                "boss",
                "boss@firm.example",
                db,
            ),
        ).resolves.toEqual({ ok: false });
    });

    it("inherits only the project verdict when a document belongs to a project", async () => {
        const crossDb = makeDb({
            projects: [
                { id: "p", user_id: "someone", org_id: "org-2" },
            ],
            org_members: [
                { org_id: "org-1", user_id: "u", role: "admin" },
                { org_id: "org-2", user_id: "u", role: "member" },
            ],
            project_access_grants: [],
        });
        await expect(
            ensureDocAccess(
                { user_id: "someone", project_id: "p", org_id: "org-1" },
                "u",
                "u@firm.example",
                crossDb,
            ),
        ).resolves.toMatchObject({ projectRole: "editor", orgRole: "member" });
    });

    it("inherits the project Owner role for a review", async () => {
        await expect(
            ensureReviewAccess(
                {
                    id: "admin-review",
                    user_id: "someone-else",
                    project_id: "org-project",
                },
                "boss",
                "boss@firm.example",
                db,
            ),
        ).resolves.toMatchObject({ projectRole: "owner" });
    });
});

// ---------------------------------------------------------------------------
// Personal content carries no organization
// ---------------------------------------------------------------------------

describe("content org resolution", () => {
    const db = makeDb({
        projects: [
            { id: "org-project", user_id: "u", org_id: "org-1" },
            { id: "personal-project", user_id: "u", org_id: null },
        ],
    });

    it("inherits the project's organization for content inside it", async () => {
        await expect(
            resolveContentOrgId(db, { projectId: "org-project" }),
        ).resolves.toEqual({ ok: true, orgId: "org-1" });
    });

    it("leaves content with no organization when there is none to inherit", async () => {
        // No hidden personal org to fall back on: org_id IS NULL *is* personal.
        await expect(
            resolveContentOrgId(db, { projectId: "personal-project" }),
        ).resolves.toEqual({ ok: true, orgId: null });
        await expect(
            resolveContentOrgId(db, { projectId: null }),
        ).resolves.toEqual({ ok: true, orgId: null });
    });

    it("refuses to answer when the lookup fails, instead of guessing personal", async () => {
        // ok:false and orgId:null must be distinguishable: null is the
        // encoding of personal content, and personal content is what account
        // deletion destroys. A failed read that presented as null filed a
        // firm's upload as its uploader's private property.
        const failing = makeDb(
            { projects: [] },
            { selectErrors: { projects: "connection reset" } },
        );
        await expect(
            resolveContentOrgId(failing, { projectId: "org-project" }),
        ).resolves.toMatchObject({ ok: false });
    });
});

describe("creator-scoped operations", () => {
    // A handful of operations — replacing or deleting one version of a
    // document, moving a review between projects — belong to whoever made the
    // row rather than to a tier. Account deletion now blanks user_id instead
    // of destroying an organization's content, so "only the creator" has to
    // answer the case where the creator no longer exists.
    it("lets the creator act", () => {
        expect(
            creatorScopedAllowed({ isCreator: true, projectRole: "viewer" }, "u1"),
        ).toBe(true);
    });

    it("still refuses an Owner while the creator exists", () => {
        // The rule is about authorship, not rank: an Owner does not get to
        // reach into a colleague's versions just for outranking them.
        expect(
            creatorScopedAllowed({ isCreator: false, projectRole: "owner" }, "u2"),
        ).toBe(false);
    });

    it("hands a creator-less row to the container's Owners", () => {
        // Otherwise deleting the account that made the row would strand it
        // inside a project the organization is supposed to control, with
        // nobody able to act on it ever again.
        expect(
            creatorScopedAllowed({ isCreator: false, projectRole: "owner" }, null),
        ).toBe(true);
    });

    it("does not hand a creator-less row to Editors or Viewers", () => {
        for (const role of ["editor", "viewer"] as const) {
            expect(
                creatorScopedAllowed({ isCreator: false, projectRole: role }, null),
            ).toBe(false);
        }
    });
});

// ---------------------------------------------------------------------------
// Chats and reviews share the same role-aware direct-grant model. These cases
// pin each exclusive scope and project inheritance.
// ---------------------------------------------------------------------------
describe("ensureChatAccess", () => {
    // alice created proj-a inside org-a and is an org admin there; dave is
    // another org admin, carol a plain org member, erin an outside
    // collaborator holding a viewer grant on proj-a and nothing else. bob
    // belongs to org-b only (the other tenant). frank is a member of nothing
    // and simply authored some of the chats.
    const db = makeDb({
        org_members: [
            { org_id: "org-a", user_id: "alice", role: "admin" },
            { org_id: "org-a", user_id: "carol", role: "member" },
            { org_id: "org-a", user_id: "dave", role: "admin" },
            { org_id: "org-b", user_id: "bob", role: "admin" },
        ],
        projects: [
            { id: "proj-a", user_id: "alice", org_id: "org-a" },
        ],
        project_access_grants: [
            { project_id: "proj-a", email: "erin@example.com", role: "viewer" },
        ],
        chat_access_grants: [
            { chat_id: "direct-chat", email: "carol@example.com", role: "editor" },
            { chat_id: "promoted-chat", email: "erin@example.com", role: "editor" },
            { chat_id: "admin-chat", email: "alice@example.com", role: "editor" },
        ],
    });

    it("makes a standalone chat's creator its Owner", async () => {
        await expect(
            ensureChatAccess(
                {
                    id: "creator-chat",
                    user_id: "carol",
                    project_id: null,
                    org_id: null,
                },
                "carol",
                "carol@example.com",
                db,
            ),
        ).resolves.toMatchObject({
            ok: true,
            isCreator: true,
            orgRole: null,
            projectRole: "owner",
        });
    });

    it("gives a directly shared email Editor access, case-insensitively", async () => {
        // A standalone chat (no project, no org) is shareable through a
        // direct grant.
        await expect(
            ensureChatAccess(
                {
                    id: "direct-chat",
                    user_id: "alice",
                    project_id: null,
                    org_id: null,
                },
                "carol",
                " CAROL@example.com ",
                db,
            ),
        ).resolves.toMatchObject({
            ok: true,
            isCreator: false,
            orgRole: null,
            projectRole: "editor",
        });
    });

    it("inherits the project verdict for a chat inside a project", async () => {
        // frank's chat lives in alice's project: everyone with standing on
        // proj-a gets that same standing on the chat, and none of them
        // becomes its creator.
        const chat = {
            id: "project-chat",
            user_id: "frank",
            project_id: "proj-a",
            org_id: "org-a",
        };
        await expect(
            ensureChatAccess(chat, "alice", "alice@example.com", db),
        ).resolves.toMatchObject({
            ok: true,
            isCreator: false,
            projectRole: "owner",
        });
        await expect(
            ensureChatAccess(chat, "dave", "dave@example.com", db),
        ).resolves.toMatchObject({
            ok: true,
            orgRole: "admin",
            projectRole: "owner",
        });
        await expect(
            ensureChatAccess(chat, "carol", "carol@example.com", db),
        ).resolves.toMatchObject({
            ok: true,
            orgRole: "member",
            projectRole: "editor",
        });
        // A direct project grant cannot cross into an organization scope.
        await expect(
            ensureChatAccess(chat, "erin", "erin@example.com", db),
        ).resolves.toEqual({ ok: false });
    });

    it("does not grant organization access to a standalone chat", async () => {
        const chat = {
            id: "org-chat",
            user_id: "alice",
            project_id: null,
            org_id: "org-a",
        };
        await expect(
            ensureChatAccess(chat, "carol", "carol@example.com", db),
        ).resolves.toEqual({ ok: false });
        await expect(
            ensureChatAccess(chat, "dave", "dave@example.com", db),
        ).resolves.toEqual({ ok: false });
    });

    it("ignores a child chat grant and enforces project access", async () => {
        await expect(
            ensureChatAccess(
                {
                    id: "promoted-chat",
                    user_id: "frank",
                    project_id: "proj-a",
                    org_id: "org-a",
                },
                "erin",
                "erin@example.com",
                db,
            ),
        ).resolves.toEqual({ ok: false });
    });

    it("inherits the project Owner role and ignores a child chat grant", async () => {
        await expect(
            ensureChatAccess(
                {
                    id: "admin-chat",
                    user_id: "frank",
                    project_id: "proj-a",
                    org_id: "org-a",
                },
                "alice",
                "alice@example.com",
                db,
            ),
        ).resolves.toMatchObject({
            ok: true,
            isCreator: false,
            projectRole: "owner",
        });
    });

    it("denies another tenant's user and an unshared standalone chat", async () => {
        await expect(
            ensureChatAccess(
                {
                    id: "tenant-chat",
                    user_id: "alice",
                    project_id: "proj-a",
                    org_id: "org-a",
                },
                "bob",
                "bob@example.com",
                db,
            ),
        ).resolves.toEqual({ ok: false });

        await expect(
            ensureChatAccess(
                {
                    id: "private-chat",
                    user_id: "alice",
                    project_id: null,
                    org_id: null,
                },
                "carol",
                "carol@example.com",
                db,
            ),
        ).resolves.toEqual({ ok: false });
    });

    it("fails closed when the caller has no email to match a share against", async () => {
        await expect(
            ensureChatAccess(
                {
                    id: "direct-chat",
                    user_id: "alice",
                    project_id: null,
                    org_id: null,
                },
                "carol",
                null,
                db,
            ),
        ).resolves.toEqual({ ok: false });
    });
});

// ---------------------------------------------------------------------------
// listAccessibleProjectIds — completeness and cost
//
// This helper scopes chat lists and similar collection reads, so a project it
// silently omits is a project the caller cannot find at all. The previous
// shape had two faults that only appear at a real firm's size: an unpaged
// `.in("org_id", …)` that PostgREST truncates at its db-max-rows cap, and a
// per-row `checkProjectAccess` fan-out of two or three round trips EACH.
// ---------------------------------------------------------------------------

/**
 * Wraps the fake above so every query it is handed is recorded — which table,
 * which filters, and every `.range()` page. Counting queries is the only way
 * to state "one batched read, not one per project" as an assertion.
 */
function makeRecordingDb(tables: Record<string, Row[]>) {
    const queries: {
        table: string;
        filters: string[];
        ranges: [number, number][];
    }[] = [];
    const base = makeDb(tables);
    const db = {
        from(table: string) {
            const record = {
                table,
                filters: [] as string[],
                ranges: [] as [number, number][],
            };
            queries.push(record);
            const inner = base.from(table);
            const proxy: unknown = new Proxy(inner, {
                get(target, prop, receiver) {
                    const value = Reflect.get(target, prop, receiver);
                    if (typeof value !== "function") return value;
                    return (...args: unknown[]) => {
                        if (prop === "range")
                            record.ranges.push([
                                args[0] as number,
                                args[1] as number,
                            ]);
                        if (prop === "eq" || prop === "in" || prop === "is")
                            record.filters.push(`${String(prop)}:${args[0]}`);
                        const out = (value as (...a: unknown[]) => unknown).apply(
                            target,
                            args,
                        );
                        return out === target ? proxy : out;
                    };
                },
            });
            return proxy;
        },
    } as any;
    return { db, queries };
}

describe("listAccessibleProjectIds", () => {
    const orgProjects = (count: number) =>
        Array.from({ length: count }, (_, index) => ({
            id: `p${String(index).padStart(4, "0")}`,
            user_id: "founder",
            org_id: "org-1",
        }));

    it("pages through an org with more projects than one read returns", async () => {
        // 1500 matters, a 1000-row page. The unpaged read came back with the
        // first 1000 and no error, so the remaining 500 simply were not there
        // — and nothing in the response said so.
        const { db, queries } = makeRecordingDb({
            org_members: [{ org_id: "org-1", user_id: "u1", role: "member" }],
            projects: orgProjects(1500),
            project_access_grants: [],
            project_org_access_overrides: [],
        });

        const ids = await listAccessibleProjectIds("u1", "u1@example.com", db);

        expect(ids).toHaveLength(1500);
        expect(ids).toContain("p1499");
        // Each page is its own query, so collect the ranges across them.
        const orgReads = queries.filter(
            (query) =>
                query.table === "projects" &&
                query.filters.includes("in:org_id"),
        );
        // Two pages: a full one, then a short one that ends the loop.
        expect(orgReads.flatMap((query) => query.ranges)).toEqual([
            [0, 999],
            [1000, 1999],
        ]);
    });

    it("reads the deny overrides once for the whole org, not once per project", async () => {
        const { db, queries } = makeRecordingDb({
            org_members: [{ org_id: "org-1", user_id: "u1", role: "member" }],
            projects: orgProjects(40),
            project_access_grants: [],
            project_org_access_overrides: [],
        });

        await listAccessibleProjectIds("u1", "u1@example.com", db);

        const overrideReads = queries.filter(
            (query) => query.table === "project_org_access_overrides",
        );
        // One. The fan-out issued forty, plus a project row read and an
        // org-role read apiece.
        expect(overrideReads).toHaveLength(1);
        // Scoped by ORG, not by an `.in()` over every candidate project id —
        // that list is spliced into the PostgREST query string and grows with
        // the firm's matters until the request line is refused.
        expect(overrideReads[0].filters).toEqual([
            "in:org_id",
            "eq:user_id",
            "eq:role",
        ]);
    });

    it("hides a denied org project but keeps the creator's and the admin's", async () => {
        // The two exemptions checkProjectAccess applies, re-derived inline:
        // the creator and an org admin keep Owner and cannot be denied. Get
        // this wrong in the batched shape and a partner loses their own
        // matter to a deny row somebody else's role should never have.
        const tables = {
            org_members: [
                { org_id: "org-1", user_id: "member", role: "member" },
                { org_id: "org-1", user_id: "boss", role: "admin" },
                { org_id: "org-1", user_id: "author", role: "member" },
            ],
            projects: [
                { id: "walled", user_id: "author", org_id: "org-1" },
                { id: "open", user_id: "author", org_id: "org-1" },
            ],
            project_access_grants: [],
            project_org_access_overrides: [
                {
                    project_id: "walled",
                    org_id: "org-1",
                    user_id: "member",
                    role: "deny",
                },
                {
                    project_id: "walled",
                    org_id: "org-1",
                    user_id: "boss",
                    role: "deny",
                },
                {
                    project_id: "walled",
                    org_id: "org-1",
                    user_id: "author",
                    role: "deny",
                },
            ],
        };

        await expect(
            listAccessibleProjectIds(
                "member",
                "member@example.com",
                makeRecordingDb(tables).db,
            ),
        ).resolves.toEqual(["open"]);
        // An org admin cannot be denied.
        await expect(
            listAccessibleProjectIds(
                "boss",
                "boss@example.com",
                makeRecordingDb(tables).db,
            ),
        ).resolves.toEqual(["walled", "open"]);
        // Neither can the project's own creator.
        await expect(
            listAccessibleProjectIds(
                "author",
                "author@example.com",
                makeRecordingDb(tables).db,
            ),
        ).resolves.toEqual(["walled", "open"]);
    });
});
