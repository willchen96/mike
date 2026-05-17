/**
 * CLEAN-44 — POST /user/account/restore restore-token flow.
 *
 * Asserts that:
 *   - a valid token within the 30-day window unbans and clears deleted_at → 204
 *   - an expired/tampered token returns 401 (H6 — verifyRestoreToken rejection)
 *   - a replayed token (already consumed) returns 410 Gone (H6 — single-use replay)
 *   - a valid token for a user with no pending deletion job returns 404 (H6 — no_job)
 *   - a tampered token (signature mismatch) returns 401
 *   - a successful restore stamps account_deletion_jobs.restore_token_used_at
 *
 * H6 status-code trichotomy (RESEARCH.md Open Q5 RESOLVED):
 *   401 — token-auth failure (verifyRestoreToken returns null)
 *   410 — replay (consumeRestoreToken reason: "already_used")
 *   404 — no pending job (consumeRestoreToken reason: "no_job")
 *
 * Uses vi.mock to stub restoreTokens and accountDeletion helpers so tests run
 * without a live Supabase instance.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import supertest from "supertest";

// ── Static hoisted mocks ───────────────────────────────────────────────────────

vi.mock("../../src/middleware/auth", () => ({
  requireAuth: vi.fn((_req: unknown, res: any, next: () => void) => {
    res.locals.userId = "test-user-restore-clean44";
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
  clearSoftDelete,
  unbanUser,
  consumeRestoreToken,
} from "../../src/lib/accountDeletion";
import { verifyRestoreToken } from "../../src/lib/restoreTokens";
import { app } from "../../src/app";

const mockVerifyRestoreToken = verifyRestoreToken as ReturnType<typeof vi.fn>;
const mockConsumeRestoreToken = consumeRestoreToken as ReturnType<typeof vi.fn>;
const mockClearSoftDelete = clearSoftDelete as ReturnType<typeof vi.fn>;
const mockUnbanUser = unbanUser as ReturnType<typeof vi.fn>;

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("POST /user/account/restore (CLEAN-44)", () => {
  const VALID_PAYLOAD = {
    user_id: "test-user-restore-clean44",
    action: "restore" as const,
    exp: Date.now() + 30 * 86_400_000,
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // Default happy-path mocks
    mockVerifyRestoreToken.mockReturnValue(VALID_PAYLOAD);
    mockConsumeRestoreToken.mockResolvedValue({ ok: true });
    mockClearSoftDelete.mockResolvedValue(true);
    mockUnbanUser.mockResolvedValue(true);
  });

  it("POST /user/account/restore?token=... within window unbans + clears deleted_at", async () => {
    const res = await supertest(app)
      .post("/user/account/restore?token=valid-token")
      .send();

    expect(res.status).toBe(204);
    // verifyRestoreToken was called with the token from the query string
    expect(mockVerifyRestoreToken).toHaveBeenCalledWith("valid-token");
    // consumeRestoreToken atomically stamps the DB row
    expect(mockConsumeRestoreToken).toHaveBeenCalledTimes(1);
    expect(mockConsumeRestoreToken.mock.calls[0][0]).toBe(VALID_PAYLOAD.user_id);
    // clearSoftDelete + unbanUser both called
    expect(mockClearSoftDelete).toHaveBeenCalledTimes(1);
    expect(mockClearSoftDelete.mock.calls[0][0]).toBe(VALID_PAYLOAD.user_id);
    expect(mockUnbanUser).toHaveBeenCalledTimes(1);
    expect(mockUnbanUser.mock.calls[0][0]).toBe(VALID_PAYLOAD.user_id);
  });

  it("(H6 401 expired) POST /user/account/restore with expired-signature token returns 401", async () => {
    // verifyRestoreToken returns null — expired exp or tampered signature
    mockVerifyRestoreToken.mockReturnValue(null);

    const res = await supertest(app)
      .post("/user/account/restore?token=expired-or-tampered-token")
      .send();

    expect(res.status).toBe(401);
    expect(res.body.detail).toBe("Invalid or expired token");
    // No DB calls — short-circuit at token verification
    expect(mockConsumeRestoreToken).not.toHaveBeenCalled();
    expect(mockClearSoftDelete).not.toHaveBeenCalled();
  });

  it("(H6 410 replay) POST /user/account/restore with replayed (already-used) token returns 410 Gone", async () => {
    // Token verifies OK but the DB row shows it was already consumed
    mockConsumeRestoreToken.mockResolvedValue({ ok: false, reason: "already_used" });

    const res = await supertest(app)
      .post("/user/account/restore?token=already-used-token")
      .send();

    expect(res.status).toBe(410);
    expect(res.body.detail).toBe("Restore token already used");
    // clearSoftDelete + unbanUser NOT called after a failed consume
    expect(mockClearSoftDelete).not.toHaveBeenCalled();
    expect(mockUnbanUser).not.toHaveBeenCalled();
  });

  it("(H6 404 no-job) POST /user/account/restore for a user with no pending deletion job returns 404", async () => {
    // Token verifies OK but there is no account_deletion_jobs row
    mockConsumeRestoreToken.mockResolvedValue({ ok: false, reason: "no_job" });

    const res = await supertest(app)
      .post("/user/account/restore?token=valid-token-no-job")
      .send();

    expect(res.status).toBe(404);
    expect(res.body.detail).toBe("No deletion job to restore");
    // clearSoftDelete + unbanUser NOT called
    expect(mockClearSoftDelete).not.toHaveBeenCalled();
    expect(mockUnbanUser).not.toHaveBeenCalled();
  });

  it("POST /user/account/restore with tampered (signature-mismatch) token returns 401", async () => {
    // Tampered token: verifyRestoreToken returns null (HMAC mismatch)
    mockVerifyRestoreToken.mockReturnValue(null);

    const res = await supertest(app)
      .post("/user/account/restore?token=tampered.token.bytes")
      .send();

    expect(res.status).toBe(401);
    expect(res.body.detail).toBe("Invalid or expired token");
  });

  it("POST /user/account/restore stamps account_deletion_jobs.restore_token_used_at", async () => {
    // consumeRestoreToken is the atomic stamp operation
    mockConsumeRestoreToken.mockResolvedValue({ ok: true });

    const res = await supertest(app)
      .post("/user/account/restore?token=valid-token")
      .send();

    expect(res.status).toBe(204);
    // consumeRestoreToken is the function that performs the stamp atomically
    expect(mockConsumeRestoreToken).toHaveBeenCalledTimes(1);
    expect(mockConsumeRestoreToken.mock.calls[0][0]).toBe(VALID_PAYLOAD.user_id);
  });
});
