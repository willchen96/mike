/**
 * Phase 8 (CLEAN-30) — Phase 8 Success Criterion #3.
 *
 * Asserts that [1][2] markers + <CITATIONS>[...]</CITATIONS> tail produce
 * annotations[0].citationKey === "1" and annotations[1].citationKey === "2"
 * after extractAnnotations parsing.
 *
 * NOTE: The plan referenced the field as `citationKey` (string). Inspecting
 * chatTools.ts lines 2590-2617 reveals the actual field name is `ref` (number).
 * Tests below assert on `ref` (the production field) and document this finding.
 * Phase 8 SC #3 intent is preserved: the citation number is correctly parsed.
 */

import { describe, it, expect } from "vitest";
import { extractAnnotations } from "../../src/lib/chatTools";
import type { DocIndex } from "../../src/lib/chatTools";

// Production note: extractAnnotations returns unknown[] items with shape
// { type: "citation_data", ref: number, doc_id: string, document_id: string|undefined,
//   version_id: string|null, version_number: number|null, filename: string, page: number|string, quote: string }
// The plan spec named this field "citationKey" (string "1", "2") but the live code uses
// `ref` (number 1, 2). Tests use the production field name `ref`.

type CitationAnnotation = {
    type: "citation_data";
    ref: number;
    doc_id: string;
    document_id: string | undefined;
    version_id: string | null;
    version_number: number | null;
    filename: string;
    page: number | string;
    quote: string;
};

describe("extractAnnotations — citations round-trip", () => {
    it("parses two citation markers and returns correct ref, quote, and page fields", () => {
        const fullText =
            "Some prose [1] and more prose [2].\n" +
            "<CITATIONS>\n" +
            "[{\"ref\":1,\"doc_id\":\"doc-0\",\"page\":3,\"quote\":\"alpha\"},{\"ref\":2,\"doc_id\":\"doc-1\",\"page\":\"41-42\",\"quote\":\"beta\"}]\n" +
            "</CITATIONS>";

        const docIndex: DocIndex = {
            "doc-0": { document_id: "uuid-a", filename: "a.pdf" },
            "doc-1": { document_id: "uuid-b", filename: "b.pdf" },
        };

        const result = extractAnnotations(fullText, docIndex) as CitationAnnotation[];

        expect(result).toHaveLength(2);

        // Production field is `ref` (number), not `citationKey` (string).
        // Plan SC #3 intent: citation number 1 → first annotation, number 2 → second.
        expect(result[0].ref).toBe(1);
        expect(result[1].ref).toBe(2);

        expect(result[0].quote).toBe("alpha");
        expect(result[1].page).toBe("41-42");
    });

    it("returns empty array when fullText has no <CITATIONS> marker", () => {
        const fullText = "Some prose with no citations.";
        const docIndex: DocIndex = {};

        const result = extractAnnotations(fullText, docIndex);

        expect(result).toHaveLength(0);
    });

    it("returns empty array (no throw) when <CITATIONS> block contains malformed JSON", () => {
        const fullText =
            "Some prose.\n" +
            "<CITATIONS>\n" +
            "{ this is not valid JSON !!!\n" +
            "</CITATIONS>";

        const docIndex: DocIndex = {};

        expect(() => {
            const result = extractAnnotations(fullText, docIndex);
            expect(result).toHaveLength(0);
        }).not.toThrow();
    });
});
