// Sentry must hook http/express before anything else loads (see file).
import "./instrument";
import { Worker as ThreadWorker } from "node:worker_threads";
import path from "node:path";
import { app } from "./app";
import { manifestPublicKey } from "./lib/manifestSigning";
import { validateRuntimeConfiguration } from "./lib/runtimeConfig";
import { startAllWorkers, stopAllWorkers } from "./workerRuntime";
import { flushSentry, reportError } from "./lib/observability/sentry";

const PORT = process.env.PORT ?? 3001;

// Surface a malformed MANIFEST_SIGNING_KEY at boot rather than when someone's
// first export fails. Unset is a valid choice and means manifests go out
// unsigned; malformed is a misconfiguration, so stop rather than serve a
// deployment whose exports will fail later.
try {
  validateRuntimeConfiguration();
  const signingKey = manifestPublicKey();
  if (signingKey) {
    console.log(`Export manifests signed with key ${signingKey.key_id}`);
  }
} catch (err) {
  reportError(err, { tags: { component: "boot" }, level: "fatal" });
  console.error(err instanceof Error ? err.message : String(err));
  void flushSentry().finally(() => process.exit(1));
}

/**
 * Where background work runs, relative to this API process:
 *   "thread" (default) — a worker_thread in this process: queue workers and
 *            maintenance run off the main event loop, so a CPU-heavy job can
 *            never starve HTTP requests, with zero deployment changes.
 *   "inline" — on the main thread (the historical behavior; escape hatch,
 *            e.g. if a platform disallows worker_threads).
 *   "none"  — not here at all: a standalone worker process (src/worker.ts)
 *            runs them — a separate container or machine on the same
 *            Postgres/Redis.
 */
const WORKERS_MODE = (() => {
  const raw = process.env.WORKERS_MODE;
  return raw === "inline" || raw === "none" ? raw : "thread";
})();

let workerThread: ThreadWorker | null = null;
let shuttingDown = false;

function spawnWorkerThread(): void {
  // In dev (tsx) this file is .ts and the thread entry must be too, loaded
  // through tsx's CJS require hook; in prod both are compiled .js in dist.
  const isTs = __filename.endsWith(".ts");
  const entry = path.join(
    __dirname,
    isTs ? "workerThread.ts" : "workerThread.js",
  );
  workerThread = new ThreadWorker(entry, {
    execArgv: isTs ? ["--require", "tsx/cjs"] : [],
  });
  workerThread.on("error", (err) => {
    // An uncaught throw inside the thread. The thread's own Sentry client
    // usually reports it first; this is the parent's view with the respawn
    // context, deduplicated by Sentry on the identical stack.
    reportError(err, { tags: { component: "worker-thread-supervisor" } });
    console.error("[worker-thread] error", err);
  });
  workerThread.on("exit", (code) => {
    workerThread = null;
    if (shuttingDown || code === 0) return;
    // A crashed worker thread must not silently kill all background
    // processing — respawn after a short pause. Durable state (db_jobs,
    // Redis) means nothing is lost across the gap.
    reportError(
      new Error(`Background worker thread exited with code ${code}`),
      {
        tags: { component: "worker-thread-supervisor" },
        extra: { exit_code: code },
        fingerprint: ["worker-thread-exit"],
      },
    );
    console.error(
      `[worker-thread] exited with code ${code}; respawning in 5s`,
    );
    setTimeout(spawnWorkerThread, 5_000).unref();
  });
}

const server = app.listen(PORT, () => {
  console.log(
    `Mike backend running on port ${PORT} (workers: ${WORKERS_MODE})`,
  );
  if (WORKERS_MODE === "thread") {
    spawnWorkerThread();
  } else if (WORKERS_MODE === "inline") {
    startAllWorkers();
  }
  // WORKERS_MODE === "none": a standalone worker process owns background
  // work (node dist/worker.js).
});

// Graceful shutdown: on SIGTERM/SIGINT (orchestrator rollout, Ctrl-C), stop
// accepting new connections, let in-flight requests/streams drain, stop the
// background workers wherever they run, then exit 0. A hard timeout guards
// against a connection or job that never drains.
async function stopBackgroundWork(): Promise<void> {
  if (WORKERS_MODE === "inline") {
    await stopAllWorkers();
    return;
  }
  const thread = workerThread;
  if (!thread) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => resolve(), 10_000);
    timeout.unref();
    thread.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    thread.postMessage("shutdown");
  });
}

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Shutting down gracefully (${signal})`);
  const forceExit = setTimeout(() => {
    console.error("Graceful shutdown timed out — forcing exit");
    process.exit(1);
  }, 15_000);
  forceExit.unref();
  try {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
    await stopBackgroundWork();
    await flushSentry();
    console.log("Shutdown complete");
    process.exit(0);
  } catch (err) {
    reportError(err, { tags: { component: "shutdown" } });
    console.error("Error during graceful shutdown", err);
    await flushSentry();
    process.exit(1);
  }
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
