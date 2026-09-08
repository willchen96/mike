import { describe, it, expect } from "vitest";
import {
    parseCitations,
    parseCitationsWithDiagnostics,
    parsePartialCitationObjects,
    createCitation,
    CITATIONS_OPEN_TAG,
    CITATIONS_CLOSE_TAG,
} from "../chat/citations";
import type { DocIndex, DocStore } from "../chat/types";

function citationsBlock(json: string) {
    return `Answer text.\n${CITATIONS_OPEN_TAG}\n${json}\n${CITATIONS_CLOSE_TAG}`;
}

// ---------------------------------------------------------------------------
// parseCitationsWithDiagnostics
// ---------------------------------------------------------------------------

describe("parseCitationsWithDiagnostics", () => {
    it("reports no block when the tags are absent", () => {
        const { citations, diagnostics } =
            parseCitationsWithDiagnostics("plain answer");
        expect(citations).toEqual([]);
        expect(diagnostics).toEqual({ hasBlock: false, rawLength: 0, error: null });
    });

    it("reports a JSON parse error for malformed block content", () => {
        const { citations, diagnostics } = parseCitationsWithDiagnostics(
            citationsBlock("[{not json"),
        );
        expect(citations).toEqual([]);
        expect(diagnostics.hasBlock).toBe(true);
        expect(diagnostics.rawLength).toBeGreaterThan(0);
        expect(diagnostics.error).toBeTruthy();
    });

    it("reports an error when the block JSON is not an array", () => {
        const { citations, diagnostics } = parseCitationsWithDiagnostics(
            citationsBlock('{"ref": 1}'),
        );
        expect(citations).toEqual([]);
        expect(diagnostics.error).toBe("CITATIONS block JSON was not an array.");
    });
});

// ---------------------------------------------------------------------------
// parseCitations — document citations
// ---------------------------------------------------------------------------

