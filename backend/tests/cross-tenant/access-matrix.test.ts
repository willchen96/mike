/**
 * CLEAN-41 — Cross-tenant access matrix red baseline.
 *
 * Authored against current `main` BEFORE any cleanup fix lands (Phases 4-13).
 * Every assertion wrapped with `it.fails(...)` represents a known cross-tenant
 * leak that a later phase MUST fix:
 *   - Phase 4: app-layer access scoping for collection/detail routes
 *   - Phase 11: RLS policies (anon-key block)
 * As each phase ships, the corresponding `it.fails` is removed (turning into
 * a normal passing `it(...)`). The git diff is the proof that the bug existed.
 *
 * Phase 3 access matrix (from 03-RESEARCH.md):
 *
 * | # | Verb   | Path                                    | User-B expects          |
 * |---|--------|-----------------------------------------|-------------------------|
 * | 1 | GET    | /projects                               | 200 + empty array       |
 * | 2 | GET    | /projects/:id                           | 404                     |
 * | 3 | PATCH  | /projects/:id                           | 404                     |
 * | 4 | DELETE | /projects/:id                           | 404                     |
 * | 5 | GET    | /projects/:id/chats                     | 404                     |
 * | 6 | GET    | /projects/:id/documents                 | 404                     |
 * | 7 | GET    | /single-documents                       | 200 + empty array       |
 * | 8 | GET    | /single-documents/:id/display           | 404                     |
 * | 9 | GET    | /single-documents/:id/url               | 404                     |
 * |10 | GET    | /single-documents/:id/versions          | 404                     |
 * |11 | DELETE | /single-documents/:id                   | 404                     |
 * |12 | GET    | /chat                                   | 200 + empty array       |
 * |13 | GET    | /chat/:id                               | 404                     |
 * |14 | DELETE | /chat/:id                               | 404                     |
 * |15 | GET    | /tabular-review                         | 200 + empty array       |
 * |16 | GET    | /tabular-review/:id                     | 404                     |
 * |17 | PATCH  | /tabular-review/:id                     | 404                     |
 * |18 | DELETE | /tabular-review/:id                     | 404                     |
 * |19 | GET    | /workflows                              | no user-A workflow IDs  |
 * |20 | GET    | /workflows/:id                          | 404                     |
 * |21 | DELETE | /workflows/:id                          | 404                     |
 */

import { describe, it, expect, beforeAll } from "vitest";
import supertest from "supertest";
import { createClient } from "@supabase/supabase-js";
import { app } from "../../src/app";
import { seedAsUserA, type SeededResources } from "./helpers/seed";

let jwtA: string;
let jwtB: string;
let userIdA: string;
let userIdB: string;
let seeded: SeededResources;

beforeAll(async () => {
  jwtA = process.env.TEST_JWT_A!;
  jwtB = process.env.TEST_JWT_B!;
  userIdA = process.env.TEST_USER_A_ID!;
  userIdB = process.env.TEST_USER_B_ID!;
  if (!jwtA || !jwtB) {
    throw new Error(
      "globalSetup did not run; TEST_JWT_A/B missing. Run via npm run test:cross-tenant.",
    );
  }
  seeded = await seedAsUserA(jwtA);
}, 60_000);

// ── 1. Projects ───────────────────────────────────────────────────────────────

describe("Projects — cross-tenant isolation", () => {
  // Route 1: GET /projects — collection; user-B has no projects so gets empty array
  it("user-B GET /projects returns empty array (no user-A projects visible)", async () => {
    const res = await supertest(app)
      .get("/projects")
      .set("Authorization", `Bearer ${jwtB}`);
    expect(res.status).toBe(200);
    // The result array must not contain user-A's project
    const ids = (res.body as { id: string }[]).map((p) => p.id);
    expect(ids).not.toContain(seeded.projectId);
  });

  // Route 2: GET /projects/:id — detail isolation; currently returns 404 (PASSING)
  it("user-B cannot GET user-A project detail", async () => {
    const res = await supertest(app)
      .get(`/projects/${seeded.projectId}`)
      .set("Authorization", `Bearer ${jwtB}`);
    expect(res.status).toBe(404);
  });

  // Route 3: PATCH /projects/:id — mutation isolation; currently returns 404 (PASSING)
  it("user-B cannot PATCH user-A project", async () => {
    const res = await supertest(app)
      .patch(`/projects/${seeded.projectId}`)
      .set("Authorization", `Bearer ${jwtB}`)
      .send({ name: "Hijacked" });
    expect(res.status).toBe(404);
  });

  // Route 4: DELETE /projects/:id — mutation isolation
  // RED BASELINE: DELETE uses .eq("user_id") only → returns 204 (no rows deleted)
  // instead of 404. Deferred — owned by Phase 5 (app-layer DELETE 404 hardening).
  it(
    "user-B DELETE /projects/:id returns 404 [RED: currently 204]",
    async () => {
      const res = await supertest(app)
        .delete(`/projects/${seeded.projectId}`)
        .set("Authorization", `Bearer ${jwtB}`);
      expect(res.status).toBe(404);
    },
  );

  // Route 5: GET /projects/:id/chats — nested collection isolation; currently 404 (PASSING)
  it("user-B cannot GET chats under user-A project", async () => {
    const res = await supertest(app)
      .get(`/projects/${seeded.projectId}/chats`)
      .set("Authorization", `Bearer ${jwtB}`);
    expect(res.status).toBe(404);
  });

  // Route 6: GET /projects/:id/documents — nested collection isolation; currently 404 (PASSING)
  it("user-B cannot GET documents under user-A project", async () => {
    const res = await supertest(app)
      .get(`/projects/${seeded.projectId}/documents`)
      .set("Authorization", `Bearer ${jwtB}`);
    expect(res.status).toBe(404);
  });
});

