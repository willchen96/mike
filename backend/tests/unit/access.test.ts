import { vi, describe, it, expect } from "vitest";
import {
  checkProjectAccess,
  ensureDocAccess,
  ensureReviewAccess,
  filterAccessibleDocumentIds,
  listAccessibleProjectIds,
} from "../../src/lib/access";

// ── mock DB factory ───────────────────────────────────────────────────────────
//
// Every builder method returns `this` so the chain is awaitable at any depth.
// `.single()` resolves with the configured result (used by checkProjectAccess).

function makeChain(
  result: { data?: unknown; error?: unknown } = { data: null, error: null },
) {
  const chain: Record<string, unknown> = {};
  const ret = () => chain;
  for (const m of ["select", "eq", "neq", "in", "filter", "delete"]) {
    chain[m] = vi.fn(ret);
  }
  chain.single = vi.fn(() => Promise.resolve(result));
  chain.upsert = vi.fn(() => Promise.resolve(result));
  chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  chain.catch = (reject: (e: unknown) => unknown) => Promise.resolve(result).catch(reject);
  chain.finally = (cb: () => void) => Promise.resolve(result).finally(cb);
  return chain;
}

// Returns a db whose `from()` always hands back the same chain.
// Useful when only one table is queried in a test.
function singleChainDb(result: { data?: unknown; error?: unknown }) {
  const chain = makeChain(result);
  return { from: vi.fn(() => chain) };
}

// Returns a db that dispatches on table name and call index.
// `tableResults[table]` is an array iterated in call order.
function multiTableDb(
  tableResults: Record<string, Array<{ data?: unknown; error?: unknown }>>,
) {
  const counters: Record<string, number> = {};
  return {
    from: vi.fn((table: string) => {
      const idx = counters[table] ?? 0;
      counters[table] = idx + 1;
      const rows = tableResults[table] ?? [];
      return makeChain(rows[idx] ?? { data: [], error: null });
    }),
  };
}

// ── checkProjectAccess ────────────────────────────────────────────────────────

const BASE_PROJECT = {
  id: "proj-1",
  user_id: "owner-id",
  shared_with: ["alice@example.com"],
};

describe("checkProjectAccess", () => {
  it("returns ok:true isOwner:true when caller owns the project", async () => {
    const db = singleChainDb({ data: BASE_PROJECT, error: null });
    const result = await checkProjectAccess(
      "proj-1",
      "owner-id",
      "owner@example.com",
      db as never,
    );
    expect(result).toEqual({ ok: true, isOwner: true, project: BASE_PROJECT });
  });

  it("returns ok:true isOwner:false when caller email is in shared_with", async () => {
    const db = singleChainDb({ data: BASE_PROJECT, error: null });
    const result = await checkProjectAccess(
      "proj-1",
      "other-user-id",
      "alice@example.com",
      db as never,
    );
    expect(result).toEqual({ ok: true, isOwner: false, project: BASE_PROJECT });
  });

  it("matches shared_with emails case-insensitively", async () => {
    const db = singleChainDb({ data: BASE_PROJECT, error: null });
    const result = await checkProjectAccess(
      "proj-1",
      "other-user-id",
      "ALICE@EXAMPLE.COM",
      db as never,
    );
    expect(result.ok).toBe(true);
  });

  it("returns ok:false when the project row is not found", async () => {
    const db = singleChainDb({ data: null, error: null });
    const result = await checkProjectAccess(
      "proj-1",
      "owner-id",
      "owner@example.com",
      db as never,
    );
    expect(result.ok).toBe(false);
  });

  it("returns ok:false when the caller is neither owner nor in shared_with", async () => {
    const db = singleChainDb({ data: BASE_PROJECT, error: null });
    const result = await checkProjectAccess(
      "proj-1",
      "stranger-id",
      "stranger@example.com",
      db as never,
    );
    expect(result.ok).toBe(false);
  });

  it("returns ok:false when shared_with is null and caller is not the owner", async () => {
    const db = singleChainDb({
      data: { ...BASE_PROJECT, shared_with: null },
      error: null,
    });
    const result = await checkProjectAccess(
      "proj-1",
      "stranger-id",
      "alice@example.com",
      db as never,
    );
    expect(result.ok).toBe(false);
  });
});

// ── ensureDocAccess ───────────────────────────────────────────────────────────

