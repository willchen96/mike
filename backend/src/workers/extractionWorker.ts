import { Worker, type Job } from "bullmq";
import { getRedisConnection } from "../lib/queue/connection";
import { reportError } from "../lib/observability/sentry";
import {
    EXTRACTION_QUEUE,
    type ExtractionJobData,
} from "../lib/queue/extractionQueue";
import {
    publishCellUpdate as defaultPublish,
    type CellUpdate,
} from "../lib/queue/runProgress";
import {
    extractRowColumns,
    finalizeCell,
} from "../lib/tabular/tabular.extractRow";
import { loadReviewRow } from "../lib/tabular/tabular.rows";
import {
    finishGenerationIfIdle,
    renewGeneration,
    validateSelectedModel,
    TABULAR_GENERATION_HEARTBEAT_MS,
    type Column,
} from "../lib/tabular/tabular.shared";
import { createServerSupabase } from "../lib/supabase";

type Db = ReturnType<typeof createServerSupabase>;

export interface ExtractionDeps {
    db: Db;
    /** Publish a progress frame (injectable so the job is unit-testable). */
    publish: (reviewId: string, update: CellUpdate) => Promise<void>;
}

function defaultDeps(): ExtractionDeps {
    return { db: createServerSupabase(), publish: defaultPublish };
}

/**
 * Extract every not-yet-`done` column for one (review, row) pair.
 *
 * This is the async counterpart of the inline loop that used to live in the
 * POST /:reviewId/generate handler — pulled into a standalone, dependency-
 * injected function so it can run on a worker and be unit-tested without a live
 * queue/Redis.
 *
 * Idempotent + retry-safe: it re-reads current cell state and only processes
 * columns that are not already `done` with content. A retry therefore narrows
 * to the columns still outstanding. If any targeted column fails to come back
 * from the model, the function THROWS so BullMQ retries the job; the permanent-
 * failure handler (below) is what finally marks stragglers `error`.
 *
 * LEASE. The request that enqueued this job claimed the review's generation
 * lease and then handed it over — it cannot hold it, because the work outlives
 * the request. So each running job renews the lease on a heartbeat, and the job
 * that clears the last generation stamp releases it. Cells still queued keep
 * their stamp, so the lease is never released while work remains.
 */
