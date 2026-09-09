import { afterEach, describe, expect, it, vi } from "vitest";

const reportError = vi.hoisted(() => vi.fn(() => "event-1"));
vi.mock("./observability/sentry", () => ({ reportError }));

import express from "express";
import request from "supertest";
import { sendInternalError } from "./httpError";

function appThatFails(error: unknown, status?: number) {
  const app = express();
  app.use((_req, res, next) => {
    res.locals.requestId = "req-abc";
    next();
  });
  app.get("/projects/:projectId", (_req, res) => {
    sendInternalError(res, error, status);
  });
  return app;
}

describe("sendInternalError", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("reports the error to Sentry with the request id and route pattern, then answers 500", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const failure = new Error("relation private_table does not exist");

    const res = await request(appThatFails(failure)).get("/projects/p-123?x=1");

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      code: "internal_error",
      detail: "Something went wrong. Please try again.",
      request_id: "req-abc",
    });
    expect(reportError).toHaveBeenCalledOnce();
    expect(reportError).toHaveBeenCalledWith(failure, {
      tags: {
        component: "http",
        http_status: 500,
        request_id: "req-abc",
        http_method: "GET",
        // Grouping key: the Express route pattern, not the concrete URL.
        http_route: "/projects/:projectId",
      },
      extra: { path: "/projects/p-123?x=1" },
    });
    // Report first, log second: the console bridge must see a known error.
    expect(reportError.mock.invocationCallOrder[0]).toBeLessThan(
      consoleError.mock.invocationCallOrder[0],
    );
  });

  it("passes a non-default status through to the report", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await request(appThatFails(new Error("upstream"), 503)).get(
      "/projects/p-1",
    );

    expect(res.status).toBe(503);
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ http_status: 503 }),
      }),
    );
  });
});
