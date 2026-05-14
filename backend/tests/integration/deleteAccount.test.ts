/**
 * CLEAN-44 — DELETE /user/account soft-delete flow.
 *
 * Asserts that deleting an account:
 *   - sets user_profiles.deleted_at
 *   - bans the user via auth.admin.updateUserById
 *   - inserts a row into account_deletion_jobs (status=pending, scheduled_for=now+30d)
 *   - returns { deleted_at, scheduled_hard_delete_at, restore_token, restore_url }
 *   - is idempotent (re-DELETE returns existing schedule + new restore_token)
 *
 * Uses vi.mock to stub requireAuth and accountDeletion helpers so tests run
 * without a live Supabase instance.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import supertest from "supertest";

// ── Static hoisted mocks ───────────────────────────────────────────────────────

vi.mock("../../src/middleware/auth", () => ({
  requireAuth: vi.fn((_req: unknown, res: any, next: () => void) => {
    res.locals.userId = "test-user-delete-clean44";
    next();
  }),
}));

vi.mock("../../src/lib/supabase", () => ({
  createServerSupabase: vi.fn(),
}));

vi.mock("../../src/lib/accountDeletion", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/accountDeletion")>();
  return {
    ...original,
    // Re-export constant as-is
    DELETE_GRACE_DAYS: 30,
    markSoftDelete: vi.fn(),
    clearSoftDelete: vi.fn(),
    banUser: vi.fn(),
    unbanUser: vi.fn(),
    enqueueDeletionJob: vi.fn(),
    consumeRestoreToken: vi.fn(),
  };
});

vi.mock("../../src/lib/restoreTokens", () => ({
  signRestoreToken: vi.fn((_userId: string, _exp: Date) => "mock-restore-token"),
  verifyRestoreToken: vi.fn(),
}));

import {
  markSoftDelete,
  banUser,
  enqueueDeletionJob,
} from "../../src/lib/accountDeletion";
import { signRestoreToken } from "../../src/lib/restoreTokens";
import { app } from "../../src/app";

const mockMarkSoftDelete = markSoftDelete as ReturnType<typeof vi.fn>;
const mockBanUser = banUser as ReturnType<typeof vi.fn>;
const mockEnqueueDeletionJob = enqueueDeletionJob as ReturnType<typeof vi.fn>;
const mockSignRestoreToken = signRestoreToken as ReturnType<typeof vi.fn>;

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("DELETE /user/account (CLEAN-44)", () => {
  const DELETED_AT = new Date("2026-05-10T12:00:00.000Z");

  beforeEach(() => {
    vi.clearAllMocks();

    // Default happy-path mocks
    mockMarkSoftDelete.mockResolvedValue({ deletedAt: DELETED_AT });
    mockBanUser.mockResolvedValue(true);
    mockEnqueueDeletionJob.mockResolvedValue({ existed: false });
    mockSignRestoreToken.mockReturnValue("mock-restore-token");
  });

  it("DELETE /user/account sets user_profiles.deleted_at", async () => {
    const res = await supertest(app)
      .delete("/user/account")
      .set("Authorization", "Bearer test-token");

    expect(res.status).toBe(200);
    // markSoftDelete was called with the user id from requireAuth
    expect(mockMarkSoftDelete).toHaveBeenCalledTimes(1);
    expect(mockMarkSoftDelete.mock.calls[0][0]).toBe("test-user-delete-clean44");
    // Response body includes deleted_at matching what markSoftDelete returned
    expect(res.body.deleted_at).toBe(DELETED_AT.toISOString());
  });

  it("DELETE /user/account bans user via auth.admin.updateUserById", async () => {
    const res = await supertest(app)
      .delete("/user/account")
      .set("Authorization", "Bearer test-token");

    expect(res.status).toBe(200);
    // banUser was called — this delegates to auth.admin.updateUserById internally
    expect(mockBanUser).toHaveBeenCalledTimes(1);
    expect(mockBanUser.mock.calls[0][0]).toBe("test-user-delete-clean44");
  });

  it("DELETE /user/account inserts row into account_deletion_jobs (status=pending, scheduled_for=now+30d)", async () => {
    const res = await supertest(app)
      .delete("/user/account")
      .set("Authorization", "Bearer test-token");

    expect(res.status).toBe(200);
    expect(mockEnqueueDeletionJob).toHaveBeenCalledTimes(1);

    // Verify the scheduled_for passed is DELETED_AT + 30 days
    const [_userId, scheduledFor] = mockEnqueueDeletionJob.mock.calls[0] as [string, Date, unknown];
    const thirtyDaysMs = 30 * 86_400_000;
    expect((scheduledFor as Date).getTime()).toBe(DELETED_AT.getTime() + thirtyDaysMs);

    // Response also reflects the schedule
    const expectedScheduled = new Date(DELETED_AT.getTime() + thirtyDaysMs).toISOString();
    expect(res.body.scheduled_hard_delete_at).toBe(expectedScheduled);
  });

  it("DELETE /user/account returns { deleted_at, scheduled_hard_delete_at, restore_token, restore_url }", async () => {
    const res = await supertest(app)
      .delete("/user/account")
      .set("Authorization", "Bearer test-token");

    expect(res.status).toBe(200);
    expect(typeof res.body.deleted_at).toBe("string");
    expect(typeof res.body.scheduled_hard_delete_at).toBe("string");
    expect(typeof res.body.restore_token).toBe("string");
    expect(typeof res.body.restore_url).toBe("string");
    // restore_url should embed the token
    expect(res.body.restore_url).toContain(res.body.restore_token);
  });

  it("DELETE /user/account on already-deleted user returns existing schedule + new restore_token", async () => {
    // Simulate already-deleted: markSoftDelete returns the existing deletedAt (same timestamp)
    const existingDeletedAt = new Date("2026-04-01T00:00:00.000Z");
    mockMarkSoftDelete.mockResolvedValue({ deletedAt: existingDeletedAt });
    // enqueueDeletionJob returns existed: true (ON CONFLICT DO NOTHING)
    mockEnqueueDeletionJob.mockResolvedValue({ existed: true });
    // signRestoreToken returns a new token each time
    mockSignRestoreToken.mockReturnValue("new-restore-token-on-redelete");

    const res = await supertest(app)
      .delete("/user/account")
      .set("Authorization", "Bearer test-token");

    expect(res.status).toBe(200);
    // deleted_at uses the EXISTING timestamp (not re-stamped)
    expect(res.body.deleted_at).toBe(existingDeletedAt.toISOString());
    // A new restore_token is issued regardless
    expect(res.body.restore_token).toBe("new-restore-token-on-redelete");
    // enqueueDeletionJob was still called (idempotent)
    expect(mockEnqueueDeletionJob).toHaveBeenCalledTimes(1);
  });
});
