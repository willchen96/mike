/**
 * CLEAN-15 — /people RPC-backed lookup tests.
 *
 * Verifies that both /projects/:id/people and /tabular-review/:id/people:
 *   1. Return the correct owner + member shape when the database has real users.
 *   2. Silently drop unknown emails from members[].
 *   3. Do NOT call auth.admin.listUsers (static-source assertion).
 *   4. Import the getUsersByEmails helper from lib/supabase (static-source assertion).
 *
 * Behavioural tests (1, 2) require a live Supabase connection via globalSetup.
 * Static-source tests (3, 4) only inspect source code text; they run regardless
 * of env-var availability.
 *
 * NOTE: Tests 1-2 and 5 will FAIL (RED baseline) until:
 *   - Task 2: migration 0001_auth_user_lookup_rpcs.ts is pushed to the database.
 *   - Task 3: getUsersByEmails / getUserById helpers exist in lib/supabase.ts.
 *   - Task 4: both route handlers are refactored to use the helpers.
 *
 * Tests 3 and 4 will FAIL until Task 4.
 */

import { describe, it, expect, beforeAll } from "vitest";
import supertest from "supertest";
import { createClient } from "@supabase/supabase-js";
import fs from "fs";
import path from "path";
import { app } from "../../src/app";

// ── Env-var guards ────────────────────────────────────────────────────────────

let jwtA: string;
let emailA: string;
let emailB: string;
let projectId: string;
let reviewId: string;
let hasEnv = false;
let documentId: string;

beforeAll(async () => {
  jwtA = process.env.TEST_JWT_A ?? "";
  emailA = process.env.TEST_USER_A_EMAIL ?? "";
  emailB = process.env.TEST_USER_B_EMAIL ?? "";
  const jwtB = process.env.TEST_JWT_B ?? "";

  if (!jwtA || !emailA || !emailB || !jwtB) {
    // Behavioural tests skip; static-source tests still run.
    return;
  }

  hasEnv = true;

  // Create a project as user A, shared with user B.
  const projRes = await supertest(app)
    .post("/projects")
    .set("Authorization", `Bearer ${jwtA}`)
    .send({ name: "peopleLookup test project", shared_with: [emailB] });
  if (projRes.status < 200 || projRes.status > 299) {
    throw new Error(
      `[peopleLookup setup] POST /projects failed: ${projRes.status} ${JSON.stringify(projRes.body)}`,
    );
  }
  projectId = (projRes.body as { id: string }).id;

  const svc = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { persistSession: false } },
  );
  const { data: docRow, error: docErr } = await svc
    .from("documents")
    .insert({
      user_id: process.env.TEST_USER_A_ID!,
      project_id: projectId,
      filename: "people-lookup.docx",
      file_type: "docx",
    })
    .select("id")
    .single();
  if (docErr || !docRow) {
    throw new Error(`[peopleLookup setup] seed document failed: ${docErr?.message}`);
  }
  documentId = (docRow as { id: string }).id;

  // Create a tabular review as user A, shared with user B.
  // POST /tabular-review requires at least one document_id.
  const reviewRes = await supertest(app)
    .post("/tabular-review")
    .set("Authorization", `Bearer ${jwtA}`)
    .send({
      title: "peopleLookup test review",
      document_ids: [documentId],
      columns_config: [],
      shared_with: [emailB],
    });
  if (reviewRes.status < 200 || reviewRes.status > 299) {
    throw new Error(
      `[peopleLookup setup] POST /tabular-review failed: ${reviewRes.status} ${JSON.stringify(reviewRes.body)}`,
    );
  }
  reviewId = (reviewRes.body as { id: string }).id;

  const shareReviewRes = await supertest(app)
    .patch(`/tabular-review/${reviewId}`)
    .set("Authorization", `Bearer ${jwtA}`)
    .send({ shared_with: [emailB] });
  if (shareReviewRes.status < 200 || shareReviewRes.status > 299) {
    throw new Error(
      `[peopleLookup setup] PATCH /tabular-review failed: ${shareReviewRes.status} ${JSON.stringify(shareReviewRes.body)}`,
    );
  }
}, 30_000);

// ── Test 1: projects /people returns owner + member ──────────────────────────

