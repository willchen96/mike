// Sentry bootstrap. This file must be the FIRST import of every backend
// entrypoint (src/index.ts, src/worker.ts, src/workerThread.ts, one-shot
// jobs): the Node SDK hooks `http` and Express through OpenTelemetry at init
// time, and modules loaded before init are never instrumented — errors
// would still be captured, but without the request URL, method, or user.
//
// dotenv runs first so SENTRY_DSN can live in backend/.env like every other
// setting. The role tag tells an event which runtime it came from; it is
// derived from how this process was started so the entrypoints stay
// one-line importers (SENTRY_ROLE overrides it when needed).

import "dotenv/config";
import path from "node:path";
import { isMainThread } from "node:worker_threads";
import { initSentry, type SentryRole } from "./lib/observability/sentry";

function detectRole(): SentryRole {
  const override = process.env.SENTRY_ROLE;
  if (
    override === "api" ||
    override === "worker" ||
    override === "worker-thread" ||
    override === "job"
  ) {
    return override;
  }
  if (!isMainThread) return "worker-thread";
  const entry = path.basename(process.argv[1] ?? "");
  if (entry.startsWith("worker")) return "worker";
  if (entry.startsWith("syncWorkflows")) return "job";
  return "api";
}

initSentry(detectRole());
