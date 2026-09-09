/**
 * Error reporting for the web app: a thin, testable layer over the Sentry
 * SDK. Application code calls these helpers instead of `@sentry/nextjs`
 * directly so the PII policy (see `@/shared/lib/sentryEvent`) and the
 * "no-op without a DSN" rule live in one place.
 */

import * as Sentry from "@sentry/nextjs";
import {
    createEventScrubber,
    normalizeApiPath,
    parseSampleRate,
} from "@/shared/lib/sentryEvent";

export type ReportLevel = "fatal" | "error" | "warning";

export type ReportContext = {
    tags?: Record<string, string | number | boolean | null | undefined>;
    extra?: Record<string, unknown>;
    level?: ReportLevel;
    fingerprint?: string[];
};

const scrubber = createEventScrubber();

/** `beforeSend` for every Sentry client in the web app (browser, server, edge). */
export const scrubEvent = scrubber.scrubEvent;

function applyContext(scope: Sentry.Scope, context: ReportContext): void {
    if (context.level) scope.setLevel(context.level);
    if (context.fingerprint) scope.setFingerprint(context.fingerprint);
    for (const [key, value] of Object.entries(context.tags ?? {})) {
        if (value !== undefined && value !== null) scope.setTag(key, value);
    }
    for (const [key, value] of Object.entries(context.extra ?? {})) {
        scope.setExtra(key, value);
    }
}

/**
 * Report an error with structured context. Call it BEFORE any accompanying
 * console.error so the console bridge recognises the error as already sent.
 */
export function reportError(
    error: unknown,
    context: ReportContext = {},
): string | null {
    scrubber.markReported(error);
    if (!Sentry.isEnabled()) return null;
    return Sentry.withScope((scope) => {
        applyContext(scope, context);
        return Sentry.captureException(error);
    });
}

/**
 * A backend 5xx seen from the browser. The request id is the same one the
 * backend attached to its own event, so the two sides of one failure can be
 * matched in Sentry by searching `request_id:<id>`.
 */
export function reportApiFailure(failure: {
    path: string;
    status: number;
    code?: string | null;
    requestId?: string | null;
    method?: string;
    /**
     * The error object the caller is about to throw. Marking it here means
     * the `console.error(..., error)` a screen logs when it catches it is
     * recognised by the console bridge as this same failure and not sent
     * again.
     */
    error?: unknown;
}): string | null {
    scrubber.markReported(failure.error);
    if (!Sentry.isEnabled()) return null;
    const route = normalizeApiPath(failure.path);
    const method = failure.method ?? "GET";
    return Sentry.withScope((scope) => {
        applyContext(scope, {
            level: "error",
            tags: {
                component: "mike-api",
                http_status: failure.status,
                http_method: method,
                http_route: route,
                request_id: failure.requestId,
                error_code: failure.code,
            },
            extra: { path: failure.path },
            fingerprint: ["api-5xx", method, route, String(failure.status)],
        });
        return Sentry.captureMessage(
            `API ${failure.status} on ${method} ${route}`,
            "error",
        );
    });
}

/** Attach (or clear) the signed-in user's id — never the email. */
export function setReportingUser(user: { id: string } | null): void {
    if (!Sentry.isEnabled()) return;
    Sentry.setUser(user ? { id: user.id } : null);
}

/**
 * Browser SDK options. `NEXT_PUBLIC_*` values are inlined at build time, so
 * the caller (instrumentation-client.ts) reads them literally and passes
 * them in; everything policy-shaped is decided here.
 */
export function browserSentryOptions(env: {
    dsn?: string;
    environment?: string;
    release?: string;
    tracesSampleRate?: string;
    nodeEnv?: string;
}): Sentry.BrowserOptions {
    const dsn = env.dsn?.trim() ?? "";
    return {
        dsn: dsn || undefined,
        enabled: dsn.length > 0,
        environment: env.environment?.trim() || env.nodeEnv || "development",
        release: env.release?.trim() || undefined,
        tracesSampleRate: parseSampleRate(env.tracesSampleRate, 0),
        // Session replay is deliberately NOT enabled: it would record
        // privileged document text on screen.
        sendDefaultPii: false,
        integrations: [Sentry.captureConsoleIntegration({ levels: ["error"] })],
        initialScope: { tags: { service: "mike-frontend", runtime: "browser" } },
        beforeSend: scrubEvent,
    };
}

/** Server / edge SDK options; env is read at runtime on the Next server. */
export function serverSentryOptions(
    runtime: "server" | "edge",
    env: NodeJS.ProcessEnv,
): Sentry.NodeOptions {
    const dsn = env.SENTRY_DSN?.trim() ?? "";
    return {
        dsn: dsn || undefined,
        enabled: dsn.length > 0,
        environment:
            env.SENTRY_ENVIRONMENT?.trim() || env.NODE_ENV || "development",
        release: env.SENTRY_RELEASE?.trim() || undefined,
        tracesSampleRate: parseSampleRate(env.SENTRY_TRACES_SAMPLE_RATE, 0),
        sendDefaultPii: false,
        initialScope: { tags: { service: "mike-frontend", runtime } },
        beforeSend: scrubEvent,
    };
}
