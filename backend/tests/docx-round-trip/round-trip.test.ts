/**
 * Phase 7 (CLEAN-31) — docxTrackedChanges round-trip fixture test.
 *
 * Verifies that applyTrackedEdits → resolveTrackedChange("accept"/"reject")
 * produces correct body text relative to the original DOCX. Semantic
 * equality via extractDocxBodyText, NOT byte equality (ZIP re-compression
 * is non-deterministic).
 *
 * extractDocxBodyText accepted-view assumption:
 *   extractDocxBodyText uses flattenParagraph which implements "accepted-view"
 *   semantics — it includes text from <w:ins> runs and skips <w:del> runs.
 *   This means extractDocxBodyText(editedBytes) already shows the accepted
 *   (new) text. The assertions here use an independent-resolve pattern:
 *   each change's [delId, insId] is resolved independently against the same
 *   un-resolved editedBytes. After reject, extractDocxBodyText returns the
 *   original text (w:del content restored, w:ins removed). After accept,
 *   the accepted-view text equals extractDocxBodyText(editedBytes) because
 *   accept makes the accepted-view permanent.
 *
 * No live DB, R2, or LLM required.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import {
    applyTrackedEdits,
    resolveTrackedChange,
    extractDocxBodyText,
} from "../../src/lib/docxTrackedChanges";
import type { EditInput } from "../../src/lib/docxTrackedChanges";

const fixtureDir = path.join(__dirname, "fixtures");

function loadFixture(name: string): Buffer {
    return readFileSync(path.join(fixtureDir, `${name}.docx`));
}

interface FixtureCase {
    name: string;
    edits: EditInput[];
}

const FIXTURES: FixtureCase[] = [
    // --- Wave 1 seed fixtures ---
    {
        name: "01-simple-insert",
        edits: [
            {
                find: "brown",
                replace: "brown and clever",
                context_before: "quick ",
                context_after: " fox",
            },
        ],
    },
    {
        name: "02-simple-delete",
        edits: [
            {
                find: "the bracketed phrase ",
                replace: "",
                context_before: "remove ",
                context_after: "from",
            },
        ],
    },
    {
        name: "04-table-cell",
        edits: [
            {
                find: "brown",
                replace: "red",
                context_before: "quick ",
                context_after: " fox",
            },
        ],
    },
    {
        name: "05-bullet-list",
        edits: [
            {
                find: "brown",
                replace: "swift",
                context_before: "quick ",
                context_after: " fox",
            },
        ],
    },
    {
        name: "06-heading",
        edits: [
            {
                find: "brown",
                replace: "agile",
                context_before: "quick ",
                context_after: " fox",
            },
        ],
    },
    // --- Wave 2 new fixtures ---
    {
        // 03-replace: single paragraph, simple substitution
        name: "03-replace",
        edits: [
            {
                find: "fast brown fox",
                replace: "agile red wolf",
                context_before: "The ",
                context_after: " runs",
            },
        ],
    },
    {
        // 07-multi-paragraph: two edits, one per paragraph
        name: "07-multi-paragraph",
        edits: [
            {
                find: "quick brown fox",
                replace: "swift orange cat",
                context_before: "the ",
                context_after: ".",
            },
            {
                find: "lazy dog",
                replace: "sleepy hound",
                context_before: "the ",
                context_after: ".",
            },
        ],
    },
    {
        // 11-mixed-ranges: "brown" spans a run boundary (plain "quick " + bold "brown" + " fox")
        // Because the bold boundary is between runs, but the word is contiguous
        // in the accepted-view text, the edit should still succeed.
        name: "11-mixed-ranges",
        edits: [
            {
                find: "brown",
                replace: "red",
                context_before: "quick ",
                context_after: " fox",
            },
        ],
    },
    {
        // 12-unicode-text: Dutch sample with ë, ï, ö, ij
        name: "12-unicode-text",
        edits: [
            {
                find: "ijsbeer",
                replace: "zwemmer",
                context_before: "vlijtige ",
                context_after: " zwemt",
            },
        ],
    },
    {
        // 13-smart-quotes: normalization layer maps U+201C/U+201D → " for matching.
        // The `find` uses straight double-quotes; the document has smart quotes.
        name: "13-smart-quotes",
        edits: [
            {
                find: "\"Hello world\"",
                replace: "\"Goodbye world\"",
                context_before: "said ",
                context_after: " and",
            },
        ],
    },
    {
        // 14-nonbreaking-space: normalization maps U+00A0 → regular space.
        // The document has NBSP between "section" and "4.2"; `find` uses a regular space.
        name: "14-nonbreaking-space",
        edits: [
            {
                find: "section 4.2",
                replace: "section 5.1",
                context_before: "",
                context_after: " governs",
            },
        ],
    },
    {
        // 15-cross-run-word: "brown" is split across two runs ("bro" + "wn" bold).
        // The engine operates at the paragraph-text level so cross-run words work.
        name: "15-cross-run-word",
        edits: [
            {
                find: "brown",
                replace: "crimson",
                context_before: "quick ",
                context_after: " fox",
            },
        ],
    },
    {
        // 16-multi-edit-same-para: two non-overlapping edits in a single paragraph
        name: "16-multi-edit-same-para",
        edits: [
            {
                find: "quick",
                replace: "nimble",
                context_before: "The ",
                context_after: " brown",
            },
            {
                find: "lazy",
                replace: "drowsy",
                context_before: "the ",
                context_after: " dog",
            },
        ],
    },
    {
        // 18-pure-insertion: find="" with context_before/after inserts text
        name: "18-pure-insertion",
        edits: [
            {
                find: "",
                replace: "fast ",
                context_before: "quick ",
                context_after: "brown",
            },
        ],
    },
    {
        // 19-pure-deletion: replace="" deletes the matched phrase
        name: "19-pure-deletion",
        edits: [
            {
                find: "(parenthetical aside) ",
                replace: "",
                context_before: "quick ",
                context_after: "brown",
            },
        ],
    },
    {
        // 20-windows-backslash-paths: backslash ZIP paths, exercises getZipEntry fallback
        name: "20-windows-backslash-paths",
        edits: [
            {
                find: "brown",
                replace: "red",
                context_before: "quick ",
                context_after: " fox",
            },
        ],
    },
];

describe("docxTrackedChanges round-trip", () => {
    for (const { name, edits } of FIXTURES) {
        it(`reject restores original text: ${name}`, async () => {
            const originalBytes = loadFixture(name);
            const originalText = await extractDocxBodyText(originalBytes);

            const { bytes: editedBytes, changes, errors } = await applyTrackedEdits(
                originalBytes,
                edits,
            );
            expect(errors).toHaveLength(0);
            expect(changes.length).toBeGreaterThan(0);

            // Accepted-view of editedBytes = new text (w:ins included, w:del excluded)
            const acceptedViewText = await extractDocxBodyText(editedBytes);
            expect(acceptedViewText).not.toBe(originalText);

            if (changes.length === 1) {
                // Single change: independent resolve pattern (Wave 1 pattern).
                const change = changes[0];
                const wIds = [change.delId, change.insId].filter(Boolean) as string[];

                // Reject: restore original (w:ins removed, w:del content restored)
                const { bytes: rejected } = await resolveTrackedChange(editedBytes, wIds, "reject");
                expect(await extractDocxBodyText(rejected)).toBe(originalText);

                // Accept: make the accepted-view permanent (w:del removed, w:ins content kept)
                const { bytes: accepted } = await resolveTrackedChange(editedBytes, wIds, "accept");
                expect(await extractDocxBodyText(accepted)).toBe(acceptedViewText);
            } else {
                // Multiple changes: sequential resolve pattern.
                // Reject all changes sequentially — final result must equal originalText.
                let rejectCursor = editedBytes;
                for (const change of changes) {
                    const wIds = [change.delId, change.insId].filter(Boolean) as string[];
                    const { bytes: next } = await resolveTrackedChange(rejectCursor, wIds, "reject");
                    rejectCursor = next;
                }
                expect(await extractDocxBodyText(rejectCursor)).toBe(originalText);

                // Accept all changes sequentially — verify wrappers were actually collapsed.
                // Using toContain/not.toContain against the edits array gives an independent
                // baseline: acceptedViewText was computed from editedBytes (which still has
                // w:ins/w:del wrappers), so comparing against it does not prove resolution
                // actually stripped those wrappers.
                let acceptCursor = editedBytes;
                for (const change of changes) {
                    const wIds = [change.delId, change.insId].filter(Boolean) as string[];
                    const { bytes: next } = await resolveTrackedChange(acceptCursor, wIds, "accept");
                    acceptCursor = next;
                }
                const finalAcceptedText = await extractDocxBodyText(acceptCursor);
                // Each replacement phrase must appear in the final text.
                for (const edit of edits) {
                    if (edit.replace) {
                        expect(finalAcceptedText).toContain(edit.replace);
                    }
                }
                // Each original phrase (when distinct from its replacement) must NOT appear.
                for (const edit of edits) {
                    if (edit.find && edit.replace !== edit.find) {
                        expect(finalAcceptedText).not.toContain(edit.find);
                    }
                }
            }
        });
    }
});

describe("docxTrackedChanges special cases", () => {
    it("17-overlapping-edit-error: second overlapping edit returns errors", async () => {
        const bytes = loadFixture("17-overlapping-edit-error");
        const { errors } = await applyTrackedEdits(bytes, [
            { find: "brown fox", replace: "red dog", context_before: "quick ", context_after: " jumps" },
            { find: "fox jumps", replace: "cat runs", context_before: "brown ", context_after: " over" },
        ]);
        expect(errors.length).toBeGreaterThan(0);
        expect(errors[errors.length - 1].reason).toMatch(/overlap/i);
    });

    it("08-nested-sdt: edits inside w:sdtContent succeed", async () => {
        const bytes = loadFixture("08-nested-sdt");
        const original = await extractDocxBodyText(bytes);
        const { bytes: editedBytes, changes, errors } = await applyTrackedEdits(bytes, [
            { find: "brown", replace: "red", context_before: "quick ", context_after: " fox" },
        ]);
        expect(errors).toHaveLength(0);
        expect(changes.length).toBeGreaterThan(0);

        // Reject all sequentially — final result must restore original text.
        let rejectCursor = editedBytes;
        for (const change of changes) {
            const wIds = [change.delId, change.insId].filter(Boolean) as string[];
            const { bytes: next } = await resolveTrackedChange(rejectCursor, wIds, "reject");
            rejectCursor = next;
        }
        expect(await extractDocxBodyText(rejectCursor)).toBe(original);

        // Accept all sequentially — result must contain each replacement phrase.
        let acceptCursor = editedBytes;
        for (const change of changes) {
            const wIds = [change.delId, change.insId].filter(Boolean) as string[];
            const { bytes: next } = await resolveTrackedChange(acceptCursor, wIds, "accept");
            acceptCursor = next;
        }
        expect(await extractDocxBodyText(acceptCursor)).toContain("red");
        expect(await extractDocxBodyText(acceptCursor)).not.toContain("brown");
    });

    // Pitfall 6: pre-existing tracked-change wrappers — extractDocxBodyText
    // returns the ACCEPTED VIEW (w:ins kept, w:del omitted) of the original.
    // Our baseline IS that accepted view, so the standard round-trip assertion
    // is correct as long as we compute originalText from extractDocxBodyText.
    it.each(["09-preexisting-ins", "10-preexisting-del"])(
        "%s: round-trip preserves accepted view",
        async (name) => {
            const bytes = loadFixture(name);
            const baselineAcceptedView = await extractDocxBodyText(bytes);
            const { bytes: editedBytes, changes, errors } = await applyTrackedEdits(bytes, [
                { find: "after", replace: "AFTER", context_before: "", context_after: "" },
            ]);
            expect(errors).toHaveLength(0);
            expect(changes.length).toBeGreaterThan(0);

            // Reject all sequentially — final result must match the pre-edit accepted view.
            let rejectCursor = editedBytes;
            for (const change of changes) {
                const wIds = [change.delId, change.insId].filter(Boolean) as string[];
                const { bytes: next } = await resolveTrackedChange(rejectCursor, wIds, "reject");
                rejectCursor = next;
            }
            expect(await extractDocxBodyText(rejectCursor)).toBe(baselineAcceptedView);

            // Accept all sequentially — result must contain the replacement phrase.
            let acceptCursor = editedBytes;
            for (const change of changes) {
                const wIds = [change.delId, change.insId].filter(Boolean) as string[];
                const { bytes: next } = await resolveTrackedChange(acceptCursor, wIds, "accept");
                acceptCursor = next;
            }
            expect(await extractDocxBodyText(acceptCursor)).toContain("AFTER");
            expect(await extractDocxBodyText(acceptCursor)).not.toContain("after");
        },
    );
});
