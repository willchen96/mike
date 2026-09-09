import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";

// The route is registered at import time behind an env flag, so the flag has
// to be set before app.ts evaluates — hence the dynamic import below.
const reportError = vi.hoisted(() => vi.fn(() => "event-1"));
const reportMessage = vi.hoisted(() => vi.fn(() => "event-2"));
const tagCurrentRequest = vi.hoisted(() => vi.fn());
vi.mock("../../lib/observability/sentry", () => ({
  reportError,
  reportMessage,
  tagCurrentRequest,
  setCurrentUser: vi.fn(),
}));

let app: typeof import("../../app").app;

beforeAll(async () => {
  process.env.SENTRY_ENABLE_TEST_ROUTE = "true";
  ({ app } = await import("../../app"));
});

afterAll(() => {
  delete process.env.SENTRY_ENABLE_TEST_ROUTE;
});

describe("GET /observability/sentry-test", () => {
  it("throws through the real 500 path and reports with the response's request id", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    const res = await request(app).get("/observability/sentry-test");

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      code: "internal_error",
      detail: "Something went wrong. Please try again.",
      request_id: res.headers["x-request-id"],
    });
    // The id was attached to the Sentry scope by the request-id middleware…
    expect(tagCurrentRequest).toHaveBeenCalledWith(res.headers["x-request-id"]);
    // …and the thrown error reached the reporter through handleUnhandledError.
    expect(reportError).toHaveBeenCalledOnce();
    const [error, context] = reportError.mock.calls[0] as unknown as [
      Error,
      { tags: Record<string, unknown> },
    ];
    expect(error.message).toContain("Sentry backend test error");
    expect(context.tags).toMatchObject({
      component: "http",
      http_status: 500,
      request_id: res.headers["x-request-id"],
      http_method: "GET",
    });
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
