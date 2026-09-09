// Sentry error tracking for every backend runtime: the API process, the
// in-process worker thread, the standalone worker process, and one-shot jobs.
//
// Design rules, in priority order:
//
//   1. OFF BY DEFAULT. Without SENTRY_DSN nothing here does anything — no
//      network, no instrumentation, no behavior change. Open-source installs
//      and the unit-test suite never contact Sentry.
//   2. NEVER LEAK DOCUMENT CONTENT OR CREDENTIALS. This is a legal platform:
//      request bodies carry privileged documents and chat transcripts, and
//      headers carry session cookies. `beforeSend` strips request bodies,
//      cookies, and auth headers, and redacts secret-looking keys anywhere
//      in an event. `sendDefaultPii` stays false.
//   3. ONE EVENT PER FAILURE. Explicit `reportError` calls at the boundaries
//      (HTTP 500 path, background jobs, stream failures, worker crashes) carry
//      structured tags; a console bridge turns every remaining `console.error`
//      into an event so nothing is silently dropped. Errors already reported
//      explicitly are remembered so the bridge does not double-report them.

import * as Sentry from "@sentry/node";

export type SentryRole = "api" | "worker" | "worker-thread" | "job";

export type ReportLevel = "fatal" | "error" | "warning";

export type ReportContext = {
  /** Sentry tags: low-cardinality, indexed, filterable in the UI. */
  tags?: Record<string, string | number | boolean | null | undefined>;
  /** Free-form structured context shown on the event; scrubbed before send. */
  extra?: Record<string, unknown>;
  level?: ReportLevel;
  /** Override Sentry's grouping when the message alone would split issues. */
  fingerprint?: string[];
};

const CONSOLE_MECHANISM = "auto.core.capture_console";
const SENSITIVE_HEADERS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-supabase-auth",
]);
const SENSITIVE_KEY_PATTERN =
  /(token|secret|password|passwd|authorization|cookie|api[-_]?key|credential|private[-_]?key)/i;
const MAX_SCRUB_DEPTH = 6;
const NESTED_SEARCH_DEPTH = 2;

/** Errors already sent via reportError(); the console bridge skips them. */
const reportedErrors = new WeakSet<object>();

let initialized = false;

function parseRate(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, 0), 1);
}

export function sentryConfiguration(env: NodeJS.ProcessEnv = process.env) {
  const dsn = env.SENTRY_DSN?.trim() ?? "";
  // A test process must never report, even when a developer's backend/.env
  // carries a real DSN: the suite deliberately points workers at dead ports
  // and would flood the project with fake failures.
  const isTestProcess =
    env.NODE_ENV === "test" || env.VITEST === "true" || env.VITEST === "1";
  return {
    dsn,
    enabled:
      dsn.length > 0 &&
      (!isTestProcess || env.SENTRY_ALLOW_IN_TESTS === "true"),
    environment:
      env.SENTRY_ENVIRONMENT?.trim() || env.NODE_ENV?.trim() || "development",
    release: env.SENTRY_RELEASE?.trim() || undefined,
    // Performance tracing is opt-in: error tracking is the goal of this
    // integration and traces cost quota. 0 keeps the OpenTelemetry request
    // instrumentation (needed for request context on errors) without
    // sending transactions.
    tracesSampleRate: parseRate(env.SENTRY_TRACES_SAMPLE_RATE, 0),
    debug: env.SENTRY_DEBUG === "true",
    maxEventsPerIssuePerMinute: envInt(
      env.SENTRY_MAX_EVENTS_PER_ISSUE_PER_MINUTE,
      DEFAULT_MAX_EVENTS_PER_ISSUE_PER_MINUTE,
    ),
  };
}

function envInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * CLIENT-SIDE FLOOD CONTROL. A background loop that fails on every poll
 * (Postgres down, 8 upload workers, sub-second retry) produces hundreds of
 * identical events a minute — one is a signal, five hundred are a quota bill
 * and a rate-limited SDK that then drops the *next, different* error. Sentry
 * only deduplicates strictly consecutive identical events, so this keeps a
 * per-issue budget per minute and drops the excess locally, logging once per
 * window how many were suppressed.
 */
const DEFAULT_MAX_EVENTS_PER_ISSUE_PER_MINUTE = 10;
const THROTTLE_WINDOW_MS = 60_000;
type ThrottleBucket = { windowStart: number; sent: number; suppressed: number };
const throttleBuckets = new Map<string, ThrottleBucket>();
let maxEventsPerIssuePerMinute = DEFAULT_MAX_EVENTS_PER_ISSUE_PER_MINUTE;