describe("ensureDocAccess", () => {
  it("returns ok:true isOwner:true for the document owner — no DB hit needed", async () => {
    const db = { from: vi.fn(() => { throw new Error("should not query DB"); }) };
    const result = await ensureDocAccess(
      { user_id: "user-1", project_id: null },
      "user-1",
      "user@example.com",
      db as never,
    );
    expect(result).toEqual({ ok: true, isOwner: true });
    expect(db.from).not.toHaveBeenCalled();
  });

  it("returns ok:false immediately when doc has no project and caller is not owner", async () => {
    const db = { from: vi.fn(() => { throw new Error("should not query DB"); }) };
    const result = await ensureDocAccess(
      { user_id: "owner-id", project_id: null },
      "other-user",
      "other@example.com",
      db as never,
    );
    expect(result.ok).toBe(false);
    expect(db.from).not.toHaveBeenCalled();
  });

  it("returns ok:true isOwner:false when caller has access via the containing project", async () => {
    const project = { id: "proj-1", user_id: "owner-id", shared_with: ["shared@example.com"] };
    const db = singleChainDb({ data: project, error: null });
    const result = await ensureDocAccess(
      { user_id: "owner-id", project_id: "proj-1" },
      "other-user",
      "shared@example.com",
      db as never,
    );
    expect(result).toEqual({ ok: true, isOwner: false });
  });

  it("returns ok:false when the caller has no project access", async () => {
    const project = { id: "proj-1", user_id: "owner-id", shared_with: [] };
    const db = singleChainDb({ data: project, error: null });
    const result = await ensureDocAccess(
      { user_id: "owner-id", project_id: "proj-1" },
      "stranger-id",
      "stranger@example.com",
      db as never,
    );
    expect(result.ok).toBe(false);
  });
});

// ── ensureReviewAccess ────────────────────────────────────────────────────────

describe("ensureReviewAccess", () => {
  it("returns ok:true isOwner:true for the review owner — no DB hit", async () => {
    const db = { from: vi.fn(() => { throw new Error("should not query DB"); }) };
    const result = await ensureReviewAccess(
      { user_id: "user-1", project_id: null, shared_with: [] },
      "user-1",
      "user@example.com",
      db as never,
    );
    expect(result).toEqual({ ok: true, isOwner: true });
    expect(db.from).not.toHaveBeenCalled();
  });

  it("returns ok:true isOwner:false when caller email is directly in review.shared_with", async () => {
    const db = { from: vi.fn(() => { throw new Error("should not query DB"); }) };
    const result = await ensureReviewAccess(
      {
        user_id: "owner-id",
        project_id: null,
        shared_with: ["collab@example.com"],
      },
      "collab-user-id",
      "collab@example.com",
      db as never,
    );
    expect(result).toEqual({ ok: true, isOwner: false });
    expect(db.from).not.toHaveBeenCalled();
  });

  it("returns ok:true isOwner:false when access comes via the containing project", async () => {
    const project = { id: "proj-1", user_id: "owner-id", shared_with: ["proj-member@example.com"] };
    const db = singleChainDb({ data: project, error: null });
    const result = await ensureReviewAccess(
      { user_id: "owner-id", project_id: "proj-1", shared_with: [] },
      "proj-member-id",
      "proj-member@example.com",
      db as never,
    );
    expect(result).toEqual({ ok: true, isOwner: false });
  });

  it("returns ok:false when no project_id and caller email is not in shared_with", async () => {
    const db = { from: vi.fn(() => { throw new Error("should not query DB"); }) };
    const result = await ensureReviewAccess(
      { user_id: "owner-id", project_id: null, shared_with: ["other@example.com"] },
      "stranger-id",
      "stranger@example.com",
      db as never,
    );
    expect(result.ok).toBe(false);
    expect(db.from).not.toHaveBeenCalled();
  });

  it("returns ok:false when project exists but caller has no project access", async () => {
    const project = { id: "proj-1", user_id: "owner-id", shared_with: [] };
    const db = singleChainDb({ data: project, error: null });
    const result = await ensureReviewAccess(
      { user_id: "owner-id", project_id: "proj-1", shared_with: [] },
      "stranger-id",
      "stranger@example.com",
      db as never,
    );
    expect(result.ok).toBe(false);
  });
});

// ── filterAccessibleDocumentIds ───────────────────────────────────────────────

