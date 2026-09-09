import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A fake scope records what reportError() sets so the assertions can check
// tags/extra/level land on the event rather than on a global scope.
type FakeScope = {
  setLevel: ReturnType<typeof vi.fn>;
  setTag: ReturnType<typeof vi.fn>;
  setExtra: ReturnType<typeof vi.fn>;
  setFingerprint: ReturnType<typeof vi.fn>;
  setUser: ReturnType<typeof vi.fn>;
};

const scopes: FakeScope[] = [];
const isolationScope: FakeScope = {
  setLevel: vi.fn(),
  setTag: vi.fn(),
  setExtra: vi.fn(),
  setFingerprint: vi.fn(),
  setUser: vi.fn(),
};

const sentryMock = vi.hoisted(() => ({
  init: vi.fn(),
  captureException: vi.fn(() => "event-id-1"),
  captureMessage: vi.fn(() => "event-id-2"),
  flush: vi.fn(() => Promise.resolve(true)),
  httpIntegration: vi.fn((opts: unknown) => ({ name: "Http", opts })),
  captureConsoleIntegration: vi.fn((opts: unknown) => ({
    name: "CaptureConsole",
    opts,
  })),
}));

vi.mock("@sentry/node", () => ({
  ...sentryMock,
  withScope: (cb: (scope: FakeScope) => unknown) => {
    const scope: FakeScope = {
      setLevel: vi.fn(),
      setTag: vi.fn(),
      setExtra: vi.fn(),
      setFingerprint: vi.fn(),
      setUser: vi.fn(),
    };
    scopes.push(scope);
    return cb(scope);
  },
  getIsolationScope: () => isolationScope,
}));

import * as Sentry from "@sentry/node";
import {
  flushSentry,
  initSentry,
  isSentryEnabled,
  reportError,
  reportMessage,
  resetSentryForTests,
  scrubEvent,
  sentryConfiguration,
  setCurrentUser,
  tagCurrentRequest,
  withinIssueBudget,
} from "./sentry";

// Unit tests run with NODE_ENV=test, which disables reporting by design; the
// cases that exercise the enabled path opt back in explicitly.
const quietEnv = {
  NODE_ENV: "test",
  SENTRY_ALLOW_IN_TESTS: "true",
} as NodeJS.ProcessEnv;

