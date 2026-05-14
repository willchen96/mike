import type { MigrationBuilder } from "node-pg-migrate";

/**
 * CLEAN-05 — envelope-encrypt LLM API keys at rest.
 * Drops plaintext columns and adds six bytea columns (ciphertext/iv/auth_tag per provider).
 *
 * Down migration cannot restore plaintext data (acceptable per
 * .planning/phases/12-encrypted-keys-account-deletion-cascade/12-CONTEXT.md
 * — pre-launch, no production users).
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql("ALTER TABLE public.user_profiles ADD COLUMN claude_api_key_ciphertext bytea");
  pgm.sql("ALTER TABLE public.user_profiles ADD COLUMN claude_api_key_iv bytea");
  pgm.sql("ALTER TABLE public.user_profiles ADD COLUMN claude_api_key_auth_tag bytea");
  pgm.sql("ALTER TABLE public.user_profiles ADD COLUMN gemini_api_key_ciphertext bytea");
  pgm.sql("ALTER TABLE public.user_profiles ADD COLUMN gemini_api_key_iv bytea");
  pgm.sql("ALTER TABLE public.user_profiles ADD COLUMN gemini_api_key_auth_tag bytea");
  pgm.sql("ALTER TABLE public.user_profiles DROP COLUMN IF EXISTS claude_api_key");
  pgm.sql("ALTER TABLE public.user_profiles DROP COLUMN IF EXISTS gemini_api_key");
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql("ALTER TABLE public.user_profiles ADD COLUMN IF NOT EXISTS claude_api_key text");
  pgm.sql("ALTER TABLE public.user_profiles ADD COLUMN IF NOT EXISTS gemini_api_key text");
  pgm.sql("ALTER TABLE public.user_profiles DROP COLUMN IF EXISTS claude_api_key_ciphertext");
  pgm.sql("ALTER TABLE public.user_profiles DROP COLUMN IF EXISTS claude_api_key_iv");
  pgm.sql("ALTER TABLE public.user_profiles DROP COLUMN IF EXISTS claude_api_key_auth_tag");
  pgm.sql("ALTER TABLE public.user_profiles DROP COLUMN IF EXISTS gemini_api_key_ciphertext");
  pgm.sql("ALTER TABLE public.user_profiles DROP COLUMN IF EXISTS gemini_api_key_iv");
  pgm.sql("ALTER TABLE public.user_profiles DROP COLUMN IF EXISTS gemini_api_key_auth_tag");
}
