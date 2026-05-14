import { beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  checkProjectAccess,
  ensureDocAccess,
  ensureReviewAccess,
  listAccessibleProjectIds,
} from "../../src/lib/access";

type Db = SupabaseClient;

let serviceRoleClient: Db;
let anonKeyClient: Db;
let userIdA: string;
let userIdB: string;
let userEmailB: string;
let sharedProjectId: string;
let controlProjectId: string;
let anonOwnerProjectId: string;
let standaloneDocument: { user_id: string; project_id: string | null };
let projectDocument: { user_id: string; project_id: string | null };
let anonOwnerDocument: { user_id: string; project_id: string | null };
let directSharedReview: {
  user_id: string;
  project_id: string | null;
  shared_with: string[] | null;
};
let projectReview: {
  user_id: string;
  project_id: string | null;
  shared_with: string[] | null;
};
let anonOwnerReview: {
  user_id: string;
  project_id: string | null;
  shared_with: string[] | null;
};
let controlReview: {
  user_id: string;
  project_id: string | null;
  shared_with: string[] | null;
};

async function insertOne<T>(
  table: string,
  row: Record<string, unknown>,
): Promise<T> {
  const { data, error } = await serviceRoleClient
    .from(table)
    .insert(row)
    .select("*")
    .single();
  if (error || !data) {
    throw new Error(`seed ${table}: ${error?.message ?? "no row returned"}`);
  }
  return data as T;
}

