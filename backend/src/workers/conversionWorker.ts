import { Worker, type Job } from "bullmq";
import { getRedisConnection } from "../lib/queue/connection";
import { reportError } from "../lib/observability/sentry";
import {
    CONVERSION_QUEUE,
    type ConversionJobData,
} from "../lib/queue/conversionQueue";
import { downloadFile, uploadFile } from "../lib/storage";
import { docxToPdf, convertedPdfKey } from "../lib/convert";
import { createServerSupabase } from "../lib/supabase";

type Db = ReturnType<typeof createServerSupabase>;

/**
 * Convert one uploaded DOCX/DOC to PDF and finalize the document.
 *
 * Extracted from the worker callback so it can be unit-tested with injected
 * deps. Mirrors the synchronous upload path's semantics: a *conversion*
 * failure is non-fatal — the document is still usable (just without a PDF
 * rendition), so we still flip it to "ready".
 *
 * WHAT IS AND IS NOT SWALLOWED. Exactly one thing is non-fatal: LibreOffice
 * failing to render the document. Everything else — a missing original, a
 * failed upload of the rendition, a failed database write — is thrown, because
 * those are the failures a retry can actually fix, and a retry budget only
 * protects the code it wraps. The earlier shape put the upload and both
 * updates inside the conversion try/catch and ignored the updates' `error`
 * field, so a storage blip or a DB hiccup was logged as "DOCX→PDF failed" and
 * the job reported success: no rendition, no retry, and (on the initial-upload
 * flow) a document flipped to "ready" that would never get its PDF.
 */
export async function runConversionJob(
    data: ConversionJobData,
    db: Db = createServerSupabase(),
): Promise<void> {
    const { documentId, versionId, userId, storagePath } = data;
    const finalize = data.finalizeDocumentStatus !== false;

    const original = await downloadFile(storagePath);
    if (!original) {
        // Transient (eventual-consistency) or a real miss — let BullMQ retry.
        throw new Error(
            `[conversion-worker] original not found at ${storagePath}`,
        );
    }

    let pdfBuf: Buffer | null = null;
    try {
        pdfBuf = await docxToPdf(Buffer.from(original));
    } catch (err) {
        // Conversion failure is non-fatal (mirrors the sync path): the version
        // stays usable without a PDF rendition. Retrying LibreOffice on the
        // same bytes just fails the same way.
        reportError(err, {
            level: "warning",
            tags: { component: "conversion-worker", stage: "docx-to-pdf" },
            extra: { document_id: documentId, version_id: versionId },
            fingerprint: ["conversion-worker-docx-to-pdf"],
        });
        console.error(
            "[conversion-worker] DOCX→PDF failed; finalizing without a PDF rendition",
            { err, documentId, versionId },
        );
    }

    if (pdfBuf) {
        const pdfKey = data.pdfKey ?? convertedPdfKey(userId, documentId);
        await uploadFile(
            pdfKey,
            pdfBuf.buffer.slice(
                pdfBuf.byteOffset,
                pdfBuf.byteOffset + pdfBuf.byteLength,
            ) as ArrayBuffer,
            "application/pdf",
        );
        // Fenced on the storage key this job converted. Replace-file reuses
        // the versionId, so two conversions of one version can be in flight;
        // whichever finishes last would otherwise win, and that can be the
        // one holding the OLDER bytes. Matching on storage_path means a job
        // whose source is no longer the version's current file writes nothing
        // (zero rows matched is not an error — it is the point).
        const { error } = await db
            .from("document_versions")
            .update({ pdf_storage_path: pdfKey })
            .eq("id", versionId)
            .eq("storage_path", storagePath);
        if (error)
            throw new Error(
                `[conversion-worker] version rendition update failed: ${error.message}`,
            );
    }

    // Only the initial-upload flow (finalize) has a document parked
    // "processing" waiting on this job.
    if (finalize) {
        const { error } = await db
            .from("documents")
            .update({
                status: "ready",
                updated_at: new Date().toISOString(),
            })
            .eq("id", documentId);
        if (error)
            throw new Error(
                `[conversion-worker] document finalize failed: ${error.message}`,
            );
    }
    if (pdfBuf)
        console.log("[conversion-worker] converted", { documentId, versionId });
}

/**
 * Move a document to a terminal status (e.g. "error"). Extracted so the
 * permanent-failure path is unit-testable without a live queue/Redis.
 */
export async function setDocumentTerminalStatus(
    db: Db,
    documentId: string,
    status: string,
): Promise<void> {
    await db
        .from("documents")
        .update({ status, updated_at: new Date().toISOString() })
        .eq("id", documentId);
}

/** True once a job has exhausted its retries (BullMQ 'failed', no attempts left). */
export function isPermanentFailure(job: Job<ConversionJobData>): boolean {
    const maxAttempts = job.opts.attempts ?? 1;
    return job.attemptsMade >= maxAttempts;
}

let worker: Worker<ConversionJobData> | null = null;

export function createConversionWorker(): Worker<ConversionJobData> {
    if (worker) return worker;
    worker = new Worker<ConversionJobData>(
        CONVERSION_QUEUE,
        async (job: Job<ConversionJobData>) => {
            await runConversionJob(job.data);
        },
        {
            connection: getRedisConnection(),
            concurrency: 2,
            // Recover jobs orphaned by a worker crash mid-run: re-queue a job
            // whose lock hasn't been renewed within stalledInterval, up to
            // maxStalledCount times before it's failed for good.
            stalledInterval: 30_000,
            maxStalledCount: 2,
        },
    );
    worker.on("stalled", (jobId) => {
        console.warn(
            "[conversion-worker] job stalled; will be re-queued",
            { jobId },
        );
    });
    worker.on("failed", async (job, err) => {
        const permanent = !!job && isPermanentFailure(job);
        reportError(err, {
            level: permanent ? "error" : "warning",
            tags: {
                component: "conversion-worker",
                terminal: permanent,
                attempt: job?.attemptsMade,
            },
            extra: {
                job_id: job?.id,
                document_id: job?.data.documentId,
                version_id: job?.data.versionId,
            },
        });
        if (!job) {
            console.error("[conversion-worker] job failed (no job)", { err });
            return;
        }
        if (!permanent) {
            console.error(
                "[conversion-worker] job failed (will retry, attempts remain)",
                { jobId: job.id, err },
            );
            return;
        }
        // Retries exhausted. For the initial-upload flow the document is stuck
        // "processing" with no path forward — surface it as a terminal
        // "error". Version flows (finalizeDocumentStatus: false) belong to an
        // already-healthy document: the version simply keeps no rendition.
        if (job.data.finalizeDocumentStatus === false) {
            console.error(
                "[conversion-worker] version rendition permanently failed; document left untouched",
                { jobId: job.id, versionId: job.data.versionId, err },
            );
            return;
        }
        console.error(
            "[conversion-worker] job permanently failed; marking document error",
            { jobId: job.id, documentId: job.data.documentId, err },
        );
        try {
            await setDocumentTerminalStatus(
                createServerSupabase(),
                job.data.documentId,
                "error",
            );
        } catch (updateErr) {
            console.error(
                "[conversion-worker] failed to mark document error",
                { jobId: job.id, documentId: job.data.documentId, updateErr },
            );
        }
    });
    return worker;
}

export async function stopConversionWorker(): Promise<void> {
    if (worker) {
        await worker.close();
        worker = null;
    }
}
