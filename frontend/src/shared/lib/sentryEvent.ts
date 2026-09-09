/**
 * Sentry event hygiene shared by the web app (browser + Next server) and the
 * Word add-in. Framework-free on purpose: this file must not import from
 * `@/app/` (the add-in bundles it through a webpack alias) and it must not
 * import a Sentry package either, because the two targets use different
 * ones (`@sentry/nextjs` vs `@sentry/react`) — the structural types below
 * are the subset both agree on.
 *
 * Two jobs:
 *
 *  1. SCRUB. Mike handles privileged legal documents. An event may carry a
 *     user id and a route; it must never carry a request body, a cookie, an
 *     auth header, or anything under a key that looks like a secret.
 *  2. DEDUPE. Every remaining `console.error` is bridged into Sentry so no
 *     failure is silently dropped, but code that already reported an error
 *     explicitly (with tags) logs it too. The explicit path marks the error
 *     object; the bridge's copy of a marked error is discarded.
 */

export const CONSOLE_CAPTURE_MECHANISM = "auto.core.capture_console";

const SENSITIVE_HEADERS = new Set([
    "authorization",
    "cookie",
    "set-cookie",
    "x-api-key",
    "x-supabase-auth",
]);
const SENSITIVE_KEY_PATTERN =
    /(token|secret|password|passwd|authorization|cookie|api[-_]?key|credential|private[-_]?key)/i;
const MAX_DEPTH = 6;

/** The pieces of a Sentry event this module reads or rewrites. */
// No index signatures: the SDKs' `ErrorEvent` is an interface, and an
// interface is not assignable to an indexable type, so the shape below must
// name only the properties it touches.
export type ScrubbableEvent = {
    /** Set to "console" by the console bridge on every event it creates. */
    logger?: string;
    message?: string;
    fingerprint?: string[];
    tags?: Record<string, unknown>;
    exception?: {
        values?: {
            type?: string;
            value?: string;
            mechanism?: { type?: string };
        }[];
    };
    request?: {
        data?: unknown;
        cookies?: unknown;
        headers?: Record<string, string>;
    };
    user?: { id?: string | number };
    extra?: Record<string, unknown>;
    contexts?: Record<string, unknown>;
    breadcrumbs?: { data?: Record<string, unknown> }[];
};

export type ScrubHint = {
    originalException?: unknown;
    /**
     * The console bridge passes its raw `console.error` arguments here
     * (`{ extra: { arguments } }`); by the time `beforeSend` runs the copy on
     * the event has been normalised, so this is the only place the original
     * objects can still be recognised.
     */
    captureContext?: unknown;
};

const NESTED_SEARCH_DEPTH = 2;

function consoleArguments(hint: ScrubHint): unknown[] | null {
    const context = hint.captureContext as
        | { extra?: { arguments?: unknown } }
        | undefined;
    const args = context?.extra?.arguments;
    return Array.isArray(args) ? args : null;
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

export function redactSensitiveValues(value: unknown, depth = 0): unknown {
    if (depth > MAX_DEPTH) return "[Truncated]";
    if (Array.isArray(value)) {
        return value.map((item) => redactSensitiveValues(item, depth + 1));
    }
    if (value && typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const [key, entry] of Object.entries(value as object)) {
            out[key] = SENSITIVE_KEY_PATTERN.test(key)
                ? "[Filtered]"
                : redactSensitiveValues(entry, depth + 1);
        }
        return out;
    }
    return value;
}

const DEFAULT_MAX_EVENTS_PER_ISSUE_PER_MINUTE = 10;
const THROTTLE_WINDOW_MS = 60_000;

function issueKey(event: ScrubbableEvent): string {
    if (event.fingerprint?.length) return event.fingerprint.join("|");
    const exception = event.exception?.values?.[0];
    const base = exception
        ? `${exception.type ?? "Error"}: ${exception.value ?? ""}`
        : (event.message ?? "");
    const component = (event.tags as Record<string, unknown> | undefined)
        ?.component;
    return `${component ?? ""}::${base.slice(0, 300)}`;
}

