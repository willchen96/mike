/**
 * edit_document tool runner + supporting helpers.
 *
 * loadCurrentVersionBytes — resolves the active .docx bytes for a document,
 * preferring the tracked-changes version if one exists.
 *
 * runEditDocument — applies tracked-change edits to a DOCX, writes the new
 * version to R2, records the document_versions row, persists document_edits
 * rows, and returns the result shape with EditAnnotation[] for the stream layer.
 */

import { randomUUID } from "crypto";
import {
    deleteFile,
    downloadFile,
    uploadFile,
} from "../../storage";
import { createServerSupabase } from "../../supabase";
import {
    applyTrackedEdits,
    type EditInput,
} from "../../docxTrackedChanges";
import { buildDownloadUrl } from "../../downloadTokens";
import { loadActiveVersion } from "../../documentVersions";
import type { EditAnnotation } from "../types";
import { insertVersionWithRetry } from "../../../routes/documents";
import { logger } from "../../logger";

// ---------------------------------------------------------------------------
// loadCurrentVersionBytes (also used by read-document.ts)
// ---------------------------------------------------------------------------

/**
 * Resolve the current .docx bytes for a document, preferring the active
 * tracked-changes version if one exists, else the original upload.
 */
export async function loadCurrentVersionBytes(
    documentId: string,
    db: ReturnType<typeof createServerSupabase>,
): Promise<{ bytes: Buffer; storage_path: string } | null> {
    const active = await loadActiveVersion(documentId, db);
    if (!active) return null;
    const raw = await downloadFile(active.storage_path);
    if (!raw) return null;
    return { bytes: Buffer.from(raw), storage_path: active.storage_path };
}

// ---------------------------------------------------------------------------
// runEditDocument
// ---------------------------------------------------------------------------

export async function runEditDocument(params: {
    documentId: string;
    userId: string;
    edits: EditInput[];
    db: ReturnType<typeof createServerSupabase>;
    /**
     * If provided, append these edits to the existing turn-scoped version
     * (overwrites the file at storagePath and reuses the document_versions
     * row) instead of creating a new version. Used to collapse multiple
     * edit_document tool calls within a single assistant turn into one
     * version.
     */
    reuseVersion?: {
        versionId: string;
        versionNumber: number;
        storagePath: string;
    };
}): Promise<
    | {
          ok: true;
          version_id: string;
          version_number: number;
          storage_path: string;
          download_url: string;
          annotations: EditAnnotation[];
          errors: { index: number; reason: string }[];
      }
    | { ok: false; error: string }
