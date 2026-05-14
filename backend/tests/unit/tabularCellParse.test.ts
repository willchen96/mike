/**
 * Unit tests for tabular cell parse schemas.
 * Phase 10, Plan 01, CLEAN-23.
 */

import { describe, it, expect } from "vitest";
import { parseLlmJson } from "../../src/lib/chatTools/parseLlmJson";
import { TabularCellSchema, TabularCellLineSchema } from "../../src/lib/chatTools/llm-schemas";

describe("TabularCellSchema", () => {
    it("parses a valid cell with summary and flag", () => {
        const raw = '{"summary":"Contract term is 12 months","flag":"green","reasoning":"Clearly stated"}';
        const result = parseLlmJson(raw, TabularCellSchema);
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.data.summary).toBe("Contract term is 12 months");
            expect(result.data.flag).toBe("green");
            expect(result.data.reasoning).toBe("Clearly stated");
        }
    });

    it("parses a valid cell with value instead of summary", () => {
        const raw = '{"value":"12 months","flag":"grey"}';
        const result = parseLlmJson(raw, TabularCellSchema);
        expect(result.ok).toBe(true);
    });

    it("fails refinement when neither summary nor value is present", () => {
        const raw = '{"flag":"green","reasoning":"some reason"}';
        const result = parseLlmJson(raw, TabularCellSchema);
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error).toContain("Cell must have summary or value");
        }
    });

    it("fails with enum violation for unknown flag value", () => {
        const raw = '{"summary":"test","flag":"purple"}';
        const result = parseLlmJson(raw, TabularCellSchema);
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(typeof result.error).toBe("string");
        }
    });
});

describe("TabularCellLineSchema", () => {
    it("parses a valid cell line with column_index", () => {
        const raw = '{"column_index":2,"summary":"found","flag":"yellow","reasoning":"partial match"}';
        const result = parseLlmJson(raw, TabularCellLineSchema);
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.data.column_index).toBe(2);
            expect(result.data.summary).toBe("found");
        }
    });

    it("fails when column_index is missing", () => {
        const raw = '{"summary":"test","flag":"green"}';
        const result = parseLlmJson(raw, TabularCellLineSchema);
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error).toContain("column_index");
        }
    });

    it("fails when neither summary nor value is present", () => {
        const raw = '{"column_index":0,"flag":"green"}';
        const result = parseLlmJson(raw, TabularCellLineSchema);
        expect(result.ok).toBe(false);
    });
});
