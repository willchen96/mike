/**
 * Unit tests for the rewired citations.ts and tool-runner.ts parse sites.
 * Verifies that parseCitations emits SSE error events on malformed JSON.
 * Phase 10, Plan 01, CLEAN-23.
 */

import { describe, it, expect } from "vitest";
import { parseCitations } from "../../src/lib/chatTools/citations";

describe("parseCitations with write parameter", () => {
    it("returns empty array and emits SSE event for malformed JSON in CITATIONS block", () => {
        const text = "<CITATIONS>{not valid json}</CITATIONS>";
        const emitted: string[] = [];
        const result = parseCitations(text, (s) => emitted.push(s));
        expect(result).toEqual([]);
        expect(emitted.length).toBe(1);
        const event = JSON.parse(emitted[0].replace(/^data: /, "").trim());
        expect(event.type).toBe("citations_parse_error");
        expect(typeof event.error).toBe("string");
    });

    it("returns empty array without emitting when write is not provided", () => {
        const text = "<CITATIONS>{not valid json}</CITATIONS>";
        const result = parseCitations(text);
        expect(result).toEqual([]);
    });

    it("returns parsed citations for valid JSON without emitting events", () => {
        const text = `<CITATIONS>[{"ref":1,"doc_id":"doc-0","page":2,"quote":"some quote"}]</CITATIONS>`;
        const emitted: string[] = [];
        const result = parseCitations(text, (s) => emitted.push(s));
        expect(result).toHaveLength(1);
        expect(result[0].ref).toBe(1);
        expect(emitted.length).toBe(0);
    });

    it("returns empty array for schema validation failure (non-array)", () => {
        const text = `<CITATIONS>{"not":"an-array"}</CITATIONS>`;
        const emitted: string[] = [];
        const result = parseCitations(text, (s) => emitted.push(s));
        expect(result).toEqual([]);
        expect(emitted.length).toBe(1);
        const event = JSON.parse(emitted[0].replace(/^data: /, "").trim());
        expect(event.type).toBe("citations_parse_error");
    });
});