export async function runExtractionJob(
    data: ExtractionJobData,
    deps: ExtractionDeps = defaultDeps(),
): Promise<void> {
    const { reviewId, userId, rowId, generationId, columnIndex } = data;
    const { db, publish } = deps;

    const leaseHeartbeat = generationId
        ? setInterval(() => {
              void renewGeneration(db, reviewId, generationId)
                  .then((held) => {
                      if (!held)
                          console.error(
                              "[extraction-worker] generation lease lost",
                              { reviewId, rowId },
                          );
                  })
                  .catch((err) =>
                      console.error(
                          "[extraction-worker] failed to renew generation lease",
                          { reviewId, rowId, err },
                      ),
                  );
          }, TABULAR_GENERATION_HEARTBEAT_MS)
        : null;
    if (leaseHeartbeat && typeof leaseHeartbeat.unref === "function")
        leaseHeartbeat.unref();

    // Set once this job has nothing left to do for the row (success, or a row/
    // review that vanished) — as opposed to throwing for a retry, where the
    // row's cells must keep their stamp so the lease stays held.
    let settled = false;
    try {
        // 0. Canceled by clear-cells while a previous attempt was active: the
        //    marker is persisted into the job's data, and each retry re-fetches
        //    that data — so this attempt must not re-claim the cleared cells.
        //    It is `settled`, not a retry: the row's cells are the caller's now
        //    (clear-cells blanked them), so this job drops its generation stamp
        //    and lets the lease be released instead of holding it to a timeout.
        if (data.canceled) {
            settled = true;
            return;
        }

        // 1. Columns configured on the review. A single-cell job (regenerate)
        //    narrows to its one column; the cell was already flipped off "done"
        //    by the enqueuing route, so the shared core will re-extract it.
        const { data: review } = await db
            .from("tabular_reviews")
            .select("columns_config, model")
            .eq("id", reviewId)
            .single();
        let columns: Column[] = (review?.columns_config as Column[]) ?? [];
        if (columnIndex != null)
            columns = columns.filter((c) => c.index === columnIndex);
        if (columns.length === 0) {
            settled = true;
            return;
        }

        // 2. The row this job fills (with its source-document ids resolved). A
        //    row deleted between enqueue and run is not an error — nothing to do.
        const row = await loadReviewRow(db, reviewId, rowId);
        if (!row) {
            settled = true;
            return;
        }

        // 3. Current cell state for this row, keyed by column.
        const { data: cells } = await db
            .from("tabular_cells")
            .select("*")
            .eq("review_id", reviewId)
            .eq("row_id", rowId);
        const existingByColumn = new Map<number, Record<string, unknown>>();
        for (const cell of (cells ?? []) as Record<string, unknown>[])
            existingByColumn.set(cell.column_index as number, cell);

        // 4. Model + keys for the owner (never serialized into the job payload).
        //    The model is the REVIEW's — the enqueuing request already validated
        //    it, but a review can be re-pointed (or a key removed) between
        //    enqueue and run, so re-check here rather than extract with a model
        //    the owner may no longer use. Throwing routes the row through the
        //    normal retry/permanent-failure path, which leaves the grid in a
        //    terminal "error" state instead of a spinner.
        const selected = await validateSelectedModel(
            (review as { model?: unknown }).model,
            userId,
            db,
        );
        if (!selected.ok) {
            throw new Error(
                `[extraction-worker] review ${reviewId} model unusable: ` +
                    String(selected.body.detail ?? selected.body.code ?? ""),
            );
        }
        const tabular_model = selected.model;
        const api_keys = selected.apiKeys;

        // 5. Run the shared extraction core; publish transitions over Redis so a
        //    tailing /generate request sees them live. Every cell write is
        //    stamped with — and, once terminal, guarded by — this generation.
        const { processed, missing } = await extractRowColumns({
            db,
            reviewId,
            row,
            columns,
            existingByColumn,
            model: tabular_model,
            apiKeys: api_keys,
            generationId,
            sink: {
                generating: (id, columnIndex) =>
                    publish(reviewId, {
                        type: "cell_update",
                        row_id: id,
                        column_index: columnIndex,
                        content: null,
                        status: "generating",
                    }),
                done: (id, columnIndex, result) =>
                    publish(reviewId, {
                        type: "cell_update",
                        row_id: id,
                        column_index: columnIndex,
                        content: result,
                        status: "done",
                    }),
            },
        });
        if (processed.length === 0) {
            settled = true;
            return;
        }

        // 6. If the model didn't return every column, throw so BullMQ retries
        //    the still-outstanding ones. Cells are left "generating" (still
        //    stamped, so the lease stays held) — the permanent-failure handler
        //    flips the survivors to "error" once retries run out.
        if (missing.length > 0) {
            throw new Error(
                `[extraction-worker] incomplete extraction for row ${rowId}: ` +
                    `missing columns ${missing.join(", ")}`,
            );
        }
        settled = true;
    } finally {
        if (leaseHeartbeat) clearInterval(leaseHeartbeat);
        if (generationId) {
            if (settled)
                await clearRowGenerationStamp(
                    db,
                    reviewId,
                    rowId,
                    generationId,
                    columnIndex,
                );
            await finishGenerationIfIdle(
                db,
                reviewId,
                generationId,
                console,
                "[extraction-worker]",
            );
        }
    }
}

/**
 * Drop this generation's stamp from every cell of a row the job is done with.
 * Terminal writes already clear their own stamp; this catches the cells the job
 * skipped (already `done` when it started), so "no cell carries this generation
 * id" is an exact test for "the run is over".
 *
 * A single-cell job (regenerate) narrows to its own column: it never owned the
 * row's other cells, so it must not un-stamp work that is still outstanding.
 */
async function clearRowGenerationStamp(
    db: Db,
    reviewId: string,
    rowId: string,
    generationId: string,
    columnIndex?: number,
): Promise<void> {
    let query = db
        .from("tabular_cells")
        .update({ generation_id: null })
        .eq("review_id", reviewId)
        .eq("row_id", rowId)
        .eq("generation_id", generationId);
    if (columnIndex != null) query = query.eq("column_index", columnIndex);
    const { error } = await query;
    if (error)
        console.error("[extraction-worker] failed to clear generation stamp", {
            reviewId,
            rowId,
            error,
        });
}

/** True once a job has exhausted its retries (BullMQ 'failed', no attempts left). */
export function isPermanentFailure(job: Job<ExtractionJobData>): boolean {
    const maxAttempts = job.opts.attempts ?? 1;
    return job.attemptsMade >= maxAttempts;
}

