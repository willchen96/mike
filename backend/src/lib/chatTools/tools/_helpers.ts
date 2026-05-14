/**
 * Shared helpers for tools/*.ts. Anything imported by exactly one tool
 * stays in that tool's file; only cross-tool helpers live here.
 *
 * Doc-id resolvers (resolveDoc, resolveDocLabel) live in ../doc-context
 * — tools import them from there.
 */

import path from "path";

// ---------------------------------------------------------------------------
// PDF standard fonts path (used by extractPdfText + any future tool that
// needs headless PDF rendering)
// ---------------------------------------------------------------------------

export const STANDARD_FONT_DATA_URL = (() => {
    try {
        const pkgPath = require.resolve("pdfjs-dist/package.json");
        return path.join(path.dirname(pkgPath), "standard_fonts") + path.sep;
    } catch {
        return undefined;
    }
})();

// ---------------------------------------------------------------------------
// PDF text extraction — shared by read-document and find-in-document
// ---------------------------------------------------------------------------

export async function extractPdfText(buf: ArrayBuffer): Promise<string> {
    try {
        const pdfjsLib = await import(
            "pdfjs-dist/legacy/build/pdf.mjs" as string
        );
        const pdf = await (
            pdfjsLib as unknown as {
                getDocument: (opts: unknown) => {
                    promise: Promise<{
                        numPages: number;
                        getPage: (n: number) => Promise<{
                            getTextContent: () => Promise<{
                                items: { str?: string }[];
                            }>;
                        }>;
                    }>;
                };
            }
        ).getDocument({
            data: new Uint8Array(buf),
            standardFontDataUrl: STANDARD_FONT_DATA_URL,
        }).promise;
        const parts: string[] = [];
        for (let i = 1; i <= pdf.numPages; i++) {
            const page = await pdf.getPage(i);
            const textContent = await page.getTextContent();
            parts.push(
                `[Page ${i}]\n${textContent.items.map((it) => it.str ?? "").join(" ")}`,
            );
        }
        return parts.join("\n\n");
    } catch {
        return "";
    }
}

// ---------------------------------------------------------------------------
// Whitespace-normalised search helpers — shared by find-in-document
// ---------------------------------------------------------------------------

/**
 * Build a whitespace-collapsed, lowercased copy of `text`, plus a map from
 * each character index in the normalized form back to the corresponding
 * index in the original text. Used by findInDocumentContent so matches
 * are tolerant of case + whitespace variance but can still return the
 * exact original excerpt.
 */
export function normalizeWithMap(text: string): { norm: string; origIdx: number[] } {
    const norm: string[] = [];
    const origIdx: number[] = [];
    let prevSpace = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (/\s/.test(ch)) {
            if (!prevSpace) {
                norm.push(" ");
                origIdx.push(i);
                prevSpace = true;
            }
        } else {
            norm.push(ch.toLowerCase());
            origIdx.push(i);
            prevSpace = false;
        }
    }
    return { norm: norm.join(""), origIdx };
}

export function normalizeQuery(q: string): string {
    return q.trim().replace(/\s+/g, " ").toLowerCase();
}
