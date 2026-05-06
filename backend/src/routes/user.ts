import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";

export const userRouter = Router();

// GET /user/profile
userRouter.get("/profile", requireAuth, async (_req, res) => {
  const userId = res.locals.userId as string;
  const db = createServerSupabase();
  const { data, error } = await db
    .from("mike_user_profiles")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) return void res.status(500).json({ detail: error.message });
  res.json({ profile: data ?? null });
});

// POST /user/profile
userRouter.post("/profile", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const db = createServerSupabase();
  const { error } = await db
    .from("mike_user_profiles")
    .upsert(
      { user_id: userId },
      { onConflict: "user_id", ignoreDuplicates: true },
    );
  if (error) return void res.status(500).json({ detail: error.message });
  res.json({ ok: true });
});

// PATCH /user/profile
userRouter.patch("/profile", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const {
    display_name,
    organisation,
    tabular_model,
    claude_api_key,
    gemini_api_key,
    message_credits_used,
    credits_reset_date,
  } = req.body ?? {};

  const patch: Record<string, unknown> = {
    user_id: userId,
    updated_at: new Date().toISOString(),
  };

  if (display_name !== undefined) patch.display_name = display_name;
  if (organisation !== undefined) patch.organisation = organisation;
  if (tabular_model !== undefined) patch.tabular_model = tabular_model;
  if (claude_api_key !== undefined) patch.claude_api_key = claude_api_key;
  if (gemini_api_key !== undefined) patch.gemini_api_key = gemini_api_key;
  if (message_credits_used !== undefined) {
    patch.message_credits_used = message_credits_used;
  }
  if (credits_reset_date !== undefined) patch.credits_reset_date = credits_reset_date;

  const db = createServerSupabase();
  const { error } = await db
    .from("mike_user_profiles")
    .upsert(patch, { onConflict: "user_id" });

  if (error) return void res.status(500).json({ detail: error.message });
  res.json({ ok: true });
});

// DELETE /user/account
userRouter.delete("/account", requireAuth, async (_req, res) => {
  const userId = res.locals.userId as string;
  const db = createServerSupabase();
  const { error } = await db.auth.admin.deleteUser(userId);
  if (error) return void res.status(500).json({ detail: error.message });
  res.status(204).send();
});
