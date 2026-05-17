/**
 * Unit tests for parseLlmJson helper and llm-schemas.
 * Phase 10, Plan 01, CLEAN-23.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { parseLlmJson } from "../../src/lib/chatTools/parseLlmJson";
import {
    CitationsArraySchema,
    TabularCellSchema,
    TabularCellLineSchema,
} from "../../src/lib/chatTools/llm-schemas";

describe("parseLlmJson", () => {
    it("returns ok: false with JSON syntax error for malformed JSON", () => {
        const result = parseLlmJson("{not json", z.object({}));
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error).toMatch(/JSON syntax:/);
            expect(result.raw).toBe("{not json");
        }
    });

    it("returns ok: true for valid citations array", () => {
        const raw = '[{"ref":1,"doc_id":"d","page":1,"quote":"q"}]';
        const result = parseLlmJson(raw, CitationsArraySchema);
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.data).toEqual([{ ref: 1, doc_id: "d", page: 1, quote: "q" }]);
        }
    });

    it("returns ok: false with schema error for citation with non-number ref", () => {
        const raw = '[{"ref":"not-a-number","doc_id":"d","page":1,"quote":"q"}]';
        const result = parseLlmJson(raw, CitationsArraySchema);
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error).toContain("ref");
            expect(typeof result.raw).toBe("string");
        }
    });

    it("returns ok: false when valid JSON has wrong type for schema", () => {
        const raw = '"valid-json-but-wrong-type"';
        const result = parseLlmJson(raw, z.array(z.number()));
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(typeof result.error).toBe("string");
            expect(result.raw).toBe(raw);
        }
    });

    it("returns ok: false for empty string input (not valid JSON)", () => {
        const result = parseLlmJson("", z.object({}));
        expect(result.ok).toBe(false);
    });

    it("returns ok: true for valid object matching schema", () => {
        const raw = '{"summary":"test","flag":"green"}';
        const result = parseLlmJson(raw, TabularCellSchema);
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.data.summary).toBe("test");
            expect(result.data.flag).toBe("green");
        }
    });

    it("returns ok: false for TabularCellSchema object with neither summary nor value (refinement failure)", () => {
        const raw = '{"flag":"green","reasoning":"some reason"}';
        const result = parseLlmJson(raw, TabularCellSchema);
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(typeof result.error).toBe("string");
        }
    });

    it("returns ok: false for TabularCellLineSchema missing column_index", () => {
        const raw = '{"summary":"test","flag":"green"}';
        const result = parseLlmJson(raw, TabularCellLineSchema);
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error).toContain("column_index");
        }
    });

    it("never throws for any string input", () => {
        const inputs = ["{not json", "", "null", "undefined", "[[[", '{"a":'];
        for (const input of inputs) {
            expect(() => parseLlmJson(input, z.object({}))).not.toThrow();
        }
    });
});
