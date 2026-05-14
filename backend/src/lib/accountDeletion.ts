/**
 * Account soft-delete and restore helpers for CLEAN-44.
 *
 * These helpers are called by:
 *   - `routes/user.ts` (DELETE /user/account + POST /user/account/restore)
 *   - `lib/accountDeletionWorker.ts` (Plan 09 — hard-delete after grace window)
 *
 * Supabase Auth ban API verified at 2026-05-10: AdminUserAttributes uses `ban_duration`.
 * Source: backend/node_modules/@supabase/auth-js/dist/module/lib/types.d.ts:446
 * Field signature: `ban_duration?: string | 'none'`
 * Ban: set to e.g. "8760h" (1 year). Unban: set to "none".
 *
 * Design decisions (per CONTEXT.md):
 *   - D-04: DELETE_GRACE_DAYS is a hardcoded constant, NOT an env var.
 *     "The 30-day window is not operator-configurable in v1."
 *   - D-05: Restore path is token-authenticated (HMAC). No email sent.
 *   - D-06: Hard-delete is the worker's job (Plan 09), not this module.
 *
 * All helpers follow CLAUDE.md "Errors in libs: return null on failure, do not throw."
 */

import { createServerSupabase } from "./supabase";
import { logger } from "./logger";

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Grace period between soft-delete and hard-delete, in days.
 *
 * Per CONTEXT.md D-04: ship as a hardcoded constant, NOT as an env var.
 * "The 30-day window is not operator-configurable in v1." M3 may revisit
 * if operators ask for a different default. RESEARCH.md Open Question 2
 * (RESOLVED) confirms this is the locked decision.
 *
 * Plan 11 smoke C temporarily edits this constant to 0 for the worker
 * fast-path verification, then reverts before commit.
 */
export const DELETE_GRACE_DAYS = 30;

/**
 * Ban duration passed to Supabase Auth admin API on soft-delete.
 *
 * 1 year (8760h) — long enough that the worker hard-deletes within the
 * 30-day grace window, but the ban must outlast a multi-week worker outage.
 * On restore, pass "none" to lift the ban.
 */
export const BAN_DURATION_FOR_SOFT_DELETE = "8760h";

/**
 * R2 prefix roots scanned per user during hard-delete (Plan 09 worker).
 * Each is joined with `/<userId>/` to form the full prefix.
 */
export const DELETION_PREFIXES = [
  "documents",
  "generated",
  "converted-pdfs",
] as const;

// ── Types ─────────────────────────────────────────────────────────────────────

type DbClient = ReturnType<typeof createServerSupabase>;

/**
 * State persisted to `account_deletion_jobs.last_continuation_token` to make
 * the worker resumable mid-walk. Plan 09 worker reads and writes this shape.
 */
