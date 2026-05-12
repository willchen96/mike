/**
 * DOCX tracked-changes helpers using the docx-track-changes library.
 *
 * Paragraphs are addressed by stable IDs (e.g., "body:ABC123") which are shown
 * when reading documents and used to target edits precisely.
 */

import {
    loadTrackable,
    type Edit,
    type ContentRun,
    type EditResult,
    type AppliedEdit,
    type TrackedChange,
} from "docx-track-changes";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type EditType =
    | "replaceText"
    | "replaceParagraph"
    | "deleteParagraph"
    | "insertAfter"
    | "insertBefore";

export interface EditInput {
    type: EditType;
    paraId: string;
    find?: string;
    replace?: string;
    content?: ContentRun[];
    occurrence?: number;
    all?: boolean;
    reason?: string;
}

export interface AppliedChange {
    id: string;
    delId?: string;
    insId?: string;
    deletedText: string;
    insertedText: string;
    reason?: string;
}

export interface EditError {
    index: number;
    reason: string;
}

export interface ApplyTrackedEditsResult {
    bytes: Buffer;
    changes: AppliedChange[];
    errors: EditError[];
}

// ---------------------------------------------------------------------------
// Text extraction
// ---------------------------------------------------------------------------

export interface ExtractWithIdsResult {
    text: string;
    /** Document bytes with minted paragraph IDs - must be saved for stable IDs */
    bytes: Buffer;
}

/**
 * Extract the body text of a .docx with paragraph IDs for LLM consumption.
 * Output format: "[body:ABC123] First paragraph text.\n[body:DEF456] Second paragraph..."
 *
 * IMPORTANT: The returned `bytes` contain minted paragraph IDs and must be
 * saved back to storage. Otherwise, IDs will change on next load.
 */
export async function extractDocxWithParagraphIds(bytes: Buffer): Promise<ExtractWithIdsResult> {
    const doc = await loadTrackable(bytes);
    const text = doc.body.map((p) => `[${p.id}] ${p.text}`).join("\n");
    const mintedBytes = await doc.getBuffer();
    return { text, bytes: mintedBytes };
}

/**
 * Extract the body text of a .docx as plain text.
 * Paragraphs are joined by a single newline.
 */
export async function extractDocxBodyText(bytes: Buffer): Promise<string> {
    const doc = await loadTrackable(bytes);
    return doc.getText();
}

// ---------------------------------------------------------------------------
// Apply tracked edits
// ---------------------------------------------------------------------------

export async function applyTrackedEdits(
    bytes: Buffer,
    edits: EditInput[],
    opts?: { author?: string },
): Promise<ApplyTrackedEditsResult> {
    let doc;
    try {
        doc = await loadTrackable(bytes);
    } catch (err) {
        return {
            bytes,
            changes: [],
            errors: [{ index: -1, reason: `Failed to load document: ${err}` }],
        };
    }

    const author = opts?.author ?? "Mike";

    // Capture original paragraph text before any modifications
    const originalText = new Map<string, string>();
    const validParaIds = new Set<string>();
    for (const p of doc.paragraphs) {
        originalText.set(p.id, p.text);
        validParaIds.add(p.id);
    }

    // Convert and validate inputs
    const { libraryEdits, indexMap, validationErrors } = convertEdits(edits, validParaIds);

    if (libraryEdits.length === 0) {
        return { bytes, changes: [], errors: validationErrors };
    }

    // Apply edits
    let result;
    try {
        result = await doc.applyTrackedEdits(libraryEdits, {
            author,
            continueOnError: true,
        });
    } catch (err) {
        return {
            bytes,
            changes: [],
            errors: [{ index: -1, reason: `Failed to apply edits: ${err}` }],
        };
    }

    // Get tracked changes from the result to properly identify del vs ins IDs
    // (the library doesn't guarantee order in changeIds, so we look up by ID)
    const trackedChangesMap = new Map<string, TrackedChange>();
    for (const tc of doc.getTrackedChanges()) {
        trackedChangesMap.set(tc.id, tc);
    }

    // Build response
    const changes = buildChanges(result, edits, indexMap, originalText, trackedChangesMap);
    const errors = [
        ...validationErrors,
        ...buildErrors(result, indexMap),
    ];

    return { bytes: result.buffer, changes, errors };
}

interface ConvertResult {
    libraryEdits: Edit[];
    indexMap: Map<Edit, number>;
    validationErrors: EditError[];
}

function convertEdits(edits: EditInput[], validParaIds: Set<string>): ConvertResult {
    const libraryEdits: Edit[] = [];
    const indexMap = new Map<Edit, number>();
    const validationErrors: EditError[] = [];

    for (let i = 0; i < edits.length; i++) {
        const e = edits[i];
        const error = validateEdit(e, validParaIds);
        if (error) {
            validationErrors.push({ index: i, reason: error });
            continue;
        }

        const libEdit = toLibraryEdit(e);
        if (libEdit) {
            libraryEdits.push(libEdit);
            indexMap.set(libEdit, i);
        }
    }

    return { libraryEdits, indexMap, validationErrors };
}

function validateEdit(e: EditInput, validParaIds: Set<string>): string | null {
    if (!e.paraId) return "paraId is required.";
    if (!validParaIds.has(e.paraId)) {
        return `Invalid paraId "${e.paraId}". Use read_document to see valid paragraph IDs.`;
    }

    switch (e.type) {
        case "replaceText":
            if (e.find === undefined) return "find is required for replaceText.";
            break;
        case "replaceParagraph":
        case "insertAfter":
        case "insertBefore":
            if (!e.content?.length) return `content is required for ${e.type}.`;
            break;
        case "deleteParagraph":
            break;
        default:
            return `Unknown edit type: ${e.type}`;
    }

    return null;
}

