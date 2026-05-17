/**
 * CLEAN-08 — version-unique retry unit test (RED → GREEN in Task 2).
 *
 * Tests that insertVersionWithRetry catches a Postgres 23505 unique_violation
 * and retries with a freshly-fetched MAX+1, guaranteeing distinct version_numbers
 * even when two concurrent requests both compute the same next number.
 */

import { describe, it, expect, vi } from "vitest";
import { insertVersionWithRetry } from "../../src/routes/documents";

// ---------------------------------------------------------------------------
// Chainable Supabase mock builder
// ---------------------------------------------------------------------------

type MockResult = { data: unknown; error: unknown };

/**
 * Build a minimal chainable mock of the Supabase query builder.
 *
 * The mock tracks:
 *   - `insertCalls`  — payloads passed to `.insert()`
 *   - `maybySingleCalls` — how many times `.maybySingle()` was awaited
 *
 * Each `insert()` consumes one entry from the `insertResults` queue.
 * Each `maybySingle()` call consumes one entry from `maybySingleResults`.
 */
function buildMockDb(opts: {
  insertResults: MockResult[];
  maybySingleResults: MockResult[];
}): {
  db: ReturnType<typeof import("../../src/lib/supabase").createServerSupabase>;
  insertCalls: unknown[];
  maybySingleCallCount: { value: number };
} {
  const insertCalls: unknown[] = [];
  const maybySingleCallCount = { value: 0 };
  let insertIdx = 0;
  let maybySingleIdx = 0;

  const maybySingleChain = () => ({
    maybySingle: async () => {
      const result = opts.maybySingleResults[maybySingleIdx++] ?? { data: null, error: null };
      maybySingleCallCount.value++;
      return result;
    },
    maybeSingle: async () => {
      const result = opts.maybySingleResults[maybySingleIdx++] ?? { data: null, error: null };
      maybySingleCallCount.value++;
      return result;
    },
  });

  const limitChain = () => ({
    limit: () => maybySingleChain(),
  });

  const orderChain = () => ({
    order: () => limitChain(),
  });

  const inChain = () => ({
    in: () => orderChain(),
  });

  const eqChain = () => ({
    eq: () => inChain(),
  });

  const singleChain = () => ({
    single: async () => {
      return opts.insertResults[insertIdx++] ?? { data: null, error: null };
    },
  });

  const insertSelectChain = () => ({
    select: () => singleChain(),
  });

  const db = {
    from: (table: string) => {
      if (table === "document_versions") {
        return {
          select: () => eqChain(),
          insert: (payload: unknown) => {
            insertCalls.push(payload);
            return insertSelectChain();
          },
        };
      }
      return {} as ReturnType<typeof eqChain>;
    },
  } as unknown as ReturnType<typeof import("../../src/lib/supabase").createServerSupabase>;

  return { db, insertCalls, maybySingleCallCount };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("insertVersionWithRetry", () => {
  it("retries with MAX+1 after a 23505 unique violation", async () => {
    const { db, insertCalls } = buildMockDb({
      insertResults: [
        { data: null, error: { code: "23505" } },
        { data: { id: "v2", version_number: 3 }, error: null },
      ],
      maybySingleResults: [
        // first MAX fetch (before first insert)
        { data: { version_number: 2 }, error: null },
        // second MAX fetch (after 23505, before retry insert)
        { data: { version_number: 2 }, error: null },
      ],
    });

    const result = await insertVersionWithRetry(db, "doc-1", {
      document_id: "doc-1",
      storage_path: "p",
      source: "user_upload",
    });

    expect(result.error).toBeNull();
    expect((result.data as { version_number: number }).version_number).toBe(3);
    // Insert must have been called twice
    expect(insertCalls).toHaveLength(2);
    // Second call must use version_number 3 (MAX 2 + 1)
    expect((insertCalls[1] as { version_number: number }).version_number).toBe(3);
  });

  it("surfaces a non-23505 error without retrying", async () => {
    const { db, insertCalls } = buildMockDb({
      insertResults: [
        { data: null, error: { code: "42703", message: "column does not exist" } },
      ],
      maybySingleResults: [
        { data: { version_number: 1 }, error: null },
      ],
    });

    const result = await insertVersionWithRetry(db, "doc-2", {
      document_id: "doc-2",
      storage_path: "q",
      source: "user_upload",
    });

    // Error must be surfaced
    expect(result.error).not.toBeNull();
    expect((result.error as { code: string }).code).toBe("42703");
    // Only one insert attempt
    expect(insertCalls).toHaveLength(1);
  });

  it("succeeds on first try with no retry and no extra MAX fetch", async () => {
    const { db, insertCalls, maybySingleCallCount } = buildMockDb({
      insertResults: [
        { data: { id: "v1", version_number: 2 }, error: null },
      ],
      maybySingleResults: [
        { data: { version_number: 1 }, error: null },
      ],
    });

    const result = await insertVersionWithRetry(db, "doc-3", {
      document_id: "doc-3",
      storage_path: "r",
      source: "upload",
    });

    expect(result.error).toBeNull();
    expect((result.data as { version_number: number }).version_number).toBe(2);
    expect(insertCalls).toHaveLength(1);
    // Only one MAX fetch (before the first insert — no retry fetch)
    expect(maybySingleCallCount.value).toBe(1);
  });
});