describe("/projects/:id/people RPC-backed lookup", () => {
  it("returns owner with emailA and a member with emailB", async () => {
    if (!hasEnv) {
      console.warn("[peopleLookup] skipping behavioural test — env vars absent");
      return;
    }

    const res = await supertest(app)
      .get(`/projects/${projectId}/people`)
      .set("Authorization", `Bearer ${jwtA}`);

    expect(res.status).toBe(200);

    const body = res.body as {
      owner: { email: string | null; user_id: string };
      members: { email: string; display_name: string | null }[];
    };

    // Owner should be user A.
    expect(body.owner).toBeDefined();
    expect(body.owner.email?.toLowerCase()).toBe(emailA.toLowerCase());

    // Members should contain user B by email.
    const memberEmails = body.members.map((m) => m.email.toLowerCase());
    expect(memberEmails).toContain(emailB.toLowerCase());

    // Each member entry for user B must expose the email field.
    const bMember = body.members.find(
      (m) => m.email.toLowerCase() === emailB.toLowerCase(),
    );
    expect(bMember).toBeDefined();
  });

  // ── Test 5: unknown email silently dropped from members[] ──────────────────

  it("silently drops an unknown email from members[]", async () => {
    if (!hasEnv) {
      console.warn("[peopleLookup] skipping behavioural test — env vars absent");
      return;
    }

    const unknownEmail = `unknown-no-account-${Date.now()}@test.invalid`;

    // Patch project to share with the unknown email as well.
    const patchRes = await supertest(app)
      .patch(`/projects/${projectId}`)
      .set("Authorization", `Bearer ${jwtA}`)
      .send({ shared_with: [emailB, unknownEmail] });
    expect(patchRes.status).toBe(200);

    const res = await supertest(app)
      .get(`/projects/${projectId}/people`)
      .set("Authorization", `Bearer ${jwtA}`);
    expect(res.status).toBe(200);

    const body = res.body as {
      members: { email: string; display_name: string | null }[];
    };

    // Unknown email may or may not appear in members depending on
    // implementation — what matters is that it has no user_id attached.
    // The plan says "silently absent from members[]"; verify it doesn't cause
    // an error and the known user B is still present.
    const memberEmails = body.members.map((m) => m.email.toLowerCase());
    expect(memberEmails).toContain(emailB.toLowerCase());
    // The unknown email should NOT appear (RPC returns null; helper drops it).
    expect(memberEmails).not.toContain(unknownEmail.toLowerCase());
  });
});

// ── Test 2: tabular /people returns owner + member ───────────────────────────

describe("/tabular-review/:id/people RPC-backed lookup", () => {
  it("returns owner with emailA and a member with emailB", async () => {
    if (!hasEnv) {
      console.warn("[peopleLookup] skipping behavioural test — env vars absent");
      return;
    }

    const res = await supertest(app)
      .get(`/tabular-review/${reviewId}/people`)
      .set("Authorization", `Bearer ${jwtA}`);

    expect(res.status).toBe(200);

    const body = res.body as {
      owner: { email: string | null; user_id: string };
      members: { email: string; display_name: string | null }[];
    };

    expect(body.owner).toBeDefined();
    expect(body.owner.email?.toLowerCase()).toBe(emailA.toLowerCase());

    const memberEmails = body.members.map((m) => m.email.toLowerCase());
    expect(memberEmails).toContain(emailB.toLowerCase());
  });
});

// ── Test 3: static-source — no auth.admin.listUsers in route files ────────────

describe("Static-source: no auth.admin.listUsers in route files", () => {
  it("projects.ts does not contain auth.admin.listUsers(", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../../src/routes/projects.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/auth\.admin\.listUsers\(/);
  });

  it("tabular.ts does not contain auth.admin.listUsers(", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../../src/routes/tabular.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/auth\.admin\.listUsers\(/);
  });
});

// ── Test 4: static-source — both files import getUsersByEmails ────────────────

describe("Static-source: both route files import getUsersByEmails from lib/supabase", () => {
  it("projects.ts imports getUsersByEmails from ../lib/supabase", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../../src/routes/projects.ts"),
      "utf8",
    );
    expect(source).toMatch(/from "\.\.\/lib\/supabase"/);
    expect(source).toMatch(/getUsersByEmails/);
  });

  it("tabular.ts imports getUsersByEmails from ../lib/supabase", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../../src/routes/tabular.ts"),
      "utf8",
    );
    expect(source).toMatch(/from "\.\.\/lib\/supabase"/);
    expect(source).toMatch(/getUsersByEmails/);
  });
});
