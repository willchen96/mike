/**
 * CLEAN-44 — requireAuth gate for soft-deleted users.
 *
 * Asserts that `requireAuth` rejects users whose `user_profiles.deleted_at`
 * IS NOT NULL with HTTP 403 and a structured body:
 *   { detail, deleted: true, deleted_at, scheduled_hard_delete_at, restore_path }
 *
 * Uses vi.mock (hoisted) to stub verifyToken and createServerSupabase so these
 * tests run without a live Supabase instance.
 *
 * Test strategy: directly invoke requireAuth with mock request/response objects
 * rather than going through supertest — avoids Express app bootstrap costs and
 * network port binding restrictions.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response, NextFunction } from "express";

const DELETED_AT = new Date("2026-04-01T00:00:00.000Z").toISOString();
const MOCK_USER_ID = "test-soft-deleted-user";
const MOCK_EMAIL = "deleted@example.com";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeReq(token: string): Partial<Request> {
  return {
    headers: {
      authorization: `Bearer ${token}`,
    },
  };
}

function makeRes(): {
  res: Partial<Response>;
  statusCode: number | undefined;
  body: Record<string, unknown>;
} {
  let statusCode: number | undefined;
  const body: Record<string, unknown> = {};
  const res: Partial<Response> = {
    status(code: number) {
      statusCode = code;
      return this as Response;
    },
    json(data: Record<string, unknown>) {
      Object.assign(body, data);
      return this as Response;
    },
    locals: {} as Record<string, unknown>,
  };
  return { res, get statusCode() { return statusCode; }, body };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("requireAuth gate — soft-deleted users (CLEAN-44)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("requireAuth returns 403 with { deleted: true, restore_path, scheduled_hard_delete_at } when deleted_at IS NOT NULL", async () => {
    vi.doMock("../../src/lib/supabase", () => ({
      verifyToken: vi.fn().mockResolvedValue({ id: MOCK_USER_ID, email: MOCK_EMAIL }),
      createServerSupabase: vi.fn().mockReturnValue({
        from: () => ({
          select: () => ({
            eq: () => ({
              single: vi.fn().mockResolvedValue({
                data: { deleted_at: DELETED_AT },
                error: null,
              }),
            }),
          }),
        }),
      }),
      adminClient: {},
      _resetAuthCache: vi.fn(),
    }));

    const { requireAuth } = await import("../../src/middleware/auth");

    const req = makeReq("valid-token");
    const { res, body } = makeRes();
    let statusCode: number | undefined;
    const resWithStatus: Partial<Response> = {
      ...res,
      status(code: number) { statusCode = code; return this as Response; },
      json(data: Record<string, unknown>) { Object.assign(body, data); return this as Response; },
      locals: {} as Record<string, unknown>,
    };
    const next = vi.fn();

    await requireAuth(req as Request, resWithStatus as Response, next as NextFunction);

    expect(statusCode).toBe(403);
    expect(body.deleted).toBe(true);
    expect(typeof body.restore_path).toBe("string");
    expect(typeof body.scheduled_hard_delete_at).toBe("string");
    expect(next).not.toHaveBeenCalled();

    vi.doUnmock("../../src/lib/supabase");
  });

  it("requireAuth returns 200/handler for users with deleted_at IS NULL", async () => {
    vi.doMock("../../src/lib/supabase", () => ({
      verifyToken: vi.fn().mockResolvedValue({ id: "active-user", email: "active@example.com" }),
      createServerSupabase: vi.fn().mockReturnValue({
        from: () => ({
          select: () => ({
            eq: () => ({
              single: vi.fn().mockResolvedValue({
                data: { deleted_at: null },
                error: null,
              }),
            }),
          }),
        }),
      }),
      adminClient: {},
      _resetAuthCache: vi.fn(),
    }));

    const { requireAuth } = await import("../../src/middleware/auth");

    const req = makeReq("valid-token");
    const body: Record<string, unknown> = {};
    let statusCode: number | undefined;
    const res: Partial<Response> = {
      status(code: number) { statusCode = code; return this as Response; },
      json(data: Record<string, unknown>) { Object.assign(body, data); return this as Response; },
      locals: {} as Record<string, unknown>,
    };
    const next = vi.fn();

    await requireAuth(req as Request, res as Response, next as NextFunction);

    // Should NOT be 403 — deleted_at is null so gate does not fire
    expect(statusCode).not.toBe(403);
    expect(body.deleted).toBeUndefined();
    // next() should have been called (auth passed through)
    expect(next).toHaveBeenCalled();

    vi.doUnmock("../../src/lib/supabase");
  });

  it("requireAuth response shape: { detail, deleted, deleted_at, scheduled_hard_delete_at, restore_path }", async () => {
    vi.doMock("../../src/lib/supabase", () => ({
      verifyToken: vi.fn().mockResolvedValue({ id: MOCK_USER_ID, email: MOCK_EMAIL }),
      createServerSupabase: vi.fn().mockReturnValue({
        from: () => ({
          select: () => ({
            eq: () => ({
              single: vi.fn().mockResolvedValue({
                data: { deleted_at: DELETED_AT },
                error: null,
              }),
            }),
          }),
        }),
      }),
      adminClient: {},
      _resetAuthCache: vi.fn(),
    }));

    const { requireAuth } = await import("../../src/middleware/auth");

    const req = makeReq("valid-token");
    const body: Record<string, unknown> = {};
    let statusCode: number | undefined;
    const res: Partial<Response> = {
      status(code: number) { statusCode = code; return this as Response; },
      json(data: Record<string, unknown>) { Object.assign(body, data); return this as Response; },
      locals: {} as Record<string, unknown>,
    };
    const next = vi.fn();

    await requireAuth(req as Request, res as Response, next as NextFunction);

    expect(statusCode).toBe(403);
    // All 5 required fields must be present with correct types
    expect(typeof body.detail).toBe("string");
    expect(body.deleted).toBe(true);
    expect(typeof body.deleted_at).toBe("string");
    expect(typeof body.scheduled_hard_delete_at).toBe("string");
    expect(body.restore_path).toBe("/user/account/restore");

    // scheduled_hard_delete_at must be 30 days after deleted_at
    const deletedAtMs = new Date(body.deleted_at as string).getTime();
    const scheduledMs = new Date(body.scheduled_hard_delete_at as string).getTime();
    const thirtyDaysMs = 30 * 86_400_000;
    expect(scheduledMs - deletedAtMs).toBe(thirtyDaysMs);

    vi.doUnmock("../../src/lib/supabase");
  });
});