> {
    const { documentId, userId, edits, db, reuseVersion } = params;

    const { data: doc } = await db
        .from("documents")
        .select("id, filename")
        .eq("id", documentId)
        .single();
    if (!doc) return { ok: false, error: "Document not found." };

    const current = await loadCurrentVersionBytes(documentId, db);
    if (!current) return { ok: false, error: "Could not load document bytes." };

    const { bytes: editedBytes, changes, errors } = await applyTrackedEdits(
        current.bytes,
        edits,
        { author: "Mike" },
    );

    if (changes.length === 0) {
        return {
            ok: false,
            error:
                errors[0]?.reason ??
                "No edits could be applied. Refine context_before/context_after and retry.",
        };
    }

    const ab = editedBytes.buffer.slice(
        editedBytes.byteOffset,
        editedBytes.byteOffset + editedBytes.byteLength,
    ) as ArrayBuffer;

    let versionRowId: string;
    let newPath: string;
    let nextVersionNumber: number;

    if (reuseVersion) {
        // Overwrite the existing turn version's file in place. The version
        // row, version_number, and current_version_id all already point here.
        // NOTE: `uploadFile` is intentionally deferred until after the
        // `document_edits` insert below succeeds, so that a DB failure does
        // not leave R2 holding bytes whose change history was never
        // recorded (storage / DB divergence).
        newPath = reuseVersion.storagePath;
        versionRowId = reuseVersion.versionId;
        nextVersionNumber = reuseVersion.versionNumber;
    } else {
        const versionId = randomUUID().replace(/-/g, "");
        newPath = `documents/${userId}/${documentId}/edits/${versionId}.docx`;
        await uploadFile(
            newPath,
            ab,
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        );

        // Inherit the display name from the most recent prior version so
        // user-applied renames carry forward through further edits. Falls
        // back to the parent document's filename when no prior version has
        // a display name (e.g. the first assistant edit of a pre-existing
        // doc). We intentionally do NOT append "[Edited Vn]" — the version
        // number is surfaced separately as a tag in the UI.
        const { data: prevRow } = await db
            .from("document_versions")
            .select("display_name, created_at")
            .eq("document_id", documentId)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();
        const inheritedDisplayName =
            (prevRow?.display_name as string | null) ??
            (doc.filename as string | null) ??
            null;

        // insertVersionWithRetry handles 23505 unique_violation races (CLEAN-08).
        // It fetches MAX(version_number)+1 and retries once on collision so
        // concurrent assistant_edit calls cannot assign the same version_number.
        const { data: versionRow, error: verErr } = await insertVersionWithRetry(db, documentId, {
            document_id: documentId,
            storage_path: newPath,
            source: "assistant_edit",
            display_name: inheritedDisplayName,
        });
        if (verErr || !versionRow) {
            return { ok: false, error: "Failed to record document version." };
        }
        versionRowId = versionRow.id as string;
        nextVersionNumber = versionRow.version_number;
    }

    // Insert one row per change
    const editRows = changes.map((c) => ({
        document_id: documentId,
        version_id: versionRowId,
        change_id: c.id,
        del_w_id: c.delId ?? null,
        ins_w_id: c.insId ?? null,
        deleted_text: c.deletedText,
        inserted_text: c.insertedText,
        context_before: c.contextBefore ?? "",
        context_after: c.contextAfter ?? "",
        status: "pending" as const,
    }));
    const { data: insertedEdits, error: editsErr } = await db
        .from("document_edits")
        .insert(editRows)
        .select("id, change_id, del_w_id, ins_w_id, deleted_text, inserted_text, context_before, context_after");

    if (editsErr || !insertedEdits) {
        if (!reuseVersion) {
            // Compensating cleanup: the document_edits insert failed after
            // R2 write + document_versions insert succeeded. Delete both to
            // prevent permanent orphans (CR-01).
            await deleteFile(newPath).catch((e: unknown) =>
                logger.error({ err: e }, "[edit-document] compensating R2 delete failed"),
            );
            const { error: vDelErr } = await db
                .from("document_versions")
                .delete()
                .eq("id", versionRowId);
            if (vDelErr) {
                logger.error({ err: vDelErr }, "[edit-document] compensating version row delete failed");
            }
        }
        return { ok: false, error: "Failed to record edits." };
    }

    if (reuseVersion) {
        // Deferred from above: only overwrite the in-place R2 bytes once
        // we've successfully recorded the new edits. If the upload fails,
        // applyReuseVersionSaga deletes the inserted document_edits rows
        // (compensating rollback) so storage and the change history stay
        // consistent on partial failure (CLEAN-16).
        const insertedEditIds = (insertedEdits ?? []).map(
            (r: { id: string }) => r.id,
        );
        const sagaResult = await applyReuseVersionSaga({
            db,
            newPath,
            ab,
            mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            insertedEditIds,
        });
        if (!sagaResult.ok) {
            return { ok: false, error: sagaResult.error };
        }
    }

    await db
        .from("documents")
        .update({ current_version_id: versionRowId })
        .eq("id", documentId);

    const annotations: EditAnnotation[] = insertedEdits.map((r: { id: string; change_id: string; deleted_text: string; inserted_text: string; context_before: string | null; context_after: string | null }) => {
        const src = changes.find((c) => c.id === r.change_id);
        return {
            kind: "edit",
            edit_id: r.id,
            document_id: documentId,
            version_id: versionRowId,
            version_number: nextVersionNumber,
            change_id: r.change_id,
            del_w_id: src?.delId,
            ins_w_id: src?.insId,
            deleted_text: r.deleted_text ?? "",
            inserted_text: r.inserted_text ?? "",
            context_before: r.context_before ?? "",
            context_after: r.context_after ?? "",
            reason: src?.reason,
            status: "pending",
        };
    });

    // Persistent, non-expiring permalink. The backend streams fresh bytes
    // on each request, so this URL stays valid as long as the file exists.
    const permalink = buildDownloadUrl(newPath, doc.filename as string);

    return {
        ok: true,
        version_id: versionRowId,
        version_number: nextVersionNumber,
        storage_path: newPath,
        download_url: permalink,
        annotations,
        errors,
    };
}

// ---------------------------------------------------------------------------
// CLEAN-16: reuseVersion compensating saga
// ---------------------------------------------------------------------------

/**
 * Deferred upload guard for the reuseVersion path of runEditDocument.
 *
 * After the document_edits rows have been inserted, this helper attempts the
 * in-place R2 overwrite. On failure it deletes the inserted rows (compensating
 * rollback) so the DB never carries document_edits that reference bytes which
 * were never written.
 *
 * Returns `{ ok: true }` on success or `{ ok: false, error }` on any storage
 * failure. The caller must NOT update documents.current_version_id on failure.
 */
export async function applyReuseVersionSaga(deps: {
    db: ReturnType<typeof createServerSupabase>;
    newPath: string;
    ab: ArrayBuffer;
    mime: string;
    insertedEditIds: string[];
}): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
        await uploadFile(deps.newPath, deps.ab, deps.mime);
        return { ok: true };
    } catch (uploadErr) {
        logger.error({ err: uploadErr }, "[edit-document] reuseVersion upload failed after document_edits insert — compensating delete");
        if (deps.insertedEditIds.length > 0) {
            const { error: delErr } = await deps.db
                .from("document_edits")
                .delete()
                .in("id", deps.insertedEditIds);
            if (delErr) {
                logger.error({ err: delErr }, "[edit-document] CRITICAL: compensating delete of document_edits failed — DB may carry orphaned edits");
            }
        }
        return {
            ok: false,
            error:
                uploadErr instanceof Error
                    ? `Storage write failed: ${uploadErr.message}`
                    : "Storage write failed.",
        };
    }
}
