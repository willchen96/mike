/**
 * CLEAN-51 — replicate_document hard-rejects count > 20 or count < 1.
 * Tests the boundary logic extracted from tool-runner.ts.
 */
import { describe, it, expect } from "vitest";

function validateReplicateCount(rawArg: unknown): { ok: true; count: number } | { ok: false; error: string } {
    const rawCount =
        typeof rawArg === "number" && Number.isFinite(rawArg)
            ? Math.floor(rawArg)
            : 1;
    if (rawCount < 1 || rawCount > 20) {
        return { ok: false, error: `count must be between 1 and 20 (got ${rawCount})` };
    }
    return { ok: true, count: rawCount };
}

describe("replicate_document count validation (CLEAN-51)", () => {
    it("rejects count=21", () => {
        const r = validateReplicateCount(21);
        expect(r.ok).toBe(false);
        expect((r as { error: string }).error).toContain("count must be between 1 and 20");
        expect((r as { error: string }).error).toContain("21");
    });

    it("rejects count=0", () => {
        const r = validateReplicateCount(0);
        expect(r.ok).toBe(false);
    });

    it("rejects count=-1", () => {
        const r = validateReplicateCount(-1);
        expect(r.ok).toBe(false);
    });

    it("accepts count=20 (boundary)", () => {
        const r = validateReplicateCount(20);
        expect(r.ok).toBe(true);
        expect((r as { count: number }).count).toBe(20);
    });

    it("accepts count=1", () => {
        const r = validateReplicateCount(1);
        expect(r.ok).toBe(true);
    });

    it("defaults to 1 when count is undefined", () => {
        const r = validateReplicateCount(undefined);
        expect(r.ok).toBe(true);
        expect((r as { count: number }).count).toBe(1);
    });
});