function toLibraryEdit(e: EditInput): Edit | null {
    switch (e.type) {
        case "replaceText":
            return {
                type: "replaceText",
                paraId: e.paraId,
                find: e.find!,
                replace: e.replace ?? "",
                occurrence: e.occurrence,
                all: e.all,
            };
        case "replaceParagraph":
            return {
                type: "replaceParagraph",
                paraId: e.paraId,
                content: e.content!,
            };
        case "deleteParagraph":
            return {
                type: "deleteParagraph",
                paraId: e.paraId,
            };
        case "insertAfter":
            return {
                type: "insertAfter",
                paraId: e.paraId,
                content: e.content!,
            };
        case "insertBefore":
            return {
                type: "insertBefore",
                paraId: e.paraId,
                content: e.content!,
            };
        default:
            return null;
    }
}

function buildChanges(
    result: EditResult,
    inputs: EditInput[],
    indexMap: Map<Edit, number>,
    originalText: Map<string, string>,
    trackedChangesMap: Map<string, TrackedChange>,
): AppliedChange[] {
    return result.applied.map((applied) => {
        const inputIdx = indexMap.get(applied.edit) ?? -1;
        const input = inputIdx >= 0 ? inputs[inputIdx] : undefined;
        const { deletedText, insertedText, delId, insId } = extractChangeDetails(
            applied,
            originalText,
            trackedChangesMap,
        );

        return {
            id: `edit-${inputIdx}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            delId,
            insId,
            deletedText,
            insertedText,
            reason: input?.reason,
        };
    });
}

/**
 * Identify del and ins IDs from changeIds by looking up their types in trackedChangesMap.
 * This is more robust than assuming a specific order in the changeIds array.
 */
function identifyChangeIds(
    changeIds: string[],
    trackedChangesMap: Map<string, TrackedChange>,
): { delId?: string; insId?: string } {
    let delId: string | undefined;
    let insId: string | undefined;

    for (const id of changeIds) {
        const tc = trackedChangesMap.get(id);
        if (!tc) continue;
        if (tc.type === "deletion" && !delId) {
            delId = id;
        } else if (tc.type === "insertion" && !insId) {
            insId = id;
        }
    }

    return { delId, insId };
}

function extractChangeDetails(
    applied: AppliedEdit,
    originalText: Map<string, string>,
    trackedChangesMap: Map<string, TrackedChange>,
): { deletedText: string; insertedText: string; delId?: string; insId?: string } {
    const edit = applied.edit;
    const ids = applied.changeIds;

    // Use the tracked changes map to correctly identify del vs ins IDs
    const { delId, insId } = identifyChangeIds(ids, trackedChangesMap);

    switch (edit.type) {
        case "replaceText":
            return {
                deletedText: edit.find,
                insertedText: edit.replace,
                delId,
                insId,
            };
        case "replaceParagraph":
            return {
                deletedText: originalText.get(edit.paraId) ?? "",
                insertedText: contentToText(edit.content),
                delId,
                insId,
            };
        case "deleteParagraph":
            return {
                deletedText: originalText.get(edit.paraId) ?? "",
                insertedText: "",
                delId,
                insId: undefined,
            };
        case "insertAfter":
        case "insertBefore":
            return {
                deletedText: "",
                insertedText: contentToText(edit.content),
                delId: undefined,
                insId,
            };
        default:
            return { deletedText: "", insertedText: "" };
    }
}

function contentToText(content: ContentRun[]): string {
    return content.map((c) => (typeof c === "string" ? c : c.text)).join("");
}

function buildErrors(result: EditResult, indexMap: Map<Edit, number>): EditError[] {
    return result.failed.map((f) => ({
        index: indexMap.get(f.edit) ?? -1,
        reason: f.reason,
    }));
}

// ---------------------------------------------------------------------------
// Extract tracked change IDs
// ---------------------------------------------------------------------------

/**
 * Return all tracked change IDs with their text content.
 * Used by the frontend to map rendered <ins>/<del> elements to w:id values.
 * Includes text so frontend can match by content (more reliable than index order).
 */
export async function extractTrackedChangeIds(
    bytes: Buffer,
): Promise<{ kind: "ins" | "del"; w_id: string; text: string }[]> {
    const doc = await loadTrackable(bytes);
    return doc.getTrackedChanges().map((c) => ({
        kind: c.type === "insertion" ? "ins" : "del",
        w_id: c.id,
        text: c.text,
    }));
}

// ---------------------------------------------------------------------------
// Resolve tracked changes (accept/reject)
// ---------------------------------------------------------------------------

export async function resolveTrackedChange(
    bytes: Buffer,
    changeIds: string[],
    mode: "accept" | "reject",
): Promise<{ bytes: Buffer; found: boolean }> {
    const doc = await loadTrackable(bytes);
    const existingIds = new Set(doc.getTrackedChanges().map((c) => c.id));
    const matchedIds = changeIds.filter((id) => existingIds.has(id));

    if (matchedIds.length === 0) {
        return { bytes: await doc.getBuffer(), found: false };
    }

    const result = await doc.resolveChanges(
        matchedIds.map((changeId) => ({ changeId, action: mode })),
    );

    return { bytes: result.buffer, found: true };
}
