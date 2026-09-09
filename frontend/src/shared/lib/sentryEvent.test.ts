import { describe, expect, it } from "vitest";
import {
    CONSOLE_CAPTURE_MECHANISM,
    type ScrubbableEvent,
    createEventScrubber,
    normalizeApiPath,
    parseSampleRate,
    redactSensitiveValues,
} from "./sentryEvent";

describe("redactSensitiveValues", () => {
    it("filters secret-looking keys at any depth and leaves the rest", () => {
        expect(
            redactSensitiveValues({
                note: "keep",
                Authorization: "Bearer x",
                nested: { apiKey: "k", list: [{ refresh_token: "t", n: 1 }] },
            }),
        ).toEqual({
            note: "keep",
            Authorization: "[Filtered]",
            nested: { apiKey: "[Filtered]", list: [{ refresh_token: "[Filtered]", n: 1 }] },
        });
    });

    it("stops descending past the depth cap instead of recursing forever", () => {
        const deep = { a: { b: { c: { d: { e: { f: { g: { h: "x" } } } } } } } };
        expect(JSON.stringify(redactSensitiveValues(deep))).toContain("[Truncated]");
    });

    it("passes primitives through", () => {
        expect(redactSensitiveValues("s")).toBe("s");
        expect(redactSensitiveValues(null)).toBeNull();
    });
});

describe("createEventScrubber", () => {
    it("strips request bodies, cookies, credential headers, and user details", () => {
        const { scrubEvent } = createEventScrubber();
        const event = scrubEvent({
            request: {
                data: "privileged body",
                cookies: { s: "1" },
                headers: { Cookie: "s=1", AUTHORIZATION: "b", accept: "*/*" },
            },
            user: { id: "u1", email: "e@example.com" } as { id: string },
            extra: { password: "p", fine: true },
            contexts: { app: { api_key: "k" } },
            breadcrumbs: [{ data: { token: "t", url: "/x" } }, { message: "m" } as { data?: undefined }],
        })!;
        expect(event.request).toEqual({ headers: { accept: "*/*" } });
        expect(event.user).toEqual({ id: "u1" });
        expect(event.extra).toEqual({ password: "[Filtered]", fine: true });
        expect(event.contexts).toEqual({ app: { api_key: "[Filtered]" } });
        expect(event.breadcrumbs).toEqual([
            { data: { token: "[Filtered]", url: "/x" } },
            { message: "m" },
        ]);
    });

    it("drops a user without an id entirely", () => {
        const { scrubEvent } = createEventScrubber();
        expect(scrubEvent({ user: {} })!.user).toBeUndefined();
    });

    it("leaves an event without optional sections untouched", () => {
        const { scrubEvent } = createEventScrubber();
        expect(scrubEvent({})).toEqual({});
    });

    it("discards the console bridge's copy of an already-reported error only", () => {
        const { markReported, scrubEvent } = createEventScrubber();
        const reported = new Error("reported");
        markReported(reported);
        markReported("not an object");
        const consoleEvent = () => ({
            exception: { values: [{ mechanism: { type: CONSOLE_CAPTURE_MECHANISM } }] },
        });

        expect(scrubEvent(consoleEvent(), { originalException: reported })).toBeNull();
        expect(
            scrubEvent(consoleEvent(), { originalException: new Error("fresh") }),
        ).not.toBeNull();
        expect(scrubEvent(consoleEvent(), { originalException: "string" })).not.toBeNull();
        expect(scrubEvent(consoleEvent())).not.toBeNull();
        // A direct capture of the same error is never a duplicate.
        expect(
            scrubEvent(
                { exception: { values: [{ mechanism: { type: "generic" } }] } },
                { originalException: reported },
            ),
        ).not.toBeNull();
    });
});