beforeEach(() => {
  resetSentryForTests();
  scopes.length = 0;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("sentryConfiguration", () => {
  it("is disabled without a DSN and falls back to NODE_ENV for the environment", () => {
    const config = sentryConfiguration({ NODE_ENV: "production" } as NodeJS.ProcessEnv);
    expect(config.enabled).toBe(false);
    expect(config.dsn).toBe("");
    expect(config.environment).toBe("production");
    expect(config.tracesSampleRate).toBe(0);
    expect(config.release).toBeUndefined();
  });

  it("reads the DSN, environment, release, and clamps the sample rate", () => {
    const config = sentryConfiguration({
      SENTRY_DSN: " https://key@o1.ingest.sentry.io/1 ",
      SENTRY_ENVIRONMENT: "staging",
      SENTRY_RELEASE: "mike@1.2.3",
      SENTRY_TRACES_SAMPLE_RATE: "7",
    } as NodeJS.ProcessEnv);
    expect(config.enabled).toBe(true);
    expect(config.dsn).toBe("https://key@o1.ingest.sentry.io/1");
    expect(config.environment).toBe("staging");
    expect(config.release).toBe("mike@1.2.3");
    expect(config.tracesSampleRate).toBe(1);
  });

  it("never enables inside a test process unless explicitly allowed", () => {
    const dsn = "https://key@o1.ingest.sentry.io/1";
    expect(
      sentryConfiguration({ SENTRY_DSN: dsn, NODE_ENV: "test" } as NodeJS.ProcessEnv)
        .enabled,
    ).toBe(false);
    expect(
      sentryConfiguration({ SENTRY_DSN: dsn, VITEST: "true" } as NodeJS.ProcessEnv)
        .enabled,
    ).toBe(false);
    expect(
      sentryConfiguration({
        SENTRY_DSN: dsn,
        NODE_ENV: "test",
        SENTRY_ALLOW_IN_TESTS: "true",
      } as NodeJS.ProcessEnv).enabled,
    ).toBe(true);
  });

  it("reads the per-issue budget with a sane default", () => {
    expect(sentryConfiguration({} as NodeJS.ProcessEnv).maxEventsPerIssuePerMinute).toBe(10);
    expect(
      sentryConfiguration({ SENTRY_MAX_EVENTS_PER_ISSUE_PER_MINUTE: "3" } as NodeJS.ProcessEnv)
        .maxEventsPerIssuePerMinute,
    ).toBe(3);
    expect(
      sentryConfiguration({ SENTRY_MAX_EVENTS_PER_ISSUE_PER_MINUTE: "-2" } as NodeJS.ProcessEnv)
        .maxEventsPerIssuePerMinute,
    ).toBe(10);
  });

  it("ignores a non-numeric sample rate", () => {
    const config = sentryConfiguration({
      SENTRY_TRACES_SAMPLE_RATE: "lots",
    } as NodeJS.ProcessEnv);
    expect(config.tracesSampleRate).toBe(0);
  });
});

describe("initSentry", () => {
  it("does nothing without a DSN so tests and OSS installs never phone home", () => {
    expect(initSentry("api", { NODE_ENV: "test" } as NodeJS.ProcessEnv)).toBe(false);
    expect(isSentryEnabled()).toBe(false);
    expect(Sentry.init).not.toHaveBeenCalled();
  });

  it("initialises once with PII off, body capture off, and the console bridge on", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const env = {
      ...quietEnv,
      SENTRY_DSN: "https://key@o1.ingest.sentry.io/1",
      SENTRY_ENVIRONMENT: "staging",
    } as NodeJS.ProcessEnv;

    expect(initSentry("worker", env)).toBe(true);
    expect(initSentry("worker", env)).toBe(true);
    expect(isSentryEnabled()).toBe(true);
    expect(Sentry.init).toHaveBeenCalledOnce();

    const options = vi.mocked(Sentry.init).mock.calls[0][0]!;
    expect(options.sendDefaultPii).toBe(false);
    expect(options.environment).toBe("staging");
    expect(options.beforeSend).toBe(scrubEvent);
    expect(options.initialScope).toEqual({
      tags: { service: "mike-backend", role: "worker" },
    });
    expect(sentryMock.httpIntegration).toHaveBeenCalledWith({
      maxIncomingRequestBodySize: "none",
    });
    expect(sentryMock.captureConsoleIntegration).toHaveBeenCalledWith({
      levels: ["error"],
    });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("enabled for worker"));
    log.mockRestore();
  });
});

