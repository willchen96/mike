/** CLEAN-49 — GET /workflows/builtin returns canonical BUILTIN_WORKFLOWS array. */
import { describe, it, expect } from "vitest";
import { BUILTIN_WORKFLOWS } from "../../src/lib/builtinWorkflows";

describe("GET /workflows/builtin — canonical BUILTIN_WORKFLOWS", () => {
    it("BUILTIN_WORKFLOWS is a non-empty array", () => {
        expect(Array.isArray(BUILTIN_WORKFLOWS)).toBe(true);
        expect(BUILTIN_WORKFLOWS.length).toBeGreaterThan(0);
    });

    it("every entry has id and title", () => {
        for (const w of BUILTIN_WORKFLOWS) {
            expect(typeof w.id).toBe("string");
            expect(typeof w.title).toBe("string");
            expect(w.id.length).toBeGreaterThan(0);
        }
    });

    it("all ids are unique", () => {
        const ids = BUILTIN_WORKFLOWS.map((w) => w.id);
        expect(new Set(ids).size).toBe(ids.length);
    });
});
