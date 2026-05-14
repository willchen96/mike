import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Request, Response, NextFunction } from "express";

// ── module mock (hoisted before any imports that load auth.ts) ────────────────
//
// `requireAuth` creates a new Supabase client on every call, so we mock the
// factory rather than the client instance.  vi.hoisted ensures the mock
// function exists before the module graph is resolved.

const mockGetUser = vi.hoisted(() => vi.fn());

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    auth: { getUser: mockGetUser },
  })),
}));

import { requireAuth } from "../../src/middleware/auth";

// ── request / response helpers ────────────────────────────────────────────────

function mockReq(headers: Record<string, string> = {}): Request {
  return { headers } as Request;
}

function mockRes() {
  const res = { locals: {} as Record<string, unknown> } as unknown as Response;
  const json = vi.fn().mockReturnValue(res);
  const status = vi.fn().mockReturnValue({ json });
  Object.assign(res, { status, json });
  return { res, status, json };
}

// ── requireAuth ───────────────────────────────────────────────────────────────

describe("requireAuth middleware", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    vi.clearAllMocks();
    // Save and set required env vars
    savedEnv.SUPABASE_URL = process.env.SUPABASE_URL;
    savedEnv.SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
    process.env.SUPABASE_URL = "https://test.supabase.co";
    process.env.SUPABASE_SECRET_KEY = "test-service-role-key";
  });

  afterEach(() => {
    process.env.SUPABASE_URL = savedEnv.SUPABASE_URL;
    process.env.SUPABASE_SECRET_KEY = savedEnv.SUPABASE_SECRET_KEY;
  });

  it("returns 401 when the Authorization header is absent", async () => {
    const req = mockReq({});
    const { res, status, json } = mockRes();
    const next = vi.fn() as unknown as NextFunction;

    await requireAuth(req, res, next);

    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ detail: expect.any(String) }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 when the header value does not start with 'Bearer '", async () => {
    const req = mockReq({ authorization: "Token abc123" });
    const { res, status, json } = mockRes();
    const next = vi.fn() as unknown as NextFunction;

    await requireAuth(req, res, next);

    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ detail: expect.any(String) }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 500 when SUPABASE_URL is not configured", async () => {
    delete process.env.SUPABASE_URL;
    const req = mockReq({ authorization: "Bearer some-token" });
    const { res, status, json } = mockRes();
    const next = vi.fn() as unknown as NextFunction;

    await requireAuth(req, res, next);

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ detail: expect.any(String) }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 500 when SUPABASE_SECRET_KEY is not configured", async () => {
    delete process.env.SUPABASE_SECRET_KEY;
    const req = mockReq({ authorization: "Bearer some-token" });
    const { res, status, json } = mockRes();
    const next = vi.fn() as unknown as NextFunction;

    await requireAuth(req, res, next);

    expect(status).toHaveBeenCalledWith(500);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 when the token is invalid or expired (getUser returns no user)", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });

    const req = mockReq({ authorization: "Bearer expired-token" });
    const { res, status } = mockRes();
    const next = vi.fn() as unknown as NextFunction;

    await requireAuth(req, res, next);

    expect(status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("populates res.locals and calls next() for a valid token", async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: "user-uuid-123", email: "User@Example.com" } },
      error: null,
    });

    const req = mockReq({ authorization: "Bearer valid-token-abc" });
    const { res } = mockRes();
    const next = vi.fn() as unknown as NextFunction;

    await requireAuth(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect((res as unknown as Record<string, unknown>).locals).toMatchObject({
      userId: "user-uuid-123",
      userEmail: "user@example.com", // must be lowercased
      token: "valid-token-abc",
    });
  });

  it("lowercases userEmail regardless of the casing returned by Supabase", async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: "user-uuid-456", email: "CAPITAL@EXAMPLE.COM" } },
      error: null,
    });

    const req = mockReq({ authorization: "Bearer another-token" });
    const { res } = mockRes();
    const next = vi.fn() as unknown as NextFunction;

    await requireAuth(req, res, next);

    expect((res as unknown as Record<string, unknown>).locals).toMatchObject({
      userEmail: "capital@example.com",
    });
  });
});
