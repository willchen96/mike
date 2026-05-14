/**
 * fan-out-bound.test.ts
 *
 * Unit tests for the runBoundedFanOut helper (CLEAN-17).
 * Verifies:
 *   A — cell-count guard rejects > 200 cells before any LLM call
 *   B — concurrency cap: no more than 5 processFn calls in-flight simultaneously
 *   C — happy path: all docs processed, result { ok: true }
 */
import { describe, it, expect, vi } from "vitest";
import { runBoundedFanOut } from "../../src/routes/tabular";

describe("runBoundedFanOut", () => {
  it("A — rejects with 400 when docs × columns > 200", async () => {
    const processFn = vi.fn().mockResolvedValue(undefined);
    // 21 docs × 10 columns = 210 cells
    const docs = Array.from({ length: 21 }, (_, i) => ({ id: `doc-${i}` }));
    const result = await runBoundedFanOut({
      docs,
      columnsCount: 10,
      processFn,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(400);
      expect(result.detail).toMatch(/200/);
    }
    expect(processFn).not.toHaveBeenCalled();
  });

  it("B — in-flight count never exceeds 5 (concurrency cap)", async () => {
    let inFlight = 0;
    let maxInFlight = 0;

    const processFn = async (_doc: { id: string }): Promise<void> => {
      inFlight++;
      if (inFlight > maxInFlight) maxInFlight = inFlight;
      await new Promise<void>((r) => setImmediate(r));
      inFlight--;
    };

    // 50 docs × 1 column = 50 cells (within 200 cap)
    const docs = Array.from({ length: 50 }, (_, i) => ({ id: `doc-${i}` }));
    const result = await runBoundedFanOut({
      docs,
      columnsCount: 1,
      processFn,
    });

    expect(result.ok).toBe(true);
    expect(maxInFlight).toBeLessThanOrEqual(5);
  });

  it("C — happy path: all 3 docs processed, returns { ok: true }", async () => {
    const processed: string[] = [];
    const docs = [{ id: "a" }, { id: "b" }, { id: "c" }];

    const result = await runBoundedFanOut({
      docs,
      columnsCount: 3, // 3 × 3 = 9 cells, within cap
      processFn: async (doc) => {
        processed.push(doc.id);
      },
    });

    expect(result.ok).toBe(true);
    expect(processed).toHaveLength(3);
    expect(processed.sort()).toEqual(["a", "b", "c"]);
  });
});
