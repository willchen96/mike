/**
 * CLEAN-16 — reuseVersion compensating saga unit test (RED → GREEN in Task 2).
 *
 * Verifies that when uploadFile throws AFTER the document_edits insert has
 * succeeded in the reuseVersion path of runEditDocument, the saga helper:
 *   1. Deletes the inserted document_edits rows (compensating rollback)
 *   2. Returns { ok: false, error } — does NOT update documents.current_version_id
 *
 * No live DB or R2 required — all dependencies are mocked.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { applyReuseVersionSaga } from "../../src/lib/chatTools/tools/edit-document";

// ---------------------------------------------------------------------------
// Mock storage module so uploadFile can be controlled per-test
// ---------------------------------------------------------------------------

vi.mock("../../src/lib/storage", () => ({
  uploadFile: vi.fn(),
  downloadFile: vi.fn(),
}));

import { uploadFile } from "../../src/lib/storage";

// ---------------------------------------------------------------------------
// Minimal chainable Supabase mock
// ---------------------------------------------------------------------------

function buildMockDb() {
  const deleteCalls: { table: string; ids: string[] }[] = [];

  const inFn = vi.fn((ids: string[]) => {
    // The last deleteCalls entry was created by `delete()` — fill in the ids
    deleteCalls[deleteCalls.length - 1].ids = ids;
    return Promise.resolve({ error: null });
  });

  const deleteFn = vi.fn((table: string) => ({
    in: (ids: string[]) => {
      deleteCalls.push({ table, ids });
      return Promise.resolve({ error: null });
    },
  }));

  // Build a chainable mock: db.from(table).delete().in("id", ids)
  const db = {
    from: (table: string) => ({
      delete: () => ({
        in: (column: string, ids: string[]) => {
          deleteCalls.push({ table, ids });
          return Promise.resolve({ error: null });
        },
      }),
    }),
  } as unknown as ReturnType<typeof import("../../src/lib/supabase").createServerSupabase>;

  return { db, deleteCalls, inFn, deleteFn };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("applyReuseVersionSaga", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("Test A: compensating delete when uploadFile throws after document_edits insert", async () => {
    // Arrange
    const { db, deleteCalls } = buildMockDb();
    vi.mocked(uploadFile).mockRejectedValue(new Error("R2 down"));

    // Act
    const result = await applyReuseVersionSaga({
      db,
      newPath: "documents/u1/d1/edits/v1.docx",
      ab: new ArrayBuffer(0),
      mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      insertedEditIds: ["e1", "e2"],
    });

    // Assert: result is failure
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("R2 down");
    }

    // Assert: compensating delete was called with the two inserted edit IDs
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0].table).toBe("document_edits");
    expect(deleteCalls[0].ids).toEqual(["e1", "e2"]);
  });

  it("Test B: happy path — uploadFile succeeds, delete is NOT called", async () => {
    // Arrange
    const { db, deleteCalls } = buildMockDb();
    vi.mocked(uploadFile).mockResolvedValue(undefined as unknown as never);

    // Act
    const result = await applyReuseVersionSaga({
      db,
      newPath: "documents/u1/d1/edits/v1.docx",
      ab: new ArrayBuffer(4),
      mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      insertedEditIds: ["e3"],
    });

    // Assert: result is success
    expect(result.ok).toBe(true);

    // Assert: no compensating delete
    expect(deleteCalls).toHaveLength(0);
  });
});
