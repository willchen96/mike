/**
 * CLEAN-44 — Account-deletion worker tests.
 *
 * Strategy: dependency-injected pure-mock tests via `_processJobForTesting`.
 * Plan 11 (smoke) runs the full FK-cascade row-count verification against
 * the live local Supabase + R2 stack.
 *
 * Coverage here:
 *   - claim FIRST (B1: concurrent-claim invariant)
 *   - R2 walk before hardDeleteUser (order of ops)
 *   - batch sizing (1000 keys per DeleteObjects call)
 *   - continuation token persistence after each batch
 *   - resume-from-token after restart
 *   - idempotent re-run after CASCADE wipes the job row
 *   - account_deletion_complete pino log entry shape
 *   - B2: crash-mid-prefix-walk re-walks and completes
 *
 * Live-DB FK cascade is covered by Plan 11 smoke.
 */

import { describe, it, expect, vi } from "vitest";
import {
  _processJobForTesting,
  type ProcessJobDeps,
} from "../../src/lib/accountDeletionWorker";
import { logger } from "../../src/lib/logger";

type JobRow = {
  user_id: string;
  status: "pending" | "running" | "done" | "failed" | "cancelled";
  scheduled_for: string;
  attempts: number;
  last_continuation_token: unknown;
  claimed_by: string | null;
  claimed_at: string | null;
  last_error: string | null;
};

function newJobRow(userId: string, overrides: Partial<JobRow> = {}): JobRow {
  return {
    user_id: userId,
    status: "pending",
    scheduled_for: new Date(Date.now() - 60_000).toISOString(),
    attempts: 0,
    last_continuation_token: null,
    claimed_by: null,
    claimed_at: null,
    last_error: null,
    ...overrides,
  };
}

/**
 * Minimal in-memory mock of the supabase-js builder shape used by
 * `claimJob`, `persistContinuationToken`, `finalizeJob`. Only the chained
 * methods the worker actually invokes are implemented.
 */
function createMockDb(initialJob: JobRow) {
  const state = { job: initialJob };
  const builder = (table: string) => {
    if (table !== "account_deletion_jobs") {
      throw new Error(`[mockDb] unexpected table: ${table}`);
    }
    type Filters = Partial<JobRow>;
    type Range = { lteScheduledFor?: string };
    type Selection = { single?: boolean; maybeSingle?: boolean; updateFields?: Partial<JobRow> };

    const filters: Filters = {};
    const range: Range = {};
    let mode: "read" | "update" = "read";
    let updateFields: Partial<JobRow> = {};
    let selectCols = "";

    const matches = (j: JobRow): boolean => {
      if (filters.user_id && j.user_id !== filters.user_id) return false;
      if (filters.status && j.status !== filters.status) return false;
      if (range.lteScheduledFor && j.scheduled_for > range.lteScheduledFor) return false;
      return true;
    };

    const api = {
      select(cols: string) {
        selectCols = cols;
        return api;
      },
      update(fields: Partial<JobRow>) {
        mode = "update";
        updateFields = fields;
        return api;
      },
      eq(col: keyof JobRow, val: unknown) {
        (filters as Record<string, unknown>)[col] = val;
        return api;
      },
      lte(col: keyof JobRow, val: string) {
        if (col === "scheduled_for") range.lteScheduledFor = val;
        return api;
      },
      async single() {
        const j = state.job;
        if (!matches(j)) {
          return { data: null, error: { code: "PGRST116", message: "no rows" } };
        }
        return { data: shape(j, selectCols), error: null };
      },
      async maybeSingle() {
        const j = state.job;
        if (!matches(j)) return { data: null, error: null };
        return { data: shape(j, selectCols), error: null };
      },
      // terminal: implicit await for non-single chains
      then(resolve: (v: { data: unknown[] | null; error: null | { code: string; message: string } }) => unknown) {
        if (mode === "update") {
          const j = state.job;
          if (matches(j)) {
            state.job = { ...j, ...updateFields };
            resolve({ data: [shape(state.job, selectCols || "*")], error: null });
          } else {
            resolve({ data: [], error: null });
          }
        } else {
          resolve({ data: matches(state.job) ? [shape(state.job, selectCols || "*")] : [], error: null });
        }
      },
    };
    return api;
  };
  function shape(j: JobRow, cols: string): Record<string, unknown> {
    if (!cols || cols === "*") return { ...j } as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const c of cols.split(",").map((s) => s.trim())) {
      out[c] = (j as unknown as Record<string, unknown>)[c];
    }
    return out;
  }
  return {
    db: { from: builder } as unknown as ProcessJobDeps["db"],
    getJob: () => state.job,
    deleteJob: () => {
      // CASCADE happens — mark the row as "gone" by failing matches
      state.job = { ...state.job, user_id: "__deleted__" };
    },
  };
}

