import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { NextFunction, Request, Response } from "express";

const mocks = vi.hoisted(() => ({
  verifyToken: vi.fn(),
  single: vi.fn(),
}));

vi.mock("../../src/lib/supabase", () => ({
  verifyToken: mocks.verifyToken,
  createServerSupabase: vi.fn(() => ({
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          single: mocks.single,
        })),
      })),
    })),
  })),
}));

import { requireAuth } from "../../src/middleware/auth";

function makeMockReq(token?: string): Partial<Request> {
  return {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  };
}

function makeMockRes(): {
  res: Partial<Response>;
  statusCode: () => number;
  body: () => unknown;
  locals: Record<string, unknown>;
} {
  let capturedStatus = 200;
  let capturedBody: unknown = null;
  const locals: Record<string, unknown> = {};

  const res: Partial<Response> = {
    locals,
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
    locals,
  };
}

async function runAuth(token?: string) {
  const req = makeMockReq(token);
  const { res, statusCode, body, locals } = makeMockRes();
  const next: NextFunction = vi.fn();

  await requireAuth(req as Request, res as Response, next);

  return { statusCode, body, locals, next };
}

describe("requireAuth failure modes", () => {
  beforeEach(() => {
    mocks.verifyToken.mockReset();
    mocks.single.mockReset();
    mocks.single.mockResolvedValue({ data: null, error: { code: "PGRST116" } });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("missing Authorization header returns 401 and does not call next", async () => {
    const { statusCode, body, next } = await runAuth();

    expect(statusCode()).toBe(401);
    expect((body() as { detail: string }).detail).toBe(
      "Missing or invalid Authorization header",
    );
    expect(next).not.toHaveBeenCalled();
  });

  it("malformed token returns 401 and does not call next", async () => {
    mocks.verifyToken.mockResolvedValue(null);

    const { statusCode, body, next } = await runAuth("malformed-token");

    expect(statusCode()).toBe(401);
    expect((body() as { detail: string }).detail).toBe("Invalid or expired token");
    expect(next).not.toHaveBeenCalled();
  });

  it("expired token returns 401 and does not call next", async () => {
    mocks.verifyToken.mockResolvedValue(null);

    const { statusCode, body, next } = await runAuth("expired-token");

    expect(statusCode()).toBe(401);
    expect((body() as { detail: string }).detail).toBe("Invalid or expired token");
    expect(next).not.toHaveBeenCalled();
  });

  it("missing email returns 401 and does not call next", async () => {
    mocks.verifyToken.mockResolvedValue({ id: "user-no-email", email: "" });

    const { statusCode, body, next } = await runAuth("missing-email-token");

    expect(statusCode()).toBe(401);
    expect((body() as { detail: string }).detail).toBe(
      "Account email not set; contact your operator",
    );
    expect(next).not.toHaveBeenCalled();
  });

  it("valid token sets locals and calls next once", async () => {
    mocks.verifyToken.mockResolvedValue({ id: "user-ok", email: "ok@example.com" });

    const { statusCode, locals, next } = await runAuth("valid-token");

    expect(statusCode()).toBe(200);
    expect(locals.userId).toBe("user-ok");
    expect(locals.userEmail).toBe("ok@example.com");
    expect(locals.token).toBe("valid-token");
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe("Supabase env validation", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  it("missing env vars throw a message containing SUPABASE_URL or SUPABASE_SECRET_KEY", async () => {
    vi.resetModules();
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SECRET_KEY;

    await expect(import("../../src/env")).rejects.toThrow(
      /SUPABASE_URL|SUPABASE_SECRET_KEY/,
    );
  });
});