export type ContinuationState = {
  currentPrefix: string;
  token: string | null;
  completedPrefixes: string[];
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Mark a user's profile as soft-deleted.
 *
 * Idempotent: if `deleted_at` is already set, fetches and returns the
 * existing timestamp rather than failing. This supports the re-DELETE
 * flow (RESEARCH.md Open Q3) where re-issuing DELETE doesn't change
 * the schedule but does re-issue a new restore token.
 *
 * Returns `{ deletedAt }` on success (new or existing), `null` on error.
 */
export async function markSoftDelete(
  userId: string,
  db?: DbClient,
): Promise<{ deletedAt: Date } | null> {
  const client = db ?? createServerSupabase();
  try {
    const now = new Date().toISOString();
    const { data, error } = await client
      .from("user_profiles")
      .update({ deleted_at: now, updated_at: now })
      .eq("user_id", userId)
      .is("deleted_at", null)
      .select("deleted_at")
      .single();

    if (error) {
      if (error.code === "PGRST116") {
        // PGRST116 = "The result contains 0 rows" — row already has deleted_at set.
        // Fetch the existing deleted_at.
        const { data: existing, error: fetchError } = await client
          .from("user_profiles")
          .select("deleted_at")
          .eq("user_id", userId)
          .single();
        if (fetchError || !existing?.deleted_at) {
          logger.error({ err: fetchError, userId }, "[accountDeletion] markSoftDelete: refetch failed");
          return null;
        }
        logger.info({ userId, deletedAt: existing.deleted_at }, "[accountDeletion] markSoftDelete: already deleted, returning existing");
        return { deletedAt: new Date(existing.deleted_at as string) };
      }
      logger.error({ err: error, userId }, "[accountDeletion] markSoftDelete failed");
      return null;
    }

    if (!data?.deleted_at) {
      logger.error({ userId }, "[accountDeletion] markSoftDelete: no deleted_at in response");
      return null;
    }

    logger.info({ userId, deletedAt: data.deleted_at }, "[accountDeletion] markSoftDelete");
    return { deletedAt: new Date(data.deleted_at as string) };
  } catch (err) {
    logger.error({ err, userId }, "[accountDeletion] markSoftDelete threw");
    return null;
  }
}

/**
 * Clear the soft-delete flag on a user's profile (restore path).
 *
 * Only updates rows where `deleted_at IS NOT NULL` so a stray call against a
 * non-deleted user is a no-op (WR-04). Returns `true` on success, `false` on
 * error.
 */
export async function clearSoftDelete(
  userId: string,
  db?: DbClient,
): Promise<boolean> {
  const client = db ?? createServerSupabase();
  try {
    const { error } = await client
      .from("user_profiles")
      .update({ deleted_at: null, updated_at: new Date().toISOString() })
      .eq("user_id", userId)
      .not("deleted_at", "is", null);
    if (error) {
      logger.error({ err: error, userId }, "[accountDeletion] clearSoftDelete failed");
      return false;
    }
    logger.info({ userId }, "[accountDeletion] clearSoftDelete");
    return true;
  } catch (err) {
    logger.error({ err, userId }, "[accountDeletion] clearSoftDelete threw");
    return false;
  }
}

/**
 * Ban a user in Supabase Auth via the admin API.
 *
 * Uses `ban_duration: BAN_DURATION_FOR_SOFT_DELETE` (1 year).
 * Returns `true` on success, `false` on error.
 */
export async function banUser(
  userId: string,
  db?: DbClient,
): Promise<boolean> {
  const client = db ?? createServerSupabase();
  try {
    const { error } = await client.auth.admin.updateUserById(userId, {
      ban_duration: BAN_DURATION_FOR_SOFT_DELETE,
    });
    if (error) {
      logger.error({ err: error, userId }, "[accountDeletion] banUser failed");
      return false;
    }
    logger.info({ userId }, "[accountDeletion] banUser");
    return true;
  } catch (err) {
    logger.error({ err, userId }, "[accountDeletion] banUser threw");
    return false;
  }
}

/**
 * Unban a user in Supabase Auth via the admin API.
 *
 * Uses `ban_duration: "none"` to lift the ban.
 * Returns `true` on success, `false` on error.
 */
export async function unbanUser(
  userId: string,
  db?: DbClient,
): Promise<boolean> {
  const client = db ?? createServerSupabase();
  try {
    const { error } = await client.auth.admin.updateUserById(userId, {
      ban_duration: "none",
    });
    if (error) {
      logger.error({ err: error, userId }, "[accountDeletion] unbanUser failed");
      return false;
    }
    logger.info({ userId }, "[accountDeletion] unbanUser");
    return true;
  } catch (err) {
    logger.error({ err, userId }, "[accountDeletion] unbanUser threw");
    return false;
  }
}

/**
 * Insert a row into `account_deletion_jobs` for the given user.
 *
 * ON CONFLICT (user_id) DO NOTHING — idempotent per RESEARCH.md Open Q3.
 * Re-issuing DELETE on an already-deleted account does NOT change the
 * scheduled hard-delete date.
 *
 * Returns `{ existed: false }` for a new insert, `{ existed: true }` if
 * the row was already present. Returns `null` on error.
 */
export async function enqueueDeletionJob(
  userId: string,
  scheduledFor: Date,
  db?: DbClient,
): Promise<{ existed: boolean } | null> {
  const client = db ?? createServerSupabase();
  try {
    // INSERT ... ON CONFLICT (user_id) DO NOTHING — idempotent.
    // We use upsert with ignoreDuplicates: true which translates to ON CONFLICT DO NOTHING.
    // Returns the inserted row on new insert, empty array if the row already existed.
    const { data, error } = await client
      .from("account_deletion_jobs")
      .upsert(
        {
          user_id: userId,
          scheduled_for: scheduledFor.toISOString(),
          status: "pending",
        },
        { onConflict: "user_id", ignoreDuplicates: true },
      )
      .select("user_id");

    if (error) {
      logger.error({ err: error, userId }, "[accountDeletion] enqueueDeletionJob failed");
      return null;
    }

    if (!data || data.length === 0) {
      // ON CONFLICT (user_id) DO NOTHING — row already existed, schedule unchanged
      logger.info({ userId }, "[accountDeletion] enqueueDeletionJob: row already existed (idempotent)");
      return { existed: true };
    }

    logger.info({ userId, scheduledFor: scheduledFor.toISOString() }, "[accountDeletion] enqueueDeletionJob: new row inserted");
    return { existed: false };
  } catch (err) {
    logger.error({ err, userId }, "[accountDeletion] enqueueDeletionJob threw");
    return null;
  }
}

/**
 * Fetch the pending deletion job for a user.
 *
 * Returns the row on success, `null` if no row exists or on error.
 */
export async function getDeletionJob(
  userId: string,
  db?: DbClient,
): Promise<{ user_id: string; scheduled_for: string; status: string; restore_token_used_at: string | null } | null> {
  const client = db ?? createServerSupabase();
  try {
    const { data, error } = await client
      .from("account_deletion_jobs")
      .select("user_id, scheduled_for, status, restore_token_used_at")
      .eq("user_id", userId)
      .single();

    if (error) {
      if (error.code !== "PGRST116") {
        logger.error({ err: error, userId }, "[accountDeletion] getDeletionJob failed");
      }
      return null;
    }

    return data as { user_id: string; scheduled_for: string; status: string; restore_token_used_at: string | null };
  } catch (err) {
    logger.error({ err, userId }, "[accountDeletion] getDeletionJob threw");
    return null;
  }
}

/**
 * Atomically consume the restore token for a user's deletion job.
 *
 * Stamps `restore_token_used_at = now()` and sets `status = 'cancelled'`
 * in a single UPDATE with a WHERE clause that enforces single-use semantics:
 * `WHERE user_id = $1 AND restore_token_used_at IS NULL AND status IN ('pending', 'running')`
 *
 * Returns:
 *   - `{ ok: true }` if the row was updated (token consumed)
 *   - `{ ok: false, reason: "already_used" }` if the row exists but `restore_token_used_at IS NOT NULL` or status is not pending/running
 *   - `{ ok: false, reason: "no_job" }` if no row exists for the user
 */
export async function consumeRestoreToken(
  userId: string,
  db?: DbClient,
): Promise<{ ok: true } | { ok: false; reason: "no_job" | "already_used" }> {
  const client = db ?? createServerSupabase();
  try {
    const now = new Date().toISOString();

    // Atomic single-use enforcement: update only if token has not been consumed yet
    const { data, error } = await client
      .from("account_deletion_jobs")
      .update({ restore_token_used_at: now, status: "cancelled" })
      .eq("user_id", userId)
      .is("restore_token_used_at", null)
      .in("status", ["pending", "running"])
      .select("user_id");

    if (error) {
      logger.error({ err: error, userId }, "[accountDeletion] consumeRestoreToken failed");
      // Treat DB errors as a "no_job" to avoid leaking internal details
      return { ok: false, reason: "no_job" };
    }

    if (data && data.length > 0) {
      logger.info({ userId }, "[accountDeletion] consumeRestoreToken: token consumed");
      return { ok: true };
    }

    // No rows updated — check whether the row exists at all
    const { data: existing, error: checkError } = await client
      .from("account_deletion_jobs")
      .select("user_id, restore_token_used_at, status")
      .eq("user_id", userId)
      .single();

    if (checkError || !existing) {
      // PGRST116 (no rows) or other error — no job row
      logger.info({ userId }, "[accountDeletion] consumeRestoreToken: no_job");
      return { ok: false, reason: "no_job" };
    }

    // Row exists but didn't match the WHERE — already consumed (or wrong status)
    logger.info({ userId, status: (existing as { status: string }).status }, "[accountDeletion] consumeRestoreToken: already_used");
    return { ok: false, reason: "already_used" };
  } catch (err) {
    logger.error({ err, userId }, "[accountDeletion] consumeRestoreToken threw");
    return { ok: false, reason: "no_job" };
  }
}

// ── Plan 09 worker helpers ────────────────────────────────────────────────────

/**
 * Atomically claim a due deletion job for processing.
 *
 * UPDATE account_deletion_jobs
 *   SET status = 'running', claimed_by = $2, claimed_at = now(), attempts = attempts + 1
 *   WHERE user_id = $1 AND status = 'pending' AND scheduled_for <= now()
 *
 * The `WHERE status = 'pending'` predicate is the SOLE de-dup gate (RESEARCH.md
 * Open Q4 / T-12-09-03): if two replicas race, only one UPDATE matches the row.
 * The other receives 0 rows back and returns `{ ok: false }`.
 *
 * On success returns `{ ok: true, lastToken }` so the worker can resume from
 * persisted continuation state. `lastToken` is `null` when the job has never
 * been touched (fresh claim, no resume needed).
 */
export async function claimJob(
  userId: string,
  claimedBy: string,
  db?: DbClient,
): Promise<{ ok: true; lastToken: ContinuationState | null } | { ok: false }> {
  const client = db ?? createServerSupabase();
  try {
    const nowIso = new Date().toISOString();
    // Read current attempts to increment atomically inside this UPDATE.
    // PostgREST does not support raw expressions in UPDATE; the read+write
    // pair below is safe because the WHERE clause prevents two writers from
    // matching at the same time — the second writer sees status='running'.
    const { data: current, error: readError } = await client
      .from("account_deletion_jobs")
      .select("attempts")
      .eq("user_id", userId)
      .eq("status", "pending")
      .lte("scheduled_for", nowIso)
      .maybeSingle();

    if (readError) {
      logger.error({ err: readError, userId }, "[accountDeletion] claimJob read failed");
      return { ok: false };
    }
    if (!current) {
      // No matching pending row (either already running, done, or not due yet)
      return { ok: false };
    }

    const nextAttempts = ((current as { attempts?: number }).attempts ?? 0) + 1;
    const { data, error } = await client
      .from("account_deletion_jobs")
      .update({
        status: "running",
        claimed_by: claimedBy,
        claimed_at: nowIso,
        attempts: nextAttempts,
      })
      .eq("user_id", userId)
      .eq("status", "pending")
      .lte("scheduled_for", nowIso)
      .select("last_continuation_token");

    if (error) {
      logger.error({ err: error, userId }, "[accountDeletion] claimJob update failed");
      return { ok: false };
    }
    if (!data || data.length === 0) {
      // Lost the race: another claimer flipped status between our read and write
      return { ok: false };
    }

    const raw = (data[0] as { last_continuation_token: unknown }).last_continuation_token;
    const lastToken =
      raw && typeof raw === "object" ? (raw as ContinuationState) : null;
    logger.info({ userId, claimedBy }, "[accountDeletion] claimJob");
    return { ok: true, lastToken };
  } catch (err) {
    logger.error({ err, userId }, "[accountDeletion] claimJob threw");
    return { ok: false };
  }
}

/**
 * Persist (or clear) the worker's continuation state on the job row.
 *
 * Pass `null` after every prefix completes (state-cleared between prefixes).
 * Returns `false` on error (logger.error); never throws.
 */
export async function persistContinuationToken(
  userId: string,
  state: ContinuationState | null,
  db?: DbClient,
): Promise<boolean> {
  const client = db ?? createServerSupabase();
  try {
    const { error } = await client
      .from("account_deletion_jobs")
      .update({ last_continuation_token: state })
      .eq("user_id", userId);
    if (error) {
      logger.error({ err: error, userId }, "[accountDeletion] persistContinuationToken failed");
      return false;
    }
    return true;
  } catch (err) {
    logger.error({ err, userId }, "[accountDeletion] persistContinuationToken threw");
    return false;
  }
}

/**
 * Mark a job row as `done` or `failed` after the worker finishes processing.
 *
 * SUCCESS PATH: this function never runs successfully on success because
 * `hardDeleteUser` cascades the row away first. It DOES run on hardDeleteUser
 * failure to mark the row as `failed` with the error text for operator review.
 *
 * Returns `false` on error; row-already-gone (success path) returns `true`.
 */
export async function finalizeJob(
  userId: string,
  result: { rows: number; objects: number; errors: string[] },
  db?: DbClient,
): Promise<boolean> {
  const client = db ?? createServerSupabase();
  try {
    const status = result.errors.length > 0 ? "failed" : "done";
    const lastError = result.errors.length > 0 ? result.errors.join("\n") : null;
    const { error } = await client
      .from("account_deletion_jobs")
      .update({ status, last_error: lastError })
      .eq("user_id", userId);
    if (error) {
      // PGRST116-style "no rows" is not an error here — the row was already
      // cascaded away by hardDeleteUser. Treat as success.
      if (error.code === "PGRST116") return true;
      logger.error({ err: error, userId }, "[accountDeletion] finalizeJob failed");
      return false;
    }
    return true;
  } catch (err) {
    logger.error({ err, userId }, "[accountDeletion] finalizeJob threw");
    return false;
  }
}

/**
 * Hard-delete the auth user via the admin API.
 *
 * This is the LAST step of the worker pipeline. FK CASCADE (Phase 5 schema)
 * wipes user_profiles + every user-owned table in one shot, including the
 * `account_deletion_jobs` row itself.
 *
 * Returns `false` on error; never throws.
 */
export async function hardDeleteUser(
  userId: string,
  db?: DbClient,
): Promise<boolean> {
  const client = db ?? createServerSupabase();
  try {
    const { error } = await client.auth.admin.deleteUser(userId);
    if (error) {
      logger.error({ err: error, userId }, "[accountDeletion] hardDeleteUser failed");
      return false;
    }
    logger.info({ userId }, "[accountDeletion] hardDeleteUser");
    return true;
  } catch (err) {
    logger.error({ err, userId }, "[accountDeletion] hardDeleteUser threw");
    return false;
  }
}