describe("scrubEvent", () => {
  it("strips request bodies, cookies, and credential headers", () => {
    const event = {
      request: {
        url: "https://api.example/projects",
        method: "POST",
        data: { document: "privileged contract text" },
        cookies: { session: "abc" },
        headers: {
          Authorization: "Bearer secret",
          Cookie: "session=abc",
          "content-type": "application/json",
        },
      },
      user: { id: "user-1", email: "person@example.com", ip_address: "1.2.3.4" },
      extra: {
        nested: { api_key: "k", refreshToken: "t", note: "keep" },
        list: [{ password: "p" }],
      },
      breadcrumbs: [{ message: "x", data: { cookie: "c", ok: 1 } }],
    } as unknown as Parameters<typeof scrubEvent>[0];

    const scrubbed = scrubEvent(event, {})!;

    expect(scrubbed.request).toEqual({
      url: "https://api.example/projects",
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    expect(scrubbed.user).toEqual({ id: "user-1" });
    expect(scrubbed.extra).toEqual({
      nested: { api_key: "[Filtered]", refreshToken: "[Filtered]", note: "keep" },
      list: [{ password: "[Filtered]" }],
    });
    expect(scrubbed.breadcrumbs).toEqual([
      { message: "x", data: { cookie: "[Filtered]", ok: 1 } },
    ]);
  });

  it("drops a user record that has no id rather than sending email alone", () => {
    const scrubbed = scrubEvent(
      { user: { email: "person@example.com" } } as Parameters<typeof scrubEvent>[0],
      {},
    )!;
    expect(scrubbed.user).toBeUndefined();
  });

  it("drops the console bridge's duplicate of an explicitly reported error", () => {
    const error = new Error("boom");
    reportError(error); // disabled → still marks the error as reported
    const consoleEvent = {
      exception: {
        values: [{ mechanism: { type: "auto.core.capture_console" } }],
      },
    } as Parameters<typeof scrubEvent>[0];

    expect(scrubEvent(consoleEvent, { originalException: error })).toBeNull();
    expect(
      scrubEvent(consoleEvent, { originalException: new Error("other") }),
    ).not.toBeNull();
  });

  it("drops a console message whose logged object wraps an already-reported error", () => {
    const error = new Error("nested");
    reportError(error);
    const event = {
      logger: "console",
      message: "[dbq] job failed [object Object]",
    } as Parameters<typeof scrubEvent>[0];

    expect(
      scrubEvent(event, {
        captureContext: {
          extra: { arguments: ["[dbq] job failed", { id: "j1", error }] },
        },
      }),
    ).toBeNull();
  });

  it("retitles a console message around an unreported nested error and groups by label", () => {
    const error = new TypeError("column does not exist");
    const event = {
      logger: "console",
      message: "[library] failed to load [object Object]",
      extra: { arguments: ["[library] failed to load", { error: "<normalised>" }] },
    } as Parameters<typeof scrubEvent>[0];

    const scrubbed = scrubEvent(event, {
      captureContext: {
        extra: { arguments: ["[library] failed to load", { error }] },
      },
    })!;

    expect(scrubbed.message).toBe(
      "[library] failed to load: TypeError: column does not exist",
    );
    expect(scrubbed.fingerprint).toEqual([
      "console",
      "[library] failed to load",
      "TypeError",
    ]);
    expect(scrubbed.extra?.error_stack).toContain("TypeError: column does not exist");
  });

  it("leaves a console message without any error in its arguments alone", () => {
    const event = {
      logger: "console",
      message: "[dbq] claim failed relation missing",
    } as Parameters<typeof scrubEvent>[0];
    const scrubbed = scrubEvent(event, {
      captureContext: { extra: { arguments: ["[dbq] claim failed", "relation missing"] } },
    })!;
    expect(scrubbed.message).toBe("[dbq] claim failed relation missing");
    expect(scrubbed.fingerprint).toBeUndefined();
  });

  it("keeps a directly captured event even if the same error was reported before", () => {
    const error = new Error("boom");
    reportError(error);
    const direct = {
      exception: { values: [{ mechanism: { type: "generic" } }] },
    } as Parameters<typeof scrubEvent>[0];
    expect(scrubEvent(direct, { originalException: error })).not.toBeNull();
  });
});

describe("per-issue flood control", () => {
  const exceptionEvent = (value: string, component = "dbq") =>
    ({
      exception: { values: [{ type: "Error", value }] },
      tags: { component },
    }) as unknown as Parameters<typeof scrubEvent>[0];

  it("lets the first ten events of an issue through per minute and drops the rest", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t0 = 1_000_000;
    for (let i = 0; i < 10; i += 1) {
      expect(withinIssueBudget(exceptionEvent("fetch failed"), t0 + i)).toBe(true);
    }
    expect(withinIssueBudget(exceptionEvent("fetch failed"), t0 + 11)).toBe(false);
    expect(withinIssueBudget(exceptionEvent("fetch failed"), t0 + 12)).toBe(false);
    // A different issue has its own budget.
    expect(withinIssueBudget(exceptionEvent("other"), t0 + 13)).toBe(true);
    expect(withinIssueBudget(exceptionEvent("fetch failed", "upload-worker"), t0 + 14)).toBe(true);
    // The window rolls over: allowed again, and the suppression is logged once.
    expect(withinIssueBudget(exceptionEvent("fetch failed"), t0 + 60_001)).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("suppressed 2 further event(s)"),
    );
    warn.mockRestore();
  });

  it("keys on the fingerprint when one is set and on the message otherwise", () => {
    const t0 = 5_000_000;
    const fingerprinted = {
      fingerprint: ["dbq-claim-failed"],
      exception: { values: [{ type: "Error", value: "a" }] },
    } as unknown as Parameters<typeof scrubEvent>[0];
    const differentValueSameFingerprint = {
      fingerprint: ["dbq-claim-failed"],
      exception: { values: [{ type: "Error", value: "b" }] },
    } as unknown as Parameters<typeof scrubEvent>[0];
    for (let i = 0; i < 10; i += 1) withinIssueBudget(fingerprinted, t0 + i);
    expect(withinIssueBudget(differentValueSameFingerprint, t0 + 20)).toBe(false);

    const message = { message: "odd state" } as Parameters<typeof scrubEvent>[0];
    for (let i = 0; i < 10; i += 1) withinIssueBudget(message, t0 + i);
    expect(withinIssueBudget(message, t0 + 20)).toBe(false);
  });

  it("is enforced by scrubEvent", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    for (let i = 0; i < 10; i += 1) {
      expect(scrubEvent(exceptionEvent("loop"), {})).not.toBeNull();
    }
    expect(scrubEvent(exceptionEvent("loop"), {})).toBeNull();
  });

  it("honours the configured budget after init", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    initSentry("api", {
      ...quietEnv,
      SENTRY_DSN: "https://key@o1.ingest.sentry.io/1",
      SENTRY_ALLOW_IN_TESTS: "true",
      SENTRY_MAX_EVENTS_PER_ISSUE_PER_MINUTE: "2",
    } as NodeJS.ProcessEnv);
    expect(withinIssueBudget(exceptionEvent("x"))).toBe(true);
    expect(withinIssueBudget(exceptionEvent("x"))).toBe(true);
    expect(withinIssueBudget(exceptionEvent("x"))).toBe(false);
  });
});

