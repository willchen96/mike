/**
 * read_document tool runner.
 *
 * Reads a document from R2 (preferring the current tracked-changes version)
 * and returns its text content. Emits doc_read_start / doc_read SSE events
 * unless opts.emitEvents is false (used internally by find_in_document to
 * suppress duplicate UI blocks).
 *
 * Verbose tracing (storage paths, magic bytes, intermediate extraction
 * lengths) is gated behind the DEBUG_CHATTOOLS env var so production logs
 * don't leak document metadata or content. Per CLAUDE.md privacy policy,
 * document body text MUST NOT appear in logs — the DONE log emits only
 * filename + final length.
 */

import { downloadFile } from "../../storage";
import { extractDocxBodyText } from "../../docxTrackedChanges";
import { createServerSupabase } from "../../supabase";
import type { DocStore, DocIndex } from "../types";
import { extractPdfText } from "./_helpers";
import { loadCurrentVersionBytes } from "./edit-document";
import { logger } from "../../logger";

const DEBUG = process.env.DEBUG_CHATTOOLS === "1" || process.env.DEBUG_CHATTOOLS === "true";
function dlog(msg: string, data?: Record<string, unknown>) {
    if (DEBUG) logger.debug(data ?? {}, msg);
}

export async function runReadDocument(args: {
    docLabel: string;
    docStore: DocStore;
    write: (s: string) => void;
    docIndex?: DocIndex;
    db?: ReturnType<typeof createServerSupabase>;
    opts?: { emitEvents?: boolean };
}): Promise<string> {
    const { docLabel, docStore, write, docIndex, db, opts } = args;
    const emitEvents = opts?.emitEvents ?? true;
    dlog(`[read_document] called with docLabel="${docLabel}"`);
    const docInfo = docStore.get(docLabel);
    if (!docInfo) {
        dlog(
            `[read_document] MISS — docLabel "${docLabel}" not in docStore`,
            { knownLabels: Array.from(docStore.keys()) },
        );
        return "Document not found.";
    }
    dlog(
        `[read_document] docInfo: filename="${docInfo.filename}", file_type="${docInfo.file_type}", storage_path="${docInfo.storage_path}"`,
    );

    const documentId = docIndex?.[docLabel]?.document_id;
    const emitDocRead = () => {
        if (!emitEvents) return;
        write(
            `data: ${JSON.stringify({
                type: "doc_read",
                filename: docInfo.filename,
                document_id: documentId,
            })}\n\n`,
        );
    };
    if (emitEvents)
        write(
            `data: ${JSON.stringify({
                type: "doc_read_start",
                filename: docInfo.filename,
                document_id: documentId,
            })}\n\n`,
        );
    try {
        // Prefer the current tracked-changes version (if any) so read_document
        // reflects accepted/pending edits rather than the original upload.
        let raw: ArrayBuffer | null = null;
        let sourcePath = docInfo.storage_path;
        if (documentId && db) {
            const current = await loadCurrentVersionBytes(documentId, db);
            if (current) {
                raw = current.bytes.buffer.slice(
                    current.bytes.byteOffset,
                    current.bytes.byteOffset + current.bytes.byteLength,
                ) as ArrayBuffer;
                sourcePath = current.storage_path;
                dlog(
                    `[read_document] using current version path="${sourcePath}" (bytes=${raw.byteLength})`,
                );
            } else {
                dlog(
                    `[read_document] loadCurrentVersionBytes returned null for documentId="${documentId}", falling back to original storage_path`,
                );
            }
        }
        if (!raw) {
            raw = await downloadFile(docInfo.storage_path);
            if (raw) {
                dlog(
                    `[read_document] fallback download from storage_path="${docInfo.storage_path}" (bytes=${raw.byteLength})`,
                );
            }
        }
        if (!raw) {
            logger.error({ filename: docInfo.filename }, "[read_document] failed to download bytes");
            emitDocRead();
            return "Document could not be read.";
        }
        // Log the first 8 bytes so we can identify real file format regardless
        // of the declared file_type. Valid .docx starts with "PK\x03\x04"
        // (zip). Legacy .doc starts with "\xD0\xCF\x11\xE0" (OLE/CFB).
        // %PDF-1 is a PDF even if mislabeled. Truncated uploads show as all-zero.
        if (DEBUG) {
            const head = Buffer.from(raw).subarray(0, 8);
            const hex = head.toString("hex");
            const ascii = head
                .toString("binary")
                .replace(/[^\x20-\x7e]/g, ".");
            dlog(
                `[read_document] magic bytes hex=${hex} ascii="${ascii}" for filename="${docInfo.filename}"`,
            );
        }
        let text: string;
        if (docInfo.file_type === "pdf") {
            text = await extractPdfText(raw);
            dlog(
                `[read_document] pdf extracted length=${text.length} for filename="${docInfo.filename}"`,
            );
        } else if (docInfo.file_type === "docx") {
            // Use the same flattening as the edit_document matcher so the
            // LLM sees exactly the characters it can anchor against.
            text = await extractDocxBodyText(Buffer.from(raw));
            dlog(
                `[read_document] docx extractDocxBodyText length=${text.length} for filename="${docInfo.filename}"`,
            );
            if (!text) {
                dlog(
                    `[read_document] docx accepted-view extractor returned empty, falling back to mammoth for filename="${docInfo.filename}"`,
                );
                const mammoth = await import("mammoth");
                const result = await mammoth.extractRawText({
                    buffer: Buffer.from(raw),
                });
                text = result.value;
                dlog(
                    `[read_document] docx mammoth fallback length=${text.length} for filename="${docInfo.filename}"`,
                );
            }
        } else {
            dlog(
                `[read_document] unknown file_type="${docInfo.file_type}" for filename="${docInfo.filename}", trying mammoth`,
            );
            const mammoth = await import("mammoth");
            const result = await mammoth.extractRawText({
                buffer: Buffer.from(raw),
            });
            text = result.value;
            dlog(
                `[read_document] mammoth length=${text.length} for filename="${docInfo.filename}"`,
            );
        }
        // Always-on completion log: filename + final length only.
        // Body text (firstChars slice) is intentionally omitted per
        // CLAUDE.md privacy policy.
        logger.info({ filename: docInfo.filename, length: text.length }, "[read_document] done");
        emitDocRead();
        return text;
    } catch (err) {
        logger.error({ err, filename: docInfo.filename }, "[read_document] threw");
        if (emitEvents)
            write(`data: ${JSON.stringify({ type: "doc_read", filename: docInfo.filename })}\n\n`);
        return "Document could not be read.";
    }
}