// ── 2. Single documents ───────────────────────────────────────────────────────

describe("Single documents — cross-tenant isolation", () => {
  // Route 7: GET /single-documents — collection; user-B has none
  it("user-B GET /single-documents returns empty array (no user-A docs visible)", async () => {
    const res = await supertest(app)
      .get("/single-documents")
      .set("Authorization", `Bearer ${jwtB}`);
    expect(res.status).toBe(200);
    const ids = (res.body as { id: string }[]).map((d) => d.id);
    expect(ids).not.toContain(seeded.documentId);
  });

  // Route 8: GET /single-documents/:id/display — detail isolation
  it("user-B cannot GET user-A document display", async () => {
    const res = await supertest(app)
      .get(`/single-documents/${seeded.documentId}/display`)
      .set("Authorization", `Bearer ${jwtB}`);
    expect(res.status).toBe(404);
  });

  // Route 9: GET /single-documents/:id/url — signed-URL isolation
  it("user-B cannot GET user-A document url", async () => {
    const res = await supertest(app)
      .get(`/single-documents/${seeded.documentId}/url`)
      .set("Authorization", `Bearer ${jwtB}`);
    expect(res.status).toBe(404);
  });

  // Route 10: GET /single-documents/:id/versions — nested collection isolation
  it("user-B cannot GET user-A document versions", async () => {
    const res = await supertest(app)
      .get(`/single-documents/${seeded.documentId}/versions`)
      .set("Authorization", `Bearer ${jwtB}`);
    expect(res.status).toBe(404);
  });

  // Route 11: DELETE /single-documents/:id — mutation isolation
  // Fixed in Phase 4 (CLEAN-12): documents.ts DELETE performs a select+check before
  // deleting, returning 404 when the doc does not belong to the requesting user.
  it(
    "user-B DELETE /single-documents/:id returns 404 [fixed in Phase 4 — CLEAN-12]",
    async () => {
      const res = await supertest(app)
        .delete(`/single-documents/${seeded.documentId}`)
        .set("Authorization", `Bearer ${jwtB}`);
      expect(res.status).toBe(404);
    },
  );
});

// ── 3. Chats ──────────────────────────────────────────────────────────────────

describe("Chats — cross-tenant isolation", () => {
  // Route 12: GET /chat — collection; user-B has no chats
  it("user-B GET /chat returns empty array (no user-A chats visible)", async () => {
    const res = await supertest(app)
      .get("/chat")
      .set("Authorization", `Bearer ${jwtB}`);
    expect(res.status).toBe(200);
    const ids = (res.body as { id: string }[]).map((c) => c.id);
    expect(ids).not.toContain(seeded.chatId);
  });

  // Route 13: GET /chat/:id — detail isolation; currently 404 (PASSING)
  it("user-B cannot GET user-A chat detail", async () => {
    const res = await supertest(app)
      .get(`/chat/${seeded.chatId}`)
      .set("Authorization", `Bearer ${jwtB}`);
    expect(res.status).toBe(404);
  });

  // Route 14: DELETE /chat/:id — mutation isolation
  // RED BASELINE: DELETE uses .eq("user_id") only → returns 204 instead of 404.
  // Deferred — owned by Phase 5 (app-layer DELETE 404 hardening).
  it(
    "user-B DELETE /chat/:id returns 404 [RED: currently 204]",
    async () => {
      const res = await supertest(app)
        .delete(`/chat/${seeded.chatId}`)
        .set("Authorization", `Bearer ${jwtB}`);
      expect(res.status).toBe(404);
    },
  );
});

// ── 4. Tabular reviews ────────────────────────────────────────────────────────

