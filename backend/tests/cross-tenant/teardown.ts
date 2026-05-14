import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

export async function teardown(): Promise<void> {
  const supabaseUrl = process.env.SUPABASE_URL ?? "";
  const serviceKey = process.env.SUPABASE_SECRET_KEY ?? "";

  if (!supabaseUrl || !serviceKey) {
    console.error("[teardown] SUPABASE_URL or SUPABASE_SECRET_KEY missing — skipping cleanup");
    return;
  }

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });

  // Clean up seeded DB rows before deleting auth users (no cascading FK on user_id text col)
  for (const userId of [process.env.TEST_USER_A_ID, process.env.TEST_USER_B_ID]) {
    if (!userId) continue;
    for (const table of ["documents", "projects", "chats", "tabular_reviews", "workflows"] as const) {
      try {
        await admin.from(table).delete().eq("user_id", userId);
      } catch (err: unknown) {
        console.error(`[teardown] failed to clean ${table} for user ${userId}`, err);
      }
    }
  }

  if (process.env.TEST_USER_A_ID) {
    try {
      await admin.auth.admin.deleteUser(process.env.TEST_USER_A_ID);
      console.log("[teardown] Deleted user A:", process.env.TEST_USER_A_ID);
    } catch (err: unknown) {
      console.error("[teardown] failed to delete user A", err);
    }
  }

  if (process.env.TEST_USER_B_ID) {
    try {
      await admin.auth.admin.deleteUser(process.env.TEST_USER_B_ID);
      console.log("[teardown] Deleted user B:", process.env.TEST_USER_B_ID);
    } catch (err: unknown) {
      console.error("[teardown] failed to delete user B", err);
    }
  }
}
