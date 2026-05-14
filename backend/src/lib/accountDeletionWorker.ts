/**
 * Account-deletion worker (CLEAN-44).
 *
 * Polls `account_deletion_jobs` every minute, atomically claims due rows,
 * walks each user's R2 prefixes deleting in 1000-key batches, then calls
 * `auth.admin.deleteUser` LAST so FK CASCADE wipes every dependent table
 * in one shot.
 *
 * Resumable: `last_continuation_token` is persisted after every page so a
 * crash mid-walk resumes from the same R2 marker. The atomic `claimJob`
 * UPDATE on `status = 'pending'` is the SOLE de-dup gate (T-12-09-03);
 * concurrent claims short-circuit before any R2 work begins.
 *
 * Mirrors `pdfQueue.ts`: lazy p-queue singleton + setInterval loop +
 * startup-fixup helper (`resetStuckRunningJobs`).
 */

import os from "os";
import { createServerSupabase } from "./supabase";
import { logger } from "./logger";
import { listObjectsByPrefix, deleteObjectsBatch, storageEnabled } from "./storage";
import {
  claimJob,
  persistContinuationToken,
  finalizeJob,
  hardDeleteUser,
  DELETION_PREFIXES,
  type ContinuationState,
} from "./accountDeletion";

const POLL_INTERVAL_MS = 60_000;
const POLL_BATCH_SIZE = 5;
const WORKER_ID = `${os.hostname()}-${process.pid}`;

type DbClient = ReturnType<typeof createServerSupabase>;
type ListObjectsFn = typeof listObjectsByPrefix;
type DeleteObjectsFn = typeof deleteObjectsBatch;

export type ProcessJobResult = {
  rows: number;
  objects: number;
  errors: string[];
};

export type ProcessJobDeps = {
  listObjects?: ListObjectsFn;
  deleteObjects?: DeleteObjectsFn;
  db?: DbClient;
  hardDelete?: typeof hardDeleteUser;
};

let _queue: import("p-queue").default | null = null;
let _interval: NodeJS.Timeout | null = null;

async function getQueue(): Promise<import("p-queue").default> {
  if (!_queue) {
    const { default: PQueue } = await import("p-queue");
    _queue = new PQueue({ concurrency: 1 });
  }
  return _queue;
}

/**
 * Process a single job end-to-end: claim → walk R2 prefixes → hardDeleteUser.
 *
 * Exported via `_processJobForTesting` so integration tests can drive a
 * single job synchronously without waiting for the setInterval tick.
 */
async function processJob(
  userId: string,
  deps: ProcessJobDeps = {},
): Promise<ProcessJobResult> {
  const db = deps.db ?? createServerSupabase();
  const listObjects = deps.listObjects ?? listObjectsByPrefix;
  const deleteObjects = deps.deleteObjects ?? deleteObjectsBatch;
  const hardDelete = deps.hardDelete ?? hardDeleteUser;

  // Refuse to proceed without R2 credentials. Otherwise listObjects no-ops
  // silently and hardDeleteUser cascades the DB rows away while leaving every
  // user-owned R2 object orphaned. The injected mock deps in tests opt out by
  // passing custom listObjects/deleteObjects. (WR-05)
  const hasInjectedR2 =
    deps.listObjects !== undefined && deps.deleteObjects !== undefined;
  if (!storageEnabled && !hasInjectedR2) {
    const msg =
      "storageEnabled is false — refusing to hard-delete without R2 cleanup";
    logger.error({ userId }, `[accountDeletionWorker] ${msg}`);
    return { rows: 0, objects: 0, errors: [msg] };
  }

  // claimJob FIRST — atomic UPDATE WHERE status='pending' is the sole de-dup gate.
  // No R2 calls happen before this returns ok (B1 invariant).
  const claim = await claimJob(userId, WORKER_ID, db);
  if (!claim.ok) {
    logger.info({ userId }, "[accountDeletionWorker] job already claimed or not due");
    return { rows: 0, objects: 0, errors: [] };
  }

  // Idempotency invariant: re-walking a completedPrefixes entry on crash recovery is
  // acceptable because R2 DeleteObjects on a missing key is a no-op (S3 API).
  const startState: ContinuationState = claim.lastToken ?? {
    currentPrefix: `${DELETION_PREFIXES[0]}/${userId}/`,
    token: null,
    completedPrefixes: [],
  };
  let totalDeleted = 0;
  const errors: string[] = [];

  try {
    for (const prefixRoot of DELETION_PREFIXES) {
      const fullPrefix = `${prefixRoot}/${userId}/`;
      if (startState.completedPrefixes.includes(fullPrefix)) continue;

      const startToken =
        startState.currentPrefix === fullPrefix
          ? startState.token ?? undefined
          : undefined;

      let nextToken: string | undefined;
      for await (const batch of listObjects(fullPrefix, startToken)) {
        if (batch.keys.length > 0) {
          const result = await deleteObjects(batch.keys);
          totalDeleted += result.deleted;
          errors.push(...result.errors);
        }
        nextToken = batch.nextToken;
        await persistContinuationToken(
          userId,
          {
            currentPrefix: fullPrefix,
            token: nextToken ?? null,
            completedPrefixes: startState.completedPrefixes,
          },
          db,
        );
        if (!nextToken) break;
      }

      startState.completedPrefixes.push(fullPrefix);
      await persistContinuationToken(
        userId,
        {
          currentPrefix: fullPrefix,
          token: null,
          completedPrefixes: startState.completedPrefixes,
        },
        db,
      );
    }

    // hardDeleteUser LAST — FK CASCADE wipes the job row and all user tables.
    const ok = await hardDelete(userId, db);
    if (!ok) {
      await finalizeJob(
        userId,
        { rows: 0, objects: totalDeleted, errors: ["hardDeleteUser returned false"] },
        db,
      );
      logger.error({ userId, totalDeleted }, "[accountDeletionWorker] hardDeleteUser failed");
      return { rows: 0, objects: totalDeleted, errors: [...errors, "hardDeleteUser returned false"] };
    }

    const result: ProcessJobResult = { rows: 1, objects: totalDeleted, errors };
    logger.info(
      {
        event: "account_deletion_complete",
        user_id: userId,
        rows: result.rows,
        objects: result.objects,
        errors: result.errors,
      },
      "[accountDeletionWorker] account_deletion_complete",
    );
    return result;
  } catch (err) {
    const errStr = String(err);
    await finalizeJob(userId, { rows: 0, objects: totalDeleted, errors: [errStr] }, db);
    logger.error({ err, userId, totalDeleted }, "[accountDeletionWorker] processJob threw");
    return { rows: 0, objects: totalDeleted, errors: [errStr] };
  }
}

