// Everything that processes background work, bundled behind one start/stop
// pair so the SAME code can run in any of three homes:
//
//   1. a worker_thread inside the API process (the default — background work
//      stays off the main event loop even on a single-box deployment),
//   2. inline on the API process's main thread (WORKERS_MODE=inline — the
//      pre-thread behavior, kept as an escape hatch),
//   3. a standalone worker process (src/worker.ts; WORKERS_MODE=none on the
//      API side) — a separate container or machine pointed at the same
//      Postgres/Redis. This is the path to dedicated worker hardware: same
//      image, different command, zero code changes.
//
// Contents: the BullMQ workers (driver-gated), the DB-queue runner, the
// stale-work reaper, and the workflow catalog boot sync.

import { anyWorkerEnabled, startWorkers, stopWorkers } from "./workers";
import { startDbJobRunner, stopDbJobRunner } from "./lib/dbq/runner";
import {
    DB_JOB_HANDLERS,
    MCP_TOKEN_REFRESH_WINDOW_MS,
} from "./lib/dbq/handlers";
import { enqueueDbJob } from "./lib/dbq/enqueue";
import { runStaleWorkSweep } from "./lib/maintenance/staleWork";
import { startUploadProcessingWorkers } from "./lib/uploadProcessing";
import { uploadProcessingConfiguration } from "./lib/runtimeConfig";
import { createServerSupabase } from "./lib/supabase";
import { reportError } from "./lib/observability/sentry";

const SWEEP_INTERVAL_MS = (() => {
    const raw = Number(process.env.STALE_SWEEP_INTERVAL_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : 10 * 60 * 1000;
})();

/** How often to look for MCP OAuth tokens about to expire. */
const MCP_REFRESH_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * How far past expiry the sweep still bothers. A connector nobody has used
 * for a day is not worth waking the authorization server for every 5 minutes
 * forever — the lazy refresh in oauthBearerToken picks it up the moment the
 * user actually touches it. Without this floor, one abandoned connector with
 * a dead grant re-enqueues a doomed job for the rest of the deployment's life.
 */
const MCP_REFRESH_MAX_EXPIRED_AGE_MS = 24 * 60 * 60 * 1000;

let sweepTimer: ReturnType<typeof setInterval> | null = null;
let initialSweep: ReturnType<typeof setTimeout> | null = null;
let mcpRefreshTimer: ReturnType<typeof setInterval> | null = null;
let stopUploadWorker: (() => void) | null = null;

/**
 * Queue a refresh for every MCP OAuth token expiring inside the handler's
 * window. Fully best-effort: this is an optimization over the lazy refresh,
 * so nothing it hits may take the worker runtime down.
 */
async function runMcpTokenRefreshSweep(): Promise<void> {
    const db = createServerSupabase();
    const now = Date.now();
    const { data, error } = await db
        .from("user_mcp_oauth_tokens")
        .select("connector_id, expires_at")
        .not("expires_at", "is", null)
        .not("encrypted_refresh_token", "is", null)
        .lt("expires_at", new Date(now + MCP_TOKEN_REFRESH_WINDOW_MS).toISOString())
        .gt("expires_at", new Date(now - MCP_REFRESH_MAX_EXPIRED_AGE_MS).toISOString());
    if (error) throw new Error(error.message);

    for (const row of (data ?? []) as { connector_id: string }[]) {
        if (!row.connector_id) continue;
        // One live job per connector: overlapping sweeps, and several
        // replicas sweeping at once, collapse into a single refresh.
        await enqueueDbJob(db, {
            kind: "mcp.refresh_token",
            payload: { connectorId: row.connector_id },
            dedupeKey: `mcp.refresh:${row.connector_id}`,
            maxAttempts: 3,
        });
    }
}
let started = false;

/** Start every background worker (idempotent). */
export function startAllWorkers(): void {
    if (started) return;
    started = true;

    // BullMQ workers: conversion/extraction when their flags are on, plus
    // the app-jobs delivery worker — all only when the Redis driver is
    // active (the registry's `enabled` predicates gate this).
    if (anyWorkerEnabled()) {
        startWorkers();
    }

    // The DB queue runs in every deployment (fast delivery when Redis is
    // up, poll-driven otherwise) — see lib/dbq/runner.ts.
    startDbJobRunner(DB_JOB_HANDLERS);

    // Upload-session processing: lease-based claims over Postgres, so any
    // number of runtimes can poll concurrently without double-processing.
    const uploadProcessing = uploadProcessingConfiguration();
    stopUploadWorker = startUploadProcessingWorkers(uploadProcessing);
    console.log(
        `Upload processing started with ${uploadProcessing.concurrency} workers ` +
            `and a ${uploadProcessing.maxRunningPerUser}-job per-user cap`,
    );

    // Stale-work reaper: a crash between "status = processing/generating"
    // and the finalizing write strands rows in a transient state forever —
    // nothing else owns them. Sweep shortly after boot (crash recovery) and
    // on an interval.
    const runSweep = () =>
        void runStaleWorkSweep()
            .then(({ documents, cells }) => {
                if (documents || cells)
                    console.warn("[stale-sweep] flipped", { documents, cells });
            })
            .catch((err) => {
                reportError(err, { tags: { component: "stale-sweep" } });
                console.error("[stale-sweep] failed", err);
            });
    initialSweep = setTimeout(runSweep, 30_000);
    initialSweep.unref();
    sweepTimer = setInterval(runSweep, SWEEP_INTERVAL_MS);
    sweepTimer.unref();

    // MCP OAuth tokens: renew the ones about to expire on this schedule
    // rather than inside whichever request first trips over the expiry. The
    // lazy refresh in lib/mcp/oauth.ts stays as the last line of defense.
    const runMcpRefresh = () =>
        void runMcpTokenRefreshSweep().catch((err) => {
            reportError(err, { tags: { component: "mcp-refresh-sweep" } });
            console.error("[mcp-refresh-sweep] failed", err);
        });
    mcpRefreshTimer = setInterval(runMcpRefresh, MCP_REFRESH_SWEEP_INTERVAL_MS);
    mcpRefreshTimer.unref();
}

/** Stop everything gracefully; safe to call more than once. */
export async function stopAllWorkers(): Promise<void> {
    if (initialSweep) clearTimeout(initialSweep);
    if (sweepTimer) clearInterval(sweepTimer);
    if (mcpRefreshTimer) clearInterval(mcpRefreshTimer);
    initialSweep = null;
    sweepTimer = null;
    mcpRefreshTimer = null;
    if (stopUploadWorker) {
        stopUploadWorker();
        stopUploadWorker = null;
    }
    await stopWorkers();
    await stopDbJobRunner();
    started = false;
}
