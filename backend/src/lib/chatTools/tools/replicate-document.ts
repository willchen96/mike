/**
 * replicate_document tool runner.
 *
 * Creates N copies of a source document within a project. Each copy gets its
 * own documents row, document_versions row, and storage key. The source bytes
 * (and PDF rendition if any) are fetched once and written in parallel. New
 * copies are registered in the live docIndex / docStore so they can be
 * edited/read in the same assistant turn.
 */

import {
    downloadFile,
    storageKey,
    uploadFile,
} from "../../storage";
import { convertedPdfKey } from "../../convert";
import { createServerSupabase } from "../../supabase";
import { buildDownloadUrl } from "../../downloadTokens";
import { loadActiveVersion } from "../../documentVersions";
import type { DocStore, DocIndex, DocReplicatedResult } from "../types";

export async function runReplicateDocument(args: {
    rawDocId: string;
    requestedFilename: string | null;
    requestedCount: number;
    sourceLabel: string;
    docStore: DocStore;
    docIndex: DocIndex;
    userId: string;
    projectId: string | null | undefined;
    db: ReturnType<typeof createServerSupabase>;
    write: (s: string) => void;
    toolCallId: string;
}): Promise<{ toolResult: unknown; replicated: DocReplicatedResult | null }> {
    const {
        rawDocId,
        requestedFilename,
        requestedCount,
        sourceLabel,
        docStore,
        docIndex,
        userId,
        projectId,
        db,
        write,
        toolCallId,
    } = args;

    const sourceInfo = docStore.get(sourceLabel);
    const sourceIndexed = docIndex[sourceLabel];
    const sourceFilename = sourceInfo?.filename ?? rawDocId;

    write(
        `data: ${JSON.stringify({
            type: "doc_replicate_start",
            filename: sourceFilename,
            count: requestedCount,
        })}\n\n`,
    );

    const fail = (error: string): { toolResult: unknown; replicated: null } => {
        write(
            `data: ${JSON.stringify({
                type: "doc_replicated",
                filename: sourceFilename,
                count: requestedCount,
                copies: [],
                error,
            })}\n\n`,
        );
        return {
            toolResult: {
                role: "tool",
                tool_call_id: toolCallId,
                content: JSON.stringify({ ok: false, error }),
            },
            replicated: null,
        };
    };

    if (!sourceInfo || !sourceIndexed) {
        return fail(`Document '${rawDocId}' not found in this project.`);
    }
    if (!projectId) {
        return fail("replicate_document is only available in project chats.");
    }

    try {
        // Pull the active version once — every copy gets the
        // same starting bytes (with any accepted tracked
        // changes rolled in), no point re-fetching per copy.
        const active = await loadActiveVersion(
            sourceIndexed.document_id,
            db,
        );
        const sourcePath =
            active?.storage_path ?? sourceInfo.storage_path;
        const sourcePdfPath = active?.pdf_storage_path ?? null;
        const raw = await downloadFile(sourcePath);
        const pdfBytes = sourcePdfPath
            ? await downloadFile(sourcePdfPath)
            : null;
        if (!raw) {
            return fail(
                "Could not read the source document's bytes from storage.",
            );
        }

        // Build N filenames. With count=1 keep the
        // pre-existing "(copy)" suffix; with count>1 use
        // numbered "(1)", "(2)" suffixes.
        const srcExt =
            sourceInfo.filename.match(/\.[^./\\]+$/)?.[0] ?? "";
        const baseStem = (() => {
            if (requestedFilename) {
                return requestedFilename.replace(
                    /\.[^./\\]+$/,
                    "",
                );
            }
            return sourceInfo.filename.replace(
                /\.[^./\\]+$/,
                "",
            );
        })();
        const filenames: string[] = [];
        for (let n = 1; n <= requestedCount; n++) {
            const suffix =
                requestedCount === 1
                    ? requestedFilename
                        ? ""
                        : " (copy)"
                    : ` (${n})`;
            filenames.push(`${baseStem}${suffix}${srcExt}`);
        }

        // Bulk insert N documents in one round-trip.
        const docRows = filenames.map((fn) => ({
            project_id: projectId,
            user_id: userId,
            filename: fn,
            file_type: sourceInfo.file_type,
            size_bytes: raw.byteLength,
            status: "ready",
        }));
        const { data: insertedDocs, error: docErr } = await db
            .from("documents")
            .insert(docRows)
            .select("id, filename");
        if (docErr || !insertedDocs || insertedDocs.length === 0) {
            return fail(
                `Failed to record replicated documents: ${docErr?.message ?? "unknown"}`,
            );
        }

        // Preserve the request order so each row pairs
        // with the right filename. Supabase returns
        // inserted rows in the same order as the
        // payload.
        const newDocs = insertedDocs as {
            id: string;
            filename: string;
        }[];
        const contentType =
            sourceInfo.file_type === "pdf"
                ? "application/pdf"
                : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

        // Parallel uploads: the doc bytes (and PDF
        // rendition if any) for every new copy.
        const uploadJobs: Promise<unknown>[] = [];
        const newKeys: string[] = [];
        const newPdfKeys: (string | null)[] = [];
        for (const d of newDocs) {
            const key = storageKey(
                userId,
                d.id,
                d.filename,
            );
            newKeys.push(key);
            uploadJobs.push(
                uploadFile(key, raw, contentType),
            );
            if (pdfBytes) {
                const pdfKey = convertedPdfKey(
                    userId,
                    d.id,
                );
                newPdfKeys.push(pdfKey);
                uploadJobs.push(
                    uploadFile(
                        pdfKey,
                        pdfBytes,
                        "application/pdf",
                    ),
                );
            } else {
                newPdfKeys.push(null);
            }
        }
        await Promise.all(uploadJobs);

        // Bulk insert N versions in one round-trip.
        const versionRows = newDocs.map((d, idx) => ({
            document_id: d.id,
            storage_path: newKeys[idx],
            pdf_storage_path: newPdfKeys[idx],
            source: "upload",
            version_number: 1,
            display_name: d.filename,
        }));
        const { data: insertedVersions, error: verErr } =
            await db
                .from("document_versions")
                .insert(versionRows)
                .select("id, document_id");
        if (
            verErr ||
            !insertedVersions ||
            insertedVersions.length !== newDocs.length
        ) {
            return fail(
                `Failed to record replicated document versions: ${verErr?.message ?? "unknown"}`,
            );
        }

        const versionByDocId = new Map<string, string>();
        for (const v of insertedVersions as {
            id: string;
            document_id: string;
        }[]) {
            versionByDocId.set(v.document_id, v.id);
        }

        // current_version_id has to be a per-row
        // value, so a single UPDATE statement
        // can't cover all N. Fan out in parallel
        // instead of sequential awaits.
        await Promise.all(
            newDocs.map((d) =>
                db
                    .from("documents")
                    .update({
                        current_version_id:
                            versionByDocId.get(d.id),
                    })
                    .eq("id", d.id),
            ),
        );

        // Register every copy under a fresh doc-N
        // slug so the model can edit/read any of
        // them in the same turn.
        const existingLabels = new Set(
            Object.keys(docIndex),
        );
        let nextLabelIdx = 0;
        const copies: {
            new_filename: string;
            document_id: string;
            version_id: string;
        }[] = [];
        const toolPayloadCopies: {
            doc_id: string;
            document_id: string;
            version_id: string;
            filename: string;
            download_url: string;
        }[] = [];
        for (let idx = 0; idx < newDocs.length; idx++) {
            const d = newDocs[idx];
            const newKey = newKeys[idx];
            const versionId = versionByDocId.get(d.id);
            if (!versionId) continue;
            while (
                existingLabels.has(
                    `doc-${nextLabelIdx}`,
                )
            )
                nextLabelIdx++;
            const slug = `doc-${nextLabelIdx}`;
            existingLabels.add(slug);
            docIndex[slug] = {
                document_id: d.id,
                filename: d.filename,
            };
            docStore.set(slug, {
                storage_path: newKey,
                file_type: sourceInfo.file_type,
                filename: d.filename,
            });
            copies.push({
                new_filename: d.filename,
                document_id: d.id,
                version_id: versionId,
            });
            toolPayloadCopies.push({
                doc_id: slug,
                document_id: d.id,
                version_id: versionId,
                filename: d.filename,
                download_url: buildDownloadUrl(
                    newKey,
                    d.filename,
                ),
            });
        }

        write(
            `data: ${JSON.stringify({
                type: "doc_replicated",
                filename: sourceFilename,
                count: copies.length,
                copies,
            })}\n\n`,
        );

        const replicated: DocReplicatedResult = {
            filename: sourceFilename,
            count: copies.length,
            copies,
        };

        return {
            toolResult: {
                role: "tool",
                tool_call_id: toolCallId,
                content: JSON.stringify({
                    ok: true,
                    count: copies.length,
                    copies: toolPayloadCopies,
                }),
            },
            replicated,
        };
    } catch (e) {
        return fail(`replicate_document failed: ${String(e)}`);
    }
}
