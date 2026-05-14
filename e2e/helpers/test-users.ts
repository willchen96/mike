// Generates a unique e-mail address per test run so sign-up flows don't
// collide with rows left over from prior runs in the test Supabase project.
// The local-part embeds a timestamp and a short random suffix so two
// tests started in the same millisecond still get distinct addresses.

const DOMAIN = process.env.E2E_TEST_EMAIL_DOMAIN ?? "e2e.gordonoss.test";

export function uniqueTestEmail(prefix = "user"): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}+${ts}-${rand}@${DOMAIN}`;
}

export const DEFAULT_TEST_PASSWORD = "TestPassword!123";
