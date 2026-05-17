/**
 * CLEAN-09 + CLEAN-34 — edit-resolution compensating saga unit test.
 *
 * Verifies the saga ordering:
 *   1. downloadFn called once (snapshot prior bytes)
 *   2. uploadFn called with new bytes
 *   3. dbUpdateFn called
 *   4. On DB failure: uploadFn called again with prior bytes (compensating rollback)
 *
 * No live DB or R2 required — all dependencies are mocked.
 */

import { describe, it, expect, vi } from "vitest";
import { applyEditResolutionSaga } from "../../src/routes/documents";

const PRIOR_BYTES = new Uint8Array([1, 2, 3]).buffer as ArrayBuffer;
const NEW_BYTES = new Uint8Array([4, 5, 6]).buffer as ArrayBuffer;

describe("applyEditResolutionSaga", () => {
  it("Test A: compensating rollback when dbUpdateFn fails after successful upload", async () => {
    const downloadFn = vi.fn().mockResolvedValue(PRIOR_BYTES);
    const uploadFn = vi.fn().mockResolvedValue(undefined);
    const dbUpdateFn = vi
      .fn()
      .mockResolvedValue({ error: { code: "boom", message: "DB error" } });

    const result = await applyEditResolutionSaga({
      latestPath: "documents/u1/d1/v1.docx",
      newBytes: NEW_BYTES,
      status: "accepted",
      editId: "edit-1",
      uploadFn,
      downloadFn,
      dbUpdateFn,
    });

    // Should return failure
    expect(result.ok).toBe(false);
    expect(result.status).toBe(500);

    // downloadFn must have been called once (to snapshot prior bytes before upload)
    expect(downloadFn).toHaveBeenCalledTimes(1);
    expect(downloadFn).toHaveBeenCalledWith("documents/u1/d1/v1.docx");

    // uploadFn must have been called twice:
    //   1st call: new bytes (overwrite)
    //   2nd call: prior bytes (compensating rollback)
    expect(uploadFn).toHaveBeenCalledTimes(2);
    expect(uploadFn.mock.calls[0][1]).toBe(NEW_BYTES);
    expect(uploadFn.mock.calls[1][1]).toBe(PRIOR_BYTES);

    // dbUpdateFn must have been called exactly once
    expect(dbUpdateFn).toHaveBeenCalledTimes(1);
  });

  it("Test B: uploadFn throws — dbUpdateFn is never called", async () => {
    const downloadFn = vi.fn().mockResolvedValue(PRIOR_BYTES);
    const uploadFn = vi.fn().mockRejectedValue(new Error("R2 unreachable"));
    const dbUpdateFn = vi.fn();

    const result = await applyEditResolutionSaga({
      latestPath: "documents/u1/d1/v1.docx",
      newBytes: NEW_BYTES,
      status: "rejected",
      editId: "edit-2",
      uploadFn,
      downloadFn,
      dbUpdateFn,
    });

    // Should return failure
    expect(result.ok).toBe(false);
    expect(result.status).toBe(500);

    // downloadFn still called (happens before upload)
    expect(downloadFn).toHaveBeenCalledTimes(1);

    // uploadFn was called once (the failing attempt) — no second call
    expect(uploadFn).toHaveBeenCalledTimes(1);

    // dbUpdateFn must NOT have been called — no DB side effects when storage fails
    expect(dbUpdateFn).not.toHaveBeenCalled();
  });

  it("Test C: happy path — uploadFn called once, dbUpdateFn called once, ok: true", async () => {
    const downloadFn = vi.fn().mockResolvedValue(PRIOR_BYTES);
    const uploadFn = vi.fn().mockResolvedValue(undefined);
    const dbUpdateFn = vi.fn().mockResolvedValue({ error: null });

    const result = await applyEditResolutionSaga({
      latestPath: "documents/u1/d1/v1.docx",
      newBytes: NEW_BYTES,
      status: "accepted",
      editId: "edit-3",
      uploadFn,
      downloadFn,
      dbUpdateFn,
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);

    // uploadFn called exactly once (new bytes only — no rollback needed)
    expect(uploadFn).toHaveBeenCalledTimes(1);
    expect(uploadFn.mock.calls[0][1]).toBe(NEW_BYTES);

    // dbUpdateFn called exactly once
    expect(dbUpdateFn).toHaveBeenCalledTimes(1);
    expect(dbUpdateFn).toHaveBeenCalledWith("accepted", "edit-3");
  });
});