describe("reportError / reportMessage", () => {
  it("returns null and captures nothing while disabled", () => {
    expect(reportError(new Error("x"), { tags: { a: "b" } })).toBeNull();
    expect(reportMessage("x")).toBeNull();
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  it("captures with tags, extra, level, and fingerprint on an isolated scope", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    initSentry("api", {
      ...quietEnv,
      SENTRY_DSN: "https://key@o1.ingest.sentry.io/1",
    } as NodeJS.ProcessEnv);
    const error = new Error("job exploded");

    const id = reportError(error, {
      level: "warning",
      tags: { component: "dbq", attempt: 2, skipped: undefined, gone: null },
      extra: { job_id: "j1" },
      fingerprint: ["dbq", "kind"],
    });

    expect(id).toBe("event-id-1");
    expect(Sentry.captureException).toHaveBeenCalledWith(error);
    const scope = scopes[0];
    expect(scope.setLevel).toHaveBeenCalledWith("warning");
    expect(scope.setFingerprint).toHaveBeenCalledWith(["dbq", "kind"]);
    expect(scope.setTag).toHaveBeenCalledWith("component", "dbq");
    expect(scope.setTag).toHaveBeenCalledWith("attempt", 2);
    expect(scope.setTag).not.toHaveBeenCalledWith("skipped", expect.anything());
    expect(scope.setTag).not.toHaveBeenCalledWith("gone", expect.anything());
    expect(scope.setExtra).toHaveBeenCalledWith("job_id", "j1");
  });

  it("wraps a non-Error throwable so Sentry still gets a stack", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    initSentry("api", {
      ...quietEnv,
      SENTRY_DSN: "https://key@o1.ingest.sentry.io/1",
    } as NodeJS.ProcessEnv);

    reportError({ code: "weird" });

    const captured = vi.mocked(Sentry.captureException).mock.calls[0][0];
    expect(captured).toBeInstanceOf(Error);
    expect((captured as Error).message).toBe('{"code":"weird"}');
  });

  it("sends messages at the requested level", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    initSentry("api", {
      ...quietEnv,
      SENTRY_DSN: "https://key@o1.ingest.sentry.io/1",
    } as NodeJS.ProcessEnv);

    reportMessage("odd state", { level: "warning", tags: { component: "http" } });

    expect(Sentry.captureMessage).toHaveBeenCalledWith("odd state", "warning");
    expect(scopes[0].setTag).toHaveBeenCalledWith("component", "http");
  });
});

describe("request context helpers", () => {
  it("are no-ops while disabled", async () => {
    tagCurrentRequest("req-1");
    setCurrentUser("user-1");
    await flushSentry();
    expect(isolationScope.setTag).not.toHaveBeenCalled();
    expect(isolationScope.setUser).not.toHaveBeenCalled();
    expect(Sentry.flush).not.toHaveBeenCalled();
  });

  it("tag the isolation scope and flush when enabled", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    initSentry("api", {
      ...quietEnv,
      SENTRY_DSN: "https://key@o1.ingest.sentry.io/1",
    } as NodeJS.ProcessEnv);

    tagCurrentRequest("req-1");
    setCurrentUser("user-1");
    setCurrentUser(null);
    await flushSentry(50);

    expect(isolationScope.setTag).toHaveBeenCalledWith("request_id", "req-1");
    expect(isolationScope.setUser).toHaveBeenCalledWith({ id: "user-1" });
    expect(isolationScope.setUser).toHaveBeenLastCalledWith(null);
    expect(Sentry.flush).toHaveBeenCalledWith(50);
  });

  it("swallows a flush failure so shutdown still exits", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    initSentry("api", {
      ...quietEnv,
      SENTRY_DSN: "https://key@o1.ingest.sentry.io/1",
    } as NodeJS.ProcessEnv);
    sentryMock.flush.mockRejectedValueOnce(new Error("transport down"));
    await expect(flushSentry()).resolves.toBeUndefined();
  });
});
