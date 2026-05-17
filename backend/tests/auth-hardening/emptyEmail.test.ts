/**
 * CLEAN-14 — requireAuth returns 401 for empty-email users.
 *
 * Before this fix, a user with email = "" would pass `requireAuth` and then be
 * silently denied inside access.ts:51-55 — the caller saw a 404 instead of a
 * 401.  After the fix, the 401 is returned from the middleware itself.
 *
 * Strategy: call `requireAuth` directly with mock Express req/res objects and
 * a stubbed `verifyToken` so no real network is needed.  The middleware is
 * the unit under test; the Express router layer is not.
 *
 * Note: supertest (HTTP server) tests for this middleware would require
 * binding to a network port, which may be restricted in some CI environments.
 * The middleware-unit approach is equivalent and more portable.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

// Stub verifyToken BEFORE the middleware is imported so it picks up the mock.
vi.mock("../../src/lib/supabase", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/supabase")>();
  return {
    ...original,
    verifyToken: vi.fn(),
  };
});

import { verifyToken } from "../../src/lib/supabase";
import { requireAuth } from "../../src/middleware/auth";
import type { Request, Response, NextFunction } from "express";

const mockVerifyToken = verifyToken as ReturnType<typeof vi.fn>;

/**
 * Builds a minimal mock Express request with an Authorization header.
 */
function makeMockReq(token: string): Partial<Request> {
  return {
    headers: { authorization: `Bearer ${token}` },
  };
}

/**
 * Builds a minimal mock Express response that captures status + JSON payload.
 */
function makeMockRes(): {
  res: Partial<Response>;
  statusCode: () => number;
  body: () => unknown;
} {
  let capturedStatus = 200;
  let capturedBody: unknown = null;

  const res: Partial<Response> = {
    locals: {},
    status(code: number) {
      capturedStatus = code;
      return this as Response;
    },
    json(data: unknown) {
      capturedBody = data;
      return this as Response;
    },
  };

  return {
    res,
    statusCode: () => capturedStatus,
    body: () => capturedBody,
  };
}

describe("requireAuth — empty-email user is rejected with 401", () => {
  beforeAll(() => {
    // Simulate verifyToken returning a user with no email.
    mockVerifyToken.mockResolvedValue({ id: "user-no-email", email: "" });
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it("returns 401 (not 404) when the authenticated user has an empty email", async () => {
    const req = makeMockReq("fake-token-empty-email");
    const { res, statusCode, body } = makeMockRes();
    const next: NextFunction = vi.fn();

    await requireAuth(req as Request, res as Response, next);

    expect(statusCode()).toBe(401);
    expect((body() as { detail: string }).detail).toBe(
      "Account email not set; contact your operator",
    );
    // next() should NOT have been called — the request was rejected.
    expect(next).not.toHaveBeenCalled();
  });

  it("does NOT call next() (the old silent-deny path through access.ts would have called it)", async () => {
    const req = makeMockReq("fake-token-empty-email");
    const { res } = makeMockRes();
    const next: NextFunction = vi.fn();

    await requireAuth(req as Request, res as Response, next);

    // If next() had been called, access.ts would receive the request with no
    // email and silently return 404.  We assert it is never called.
    expect(next).not.toHaveBeenCalled();
  });
});
