"use client";

const PAGE_CITATION_RE = /\[\[(?:doc_id:([^|\]]+)\|\|)?page:(\d+)\|\|(?:quote:)?((?:[^\[\]]|\[[^\]]*\])+)\]\]/gi;

export interface ParsedCitation {
    documentId?: string;
    page: number;
    quote: string;
}

/**
 * Replaces [[page:n||quote:...]] markers with `§idx§` placeholders.
 * Returns the processed string and an ordered array of extracted citation data.
 */
export function preprocessCitations(text: string): {
    processed: string;
    citations: ParsedCitation[];
} {
    const citations: ParsedCitation[] = [];
    PAGE_CITATION_RE.lastIndex = 0;
    const processed = text.replace(PAGE_CITATION_RE, (_, documentId, page, quote) => {
        const idx = citations.length;
        citations.push({
            documentId: typeof documentId === "string" ? documentId.trim() : undefined,
            page: parseInt(page, 10),
            quote: quote.trim(),
        });
        return `§${idx}§`;
    });
    return { processed, citations };
}