describe("per-issue flood control", () => {
    const exceptionEvent = (value: string, component = "x"): ScrubbableEvent => ({
        exception: { values: [{ type: "Error", value }] },
        tags: { component },
    });

    it("passes the first N events of an issue per minute and drops the rest", () => {
        let clock = 1_000;
        const { scrubEvent } = createEventScrubber({
            maxEventsPerIssuePerMinute: 2,
            now: () => clock,
        });
        expect(scrubEvent(exceptionEvent("loop"))).not.toBeNull();
        expect(scrubEvent(exceptionEvent("loop"))).not.toBeNull();
        expect(scrubEvent(exceptionEvent("loop"))).toBeNull();
        // Other issues keep their own budget.
        expect(scrubEvent(exceptionEvent("other"))).not.toBeNull();
        expect(scrubEvent(exceptionEvent("loop", "y"))).not.toBeNull();
        expect(scrubEvent({ message: "plain" })).not.toBeNull();
        // Window rollover.
        clock += 60_000;
        expect(scrubEvent(exceptionEvent("loop"))).not.toBeNull();
    });

    it("keys on the fingerprint when present", () => {
        const { scrubEvent } = createEventScrubber({ maxEventsPerIssuePerMinute: 1 });
        expect(
            scrubEvent({ fingerprint: ["api-5xx"], message: "a" }),
        ).not.toBeNull();
        expect(scrubEvent({ fingerprint: ["api-5xx"], message: "b" })).toBeNull();
    });

    it("defaults to ten per minute", () => {
        const { scrubEvent } = createEventScrubber();
        for (let i = 0; i < 10; i += 1) {
            expect(scrubEvent(exceptionEvent("ten"))).not.toBeNull();
        }
        expect(scrubEvent(exceptionEvent("ten"))).toBeNull();
    });
});

describe("console bridge post-processing", () => {
    const consoleHint = (args: unknown[]) => ({
        captureContext: { extra: { arguments: args } },
    });

    it("drops a console message whose logged object wraps a reported error", () => {
        const { markReported, scrubEvent } = createEventScrubber();
        const error = new Error("nested");
        markReported(error);
        expect(
            scrubEvent(
                { logger: "console", message: "[x] failed [object Object]" },
                consoleHint(["[x] failed", { id: 1, error }]),
            ),
        ).toBeNull();
    });

    it("retitles a message around an unreported nested error and groups by label", () => {
        const { scrubEvent } = createEventScrubber();
        const error = new RangeError("too deep");
        const event: ScrubbableEvent = {
            logger: "console",
            message: "[x] failed [object Object]",
            extra: {},
        };
        const scrubbed = scrubEvent(event, consoleHint(["[x]", "failed", { cause: { error } }]))!;
        expect(scrubbed.message).toBe("[x] failed: RangeError: too deep");
        expect(scrubbed.fingerprint).toEqual(["console", "[x] failed", "RangeError"]);
        expect(scrubbed.extra?.error_stack).toContain("RangeError: too deep");
    });

    it("does not retitle when the only error is a top-level argument (already an exception event)", () => {
        const { scrubEvent } = createEventScrubber();
        const scrubbed = scrubEvent(
            { logger: "console", message: "kept" },
            consoleHint(["label", new Error("top")]),
        )!;
        expect(scrubbed.message).toBe("kept");
    });

    it("ignores non-console events and malformed hints", () => {
        const { scrubEvent } = createEventScrubber();
        expect(
            scrubEvent({ message: "m" }, consoleHint([{ error: new Error("x") }]))!
                .message,
        ).toBe("m");
        expect(
            scrubEvent(
                { logger: "console", message: "m" },
                { captureContext: { extra: { arguments: "nope" } } },
            )!.message,
        ).toBe("m");
        expect(
            scrubEvent({ logger: "console", message: "m" }, { captureContext: null })!
                .message,
        ).toBe("m");
        expect(
            scrubEvent({ logger: "console", message: "m" }, consoleHint(["a", 1, null]))!
                .message,
        ).toBe("m");
    });

    it("stops searching past two levels of nesting", () => {
        const { scrubEvent } = createEventScrubber();
        const scrubbed = scrubEvent(
            { logger: "console", message: "m" },
            consoleHint([{ a: { b: { c: new Error("deep") } } }]),
        )!;
        expect(scrubbed.message).toBe("m");
    });
});

describe("normalizeApiPath", () => {
    it("replaces uuids and numeric segments and drops the query string", () => {
        expect(
            normalizeApiPath(
                "/projects/8f1c2a3e-1234-4bcd-9e0f-1234567890ab/documents/42?x=1",
            ),
        ).toBe("/projects/:id/documents/:id");
        expect(normalizeApiPath("/user/profile")).toBe("/user/profile");
    });
});

describe("parseSampleRate", () => {
    it("clamps to [0, 1] and falls back on junk", () => {
        expect(parseSampleRate(undefined, 0.2)).toBe(0.2);
        expect(parseSampleRate("abc", 0.2)).toBe(0.2);
        expect(parseSampleRate("5", 0)).toBe(1);
        expect(parseSampleRate("-1", 0)).toBe(0);
        expect(parseSampleRate("0.5", 0)).toBe(0.5);
    });
});
