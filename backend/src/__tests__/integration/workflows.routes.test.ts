import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

// ---------------------------------------------------------------------------
// Hoisted mock fns we want to reconfigure per-test.
// ---------------------------------------------------------------------------
const { checkProjectAccess, checkWorkflowAccess, deleteUserProjects, getOrgRole } = vi.hoisted(
    () => ({
        checkProjectAccess: vi.fn(),
        checkWorkflowAccess: vi.fn(),
        deleteUserProjects: vi.fn(),
        getOrgRole: vi.fn(),
    }),
);

// ---------------------------------------------------------------------------
// Configurable Supabase stub — same shape as projects.routes.test.ts's, since
// both exercise the same `app` import (which loads every router).
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

vi.mock("../../lib/access", () => ({
    checkProjectAccess: (...args: unknown[]) => checkProjectAccess(...args),
    checkWorkflowAccess: (...args: unknown[]) => checkWorkflowAccess(...args),
    ensureDocAccess: vi.fn(async () => ({ ok: true, isCreator: true })),
    ensureReviewAccess: vi.fn(async () => ({ ok: true, isCreator: true })),
    filterAccessibleDocumentIds: vi.fn(async (ids: string[]) => ids),
    listAccessibleProjectIds: vi.fn(async () => []),
    getOrgRole: (...args: unknown[]) => getOrgRole(...args),
}));

vi.mock("../../lib/userDataCleanup", () => ({
    deleteUserProjects: (...args: unknown[]) => deleteUserProjects(...args),
    deleteAllUserChats: vi.fn(async () => {}),
    deleteAllUserTabularReviews: vi.fn(async () => {}),
    deleteUserAccountData: vi.fn(async () => {}),
}));

vi.mock("../../lib/documentVersions", () => ({
    attachActiveVersionPaths: vi.fn(async () => {}),
    attachLatestVersionNumbers: vi.fn(async () => {}),
    contentSha256: vi.fn(() => "0".repeat(64)),
    loadActiveVersion: vi.fn(async () => null),
}));

import { app } from "../../app";
import { ensureDocAccess } from "../../lib/access";
import { createServerSupabase } from "../../lib/supabase";
import { resetEnsuredDefaultUsersForTests } from "../../lib/workflowCatalog";

const AUTH = ["Authorization", "Bearer test"] as const;

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