beforeAll(async () => {
  const supabaseUrl = process.env.SUPABASE_URL ?? "";
  const serviceKey = process.env.SUPABASE_SECRET_KEY ?? "";
  const anonKey = process.env.SUPABASE_ANON_KEY ?? "";
  const jwtA = process.env.TEST_JWT_A;
  const jwtB = process.env.TEST_JWT_B;
  userIdA = process.env.TEST_USER_A_ID ?? "";
  userIdB = process.env.TEST_USER_B_ID ?? "";
  userEmailB = process.env.TEST_USER_B_EMAIL ?? "";

  if (!jwtA || !jwtB) {
    throw new Error(
      "globalSetup did not run; TEST_JWT_A/B missing. Run via npm run test:cross-tenant.",
    );
  }
  if (!supabaseUrl || !serviceKey || !anonKey || !userIdA || !userIdB || !userEmailB) {
    throw new Error("cross-tenant access-helper matrix env vars are missing");
  }

  serviceRoleClient = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });
  anonKeyClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${jwtB}` } },
    auth: { persistSession: false },
  });

  const sharedProject = await insertOne<{ id: string }>("projects", {
    user_id: userIdA,
    name: "CLEAN-35 Shared Project",
    shared_with: [userEmailB.toUpperCase(), userEmailB.toLowerCase()],
  });
  sharedProjectId = sharedProject.id;

  const controlProject = await insertOne<{ id: string }>("projects", {
    user_id: userIdA,
    name: "CLEAN-35 Control Project",
    shared_with: [],
  });
  controlProjectId = controlProject.id;

  const anonOwnerProject = await insertOne<{ id: string }>("projects", {
    user_id: userIdB,
    name: "CLEAN-35 Anon Owner Project",
    shared_with: [],
  });
  anonOwnerProjectId = anonOwnerProject.id;

  standaloneDocument = await insertOne("documents", {
    user_id: userIdA,
    project_id: null,
    filename: "clean-35-standalone.docx",
    file_type: "docx",
  });
  projectDocument = await insertOne("documents", {
    user_id: userIdA,
    project_id: sharedProjectId,
    filename: "clean-35-project.docx",
    file_type: "docx",
  });
  anonOwnerDocument = await insertOne("documents", {
    user_id: userIdB,
    project_id: anonOwnerProjectId,
    filename: "clean-35-anon-owner.docx",
    file_type: "docx",
  });
  directSharedReview = await insertOne("tabular_reviews", {
    user_id: userIdA,
    project_id: null,
    title: "CLEAN-35 Direct Shared Review",
    columns_config: [{ index: 0, name: "Summary", prompt: "Summarize" }],
    shared_with: [userEmailB],
  });
  projectReview = await insertOne("tabular_reviews", {
    user_id: userIdA,
    project_id: sharedProjectId,
    title: "CLEAN-35 Project Review",
    columns_config: [{ index: 0, name: "Summary", prompt: "Summarize" }],
    shared_with: [],
  });
  anonOwnerReview = await insertOne("tabular_reviews", {
    user_id: userIdB,
    project_id: anonOwnerProjectId,
    title: "CLEAN-35 Anon Owner Review",
    columns_config: [{ index: 0, name: "Summary", prompt: "Summarize" }],
    shared_with: [],
  });
  controlReview = await insertOne("tabular_reviews", {
    user_id: userIdA,
    project_id: controlProjectId,
    title: "CLEAN-35 Control Review",
    columns_config: [{ index: 0, name: "Summary", prompt: "Summarize" }],
    shared_with: [],
  });
}, 60_000);

async function expectMatrix(clientName: "service-role" | "anon-key", db: Db) {
  const ownerId = clientName === "anon-key" ? userIdB : userIdA;
  const ownerProjectId =
    clientName === "anon-key" ? anonOwnerProjectId : sharedProjectId;
  const ownerDocument =
    clientName === "anon-key" ? anonOwnerDocument : projectDocument;
  const ownerReview =
    clientName === "anon-key" ? anonOwnerReview : directSharedReview;

  const ownerProject = await checkProjectAccess(
    ownerProjectId,
    ownerId,
    clientName === "anon-key" ? userEmailB : "owner@example.test",
    db,
  );
  expect(ownerProject, clientName).toMatchObject({ ok: true, isOwner: true });

  const sharedProject = await checkProjectAccess(
    sharedProjectId,
    userIdB,
    userEmailB.toLowerCase(),
    db,
  );
  expect(sharedProject, clientName).toMatchObject({ ok: true, isOwner: false });

  const controlProject = await checkProjectAccess(
    controlProjectId,
    userIdB,
    userEmailB,
    db,
  );
  expect(controlProject, clientName).toEqual({ ok: false });

  await expect(
    ensureDocAccess(
      ownerDocument,
      ownerId,
      clientName === "anon-key" ? userEmailB : "owner@example.test",
      db,
    ),
  ).resolves.toMatchObject({ ok: true, isOwner: true });
  await expect(
    ensureDocAccess(projectDocument, userIdB, userEmailB, db),
  ).resolves.toMatchObject({ ok: true, isOwner: false });
  await expect(
    ensureDocAccess(standaloneDocument, userIdB, userEmailB, db),
  ).resolves.toEqual({ ok: false });

  await expect(
    ensureReviewAccess(
      ownerReview,
      ownerId,
      clientName === "anon-key" ? userEmailB : "owner@example.test",
      db,
    ),
  ).resolves.toMatchObject({ ok: true, isOwner: true });
  await expect(
    ensureReviewAccess(directSharedReview, userIdB, userEmailB.toUpperCase(), db),
  ).resolves.toMatchObject({ ok: true, isOwner: false });
  await expect(
    ensureReviewAccess(projectReview, userIdB, userEmailB, db),
  ).resolves.toMatchObject({ ok: true, isOwner: false });
  await expect(
    ensureReviewAccess(controlReview, userIdB, userEmailB, db),
  ).resolves.toEqual({ ok: false });

  const accessibleProjectIds = await listAccessibleProjectIds(
    userIdB,
    userEmailB.toLowerCase(),
    db,
  );
  expect(accessibleProjectIds, clientName).toContain(sharedProjectId);
  expect(accessibleProjectIds, clientName).not.toContain(controlProjectId);
}

describe("access helper matrix", () => {
  it("covers owner, direct email share, project share, and no-access with service-role", async () => {
    await expectMatrix("service-role", serviceRoleClient);
  });

  it("covers owner, direct email share, project share, and no-access with anon-key", async () => {
    await expectMatrix("anon-key", anonKeyClient);
  });
});