async function tick(): Promise<void> {
  const db = createServerSupabase();
  const nowIso = new Date().toISOString();
  const { data: jobs, error } = await db
    .from("account_deletion_jobs")
    .select("user_id")
    .lte("scheduled_for", nowIso)
    .eq("status", "pending")
    .limit(POLL_BATCH_SIZE);

  if (error) {
    logger.error({ err: error }, "[accountDeletionWorker] tick select failed");
    return;
  }
  if (!jobs || jobs.length === 0) return;

  const queue = await getQueue();
  for (const job of jobs as { user_id: string }[]) {
    void queue.add(() => processJob(job.user_id));
  }
}

/**
 * Wire the polling setInterval. Idempotent — calling twice is a no-op.
 * Returns immediately; the interval drives further work in the background.
 */
export function startAccountDeletionWorker(): void {
  if (_interval) return;
  _interval = setInterval(() => {
    void tick().catch((err) =>
      logger.error({ err }, "[accountDeletionWorker] tick failed"),
    );
  }, POLL_INTERVAL_MS);
  logger.info(
    { pollIntervalMs: POLL_INTERVAL_MS, workerId: WORKER_ID },
    "[accountDeletionWorker] started",
  );
}

/**
 * Crash-recovery: flip orphaned `running` rows back to `pending` at boot.
 * Mirrors `pdfQueue.resetStuckPendingConversions`.
 */
export async function resetStuckRunningJobs(): Promise<void> {
  try {
    const db = createServerSupabase();
    const { data, error } = await db
      .from("account_deletion_jobs")
      .update({ status: "pending", claimed_by: null, claimed_at: null })
      .eq("status", "running")
      .select("user_id");
    if (error) {
      logger.error({ err: error }, "[accountDeletionWorker] resetStuckRunningJobs failed");
      return;
    }
    const count = data?.length ?? 0;
    if (count > 0) {
      logger.info({ count }, "[accountDeletionWorker] startup fixup: reset stuck running rows to pending");
    }
  } catch (err) {
    logger.error({ err }, "[accountDeletionWorker] resetStuckRunningJobs threw");
  }
}

/**
 * Test-only export: drives a single job synchronously without the setInterval.
 * Accepts optional dep-injection for R2 client + DB to enable mock-based tests.
 */
export async function _processJobForTesting(
  userId: string,
  deps?: ProcessJobDeps,
): Promise<ProcessJobResult> {
  return processJob(userId, deps);
}

/**
 * Test-only export: drives a single tick synchronously (used by polling tests
 * that don't want to wait for the setInterval).
 */
export async function _tickForTesting(): Promise<void> {
  return tick();
}