/**
 * A registry of errors already sent with explicit context, plus per-issue
 * flood control. Each runtime (web app, add-in) creates one and installs its
 * scrubber as `beforeSend`.
 *
 * Flood control: a render loop or a retry loop can raise the same error many
 * times a second, and Sentry only collapses strictly consecutive duplicates.
 * The first `maxEventsPerIssuePerMinute` events of an issue go out; the rest
 * are dropped locally so the quota stays for the next, different bug.
 */
export function createEventScrubber(options?: {
    maxEventsPerIssuePerMinute?: number;
    now?: () => number;
}) {
    const reported = new WeakSet<object>();
    const budget =
        options?.maxEventsPerIssuePerMinute ??
        DEFAULT_MAX_EVENTS_PER_ISSUE_PER_MINUTE;
    const now = options?.now ?? (() => Date.now());
    const buckets = new Map<string, { windowStart: number; sent: number }>();

    const withinBudget = (event: ScrubbableEvent): boolean => {
        const key = issueKey(event);
        const at = now();
        let bucket = buckets.get(key);
        if (!bucket || at - bucket.windowStart >= THROTTLE_WINDOW_MS) {
            bucket = { windowStart: at, sent: 0 };
            buckets.set(key, bucket);
        }
        if (bucket.sent >= budget) return false;
        bucket.sent += 1;
        return true;
    };

    const markReported = (error: unknown): void => {
        if (error && typeof error === "object") reported.add(error);
    };

    const scrubEvent = <T extends ScrubbableEvent>(
        event: T,
        hint: ScrubHint = {},
    ): T | null => {
        const mechanism = event.exception?.values?.[0]?.mechanism?.type;
        const original = hint.originalException;
        if (
            mechanism === CONSOLE_CAPTURE_MECHANISM &&
            original &&
            typeof original === "object" &&
            reported.has(original)
        ) {
            return null;
        }

        // console.error("[label] failed", { jobId, error }) — the common shape
        // in this codebase. The bridge only recognises a top-level Error, so
        // it sends this as a message titled "[label] failed [object Object]".
        // Recover: drop it if that nested error was already reported, else
        // give the message the error's name and text and group by label.
        const args =
            event.logger === "console" ? consoleArguments(hint) : null;
        if (args) {
            if (args.some((arg) => findNested(arg, (c) => reported.has(c)))) {
                return null;
            }
            const nestedError = args
                .map((arg) =>
                    typeof arg === "object" && arg instanceof Error
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
                event.extra = {
                    ...(event.extra ?? {}),
                    error_stack: nestedError.stack,
                };
            }
        }

        if (event.request) {
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
            event.user = event.user.id ? { id: event.user.id } : undefined;
        }
        if (event.extra) {
            event.extra = redactSensitiveValues(event.extra) as Record<
                string,
                unknown
            >;
        }
        if (event.contexts) {
            event.contexts = redactSensitiveValues(event.contexts) as Record<
                string,
                unknown
            >;
        }
        if (event.breadcrumbs) {
            event.breadcrumbs = event.breadcrumbs.map((crumb) =>
                crumb.data
                    ? {
                          ...crumb,
                          data: redactSensitiveValues(crumb.data) as Record<
                              string,
                              unknown
                          >,
                      }
                    : crumb,
            );
        }
        if (!withinBudget(event)) return null;
        return event;
    };

    return { markReported, scrubEvent };
}

/**
 * Collapse ids out of an API path so one failing endpoint groups as one
 * Sentry issue: /projects/8f1c…/documents/42 → /projects/:id/documents/:id.
 */
export function normalizeApiPath(path: string): string {
    const withoutQuery = path.split("?")[0] ?? path;
    return withoutQuery
        .replace(
            /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
            ":id",
        )
        .replace(/\/\d+(?=\/|$)/g, "/:id");
}

/** Clamp an env-provided sample rate to [0, 1]; anything unparseable → fallback. */
export function parseSampleRate(
    raw: string | undefined,
    fallback: number,
): number {
    if (!raw) return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(Math.max(parsed, 0), 1);
}
