/**
 * Error reporting for the Word add-in. Same policy as the web app (see
 * frontend/src/app/lib/errorReporting.ts and the shared scrubber it uses):
 * off without a DSN, no PII beyond the user id, every console.error bridged,
 * explicit reports deduplicated against the bridge.
 *
 * The add-in adds one thing the web app does not have: the Office host. A
 * bug that only reproduces in Word on Mac 16.x or Word on the web is
 * invisible without those tags, so they are attached as soon as Office.js
 * reports them.
 */
import * as Sentry from "@sentry/react";
import {
  createEventScrubber,
  normalizeApiPath,
  parseSampleRate,
} from "@mike/sentry-event";

export type ReportLevel = "fatal" | "error" | "warning";

export type ReportContext = {
  tags?: Record<string, string | number | boolean | null | undefined>;
  extra?: Record<string, unknown>;
  level?: ReportLevel;
  fingerprint?: string[];
};

const scrubber = createEventScrubber();

export const scrubEvent = scrubber.scrubEvent;

/** `service`/`surface` distinguish the pane from its ribbon and OAuth pages. */
export type AddinSurface = "taskpane" | "commands" | "oauth-dialog";

export function addinSentryOptions(
  surface: AddinSurface,
  env: {
    dsn?: string;
    environment?: string;
    release?: string;
    tracesSampleRate?: string;
    nodeEnv?: string;
  },
): Sentry.BrowserOptions {
  const dsn = env.dsn?.trim() ?? "";
  return {
    dsn: dsn || undefined,
    enabled: dsn.length > 0,
    environment: env.environment?.trim() || env.nodeEnv || "development",
    release: env.release?.trim() || undefined,
    tracesSampleRate: parseSampleRate(env.tracesSampleRate, 0),
    // No session replay: the pane sits next to a privileged document.
    sendDefaultPii: false,
    integrations: [Sentry.captureConsoleIntegration({ levels: ["error"] })],
    initialScope: { tags: { service: "mike-word-addin", surface } },
    beforeSend: scrubEvent,
  };
}

/** Initialise once per bundle entry (task pane, commands, OAuth dialog). */
export function initAddinErrorReporting(surface: AddinSurface): boolean {
  const options = addinSentryOptions(surface, {
    dsn: process.env.REACT_APP_SENTRY_DSN,
    environment: process.env.REACT_APP_SENTRY_ENVIRONMENT,
    release: process.env.REACT_APP_SENTRY_RELEASE,
    tracesSampleRate: process.env.REACT_APP_SENTRY_TRACES_SAMPLE_RATE,
    nodeEnv: process.env.NODE_ENV,
  });
  if (!options.enabled) return false;
  Sentry.init(options);
  return true;
}

/**
 * Tag every event with the Office host once Office.js knows it. Called from
 * Office.onReady; a pane running outside Office (the e2e harness) simply
 * has no diagnostics and gets no tags.
 */
export function tagOfficeHost(): void {
  if (!Sentry.isEnabled()) return;
  const diagnostics = (
    globalThis as {
      Office?: {
        context?: {
          diagnostics?: { host?: unknown; platform?: unknown; version?: unknown };
        };
      };
    }
  ).Office?.context?.diagnostics;
  if (!diagnostics) return;
  const scope = Sentry.getCurrentScope();
  if (diagnostics.host != null) scope.setTag("office_host", String(diagnostics.host));
  if (diagnostics.platform != null) {
    scope.setTag("office_platform", String(diagnostics.platform));
  }
  if (diagnostics.version != null) {
    scope.setTag("office_version", String(diagnostics.version));
  }
}

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

/** Report BEFORE the accompanying console.error (bridge dedupe). */
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

/** A backend 5xx seen from the pane, correlated by the backend's request id. */
export function reportApiFailure(failure: {
  path: string;
  status: number;
  code?: string | null;
  requestId?: string | null;
  method?: string;
  /** The error about to be thrown; its later console.error copy is dropped. */
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

/**
 * The request never reached the server (dead backend, blocked origin, TLS).
 * Not a code bug, but in a Word pane it is the failure users see most and
 * cannot diagnose, so it is tracked as a warning grouped per endpoint.
 */
export function reportNetworkFailure(
  error: unknown,
  request: { method: string; url: string },
): string | null {
  scrubber.markReported(error);
  if (!Sentry.isEnabled()) return null;
  const route = normalizeApiPath(request.url);
  return Sentry.withScope((scope) => {
    applyContext(scope, {
      level: "warning",
      tags: { component: "mike-api", network: true, http_method: request.method, http_route: route },
      extra: { url: request.url },
      fingerprint: ["api-network", request.method, route],
    });
    return Sentry.captureException(error);
  });
}

/** Attach (or clear) the signed-in user's id — never the email. */
export function setReportingUser(user: { id: string } | null): void {
  if (!Sentry.isEnabled()) return;
  Sentry.setUser(user ? { id: user.id } : null);
}

export const ErrorBoundary = Sentry.ErrorBoundary;
