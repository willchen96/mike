import { createServerSupabase } from "./supabase";

/**
 * Monthly cap on user-initiated LLM messages. Surfaced on the user
 * profile as `creditsRemaining`. The historical default was 999999 —
 * effectively unlimited — and we preserve that here so this module is
 * behaviour-neutral unless the operator opts in by setting
 * MONTHLY_MESSAGE_CREDIT_LIMIT to a smaller integer. Tier-based limits
 * are intentionally out of scope; once a single env-driven cap exists
 * it's straightforward to layer tier overrides on top.
 */
export function monthlyCreditLimit(): number {
    const raw = process.env.MONTHLY_MESSAGE_CREDIT_LIMIT;
    if (!raw) return 999999;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < 0) return 999999;
    return parsed;
}

type Db = ReturnType<typeof createServerSupabase>;

export type CreditState = {
    used: number;
    limit: number;
    remaining: number;
};

/**
 * Returns the user's current message-credit balance. Caller is
 * responsible for translating a non-positive `remaining` into a 402
 * before the LLM call.
 *
 * Note: read-only. The 30-day window reset still happens in
 * routes/user.ts → loadProfile() when the profile is fetched. We do
 * not duplicate that here because the streaming-chat code path doesn't
 * fetch the full profile; a small amount of staleness is acceptable
 * for the enforcement check (a user can at most spend one extra
 * message before their reset is observed by the next /user/profile
 * fetch).
 */
export async function getCreditState(
    userId: string,
    db: Db,
): Promise<CreditState> {
    const limit = monthlyCreditLimit();
    const { data } = await db
        .from("user_profiles")
        .select("message_credits_used")
        .eq("user_id", userId)
        .maybeSingle();
    const used = Number((data as { message_credits_used?: number } | null)?.message_credits_used ?? 0);
    const safeUsed = Number.isFinite(used) ? used : 0;
    return { used: safeUsed, limit, remaining: Math.max(limit - safeUsed, 0) };
}

/**
 * Increment the user's message-credit counter by `n` (default 1).
 * Called exactly once per successful user-initiated LLM message — not
 * per tool turn — so the counter reflects user-visible message volume.
 *
 * We do a read-then-write because postgrest doesn't expose an atomic
 * increment expression. Two near-simultaneous requests can therefore
 * under-count by one; that's acceptable for a soft budget. If hard
 * accounting is needed later, swap this for an `rpc('inc_credits', ...)`
 * stored procedure.
 */
export async function incrementMessageCredits(
    userId: string,
    db: Db,
    n = 1,
): Promise<void> {
    const { data } = await db
        .from("user_profiles")
        .select("message_credits_used")
        .eq("user_id", userId)
        .maybeSingle();
    const current = Number((data as { message_credits_used?: number } | null)?.message_credits_used ?? 0);
    const next = (Number.isFinite(current) ? current : 0) + n;
    await db
        .from("user_profiles")
        .update({
            message_credits_used: next,
            updated_at: new Date().toISOString(),
        })
        .eq("user_id", userId);
}