function issueKey(event: Sentry.ErrorEvent): string {
  if (event.fingerprint?.length) return event.fingerprint.join("|");
  const exception = event.exception?.values?.[0];
  const base = exception
    ? `${exception.type ?? "Error"}: ${exception.value ?? ""}`
    : (event.message ?? "");
  const component = event.tags?.component;
  return `${component == null ? "" : String(component)}::${base.slice(0, 300)}`;
}

/** True when this event is within its issue's per-minute budget. */
export function withinIssueBudget(
  event: Sentry.ErrorEvent,
  now = Date.now(),
): boolean {
  const key = issueKey(event);
  let bucket = throttleBuckets.get(key);
  if (!bucket || now - bucket.windowStart >= THROTTLE_WINDOW_MS) {
    if (bucket?.suppressed) {
      console.warn(
        `[sentry] suppressed ${bucket.suppressed} further event(s) for: ${key.slice(0, 120)}`,
      );
    }
    bucket = { windowStart: now, sent: 0, suppressed: 0 };
    throttleBuckets.set(key, bucket);
    // Keep the map bounded on a long-running process.
    if (throttleBuckets.size > 1_000) {
      for (const [otherKey, other] of throttleBuckets) {
        if (now - other.windowStart >= THROTTLE_WINDOW_MS) {
          throttleBuckets.delete(otherKey);
        }
      }
    }
  }
  if (bucket.sent < maxEventsPerIssuePerMinute) {
    bucket.sent += 1;
    return true;
  }
  bucket.suppressed += 1;
  return false;
}

/** True once init() ran with a DSN in this process (or thread). */
export function isSentryEnabled(): boolean {
  return initialized;
}

function redactValue(value: unknown, depth: number): unknown {
  if (depth > MAX_SCRUB_DEPTH) return "[Truncated]";
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, depth + 1));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as object)) {
      out[key] = SENSITIVE_KEY_PATTERN.test(key)
        ? "[Filtered]"
        : redactValue(entry, depth + 1);
    }
    return out;
  }
  return value;
}

function findNested(
  value: unknown,
  predicate: (candidate: object) => boolean,
  depth = 0,
): object | null {
  if (!value || typeof value !== "object") return null;
  if (predicate(value)) return value;
  if (depth >= NESTED_SEARCH_DEPTH) return null;
  for (const entry of Object.values(value)) {
    const found = findNested(entry, predicate, depth + 1);
    if (found) return found;
  }
  return null;
}

/**
 * The console bridge hands its raw `console.error` arguments to beforeSend
 * through the hint; the copy on the event is already normalised by then, so
 * this is the only place the original Error objects can be recognised.
 */
function consoleArguments(hint: Sentry.EventHint): unknown[] | null {
  const context = hint.captureContext as
    | { extra?: { arguments?: unknown } }
    | undefined;
  const args = context?.extra?.arguments;
  return Array.isArray(args) ? args : null;
}

/**
 * Strip everything a legal-platform event must never carry, then drop
 * console-bridge duplicates of errors that were reported explicitly.
 * Exported for tests; installed as `beforeSend`.
 */
export function scrubEvent(
  event: Sentry.ErrorEvent,
  hint: Sentry.EventHint,
): Sentry.ErrorEvent | null {
  const mechanism = event.exception?.values?.[0]?.mechanism?.type;
  const original = hint.originalException;
  if (
    mechanism === CONSOLE_MECHANISM &&
    original &&
    typeof original === "object" &&
    reportedErrors.has(original)
  ) {
    return null;
  }

  // console.error("[label] failed", { jobId, error }) is the common shape in
  // this codebase. The bridge only recognises a top-level Error, so it sends
  // this as a message titled "[label] failed [object Object]". Recover: drop
  // it when the nested error was already reported explicitly (most of the
  // boundaries above do exactly that), otherwise give the message the error's
  // name and text and group by label instead of by the serialised object.
  const args = event.logger === "console" ? consoleArguments(hint) : null;
  if (args) {
    if (args.some((arg) => findNested(arg, (c) => reportedErrors.has(c)))) {
      return null;
    }
    const nestedError = args
      .map((arg) =>
        arg instanceof Error
          ? null
          : findNested(arg, (c) => c instanceof Error),
      )
      .find((found): found is Error => found instanceof Error);
    if (nestedError) {
      const label = args
        .filter((arg): arg is string => typeof arg === "string")
        .join(" ")
        .trim();
      event.message = `${label ? `${label}: ` : ""}${nestedError.name}: ${nestedError.message}`;
      event.fingerprint = ["console", label, nestedError.name];
      event.extra = { ...(event.extra ?? {}), error_stack: nestedError.stack };
    }
  }

  if (event.request) {
    // Bodies are documents, chat turns, passwords. Never.
    delete event.request.data;
    delete event.request.cookies;
    if (event.request.headers) {
      for (const name of Object.keys(event.request.headers)) {
        if (SENSITIVE_HEADERS.has(name.toLowerCase())) {
          delete event.request.headers[name];
        }
      }
    }
  }
  if (event.user) {
    // Keep the id (needed to answer "how many users hit this?"); drop the
    // rest — the SDK can attach email/ip from the request otherwise.
    event.user = event.user.id ? { id: event.user.id } : undefined;
  }
  if (event.extra) {
    event.extra = redactValue(event.extra, 0) as Record<string, unknown>;
  }
  if (event.contexts) {
    event.contexts = redactValue(event.contexts, 0) as typeof event.contexts;
  }
  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs.map((crumb) =>
      crumb.data
        ? {
            ...crumb,
            data: redactValue(crumb.data, 0) as Record<string, unknown>,
          }
        : crumb,
    );
  }
  if (!withinIssueBudget(event)) return null;
  return event;
}

