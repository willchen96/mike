/**
 * <CITATIONS> block parser and post-stream annotation extractor.
 *
 * stream.ts uses CITATIONS_OPEN_TAG as the inline sentinel for visible-
 * content stripping (the inline streamVisibleContent closure in
 * runLLMStream). After the stream ends, extractAnnotations parses the
 * complete fullText into EditAnnotation[] for the assistant message
 * persistence path.
 */

import type { DocIndex, EditAnnotation } from "./types";
import { parseLlmJson } from "./parseLlmJson";
import { CitationsArraySchema } from "./llm-schemas";
import { logger } from "../logger";

export const CITATIONS_BLOCK_RE = /<CITATIONS>\s*([\s\S]*?)\s*<\/CITATIONS>/;
export const CITATIONS_OPEN_TAG = "<CITATIONS>";

export type ParsedCitation = {
    ref: number;
    doc_id: string;
    page: number | string;
    quote: string;
};

function normalizeCitation(raw: unknown): ParsedCitation | null {
    if (!raw || typeof raw !== "object") return null;
    const c = raw as Record<string, unknown>;
    if (typeof c.ref !== "number" || typeof c.doc_id !== "string") return null;
    if (typeof c.quote !== "string" || !c.quote) return null;
    let page: number | string;
    if (typeof c.page === "number") {
        page = c.page;
    } else if (typeof c.page === "string" && /^\d+\s*-\s*\d+$/.test(c.page)) {
        page = c.page;
    } else {
        const n = parseInt(String(c.page ?? ""), 10);
        if (!Number.isFinite(n)) return null;
        page = n;
    }
    return { ref: c.ref, doc_id: c.doc_id, page, quote: c.quote };
}

export function parseCitations(
    text: string,
    write?: (s: string) => void,
): ParsedCitation[] {
    const match = text.match(CITATIONS_BLOCK_RE);
    if (!match) return [];
    const result = parseLlmJson(match[1], CitationsArraySchema);
    if (!result.ok) {
        logger.warn({ err: result.error }, "[chatTools/citations] parse failed");
        if (write) {
            write(
                `data: ${JSON.stringify({ type: "citations_parse_error", error: result.error })}\n\n`,
            );
        }
        return [];
    }
    return result.data
        .map(normalizeCitation)
        .filter((c): c is ParsedCitation => c !== null);
}

export function extractAnnotations(
    fullText: string,
    docIndex: DocIndex,
    events?: ({ type: string } & Record<string, unknown>)[],
    write?: (s: string) => void,
): unknown[] {
    const out: unknown[] = parseCitations(fullText, write).map((c) => {
        const docInfo = docIndex[c.doc_id];
        return {
            type: "citation_data",
            ref: c.ref,
            doc_id: c.doc_id,
            document_id: docInfo?.document_id,
            version_id: docInfo?.version_id ?? null,
            version_number: docInfo?.version_number ?? null,
            filename: docInfo?.filename ?? c.doc_id,
            page: c.page,
            quote: c.quote,
        };
    });
    if (Array.isArray(events)) {
        for (const ev of events as { type?: string; annotations?: EditAnnotation[] }[]) {
            if (ev?.type === "doc_edited" && Array.isArray(ev.annotations)) {
                for (const a of ev.annotations) out.push({ ...a, type: "edit_data" });
            }
        }
    }
    return out;
}