/**
 * Terminal cleanup for a permanently failed job: flip every still-unfinished
 * cell for this row to "error" and announce it, so the grid shows a clear
 * terminal state instead of a spinner that never resolves. Extracted so it is
 * unit-testable without a live queue.
 *
 * Cells this job no longer owns are left alone: a *different* stamp means the
 * run that superseded us owns their outcome, and NO stamp means the claim was
 * revoked (clear-cells blanked the row) — the user's reset must win over a late
 * "error". Clearing the stamps here is also what lets the lease be released.
 */
export async function markExtractionFailed(
    data: ExtractionJobData,
    deps: ExtractionDeps = defaultDeps(),
): Promise<void> {
    const { reviewId, rowId, generationId, columnIndex } = data;
    const { db, publish } = deps;

    const { data: cells } = await db
        .from("tabular_cells")
        .select("id, column_index, status, content, generation_id")
        .eq("review_id", reviewId)
        .eq("row_id", rowId);

    for (const cell of (cells ?? []) as Record<string, unknown>[]) {
        // Single-cell jobs only ever own their one column's terminal state.
        if (columnIndex != null && cell.column_index !== columnIndex) continue;
        if (cell.status === "done" && cell.content) continue;
        // Only flip cells this job still OWNS — i.e. that still carry its
        // generation stamp. A different stamp means a newer run superseded us
        // and owns the outcome; NO stamp means the claim was revoked, which is
        // what clear-cells does when it blanks a row (content null, status
        // "pending", generation_id null) while this job was retrying. That
        // reset must win: flipping the cell to "error" here would be a lost
        // update, silently undoing the user's action. The cost is the flagged
        // tradeoff — a job that dies before ever claiming its cells leaves
        // them "pending" rather than "error", a blank re-runnable state rather
        // than a red one.
        if (generationId && cell.generation_id !== generationId) continue;
        await finalizeCell(db, {
            reviewId,
            rowId,
            columnIndex: cell.column_index as number,
            status: "error",
            // Guard with the stamp the cell actually carries: for a leased job
            // that is `generationId` (checked just above); for an unleased one
            // the cell belongs to no run, so guarding at all would match
            // nothing and leave it spinning.
            generationId: (cell.generation_id as string | null) ?? undefined,
        });
        await publish(reviewId, {
            type: "cell_update",
            row_id: rowId,
            column_index: cell.column_index as number,
            content: null,
            status: "error",
        });
    }

    if (generationId) {
        await clearRowGenerationStamp(
            db,
            reviewId,
            rowId,
            generationId,
            columnIndex,
        );
        await finishGenerationIfIdle(
            db,
            reviewId,
            generationId,
            console,
            "[extraction-worker]",
        );
    }
}

let worker: Worker<ExtractionJobData> | null = null;

export function createExtractionWorker(): Worker<ExtractionJobData> {
    if (worker) return worker;
    worker = new Worker<ExtractionJobData>(
        EXTRACTION_QUEUE,
        async (job: Job<ExtractionJobData>) => {
            await runExtractionJob(job.data);
        },
        {
            connection: getRedisConnection(),
            concurrency: 3,
            // Recover jobs orphaned by a worker crash mid-run: re-queue a job
            // whose lock hasn't been renewed within stalledInterval, up to
            // maxStalledCount times before it's failed for good.
            stalledInterval: 30_000,
            maxStalledCount: 2,
        },
    );
    worker.on("stalled", (jobId) => {
        console.warn(
            "[extraction-worker] job stalled; will be re-queued",
            { jobId },
        );
    });
    worker.on("failed", async (job, err) => {
        const permanent = !!job && isPermanentFailure(job);
        reportError(err, {
            level: permanent ? "error" : "warning",
            tags: {
                component: "extraction-worker",
                terminal: permanent,
                attempt: job?.attemptsMade,
            },
            extra: {
                job_id: job?.id,
                review_id: job?.data.reviewId,
                row_id: job?.data.rowId,
            },
        });
        if (!job) {
            console.error("[extraction-worker] job failed (no job)", { err });
            return;
        }
        if (!permanent) {
            console.error(
                "[extraction-worker] job failed (will retry, attempts remain)",
                { jobId: job.id, err },
            );
            return;
        }
        console.error(
            "[extraction-worker] job permanently failed; marking cells error",
            {
                jobId: job.id,
                reviewId: job.data.reviewId,
                rowId: job.data.rowId,
                err,
            },
        );
        try {
            await markExtractionFailed(job.data);
        } catch (updateErr) {
            console.error(
                "[extraction-worker] failed to mark cells error",
                { jobId: job.id, updateErr },
            );
        }
    });
    return worker;
}

export async function stopExtractionWorker(): Promise<void> {
    if (worker) {
        await worker.close();
        worker = null;
    }
}