describe("parseCitations (document citations)", () => {
    it("parses a minimal document citation", () => {
        const [citation] = parseCitations(
            citationsBlock(
                '[{"ref": 1, "doc_id": "doc-1", "page": 3, "quote": "the term"}]',
            ),
        );
        expect(citation).toMatchObject({
            kind: "document",
            ref: 1,
            doc_id: "doc-1",
            page: 3,
            quote: "the term",
        });
        expect(citation.quotes).toHaveLength(1);
    });

    it("derives ref from a [N] marker when ref is missing", () => {
        const [citation] = parseCitations(
            citationsBlock(
                '[{"marker": "[7]", "doc_id": "doc-1", "page": 1, "quote": "q"}]',
            ),
        );
        expect(citation.ref).toBe(7);
    });

    it("drops entries without a usable ref or marker", () => {
        expect(
            parseCitations(
                citationsBlock('[{"doc_id": "doc-1", "quote": "q", "marker": "nope"}]'),
            ),
        ).toEqual([]);
    });

    it("drops document entries without doc_id or quote", () => {
        expect(
            parseCitations(citationsBlock('[{"ref": 1, "doc_id": "doc-1"}]')),
        ).toEqual([]);
        expect(
            parseCitations(citationsBlock('[{"ref": 1, "quote": "q"}]')),
        ).toEqual([]);
    });

    it("drops non-object entries but keeps valid ones", () => {
        const citations = parseCitations(
            citationsBlock(
                '[null, "junk", {"ref": 2, "doc_id": "doc-2", "page": 4, "quote": "kept"}]',
            ),
        );
        expect(citations).toHaveLength(1);
        expect(citations[0]).toMatchObject({ ref: 2, doc_id: "doc-2" });
    });

    it("accepts a text field as a quote alias", () => {
        const [citation] = parseCitations(
            citationsBlock('[{"ref": 1, "doc_id": "doc-1", "page": 2, "text": "aliased"}]'),
        );
        expect(citation.kind).toBe("document");
        expect((citation as { quote: string }).quote).toBe("aliased");
    });

    it("normalizes pages: numbers kept, ranges kept, junk becomes 1", () => {
        const citations = parseCitations(
            citationsBlock(
                '[{"ref": 1, "doc_id": "d", "page": 5, "quote": "a"},' +
                    '{"ref": 2, "doc_id": "d", "page": "3-5", "quote": "b"},' +
                    '{"ref": 3, "doc_id": "d", "page": "12", "quote": "c"},' +
                    '{"ref": 4, "doc_id": "d", "page": "unknown", "quote": "d"}]',
            ),
        );
        expect(citations.map((c) => (c as { page: number | string }).page)).toEqual([
            5,
            "3-5",
            12,
            1,
        ]);
    });

    it("keeps at most 3 quotes and inherits top-level page/sheet/cell", () => {
        const [citation] = parseCitations(
            citationsBlock(
                JSON.stringify([
                    {
                        ref: 1,
                        doc_id: "doc-1",
                        page: 9,
                        sheet: "Summary",
                        cell: "B7",
                        quotes: [
                            { quote: "one" },
                            { quote: "two", page: 2 },
                            { quote: "three", sheet: "Detail", cell: "C1" },
                            { quote: "four" },
                        ],
                    },
                ]),
            ),
        );
        expect(citation.kind).toBe("document");
        const doc = citation as {
            page: number | string;
            quotes: { page: number | string; quote: string; sheet?: string; cell?: string }[];
        };
        expect(doc.quotes).toHaveLength(3);
        expect(doc.quotes[0]).toEqual({
            page: 9,
            quote: "one",
            sheet: "Summary",
            cell: "B7",
        });
        expect(doc.quotes[1].page).toBe(2);
        expect(doc.quotes[2]).toMatchObject({ sheet: "Detail", cell: "C1" });
        // Top-level fields mirror the first quote.
        expect(doc.page).toBe(9);
    });

    it("skips quote rows without text", () => {
        const [citation] = parseCitations(
            citationsBlock(
                '[{"ref": 1, "doc_id": "doc-1", "page": 1,' +
                    ' "quotes": [{"page": 2}, {"quote": "  "}, {"quote": "real"}]}]',
            ),
        );
        expect((citation as { quotes: unknown[] }).quotes).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
// parseCitations — case citations
// ---------------------------------------------------------------------------

describe("parseCitations (case citations)", () => {
    it("parses a case citation from a numeric cluster_id", () => {
        const [citation] = parseCitations(
            citationsBlock('[{"ref": 1, "cluster_id": 12345, "quote": "held that"}]'),
        );
        expect(citation).toMatchObject({ kind: "case", ref: 1, cluster_id: 12345 });
        expect((citation as { quotes: unknown[] }).quotes).toEqual([
            { opinionId: null, type: null, author: null, quote: "held that" },
        ]);
    });

    it("accepts clusterId camelCase and string cluster ids", () => {
        const citations = parseCitations(
            citationsBlock(
                '[{"ref": 1, "clusterId": 7, "quote": "a"},' +
                    '{"ref": 2, "cluster_id": "42", "quote": "b"}]',
            ),
        );
        expect(citations.map((c) => (c as { cluster_id: number }).cluster_id)).toEqual([
            7, 42,
        ]);
    });

    it("floors fractional cluster ids", () => {
        const [citation] = parseCitations(
            citationsBlock('[{"ref": 1, "cluster_id": 12.9, "quote": "q"}]'),
        );
        expect((citation as { cluster_id: number }).cluster_id).toBe(12);
    });

    it("treats non-positive cluster ids as document citations", () => {
        // cluster_id 0 fails the > 0 check, so the entry needs a doc_id.
        expect(
            parseCitations(citationsBlock('[{"ref": 1, "cluster_id": 0, "quote": "q"}]')),
        ).toEqual([]);
    });

    it("normalizes structured case quotes with opinion metadata", () => {
        const [citation] = parseCitations(
            citationsBlock(
                JSON.stringify([
                    {
                        ref: 3,
                        cluster_id: 99,
                        quotes: [
                            {
                                quote: "majority text",
                                opinion_id: 11.7,
                                type: "majority",
                                author: "Judge A",
                            },
                            { text: "concurrence text", opinionId: 12 },
                            { type: "no quote text, dropped" },
                        ],
                    },
                ]),
            ),
        );
        expect((citation as { quotes: unknown[] }).quotes).toEqual([
            {
                opinionId: 11,
                type: "majority",
                author: "Judge A",
                quote: "majority text",
            },
            { opinionId: 12, type: null, author: null, quote: "concurrence text" },
        ]);
    });

    it("drops case citations with no quotes at all", () => {
        expect(
            parseCitations(citationsBlock('[{"ref": 1, "cluster_id": 5}]')),
        ).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// parsePartialCitationObjects
// ---------------------------------------------------------------------------

describe("parsePartialCitationObjects", () => {
    it("returns [] when no array has started", () => {
        expect(parsePartialCitationObjects("streaming <CITATIONS>")).toEqual([]);
    });

    it("extracts complete objects and ignores a trailing incomplete one", () => {
        const partial =
            '<CITATIONS>[{"ref": 1, "doc_id": "doc-1", "page": 2, "quote": "done"},' +
            ' {"ref": 2, "doc_id": "doc-2", "page": 3, "quote": "still stream';
        const citations = parsePartialCitationObjects(partial);
        expect(citations).toHaveLength(1);
        expect(citations[0]).toMatchObject({ ref: 1, doc_id: "doc-1" });
    });

    it("handles braces and escaped quotes inside string values", () => {
        const partial =
            '<CITATIONS>[{"ref": 1, "doc_id": "doc-1", "page": 1,' +
            ' "quote": "clause {a} says \\"stop\\""}';
        const citations = parsePartialCitationObjects(partial);
        expect(citations).toHaveLength(1);
        expect((citations[0] as { quote: string }).quote).toBe(
            'clause {a} says "stop"',
        );
    });

    it("ignores content after the closing tag", () => {
        const text =
            '<CITATIONS>[{"ref": 1, "doc_id": "a", "page": 1, "quote": "q"}]</CITATIONS>' +
            '[{"ref": 9, "doc_id": "b", "page": 1, "quote": "after"}]';
        const citations = parsePartialCitationObjects(text);
        expect(citations).toHaveLength(1);
        expect(citations[0]).toMatchObject({ ref: 1 });
    });

    it("stops at the array close bracket", () => {
        const text =
            '[{"ref": 1, "doc_id": "a", "page": 1, "quote": "q"}] {"ref": 2, "doc_id": "b", "page": 1, "quote": "outside"}';
        const citations = parsePartialCitationObjects(text);
        expect(citations).toHaveLength(1);
    });

    it("skips malformed objects but keeps later valid ones", () => {
        const text =
            '[{"ref": bad}, {"ref": 2, "doc_id": "doc-2", "page": 1, "quote": "ok"}';
        const citations = parsePartialCitationObjects(text);
        expect(citations).toHaveLength(1);
        expect(citations[0]).toMatchObject({ ref: 2 });
    });
});

// ---------------------------------------------------------------------------
// createCitation
// ---------------------------------------------------------------------------

describe("createCitation", () => {
    const docIndex: DocIndex = {
        "doc-1": {
            document_id: "uuid-aaa",
            filename: "contract.pdf",
            version_id: "ver-1",
            version_number: 2,
        },
    };

    it("builds a document citation payload from the doc index", () => {
        const [parsed] = parseCitations(
            citationsBlock('[{"ref": 1, "doc_id": "doc-1", "page": 4, "quote": "q"}]'),
        );
        expect(createCitation(parsed, docIndex)).toMatchObject({
            type: "citation_data",
            kind: "document",
            ref: 1,
            doc_id: "doc-1",
            document_id: "uuid-aaa",
            version_id: "ver-1",
            version_number: 2,
            filename: "contract.pdf",
            page: 4,
            quote: "q",
            document: {
                document_id: "uuid-aaa",
                title: "contract.pdf",
                type: "pdf",
                metadata: [],
                quotes: [{ quote: "q", target: { page: 4 } }],
            },
        });
    });

    it("falls back to the raw doc_id as filename when unresolvable", () => {
        const [parsed] = parseCitations(
            citationsBlock('[{"ref": 1, "doc_id": "doc-9", "page": 1, "quote": "q"}]'),
        );
        const citation = createCitation(parsed, docIndex);
        expect(citation).toMatchObject({
            filename: "doc-9",
            document_id: undefined,
            version_id: null,
        });
    });

    it("uses request-scoped document metadata for inline citations", () => {
        const [parsed] = parseCitations(
            citationsBlock('[{"ref": 1, "doc_id": "active-word-document", "quote": "q"}]'),
        );
        const docStore: DocStore = new Map([
            [
                "active-word-document",
                {
                    storage_path: "inline:word-document:test",
                    file_type: "text/markdown",
                    filename: "Contract.docx",
                    inline_text: "q",
                },
            ],
        ]);

        expect(createCitation(parsed, docIndex, undefined, docStore)).toMatchObject({
            filename: "Contract.docx",
            document: { title: "Contract.docx" },
        });
    });

    it("enriches a case citation from the cluster map", () => {
        const [parsed] = parseCitations(
            citationsBlock('[{"ref": 2, "cluster_id": 55, "quote": "held"}]'),
        );
        const cases = new Map([
            [
                55,
                {
                    caseName: "Smith v. Jones",
                    citations: ["123 U.S. 456", "alt cite"],
                    url: "https://example.test/case",
                    pdfUrl: null,
                    dateFiled: "1990-01-02",
                },
            ],
        ]);
        expect(createCitation(parsed, docIndex, cases)).toMatchObject({
            type: "citation_data",
            kind: "case",
            ref: 2,
            cluster_id: 55,
            case_name: "Smith v. Jones",
            citation: "123 U.S. 456",
            url: "https://example.test/case",
            pdfUrl: null,
            dateFiled: "1990-01-02",
            document: {
                document_id: "case:55",
                title: "Smith v. Jones, 123 U.S. 456",
                type: "case",
                metadata: [
                    {
                        label: "Date",
                        value: "1990-01-02",
                        format: "date",
                    },
                ],
            },
        });
    });

    it("nulls case metadata when the cluster map has no entry", () => {
        const [parsed] = parseCitations(
            citationsBlock('[{"ref": 2, "cluster_id": 55, "quote": "held"}]'),
        );
        expect(createCitation(parsed, docIndex)).toMatchObject({
            case_name: null,
            citation: null,
            url: null,
            pdfUrl: null,
            dateFiled: null,
        });
    });

    it("keeps a request-scoped source document body in the citation", () => {
        const [parsed] = parseCitations(
            citationsBlock(
                '[{"ref":1,"doc_id":"doc-0","quote":"Exact text"}]',
            ),
        );
        const panelDocument = {
            document_id: "source-1",
            title: "Article 1",
            type: "legislation" as const,
            metadata: [],
            quotes: [],
            subdocuments: [
                {
                    document_id: "source-1:text",
                    title: "Article 1",
                    type: "html" as const,
                    text: "Exact text",
                },
            ],
        };
        const docStore: DocStore = new Map([
            [
                "doc-0",
                {
                    storage_path: "",
                    file_type: "text/plain",
                    filename: "Article 1",
                    inline_text: "Exact text",
                    panel_document: panelDocument,
                },
            ],
        ]);

        const citation = createCitation(parsed, {}, undefined, docStore);

        expect(citation.document).toMatchObject({
            ...panelDocument,
            quotes: [
                {
                    quote: "Exact text",
                    target: { subdocument_id: "source-1:text" },
                },
            ],
        });
    });
});
