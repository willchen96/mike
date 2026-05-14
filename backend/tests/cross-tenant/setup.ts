import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

export async function setup(): Promise<void> {
  const supabaseUrl = process.env.SUPABASE_URL ?? "";
  const serviceKey = process.env.SUPABASE_SECRET_KEY ?? "";
  const anonKey = process.env.SUPABASE_ANON_KEY ?? "";

  if (!anonKey) {
    throw new Error(
      "SUPABASE_ANON_KEY is required for cross-tenant tests; see backend/.env.example",
    );
  }

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });

  const ts = Date.now();
  const emailA = `test-user-a-${ts}@test.invalid`;
  const emailB = `test-user-b-${ts}@test.invalid`;
  const password = "TestPassw0rd!";

  const { data: dataA, error: errorA } = await admin.auth.admin.createUser({
    email: emailA,
    password,
    email_confirm: true,
  });
  if (errorA || !dataA.user) {
    throw new Error(`[setup] failed to create user A: ${errorA?.message ?? "no user returned"}`);
  }

  const { data: dataB, error: errorB } = await admin.auth.admin.createUser({
    email: emailB,
    password,
    email_confirm: true,
  });
  if (errorB || !dataB.user) {
    throw new Error(`[setup] failed to create user B: ${errorB?.message ?? "no user returned"}`);
  }

  const anon = createClient(supabaseUrl, anonKey);

  const { data: sessionA, error: errorSessionA } = await anon.auth.signInWithPassword({
    email: emailA,
    password,
  });
  if (errorSessionA || !sessionA.session?.access_token) {
    throw new Error(`[setup] failed to sign in user A: ${errorSessionA?.message ?? "no token"}`);
  }

  const { data: sessionB, error: errorSessionB } = await anon.auth.signInWithPassword({
    email: emailB,
    password,
  });
  if (errorSessionB || !sessionB.session?.access_token) {
    throw new Error(`[setup] failed to sign in user B: ${errorSessionB?.message ?? "no token"}`);
  }

  process.env.TEST_USER_A_ID = dataA.user.id;
  process.env.TEST_USER_B_ID = dataB.user.id;
  process.env.TEST_USER_A_EMAIL = emailA;
  process.env.TEST_USER_B_EMAIL = emailB;
  process.env.TEST_JWT_A = sessionA.session.access_token;
  process.env.TEST_JWT_B = sessionB.session.access_token;
  process.env.TEST_PASSWORD = password;

  console.log("[setup] Test users created and signed in successfully");
  console.log(`[setup] User A: ${emailA} (id: ${dataA.user.id})`);
  console.log(`[setup] User B: ${emailB} (id: ${dataB.user.id})`);
}
