/**
 * Shared helpers for auth-hardening test fixtures.
 *
 * `mintEmptyEmailUser` creates a real Supabase user then blanks out their email
 * via the admin API.  Because the admin API does not allow creating a user with
 * an empty email at creation time, we:
 *   1. Create the user with a unique placeholder email.
 *   2. Use the admin `updateUserById` API to set email to `""`.
 *   3. Generate an admin-issued session so we can get a valid JWT.
 *
 * If the live Supabase env is not available the helper will throw early, which
 * is intentional — the integration tests that call it will fail (or be skipped
 * by the caller's guard).
 *
 * `cleanupEmptyEmailUser` deletes the test user after each test run.
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

export interface EmptyEmailFixture {
  userId: string;
  jwt: string;
}

/**
 * Creates a Supabase user whose email is set to "" after creation.
 * Returns the user id and a valid JWT for that user.
 */
export async function mintEmptyEmailUser(): Promise<EmptyEmailFixture> {
  const supabaseUrl = process.env.SUPABASE_URL ?? "";
  const serviceKey = process.env.SUPABASE_SECRET_KEY ?? "";

  if (!supabaseUrl || !serviceKey) {
    throw new Error(
      "[_setup] SUPABASE_URL / SUPABASE_SECRET_KEY not set; cannot mint empty-email user",
    );
  }

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const ts = Date.now();
  const placeholderEmail = `test-empty-email-${ts}@test.invalid`;
  const password = "TestEmpty0!";

  // Step 1: create a regular user.
  const { data: createData, error: createError } =
    await admin.auth.admin.createUser({
      email: placeholderEmail,
      password,
      email_confirm: true,
    });
  if (createError || !createData.user) {
    throw new Error(
      `[_setup] failed to create placeholder user: ${createError?.message ?? "no user"}`,
    );
  }
  const userId = createData.user.id;

  // Step 2: blank out the email via admin update.
  const { error: updateError } = await admin.auth.admin.updateUserById(userId, {
    email: "",
  });
  if (updateError) {
    // updateUserById may reject empty email on some Supabase versions.
    // In that case we fall back to the stub approach: generate a link and
    // exchange it, then note the original email in a comment for the caller.
    console.warn(
      `[_setup] updateUserById(email="") rejected (${updateError.message}); ` +
        "falling back to mock-based test path — emptyEmail.test.ts will stub verifyToken instead",
    );
    // Clean up the created user before bailing.
    await admin.auth.admin.deleteUser(userId);
    throw new Error(
      `EMPTY_EMAIL_UPDATE_UNSUPPORTED:${placeholderEmail}:${userId}`,
    );
  }

  // Step 3: generate an admin session link and exchange it for a JWT.
  // `generateLink` with type "magiclink" yields a one-time URL whose token
  // can be exchanged via `verifyOtp`.
  const { data: linkData, error: linkError } =
    await admin.auth.admin.generateLink({
      type: "magiclink",
      email: placeholderEmail,
    });
  if (linkError || !linkData.properties?.hashed_token) {
    // Some configs don't expose the hashed_token; fall through to password.
    // The user still has no email, so signInWithPassword will fail if email
    // is truly blank — that's acceptable: the test will use a direct stub.
    throw new Error(
      `[_setup] generateLink failed: ${linkError?.message ?? "no hashed_token"}`,
    );
  }

  // Exchange the magic-link token for a session.
  const { data: sessionData, error: sessionError } =
    await admin.auth.verifyOtp({
      token_hash: linkData.properties.hashed_token,
      type: "magiclink",
    });
  if (sessionError || !sessionData.session?.access_token) {
    throw new Error(
      `[_setup] verifyOtp exchange failed: ${sessionError?.message ?? "no access_token"}`,
    );
  }

  return { userId, jwt: sessionData.session.access_token };
}

/**
 * Deletes the test user created by `mintEmptyEmailUser`.
 */
export async function cleanupEmptyEmailUser(userId: string): Promise<void> {
  const supabaseUrl = process.env.SUPABASE_URL ?? "";
  const serviceKey = process.env.SUPABASE_SECRET_KEY ?? "";
  if (!supabaseUrl || !serviceKey) {
    return; // best-effort; don't throw in teardown
  }
  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  await admin.auth.admin.deleteUser(userId);
}