describe("filterAccessibleDocumentIds", () => {
  it("returns an empty array without touching the DB when input is empty", async () => {
    const db = { from: vi.fn(() => { throw new Error("should not query DB"); }) };
    const result = await filterAccessibleDocumentIds([], "user-1", "u@x.com", db as never);
    expect(result).toEqual([]);
    expect(db.from).not.toHaveBeenCalled();
  });

  it("returns an empty array when none of the IDs exist in the DB", async () => {
    // documents → empty, projects (own) → empty, projects (shared) → empty
    const db = multiTableDb({
      documents: [{ data: [], error: null }],
      projects: [{ data: [], error: null }, { data: [], error: null }],
    });
    const result = await filterAccessibleDocumentIds(
      ["missing-id"],
      "user-1",
      "u@x.com",
      db as never,
    );
    expect(result).toEqual([]);
  });

  it("includes documents owned by the caller", async () => {
    const docs = [{ id: "doc-mine", user_id: "user-1", project_id: null }];
    const db = multiTableDb({
      documents: [{ data: docs, error: null }],
      projects: [{ data: [], error: null }, { data: [], error: null }],
    });
    const result = await filterAccessibleDocumentIds(
      ["doc-mine"],
      "user-1",
      "u@x.com",
      db as never,
    );
    expect(result).toContain("doc-mine");
  });

  it("includes documents whose project is accessible to the caller", async () => {
    const docs = [{ id: "doc-shared", user_id: "owner-id", project_id: "proj-A" }];
    // own projects = [] ; shared projects = [proj-A]
    const db = multiTableDb({
      documents: [{ data: docs, error: null }],
      projects: [
        { data: [], error: null },               // own
        { data: [{ id: "proj-A" }], error: null }, // shared
      ],
    });
    const result = await filterAccessibleDocumentIds(
      ["doc-shared"],
      "user-1",
      "u@x.com",
      db as never,
    );
    expect(result).toContain("doc-shared");
  });

  it("excludes documents the caller neither owns nor has project access to", async () => {
    const docs = [
      { id: "doc-mine", user_id: "user-1", project_id: null },
      { id: "doc-other", user_id: "stranger-id", project_id: "proj-B" },
    ];
    const db = multiTableDb({
      documents: [{ data: docs, error: null }],
      projects: [{ data: [], error: null }, { data: [], error: null }],
    });
    const result = await filterAccessibleDocumentIds(
      ["doc-mine", "doc-other"],
      "user-1",
      "u@x.com",
      db as never,
    );
    expect(result).toContain("doc-mine");
    expect(result).not.toContain("doc-other");
  });
});

// ── listAccessibleProjectIds ──────────────────────────────────────────────────

describe("listAccessibleProjectIds", () => {
  it("includes projects owned by the caller", async () => {
    const db = multiTableDb({
      projects: [
        { data: [{ id: "proj-mine" }], error: null }, // own
        { data: [], error: null },                     // shared
      ],
    });
    const ids = await listAccessibleProjectIds("user-1", "u@x.com", db as never);
    expect(ids).toContain("proj-mine");
  });

  it("includes projects shared with the caller's email", async () => {
    const db = multiTableDb({
      projects: [
        { data: [], error: null },                       // own
        { data: [{ id: "proj-shared" }], error: null },  // shared
      ],
    });
    const ids = await listAccessibleProjectIds("user-1", "u@x.com", db as never);
    expect(ids).toContain("proj-shared");
  });

  it("deduplicates when a project appears in both result sets", async () => {
    const db = multiTableDb({
      projects: [
        { data: [{ id: "proj-dup" }], error: null }, // own
        { data: [{ id: "proj-dup" }], error: null }, // shared (same id)
      ],
    });
    const ids = await listAccessibleProjectIds("user-1", "u@x.com", db as never);
    expect(ids.filter((id) => id === "proj-dup")).toHaveLength(1);
  });

  it("skips the shared query and returns only own projects when userEmail is null", async () => {
    const db = multiTableDb({
      projects: [
        { data: [{ id: "proj-mine" }], error: null }, // own (only call made)
      ],
    });
    const ids = await listAccessibleProjectIds("user-1", null, db as never);
    expect(ids).toEqual(["proj-mine"]);
    // from("projects") called exactly once — no shared query
    expect((db.from as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });
});
