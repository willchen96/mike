import { Request, Response, NextFunction } from "express";
import { verifyToken } from "../lib/supabase";
import { createServerSupabase } from "../lib/supabase";
import { logger } from "../lib/logger";
import { DELETE_GRACE_DAYS } from "../lib/accountDeletion";

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const auth = req.headers.authorization ?? "";
  if (!auth.startsWith("Bearer ")) {
    res.status(401).json({ detail: "Missing or invalid Authorization header" });
    return;
  }
  const token = auth.slice(7).trim();

  let user;
  try {
    user = await verifyToken(token);
  } catch (err) {
    logger.error({ err }, "[auth] verifyToken failed");
    res.status(500).json({ detail: "Auth check failed" });
    return;
  }

  if (!user) {
    res.status(401).json({ detail: "Invalid or expired token" });
    return;
  }

  if (!user.email) {
    res.status(401).json({ detail: "Account email not set; contact your operator" });
    return;
  }

  // Soft-delete gate (CLEAN-44): reject users with deleted_at IS NOT NULL.
  // Fresh SELECT on every authenticated request — locked v1 perf trade per
  // CONTEXT.md D-04 + RESEARCH Open Q1 RESOLVED. The partial index
  // idx_user_profiles_deleted_at (Plan 03) keeps this O(log N) of deleted rows.
  // M3 may extend Phase 4 userAuthCache to include deleted_at; not in scope here.
  const db = createServerSupabase();
  const { data: profile, error: profileError } = await db
    .from("user_profiles")
    .select("deleted_at")
    .eq("user_id", user.id)
    .single();

  if (profileError && profileError.code !== "PGRST116") {
    // PGRST116 = "0 rows" — user has no profile yet (signup not finished); allow through
    logger.error({ err: profileError, userId: user.id }, "[auth] deleted_at lookup failed");
    res.status(500).json({ detail: "Auth check failed" });
    return;
  }

  if (profile?.deleted_at) {
    const deletedAt = new Date(profile.deleted_at as string);
    const scheduledHardDeleteAt = new Date(
      deletedAt.getTime() + DELETE_GRACE_DAYS * 86_400_000,
    );
    res.status(403).json({
      detail: "Account scheduled for deletion",
      deleted: true,
      deleted_at: profile.deleted_at,
      scheduled_hard_delete_at: scheduledHardDeleteAt.toISOString(),
      restore_path: "/user/account/restore",
    });
    return;
  }

  res.locals.userId = user.id;
  res.locals.userEmail = user.email;
  res.locals.token = token;
  next();
}
