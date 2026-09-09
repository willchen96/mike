import { Worker, type Job } from "bullmq";
import { getRedisConnection } from "../lib/queue/connection";
import { reportError } from "../lib/observability/sentry";
import {
    APP_JOBS_QUEUE,
    type AppJobDelivery,
} from "../lib/queue/appJobsQueue";
import { processClaimedJob } from "../lib/dbq/runner";
import { DB_JOB_HANDLERS } from "../lib/dbq/handlers";
import { createServerSupabase } from "../lib/supabase";
import type { Db, DbJob } from "../lib/dbq/types";

/**
 * The fast half of the DB queue when Redis is configured: BullMQ delivers a
 * db_jobs row id, this worker CLAIMS the row through Postgres and runs it
 * through the shared state machine (processClaimedJob).
 *
 * Claiming through Postgres — not trusting the delivery — is what makes the
 * outbox safe: a duplicate delivery (BullMQ replay, poll backstop racing the
 * delivery, an operator re-enqueue) matches zero rows on the conditional
 * claim and becomes a no-op. A delivery for a row that is not yet due (clock
 * skew on a delayed retry) also claims nothing; the poll backstop runs it
 * when it is due. Delivery jobs themselves never retry (attempts: 1) — the
 * durable record and the poller are the retry mechanism.
 */
export async function runAppJobDelivery(
    data: AppJobDelivery,
    db: Db = createServerSupabase(),
): Promise<void> {
    const { data: rows, error } = await db.rpc("claim_db_job", {
        p_id: data.dbJobId,
        p_stale_seconds: 600,
    });
    if (error) {
        // Claim failure (transient DB trouble): do nothing — the row is
        // untouched and the poll backstop will claim it.
        console.error("[app-jobs] claim failed", {
            dbJobId: data.dbJobId,
            error: error.message,
        });
        return;
    }
    const job = ((rows ?? []) as DbJob[])[0];
    if (!job) return; // already claimed/finished elsewhere, or not yet due
    await processClaimedJob(db, DB_JOB_HANDLERS, job);
}

let worker: Worker<AppJobDelivery> | null = null;

export function createAppJobsWorker(): Worker<AppJobDelivery> {
    if (worker) return worker;
    worker = new Worker<AppJobDelivery>(
        APP_JOBS_QUEUE,
        async (job: Job<AppJobDelivery>) => {
            await runAppJobDelivery(job.data);
        },
        {
            connection: getRedisConnection(),
            concurrency: 5,
            stalledInterval: 30_000,
            maxStalledCount: 2,
        },
    );
    worker.on("failed", (job, err) => {
        // Only infrastructure errors land here (processClaimedJob contains
        // handler errors itself); the db_jobs row stays claimable.
        reportError(err, {
            tags: { component: "app-jobs", stage: "delivery" },
            extra: { job_id: job?.id },
        });
        console.error("[app-jobs] delivery processing failed", {
            jobId: job?.id,
            err,
        });
    });
    return worker;
}

export async function stopAppJobsWorker(): Promise<void> {
    if (worker) {
        await worker.close();
        worker = null;
    }
}
