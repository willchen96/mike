import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import { encryptApiKey } from "../lib/crypto";
import { logger } from "../lib/logger";
import { signRestoreToken, verifyRestoreToken } from "../lib/restoreTokens";
import {
  markSoftDelete,
  clearSoftDelete,
  banUser,
  unbanUser,
  enqueueDeletionJob,
  consumeRestoreToken,
  DELETE_GRACE_DAYS,
} from "../lib/accountDeletion";

export const userRouter = Router();

const patchApiKeySchema = z.object({
  provider: z.enum(["claude", "gemini"]),
  key: z.string().min(1).nullable(),
});

// POST /user/profile
userRouter.post("/profile", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const db = createServerSupabase();
  const { error } = await db
    .from("user_profiles")
    .upsert(
      { user_id: userId },
      { onConflict: "user_id", ignoreDuplicates: true },
    );
  if (error) return void res.status(500).json({ detail: error.message });
  res.json({ ok: true });
});

// PATCH /user/api-keys
userRouter.patch("/api-keys", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const parsed = patchApiKeySchema.safeParse(req.body);
  if (!parsed.success) {
    return void res.status(400).json({
      detail: "Invalid request body",
      issues: parsed.error.issues,
    });
  }
  const { provider, key } = parsed.data;
  const db = createServerSupabase();

  const colCT = `${provider}_api_key_ciphertext`;
  const colIV = `${provider}_api_key_iv`;
  const colTag = `${provider}_api_key_auth_tag`;

  let payload: Record<string, unknown>;
  if (key === null) {
    payload = {
      [colCT]: null,
      [colIV]: null,
      [colTag]: null,
      updated_at: new Date().toISOString(),
    };
  } else {
    // Supabase JS serialises payloads via JSON.stringify, which renders raw
    // Buffer values as `{}` and silently drops every byte. Send PostgreSQL's
    // hex bytea text format so PostgREST stores the encrypted bytes exactly.
    const enc = encryptApiKey(key);
    payload = {
      [colCT]: `\\x${enc.ciphertext.toString("hex")}`,
      [colIV]: `\\x${enc.iv.toString("hex")}`,
      [colTag]: `\\x${enc.authTag.toString("hex")}`,
      updated_at: new Date().toISOString(),
    };
  }

  const { error } = await db
    .from("user_profiles")
    .update(payload)
    .eq("user_id", userId);
  if (error) return void res.status(500).json({ detail: error.message });
  res.status(204).send();
});

// GET /user/api-keys/status
userRouter.get("/api-keys/status", requireAuth, async (_req, res) => {
  const userId = res.locals.userId as string;
  const db = createServerSupabase();
  const { data, error } = await db
    .from("user_profiles")
    .select("claude_api_key_ciphertext, gemini_api_key_ciphertext")
    .eq("user_id", userId)
    .single();
  if (error) return void res.status(500).json({ detail: error.message });
  res.json({
    has_claude: Boolean(data?.claude_api_key_ciphertext),
    has_gemini: Boolean(data?.gemini_api_key_ciphertext),
  });
});

// DELETE /user/account — soft-delete + restore-token issuance (CLEAN-44)
// Replaces immediate hard-delete; worker (Plan 09) performs hard-delete after 30-day grace.
userRouter.delete("/account", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const db = createServerSupabase();

  // 1. Mark soft-delete (idempotent — returns existing deletedAt if already soft-deleted)
  const softDelete = await markSoftDelete(userId, db);
  if (!softDelete) {
    return void res.status(500).json({ detail: "Failed to mark account for deletion" });
  }

  const scheduledHardDeleteAt = new Date(
    softDelete.deletedAt.getTime() + DELETE_GRACE_DAYS * 86_400_000,
  );

  // 2. Ban the auth user (idempotent — banning an already-banned user is a no-op for our purposes)
  const banned = await banUser(userId, db);
  if (!banned) {
    return void res.status(500).json({ detail: "Failed to disable auth session" });
  }

  // 3. Enqueue hard-delete job (ON CONFLICT DO NOTHING — re-DELETE doesn't change the schedule)
  const enqueued = await enqueueDeletionJob(userId, scheduledHardDeleteAt, db);
  if (!enqueued) {
    return void res.status(500).json({ detail: "Failed to enqueue deletion job" });
  }

  // 4. Issue a fresh restore token per Open Question 3 — re-DELETE re-issues;
  //    old tokens still verify until exp, but only one can consume the job (single-use enforcement).
  const restoreToken = signRestoreToken(userId, scheduledHardDeleteAt);

  logger.info({ userId, scheduledHardDeleteAt: scheduledHardDeleteAt.toISOString() }, "[user] account soft-deleted");

  res.json({
    deleted_at: softDelete.deletedAt.toISOString(),
    scheduled_hard_delete_at: scheduledHardDeleteAt.toISOString(),
    restore_token: restoreToken,
    restore_url: `/user/account/restore?token=${restoreToken}`,
  });
});

// POST /user/account/restore — token-authenticated (NOT requireAuth — user is banned)
// The HMAC token IS the auth. Three-way status-code trichotomy (H6 / RESEARCH.md Open Q5 RESOLVED):
//   401 — token-auth failure (verifyRestoreToken returns null: expired, tampered, malformed, missing)
//   410 — single-use replay (DB row exists, restore_token_used_at already set)
//   404 — no pending job (no account_deletion_jobs row for user)
userRouter.post("/account/restore", async (req, res) => {
  const token = String(req.query.token ?? "");
  if (!token) {
    return void res.status(401).json({ detail: "Missing token" });
  }

  const payload = verifyRestoreToken(token);
  if (!payload) {
    return void res.status(401).json({ detail: "Invalid or expired token" });
  }

  const userId = payload.user_id;
  const db = createServerSupabase();

  // 1. Atomically consume the restore token (single-use enforcement — H6 trichotomy)
  const consumeResult = await consumeRestoreToken(userId, db);
  if (consumeResult.ok === false) {
    if (consumeResult.reason === "no_job") {
      // 404 Not Found — no row for this user (never soft-deleted, or already cascade-cleared)
      return void res.status(404).json({ detail: "No deletion job to restore" });
    }
    // 410 Gone — replay of a consumed token (restore_token_used_at already set)
    return void res.status(410).json({ detail: "Restore token already used" });
  }

  // 2. Clear soft-delete + unban auth user
  const cleared = await clearSoftDelete(userId, db);
  const unbanned = await unbanUser(userId, db);
  if (!cleared || !unbanned) {
    logger.error({ userId, cleared, unbanned }, "[user] restore failed mid-flight");
    return void res.status(500).json({ detail: "Restore failed" });
  }

  logger.info({ userId }, "[user] account restored");
  res.status(204).send();
});