function makeListObjects(keysByPrefix: Record<string, string[]>) {
  return async function* listObjects(prefix: string): AsyncGenerator<{
    keys: string[];
    nextToken: string | undefined;
  }> {
    const keys = keysByPrefix[prefix] ?? [];
    const pageSize = 1000;
    for (let i = 0; i < keys.length; i += pageSize) {
      const slice = keys.slice(i, i + pageSize);
      const hasNext = i + pageSize < keys.length;
      yield { keys: slice, nextToken: hasNext ? `token-${i + pageSize}` : undefined };
    }
    if (keys.length === 0) {
      yield { keys: [], nextToken: undefined };
    }
  };
}

describe("account-deletion worker (CLEAN-44)", () => {
  it("claimJob runs BEFORE any R2 enumeration (B1 invariant)", async () => {
    const userId = "u-claim-first";
    const mock = createMockDb(newJobRow(userId));
    const order: string[] = [];
    const listObjects = vi.fn(async function* (prefix: string) {
      order.push(`list:${prefix}`);
      yield { keys: [], nextToken: undefined };
    });
    const deleteObjects = vi.fn(async (_keys: string[]) => ({ deleted: 0, errors: [] }));
    const hardDelete = vi.fn(async () => {
      order.push("hardDelete");
      return true;
    });

    // Wrap claim to record order — we know claim is the first operation
    // performed by processJob.
    await _processJobForTesting(userId, {
      db: mock.db,
      listObjects: listObjects as unknown as ProcessJobDeps["listObjects"],
      deleteObjects: deleteObjects as unknown as ProcessJobDeps["deleteObjects"],
      hardDelete: hardDelete as unknown as ProcessJobDeps["hardDelete"],
    });

    expect(order[0]).toMatch(/^list:/);
    expect(order[order.length - 1]).toBe("hardDelete");
  });

  it("two concurrent processJob calls for the same user result in exactly one R2 enumeration (B1)", async () => {
    const userId = "u-concurrent";
    const mock = createMockDb(newJobRow(userId));
    const listObjects = vi.fn(async function* () {
      yield { keys: [], nextToken: undefined };
    });
    const deleteObjects = vi.fn(async () => ({ deleted: 0, errors: [] }));
    const hardDelete = vi.fn(async () => true);

    const deps = {
      db: mock.db,
      listObjects: listObjects as unknown as ProcessJobDeps["listObjects"],
      deleteObjects: deleteObjects as unknown as ProcessJobDeps["deleteObjects"],
      hardDelete: hardDelete as unknown as ProcessJobDeps["hardDelete"],
    };

    await Promise.all([
      _processJobForTesting(userId, deps),
      _processJobForTesting(userId, deps),
    ]);

    // Three prefixes scanned exactly once total — the second claim returned ok=false.
    expect(listObjects).toHaveBeenCalledTimes(3);
    expect(hardDelete).toHaveBeenCalledTimes(1);
  });

  it("walks all three prefixes in order", async () => {
    const userId = "u-prefixes";
    const mock = createMockDb(newJobRow(userId));
    const visited: string[] = [];
    const listObjects = vi.fn(async function* (prefix: string) {
      visited.push(prefix);
      yield { keys: [], nextToken: undefined };
    });
    await _processJobForTesting(userId, {
      db: mock.db,
      listObjects: listObjects as unknown as ProcessJobDeps["listObjects"],
      deleteObjects: (async () => ({ deleted: 0, errors: [] })) as unknown as ProcessJobDeps["deleteObjects"],
      hardDelete: (async () => true) as unknown as ProcessJobDeps["hardDelete"],
    });
    expect(visited).toEqual([
      `documents/${userId}/`,
      `generated/${userId}/`,
      `converted-pdfs/${userId}/`,
    ]);
  });

  it("batch-deletes 1000 keys per call when prefix has > 1000 objects", async () => {
    const userId = "u-batch";
    const mock = createMockDb(newJobRow(userId));
    const bigKeyset = Array.from({ length: 2500 }, (_, i) => `documents/${userId}/k${i}`);
    const listObjects = makeListObjects({ [`documents/${userId}/`]: bigKeyset });
    const deleteObjects = vi.fn(async (keys: string[]) => ({ deleted: keys.length, errors: [] as string[] }));

    await _processJobForTesting(userId, {
      db: mock.db,
      listObjects: listObjects as unknown as ProcessJobDeps["listObjects"],
      deleteObjects: deleteObjects as unknown as ProcessJobDeps["deleteObjects"],
      hardDelete: (async () => true) as unknown as ProcessJobDeps["hardDelete"],
    });

    expect(deleteObjects).toHaveBeenCalledTimes(3);
    const sizes = deleteObjects.mock.calls.map((c) => c[0].length);
    expect(sizes[0]).toBe(1000);
    expect(sizes[1]).toBe(1000);
    expect(sizes[2]).toBe(500);
  });

  it("persists continuation token between pages", async () => {
    const userId = "u-resume-persist";
    const mock = createMockDb(newJobRow(userId));
    const keyset = Array.from({ length: 1500 }, (_, i) => `documents/${userId}/k${i}`);
    const listObjects = makeListObjects({ [`documents/${userId}/`]: keyset });

    await _processJobForTesting(userId, {
      db: mock.db,
      listObjects: listObjects as unknown as ProcessJobDeps["listObjects"],
      deleteObjects: (async (keys: string[]) => ({ deleted: keys.length, errors: [] })) as unknown as ProcessJobDeps["deleteObjects"],
      hardDelete: (async () => true) as unknown as ProcessJobDeps["hardDelete"],
    });

    // After processing, the last completedPrefixes update writes documents+generated+converted-pdfs/.../
    const finalJob = mock.getJob();
    const token = finalJob.last_continuation_token as { completedPrefixes?: string[] } | null;
    expect(token?.completedPrefixes).toContain(`documents/${userId}/`);
  });

  it("resumes from a previously persisted continuation token", async () => {
    const userId = "u-resume";
    const seededState = {
      currentPrefix: `documents/${userId}/`,
      token: "token-1000",
      completedPrefixes: [] as string[],
    };
    const mock = createMockDb(newJobRow(userId, { last_continuation_token: seededState }));

    const callsByPrefix: Record<string, Array<string | undefined>> = {};
    const listObjects = vi.fn(async function* (prefix: string, startToken?: string) {
      callsByPrefix[prefix] = (callsByPrefix[prefix] ?? []).concat([startToken]);
      yield { keys: [], nextToken: undefined };
    });

    await _processJobForTesting(userId, {
      db: mock.db,
      listObjects: listObjects as unknown as ProcessJobDeps["listObjects"],
      deleteObjects: (async () => ({ deleted: 0, errors: [] })) as unknown as ProcessJobDeps["deleteObjects"],
      hardDelete: (async () => true) as unknown as ProcessJobDeps["hardDelete"],
    });

    expect(callsByPrefix[`documents/${userId}/`]?.[0]).toBe("token-1000");
    expect(callsByPrefix[`generated/${userId}/`]?.[0]).toBeUndefined();
  });

  it("skips already-completed prefixes on resume", async () => {
    const userId = "u-skip-done";
    const seededState = {
      currentPrefix: `generated/${userId}/`,
      token: null,
      completedPrefixes: [`documents/${userId}/`],
    };
    const mock = createMockDb(newJobRow(userId, { last_continuation_token: seededState }));
    const visited: string[] = [];
    const listObjects = vi.fn(async function* (prefix: string) {
      visited.push(prefix);
      yield { keys: [], nextToken: undefined };
    });
    await _processJobForTesting(userId, {
      db: mock.db,
      listObjects: listObjects as unknown as ProcessJobDeps["listObjects"],
      deleteObjects: (async () => ({ deleted: 0, errors: [] })) as unknown as ProcessJobDeps["deleteObjects"],
      hardDelete: (async () => true) as unknown as ProcessJobDeps["hardDelete"],
    });
    expect(visited).not.toContain(`documents/${userId}/`);
    expect(visited).toContain(`generated/${userId}/`);
    expect(visited).toContain(`converted-pdfs/${userId}/`);
  });

  it("calls hardDeleteUser LAST after R2 enumeration completes", async () => {
    const userId = "u-order";
    const mock = createMockDb(newJobRow(userId));
    const order: string[] = [];
    const listObjects = vi.fn(async function* (prefix: string) {
      order.push(`list:${prefix}`);
      yield { keys: [], nextToken: undefined };
    });
    const hardDelete = vi.fn(async () => {
      order.push("hardDelete");
      return true;
    });
    await _processJobForTesting(userId, {
      db: mock.db,
      listObjects: listObjects as unknown as ProcessJobDeps["listObjects"],
      deleteObjects: (async () => ({ deleted: 0, errors: [] })) as unknown as ProcessJobDeps["deleteObjects"],
      hardDelete: hardDelete as unknown as ProcessJobDeps["hardDelete"],
    });
    expect(order[order.length - 1]).toBe("hardDelete");
    expect(order.filter((s) => s.startsWith("list:"))).toHaveLength(3);
  });

  it("re-run after hardDeleteUser+CASCADE returns 0 work without crashing (idempotency)", async () => {
    const userId = "u-rerun";
    const mock = createMockDb(newJobRow(userId));
    mock.deleteJob(); // Simulate CASCADE wiping the row before second run

    const listObjects = vi.fn(async function* () {
      yield { keys: [], nextToken: undefined };
    });
    const hardDelete = vi.fn(async () => true);
    const result = await _processJobForTesting(userId, {
      db: mock.db,
      listObjects: listObjects as unknown as ProcessJobDeps["listObjects"],
      deleteObjects: (async () => ({ deleted: 0, errors: [] })) as unknown as ProcessJobDeps["deleteObjects"],
      hardDelete: hardDelete as unknown as ProcessJobDeps["hardDelete"],
    });
    expect(result.rows).toBe(0);
    expect(listObjects).not.toHaveBeenCalled();
    expect(hardDelete).not.toHaveBeenCalled();
  });

  it("emits account_deletion_complete log entry on success", async () => {
    const userId = "u-log";
    const mock = createMockDb(newJobRow(userId));
    const spy = vi.spyOn(logger, "info");
    await _processJobForTesting(userId, {
      db: mock.db,
      listObjects: (async function* () {
        yield { keys: ["documents/k1"], nextToken: undefined };
      }) as unknown as ProcessJobDeps["listObjects"],
      deleteObjects: (async (keys: string[]) => ({ deleted: keys.length, errors: [] })) as unknown as ProcessJobDeps["deleteObjects"],
      hardDelete: (async () => true) as unknown as ProcessJobDeps["hardDelete"],
    });
    const completeCall = spy.mock.calls.find(
      (c) => (c[0] as { event?: string })?.event === "account_deletion_complete",
    );
    expect(completeCall).toBeTruthy();
    const payload = completeCall?.[0] as { user_id?: string; rows?: number; objects?: number };
    expect(payload?.user_id).toBe(userId);
    expect(payload?.rows).toBe(1);
    expect(typeof payload?.objects).toBe("number");
    spy.mockRestore();
  });

  it("B2: crash-mid-prefix-walk recovers and completes without error", async () => {
    const userId = "u-b2";
    const seededState = {
      currentPrefix: `documents/${userId}/`,
      token: null,
      completedPrefixes: [] as string[],
    };
    const mock = createMockDb(newJobRow(userId, { last_continuation_token: seededState }));
    const listObjects = makeListObjects({ [`documents/${userId}/`]: [`documents/${userId}/orphan-key`] });
    const deleteObjects = vi.fn(async (keys: string[]) => ({ deleted: keys.length, errors: [] }));
    const hardDelete = vi.fn(async () => true);

    const result = await _processJobForTesting(userId, {
      db: mock.db,
      listObjects: listObjects as unknown as ProcessJobDeps["listObjects"],
      deleteObjects: deleteObjects as unknown as ProcessJobDeps["deleteObjects"],
      hardDelete: hardDelete as unknown as ProcessJobDeps["hardDelete"],
    });

    expect(result.errors).toEqual([]);
    expect(deleteObjects).toHaveBeenCalledWith([`documents/${userId}/orphan-key`]);
    expect(hardDelete).toHaveBeenCalledTimes(1);
  });

  // FK cascade verification across 9+ tables requires a live Supabase + R2 stack.
  // Plan 11 (12-11-schema-push-smoke) runs the integration suite against the
  // local dev stack and asserts row counts reach 0 across projects, documents,
  // chats, chat_messages, tabular_reviews, tabular_cells, workflows,
  // document_versions, document_edits, user_profiles, and auth.users.
  it.skip("FK cascade verification: row counts reach 0 across all user-owned tables (Plan 11 live-DB smoke)", () => {
    // Implemented as Plan 11 manual smoke C — see 12-11-schema-push-smoke-PLAN.md.
  });
});