/**
 * Initialise Sentry for this process. Safe to call more than once; returns
 * whether tracking is active. MUST run before Express/HTTP modules load so
 * the request instrumentation can hook them — see src/instrument.ts.
 */
export function initSentry(
  role: SentryRole,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (initialized) return true;
  const config = sentryConfiguration(env);
  if (!config.enabled) {
    if (env.NODE_ENV !== "test") {
      console.log(`[sentry] disabled for ${role} (SENTRY_DSN is not set)`);
    }
    return false;
  }

  maxEventsPerIssuePerMinute = config.maxEventsPerIssuePerMinute;
  Sentry.init({
    dsn: config.dsn,
    environment: config.environment,
    release: config.release,
    debug: config.debug,
    tracesSampleRate: config.tracesSampleRate,
    sendDefaultPii: false,
    // Bodies are stripped in beforeSend as well; not collecting them at all
    // means they never sit in memory on the event either.
    integrations: [
      Sentry.httpIntegration({ maxIncomingRequestBodySize: "none" }),
      Sentry.captureConsoleIntegration({ levels: ["error"] }),
    ],
    initialScope: {
      tags: { service: "mike-backend", role },
    },
    beforeSend: scrubEvent,
  });
  initialized = true;
  console.log(
    `[sentry] enabled for ${role} (environment ${config.environment}` +
      `${config.release ? `, release ${config.release}` : ""})`,
  );
  return true;
}

/**
 * Report an error with structured context. Call it BEFORE the accompanying
 * console.error so the console bridge recognises the error as already sent.
 * Returns the Sentry event id (useful for correlating with a request id), or
 * null when tracking is off.
 */
export function reportError(
  error: unknown,
  context: ReportContext = {},
): string | null {
  if (error && typeof error === "object") reportedErrors.add(error);
  if (!initialized) return null;
  return Sentry.withScope((scope) => {
    if (context.level) scope.setLevel(context.level);
    if (context.fingerprint) scope.setFingerprint(context.fingerprint);
    for (const [key, value] of Object.entries(context.tags ?? {})) {
      if (value !== undefined && value !== null) scope.setTag(key, value);
    }
    for (const [key, value] of Object.entries(context.extra ?? {})) {
      scope.setExtra(key, value);
    }
    return Sentry.captureException(
      error instanceof Error ? error : new Error(describe(error)),
    );
  });
}

/** A message-only event (no Error object), for "this should never happen". */
export function reportMessage(
  message: string,
  context: ReportContext = {},
): string | null {
  if (!initialized) return null;
  return Sentry.withScope((scope) => {
    if (context.fingerprint) scope.setFingerprint(context.fingerprint);
    for (const [key, value] of Object.entries(context.tags ?? {})) {
      if (value !== undefined && value !== null) scope.setTag(key, value);
    }
    for (const [key, value] of Object.entries(context.extra ?? {})) {
      scope.setExtra(key, value);
    }
    return Sentry.captureMessage(message, context.level ?? "error");
  });
}

/** Attach the request id to every event captured during this request. */
export function tagCurrentRequest(requestId: string): void {
  if (!initialized) return;
  Sentry.getIsolationScope().setTag("request_id", requestId);
}

/** Attach the authenticated user's id (never the email) to this request. */
export function setCurrentUser(userId: string | null): void {
  if (!initialized) return;
  Sentry.getIsolationScope().setUser(userId ? { id: userId } : null);
}

/** Flush queued events before a process exits (one-shot jobs, crashes). */
export async function flushSentry(timeoutMs = 2_000): Promise<void> {
  if (!initialized) return;
  try {
    await Sentry.flush(timeoutMs);
  } catch {
    // Exiting anyway; a lost event is better than a hung process.
  }
}

function describe(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Test seam: forget init and throttle state between unit tests. */
export function resetSentryForTests(): void {
  initialized = false;
  throttleBuckets.clear();
  maxEventsPerIssuePerMinute = DEFAULT_MAX_EVENTS_PER_ISSUE_PER_MINUTE;
}