describe("Tabular reviews — cross-tenant isolation", () => {
  // Route 15: GET /tabular-review — collection; user-B has none
  it("user-B GET /tabular-review returns empty array (no user-A reviews visible)", async () => {
    const res = await supertest(app)
      .get("/tabular-review")
      .set("Authorization", `Bearer ${jwtB}`);
    expect(res.status).toBe(200);
    const ids = (res.body as { id: string }[]).map((r) => r.id);
    expect(ids).not.toContain(seeded.reviewId);
  });

  // Route 16: GET /tabular-review/:id — detail isolation; currently 404 (PASSING)
  it("user-B cannot GET user-A tabular review detail", async () => {
    const res = await supertest(app)
      .get(`/tabular-review/${seeded.reviewId}`)
      .set("Authorization", `Bearer ${jwtB}`);
    expect(res.status).toBe(404);
  });

  // Route 17: PATCH /tabular-review/:id — mutation isolation; currently 404 (PASSING)
  it("user-B cannot PATCH user-A tabular review", async () => {
    const res = await supertest(app)
      .patch(`/tabular-review/${seeded.reviewId}`)
      .set("Authorization", `Bearer ${jwtB}`)
      .send({ title: "Hijacked" });
    expect(res.status).toBe(404);
  });

  // Route 18: DELETE /tabular-review/:id — mutation isolation
  // RED BASELINE: DELETE uses .eq("user_id") only → returns 204 instead of 404.
  // Deferred — owned by Phase 5 (app-layer DELETE 404 hardening).
  it(
    "user-B DELETE /tabular-review/:id returns 404 [RED: currently 204]",
    async () => {
      const res = await supertest(app)
        .delete(`/tabular-review/${seeded.reviewId}`)
        .set("Authorization", `Bearer ${jwtB}`);
      expect(res.status).toBe(404);
    },
  );
});

// ── 5. Workflows ──────────────────────────────────────────────────────────────

describe("Workflows — cross-tenant isolation", () => {
  // Route 19: GET /workflows — collection; user-B should not see user-A workflows
  it("user-B GET /workflows does not include user-A workflow", async () => {
    const res = await supertest(app)
      .get("/workflows")
      .set("Authorization", `Bearer ${jwtB}`);
    expect(res.status).toBe(200);
    // user-B is allowed to see their own workflows and builtins but NOT user-A's
    const ids = (res.body as { id: string }[]).map((w) => w.id);
    expect(ids).not.toContain(seeded.workflowId);
  });

  // Route 20: GET /workflows/:id — detail isolation; currently 404 (PASSING)
  it("user-B cannot GET user-A workflow detail", async () => {
    const res = await supertest(app)
      .get(`/workflows/${seeded.workflowId}`)
      .set("Authorization", `Bearer ${jwtB}`);
    expect(res.status).toBe(404);
  });

  // Route 21: DELETE /workflows/:id — mutation isolation
  // RED BASELINE: DELETE uses .eq("user_id") only → returns 204 instead of 404.
  // Deferred — owned by Phase 5 (app-layer DELETE 404 hardening).
  it(
    "user-B DELETE /workflows/:id returns 404 [RED: currently 204]",
    async () => {
      const res = await supertest(app)
        .delete(`/workflows/${seeded.workflowId}`)
        .set("Authorization", `Bearer ${jwtB}`);
      expect(res.status).toBe(404);
    },
  );
});

// ── 6. Anon-key RLS path (Phase 11 target — RED baseline at Phase 3) ──────────

const hasAnonKey = Boolean(process.env.SUPABASE_ANON_KEY);

(hasAnonKey ? describe : describe.skip)(
  "anon-key RLS path (Phase 11 target — RED baseline at Phase 3)",
  () => {
    const supabaseUrl = process.env.SUPABASE_URL!;
    const anonKey = process.env.SUPABASE_ANON_KEY!;
    let anonClientB: ReturnType<typeof createClient>;

    beforeAll(async () => {
      anonClientB = createClient(supabaseUrl, anonKey);
      const { error } = await anonClientB.auth.signInWithPassword({
        email: process.env.TEST_USER_B_EMAIL!,
        password: process.env.TEST_PASSWORD ?? "TestPassw0rd!",
      });
      if (error) {
        throw new Error(`[RLS beforeAll] Failed to sign in user B: ${error.message}`);
      }
    });

    // document_versions and chat_messages have no user_id column — they are
    // indirectly protected via their parent document/chat rows.
    const tables = [
      "projects",
      "documents",
      "chats",
      "tabular_reviews",
      "workflows",
    ] as const;

    for (const table of tables) {
      it(
        `anon-key user-B sees no unshared seed row in ${table} owned by user-A (GREEN: RLS enforced)`,
        async () => {
          const rowIds = {
            projects: seeded.projectId,
            documents: seeded.documentId,
            chats: seeded.chatId,
            tabular_reviews: seeded.reviewId,
            workflows: seeded.workflowId,
          } as const;
          const { data, error } = await anonClientB
            .from(table)
            .select("*")
            .eq("user_id", userIdA)
            .eq("id", rowIds[table]);
          expect(error).toBeNull();
          expect(data).toHaveLength(0);
        },
      );
    }
  },
);