describe("workflows.routes", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetSupabaseState();
        resetEnsuredDefaultUsersForTests();
        // Default: the caller belongs to no organization.
        getOrgRole.mockResolvedValue(null);
        checkWorkflowAccess.mockImplementation(
            async (_workflowId: string, userId: string) => {
                const workflow = supabaseState.tables.workflows?.data as
                    | { id: string; user_id: string | null; org_id?: string | null }
                    | null
                    | undefined;
                if (!workflow) return { ok: false };
                const isCreator = workflow.user_id === userId;
                if (isCreator)
                    return {
                        ok: true,
                        isCreator: true,
                        orgRole: null,
                        projectRole: "owner",
                        workflow,
                    };
                if (!workflow.org_id) return { ok: false };
                const orgRole = await getOrgRole(userId, workflow.org_id);
                if (!orgRole) return { ok: false };
                return {
                    ok: true,
                    isCreator: false,
                    orgRole,
                    projectRole: orgRole === "admin" ? "owner" : "editor",
                    workflow,
                };
            },
        );
    });

    // ── GET /workflows (overview) ─────────────────────────────────────────
    describe("GET /workflows", () => {
        it("returns the user's installed workflows when no pagination params are present", async () => {
            supabaseState.rpc = {
                data: [
                    {
                        id: "w1",
                        title: "My workflow",
                        org_id: "org-1",
                        access_scope: "organization",
                        organization_name: "Elite Law LLP",
                    },
                ],
                error: null,
            };

            const res = await request(app)
                .get("/workflows?type=assistant")
                .set(...AUTH);

            expect(res.status).toBe(200);
            // Defaults are installed as user-owned database workflows rather
            // than prepended from the static system catalog.
            expect(res.body.at(-1)).toMatchObject({
                id: "w1",
                is_system: false,
                org_id: "org-1",
                access_scope: "organization",
                organization_name: "Elite Law LLP",
                metadata: { title: "My workflow" },
            });
        });

        it("backfills organization access when the overview RPC is stale", async () => {
            supabaseState.rpc = {
                data: [{ id: "w1", title: "Firm workflow", is_owner: true }],
                error: null,
            };
            supabaseState.tables.workflows = {
                data: [{ id: "w1", org_id: "org-1" }],
                error: null,
            };
            supabaseState.tables.workflow_shares = {
                data: [],
                error: null,
            };
            supabaseState.tables.organizations = {
                data: [{ id: "org-1", name: "Elite Law LLP" }],
                error: null,
            };

            const res = await request(app)
                .get("/workflows?type=assistant")
                .set(...AUTH);

            expect(res.status).toBe(200);
            expect(res.body.at(-1)).toMatchObject({
                id: "w1",
                org_id: "org-1",
                access_scope: "organization",
                organization_name: "Elite Law LLP",
            });
        });

        // Regression guard: the workflow picker modal, the chat slash-menu
        // picker, and UseWorkflowModal's own independent fetch all call
        // GET /workflows with no pagination params and need the exact
        // legacy response shape (system workflows included) back. If this
        // ever silently switched to the paginated RPC shape by default,
        // those callers would start seeing a truncated, system-workflow-free
        // list with no error.
        it("calls the legacy 3-arg RPC shape when no pagination params are present", async () => {
            const captured = captureRpcArgs();
            supabaseState.rpc = { data: [], error: null };

      await request(app)
        .get("/workflows?type=tabular")
        .set(...AUTH);

            expect(captured.name).toBe("get_workflows_overview");
            expect(captured.args).toEqual({
                p_user_id: "u1",
                p_user_email: "u1@test.local",
                p_type: "tabular",
            });
        });

        it("calls the paginated RPC shape with every filter parsed once any pagination param is present, and omits system workflows", async () => {
            const captured = captureRpcArgs();
            supabaseState.rpc = { data: [], error: null };

            const res = await request(app)
                .get(
                    "/workflows?limit=10&scope=owned&sort_key=name&sort_direction=asc" +
                        "&search=nda&practice=Litigation&language=English&jurisdiction=NSW",
                )
                .set(...AUTH);

            expect(res.status).toBe(200);
            expect(res.body).toEqual([]);
            expect(captured.name).toBe("get_workflows_overview");
            expect(captured.args).toEqual({
                p_user_id: "u1",
                p_user_email: "u1@test.local",
                p_type: null,
                p_scope: "owned",
                p_limit: 10,
                p_offset: 0,
                p_search_term: "nda",
                p_sort_key: "name",
                p_sort_direction: "asc",
                p_practice: "Litigation",
                p_language: "English",
                p_jurisdiction: "NSW",
            });
        });

        it("returns 500 with detail when the RPC errors", async () => {
            supabaseState.rpc = { data: null, error: { message: "boom" } };

      const res = await request(app)
        .get("/workflows?type=assistant")
        .set(...AUTH);

            expect(res.status).toBe(500);
            expect(res.body.detail).toBe("Something went wrong. Please try again.");
        });
    });

    // ── GET /workflows/system ──────────────────────────────────────────────
    describe("GET /workflows/system", () => {
        it("returns catalog workflows in the legacy system response shape", async () => {
            supabaseState.tables.mike_workflows = {
                data: [
                    {
                        id: "catalog-1",
                        workflow_key: "proofread",
                        distribution: "default",
                        version: "1.0.0",
                        title: "Proofread",
                        description: "Proofread a document.",
                        type: "assistant",
                        prompt_md: "# Proofread",
                        columns_config: null,
                        contributors: [],
                        language: "English",
                        practice: "General Transactions",
                        jurisdictions: ["General"],
                        pack_key: null,
                        pack_title: null,
                        pack_description: null,
                        pack_version: null,
                        source_commit: "a".repeat(40),
                        content_hash: "b".repeat(64),
                        active: true,
                        created_at: "2026-08-23T00:00:00.000Z",
                        updated_at: "2026-08-23T00:00:00.000Z",
                    },
                ],
                error: null,
            };
            const res = await request(app)
                .get("/workflows/system?type=assistant")
                .set(...AUTH);

            expect(res.status).toBe(200);
            expect(res.body).toEqual([
                expect.objectContaining({
                    id: "builtin-proofread",
                    is_system: true,
                    metadata: expect.objectContaining({
                        type: "assistant",
                        title: "Proofread",
                    }),
                }),
            ]);
            expect(createServerSupabase).toHaveBeenCalled();
        });
    });

    // ── GET /workflows/ids (select-all-matching support) ──────────────────
    describe("GET /workflows/ids", () => {
        it("pages through the RPC until an empty page is returned", async () => {
            const rpcMock = vi
                .fn()
                .mockResolvedValueOnce({ data: 0, error: null })
                .mockResolvedValueOnce({
                    data: [{ id: "w1", user_id: "u1" }],
                    error: null,
                })
                .mockResolvedValueOnce({ data: [], error: null });
            vi.mocked(createServerSupabase).mockImplementationOnce(() => {
                const db = mockSupabase();
                db.rpc = rpcMock;
                return db as unknown as ReturnType<typeof createServerSupabase>;
            });

      const res = await request(app)
        .get("/workflows/ids")
        .set(...AUTH);

            expect(res.status).toBe(200);
            expect(res.body).toEqual([{ id: "w1", user_id: "u1" }]);
            expect(rpcMock).toHaveBeenCalledTimes(3);
            expect(rpcMock.mock.calls[0][0]).toBe(
                "install_missing_default_workflows",
            );
            expect(rpcMock.mock.calls[1][0]).toBe("get_workflow_ids_overview");
        });

        it("returns 500 with detail when the RPC errors", async () => {
            supabaseState.rpc = { data: null, error: { message: "boom" } };

      const res = await request(app)
        .get("/workflows/ids")
        .set(...AUTH);

            expect(res.status).toBe(500);
            expect(res.body.detail).toBe("Something went wrong. Please try again.");
        });
    });

  describe("GET /workflows/filter-options", () => {
    it("passes type and scope to the facet RPC", async () => {
      const captured = captureRpcArgs();
      supabaseState.rpc = {
        data: [
          {
            practices: ["Disputes"],
            languages: ["English"],
            jurisdictions: ["Singapore"],
          },
        ],
        error: null,
      };

      const res = await request(app)
        .get("/workflows/filter-options?type=assistant&scope=shared")
        .set(...AUTH);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        practices: ["Disputes"],
        languages: ["English"],
        jurisdictions: ["Singapore"],
      });
      expect(captured.name).toBe("get_workflow_filter_options");
      expect(captured.args).toEqual({
        p_user_id: "u1",
        p_user_email: "u1@test.local",
        p_type: "assistant",
        p_scope: "shared",
      });
    });
  });

  describe("POST /workflows/:workflowId/assets/from-documents", () => {
    it("rejects an empty saved-file selection", async () => {
      const res = await request(app)
        .post("/workflows/workflow-1/assets/from-documents")
        .set(...AUTH)
        .send({ document_ids: [] });

      expect(res.status).toBe(400);
      expect(res.body.detail).toContain("between 1 and 50");
      expect(createServerSupabase).not.toHaveBeenCalled();
    });

    it("does not allow assets on a tabular workflow", async () => {
      supabaseState.tables.workflows = {
        data: {
          id: "workflow-1",
          user_id: "u1",
          type: "tabular",
        },
        error: null,
      };

      const res = await request(app)
        .post("/workflows/workflow-1/assets/from-documents")
        .set(...AUTH)
        .send({ document_ids: ["document-1"] });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        detail: "Assets are only available for assistant workflows",
      });
    });
  });

  // ── Organization workflows ────────────────────────────────────────────
  // Before this, org workflows were write-dead: POST hardcoded org_id null so
  // no API call could create one, and the org arm of the list RPC reported
  // allow_edit false so even an org admin could not change one that already
  // existed. The only way to get an org workflow at all was the account
  // -deletion detach path — a firm's shared workflow that nobody could make
  // and nobody could edit.
  describe("organization workflows", () => {
    const create = (body: Record<string, unknown>) =>
      request(app)
        .post("/workflows")
        .set(...AUTH)
        .send({
          metadata: { title: "Firm playbook", type: "assistant" },
          ...body,
        });

    it("files a workflow under an organization the caller belongs to", async () => {
      getOrgRole.mockResolvedValue("member");
      supabaseState.tables.workflows = {
        data: { id: "w-org", user_id: "u1", org_id: "org-1" },
        error: null,
      };

      const res = await create({ org_id: "org-1" });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        org_id: "org-1",
        access_scope: "organization",
        organization_name: null,
      });
      expect(
        supabaseState.inserts.find((i) => i.table === "workflows")?.payload,
      ).toMatchObject({ org_id: "org-1", user_id: "u1" });
    });

    it("400s an org the caller does not belong to, and writes nothing", async () => {
      getOrgRole.mockResolvedValue(null);

      const res = await create({ org_id: "org-elsewhere" });

      expect(res.status).toBe(400);
      expect(res.body.detail).toBe(
        "You are not a member of that organization.",
      );
      expect(supabaseState.inserts).toEqual([]);
    });

    it("keeps a workflow personal when no org is named", async () => {
      supabaseState.tables.workflows = {
        data: { id: "w1", user_id: "u1", org_id: null },
        error: null,
      };

      const res = await create({});

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        org_id: null,
        access_scope: "private",
        organization_name: null,
      });
      expect(
        supabaseState.inserts.find((i) => i.table === "workflows")?.payload,
      ).toMatchObject({ org_id: null });
    });

    it("lets a colleague in the same org edit an org workflow", async () => {
      // The workflow belongs to the organization, not to whoever drafted it.
      // Both org roles sit at member or above on the ladder, where editing
      // content is a member capability.
      supabaseState.tables.workflows = {
        data: {
          id: "w-org",
          user_id: "someone-else",
          org_id: "org-1",
          title: "Firm playbook",
        },
        error: null,
      };
      supabaseState.tables.workflow_shares = { data: null, error: null };
      getOrgRole.mockResolvedValue("member");

      const res = await request(app)
        .patch("/workflows/w-org")
        .set(...AUTH)
        .send({ metadata: { title: "Firm playbook v2" } });

      expect(res.status).toBe(200);
      // Editable, but not owned: share and delete stay with the creator.
      expect(res.body.allow_edit).toBe(true);
      expect(res.body.is_owner).toBe(false);
    });

    it("still refuses an org workflow to somebody outside the org", async () => {
      supabaseState.tables.workflows = {
        data: { id: "w-org", user_id: "someone-else", org_id: "org-1" },
        error: null,
      };
      supabaseState.tables.workflow_shares = { data: null, error: null };
      getOrgRole.mockResolvedValue(null);

      const res = await request(app)
        .patch("/workflows/w-org")
        .set(...AUTH)
        .send({ metadata: { title: "Nope" } });

      expect(res.status).toBe(404);
    });
  });

  describe("workflow direct grants", () => {
    it("rejects a personal grant for an email that has not registered", async () => {
      supabaseState.tables.workflows = {
        data: { id: "w-personal", user_id: "u1", org_id: null },
        error: null,
      };
      supabaseState.tables.user_profiles = { data: [], error: null };

      const res = await request(app)
        .post("/workflows/w-personal/share")
        .set(...AUTH)
        .send({ emails: ["future@firm.test"], role: "viewer" });

      expect(res.status).toBe(400);
      expect(res.body.detail).toBe(
        "future@firm.test does not belong to a Mike user.",
      );
    });

    it("stores a personal grant for an existing user", async () => {
      supabaseState.tables.workflows = {
        data: { id: "w-personal", user_id: "u1", org_id: null },
        error: null,
      };
      supabaseState.tables.user_profiles = {
        data: [{ email: "colleague@firm.test" }],
        error: null,
      };
      supabaseState.tables.workflow_shares = { data: null, error: null };

      const res = await request(app)
        .post("/workflows/w-personal/share")
        .set(...AUTH)
        .send({ emails: ["colleague@firm.test"], role: "editor" });

      expect(res.status).toBe(204);
    });

    // Revoking used to fire the delete and ignore its result: a failed
    // delete and an unknown share id both answered 204, so the client
    // dropped the row from the list while the person kept access.
    describe("DELETE /workflows/:workflowId/shares/:shareId", () => {
      beforeEach(() => {
        supabaseState.tables.workflows = {
          data: { id: "w-personal", user_id: "u1", org_id: null },
          error: null,
        };
      });

      it("returns 204 when a row was actually removed", async () => {
        supabaseState.tables.workflow_shares = {
          data: [{ id: "s1" }],
          error: null,
        };

        const res = await request(app)
          .delete("/workflows/w-personal/shares/s1")
          .set(...AUTH);

        expect(res.status).toBe(204);
      });

      it("returns 404 when the share id matched nothing", async () => {
        supabaseState.tables.workflow_shares = { data: [], error: null };

        const res = await request(app)
          .delete("/workflows/w-personal/shares/s-unknown")
          .set(...AUTH);

        expect(res.status).toBe(404);
        expect(res.body.detail).toBe("Access grant not found");
      });

      it("reports a failed delete instead of a false 204", async () => {
        supabaseState.tables.workflow_shares = {
          data: null,
          error: { message: "boom" },
        };

        const res = await request(app)
          .delete("/workflows/w-personal/shares/s1")
          .set(...AUTH);

        expect(res.status).toBe(500);
        expect(res.body.detail).toBe("Something went wrong. Please try again.");
      });
    });

    // ── organization overrides are written as ONE statement ─────────────
    // The loop used to validate and write one email at a time, so a bad
    // third address returned 400 with the first two overrides already
    // persisted: the caller read "nothing happened" while access had
    // silently changed for two people. Validation now completes first, and
    // the write is a single bulk upsert so a trigger refusal rolls the whole
    // batch back rather than stopping half way.
    function orgShareDb(options: { upsertError?: string } = {}) {
      const upserts: { payload: unknown; options: unknown }[] = [];
      const build = (resolve: (filters: Record<string, unknown>) => unknown) => {
        const filters: Record<string, unknown> = {};
        const b: Record<string, unknown> = {};
        for (const method of ["select", "order", "limit", "in", "is"])
          b[method] = () => b;
        b.eq = (column: string, value: unknown) => {
          filters[column] = value;
          return b;
        };
        b.upsert = (payload: unknown, upsertOptions?: unknown) => {
          upserts.push({ payload, options: upsertOptions });
          return b;
        };
        const settle = () => ({
          data: resolve(filters),
          error:
            upserts.length && options.upsertError
              ? { message: options.upsertError }
              : null,
        });
        b.single = () => Promise.resolve(settle());
        b.maybeSingle = b.single;
        b.then = (onResolve: (v: unknown) => unknown) =>
          Promise.resolve(settle()).then(onResolve);
        return b;
      };
      const db = {
        from: (table: string) => {
          if (table === "workflows")
            return build(() => ({
              id: "w-org",
              user_id: "u1",
              org_id: "org-1",
            }));
          if (table === "user_profiles")
            return build((filters) => {
              const email = String(filters.email ?? "");
              return email
                ? { user_id: `u-${email.split("@")[0]}`, email }
                : null;
            });
          if (table === "org_members")
            return build((filters) =>
              // The third address belongs to a real user who is not in this
              // organization.
              filters.user_id === "u-third"
                ? null
                : { user_id: filters.user_id, role: "member" },
            );
          return build(() => null);
        },
        rpc: () => Promise.resolve({ data: null, error: null }),
        auth: {
          getUser: () =>
            Promise.resolve({ data: { user: { id: "u1" } }, error: null }),
        },
      } as unknown as ReturnType<typeof createServerSupabase>;
      return { db, upserts };
    }

    function shareOrgWorkflow(emails: string[]) {
      supabaseState.tables.workflows = {
        data: { id: "w-org", user_id: "u1", org_id: "org-1" },
        error: null,
      };
      return request(app)
        .post("/workflows/w-org/share")
        .set(...AUTH)
        .send({ emails, role: "viewer" });
    }

    it("writes no org override when a later email in the batch is invalid", async () => {
      const { db, upserts } = orgShareDb();
      vi.mocked(createServerSupabase).mockImplementationOnce(() => db);

      const res = await shareOrgWorkflow([
        "first@firm.test",
        "second@firm.test",
        "third@firm.test",
      ]);

      // SOFT, both of them: "nothing was written" is the claim that matters,
      // and a plain assertion on the status would abandon the run before it
      // was ever checked — so a regression that wrote the first two rows AND
      // changed the status code would have been reported as a status bug.
      expect.soft(res.status).toBe(400);
      expect.soft(upserts).toEqual([]);
    });

    it("writes the whole batch in exactly one upsert", async () => {
      // One statement, so a trigger refusal on any row rolls back the rest.
      // Three separate upserts would be three separate transactions.
      const { db, upserts } = orgShareDb();
      vi.mocked(createServerSupabase).mockImplementationOnce(() => db);

      const res = await shareOrgWorkflow([
        "first@firm.test",
        "second@firm.test",
      ]);

      expect(res.status).toBe(204);
      expect(upserts).toHaveLength(1);
      expect(upserts[0].payload).toEqual([
        expect.objectContaining({
          workflow_id: "w-org",
          org_id: "org-1",
          user_id: "u-first",
          role: "viewer",
          assigned_by: "u1",
        }),
        expect.objectContaining({
          workflow_id: "w-org",
          org_id: "org-1",
          user_id: "u-second",
          role: "viewer",
          assigned_by: "u1",
        }),
      ]);
      // Upsert, not insert: re-sharing with somebody who already has an
      // override must change their role rather than fail on the key.
      expect(upserts[0].options).toEqual({
        onConflict: "workflow_id,user_id",
      });
    });

    it("answers 500 and writes nothing when the bulk upsert is refused", async () => {
      // The org-membership triggers can still refuse a row after validation
      // passed. That is a database failure, not a bad request, and the whole
      // statement rolls back.
      const { db, upserts } = orgShareDb({
        upsertError: "org_members_protect_last_admin",
      });
      vi.mocked(createServerSupabase).mockImplementationOnce(() => db);

      const res = await shareOrgWorkflow([
        "first@firm.test",
        "second@firm.test",
      ]);

      expect.soft(res.status).toBe(500);
      expect.soft(res.body.detail).toBe(
        "Something went wrong. Please try again.",
      );
      // One attempt, all-or-nothing — not two rows written and a third
      // refused.
      expect.soft(upserts).toHaveLength(1);
    });
  });

  describe("organization workflow Owner operations", () => {
    const detached = {
      id: "w-orphan",
      user_id: null,
      org_id: "org-1",
      title: "Orphaned firm playbook",
    };

    function captureWorkflowQueries() {
      const queries: { table: string; q: Record<string, unknown> }[] = [];
      vi.mocked(createServerSupabase).mockImplementationOnce(() => {
        const db = mockSupabase();
        const originalFrom = db.from;
        db.from = vi.fn((table: string) => {
          const q = originalFrom(table);
          queries.push({ table, q: q as Record<string, unknown> });
          return q;
        });
        return db as unknown as ReturnType<typeof createServerSupabase>;
      });
      return queries;
    }

    it("lets an org admin delete a workflow whose creator's account is gone", async () => {
      supabaseState.tables.workflows = { data: detached, error: null };
      supabaseState.tables.workflow_reference_documents = {
        data: [],
        error: null,
      };
      getOrgRole.mockResolvedValue("admin");
      const queries = captureWorkflowQueries();

      const res = await request(app)
        .delete("/workflows/w-orphan")
        .set(...AUTH);

      expect(res.status).toBe(204);
      expect(getOrgRole).toHaveBeenCalledWith("u1", "org-1");
      // The delete must be keyed by id alone: nothing can match a NULL
      // creator, so any user_id filter would turn this into a silent no-op.
      for (const { table, q } of queries) {
        if (table !== "workflows") continue;
        const eq = q.eq as ReturnType<typeof vi.fn>;
        const columns = eq.mock.calls.map((c) => c[0]);
        expect(columns).not.toContain("user_id");
      }
    });

    it("does not extend Owner operations to org Members", async () => {
      supabaseState.tables.workflows = { data: detached, error: null };
      getOrgRole.mockResolvedValue("member");

      const res = await request(app)
        .delete("/workflows/w-orphan")
        .set(...AUTH);

      expect(res.status).toBe(404);
    });

    it("lets an org Admin manage a workflow with a living creator", async () => {
      supabaseState.tables.workflows = {
        data: { ...detached, user_id: "someone-else" },
        error: null,
      };
      getOrgRole.mockResolvedValue("admin");

      const res = await request(app)
        .delete("/workflows/w-orphan")
        .set(...AUTH);

      expect(res.status).toBe(204);
    });

    it("applies the same Owner rule to the sharing surface", async () => {
      supabaseState.tables.workflows = { data: detached, error: null };
      supabaseState.tables.workflow_shares = { data: [], error: null };
      getOrgRole.mockResolvedValue("admin");

      const res = await request(app)
        .get("/workflows/w-orphan/shares")
        .set(...AUTH);

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it("keeps the sharing surface closed to org members", async () => {
      supabaseState.tables.workflows = { data: detached, error: null };
      getOrgRole.mockResolvedValue("member");

      const res = await request(app)
        .get("/workflows/w-orphan/shares")
        .set(...AUTH);

      expect(res.status).toBe(404);
    });
  });
  // ── POST /workflows/:workflowId/assets/from-documents ─────────────────
  // ensureDocAccess resolves a document through its project, then its
  // workflow, then its ORG. A row selected without org_id therefore looks
  // container-less and is refused — so every organization-library file was
  // unattachable, answering "One or more files could not be found" for a
  // file the caller is looking straight at.
  describe("POST /workflows/:workflowId/assets/from-documents", () => {
    const DOC_ID = "55555555-5555-4555-8555-555555555555";

    /**
     * PROJECTS the row to the columns the caller selected, which is what
     * makes a missing column in the select string observable at all. The
     * shared stub hands back whole rows regardless of `.select()`, so under
     * it this bug is invisible.
     */
    function projectingDb(row: Record<string, unknown>) {
      const selects: Record<string, string> = {};
      const build = (table: string, resolve: () => unknown) => {
        let columns = "*";
        const b: Record<string, unknown> = {};
        for (const method of ["eq", "in", "is", "order", "limit"])
          b[method] = () => b;
        b.select = (value?: string) => {
          columns = value ?? "*";
          selects[table] = columns;
          return b;
        };
        const project = (value: unknown) => {
          if (columns === "*" || !value || typeof value !== "object")
            return value;
          const wanted = columns.split(",").map((column) => column.trim());
          return Object.fromEntries(
            Object.entries(value as Record<string, unknown>).filter(
              ([column]) => wanted.includes(column),
            ),
          );
        };
        const settle = () => {
          const value = resolve();
          return {
            data: Array.isArray(value) ? value.map(project) : project(value),
            error: null,
          };
        };
        b.single = () => Promise.resolve(settle());
        b.maybeSingle = b.single;
        b.then = (onResolve: (v: unknown) => unknown) =>
          Promise.resolve(settle()).then(onResolve);
        return b;
      };
      const db = {
        from: (table: string) => {
          if (table === "workflows")
            return build(table, () => ({
              id: "w-org",
              user_id: "u1",
              org_id: "org-1",
              type: "assistant",
            }));
          if (table === "documents") return build(table, () => [row]);
          return build(table, () => []);
        },
        rpc: () => Promise.resolve({ data: null, error: null }),
        auth: {
          getUser: () =>
            Promise.resolve({ data: { user: { id: "u1" } }, error: null }),
        },
      } as unknown as ReturnType<typeof createServerSupabase>;
      return { db, selects };
    }

    it("selects org_id, so an org-library file attaches", async () => {
      supabaseState.tables.workflows = {
        data: { id: "w-org", user_id: "u1", org_id: "org-1", type: "assistant" },
        error: null,
      };
      // Mirrors the real fall-through: a row with no project, no workflow and
      // no org has no container to grant access, so it is refused.
      vi.mocked(ensureDocAccess).mockImplementation(
        async (document: unknown) => ({
          ok: Boolean(
            (document as Record<string, unknown>).project_id ??
              (document as Record<string, unknown>).workflow_id ??
              (document as Record<string, unknown>).org_id,
          ),
        }),
      );
      const { db, selects } = projectingDb({
        id: DOC_ID,
        user_id: "u2",
        project_id: null,
        workflow_id: null,
        // Filed straight in the organization's library.
        org_id: "org-1",
        current_version_id: null,
      });
      vi.mocked(createServerSupabase).mockImplementationOnce(() => db);

      const res = await request(app)
        .post("/workflows/w-org/assets/from-documents")
        .set(...AUTH)
        .send({ document_ids: [DOC_ID] });

      // Past the access gate. (409 because the fixture has no ready version,
      // which is a later guard entirely — the point is that it is no longer
      // "could not be found".)
      expect(res.status).toBe(409);
      expect(res.body.detail).toBe("One or more files are not ready");
      expect(selects.documents).toContain("org_id");
      expect(selects.documents).toContain("workflow_id");
    });
  });
});
