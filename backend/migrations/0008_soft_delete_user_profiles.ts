import type { MigrationBuilder } from "node-pg-migrate";

/**
 * CLEAN-44 — 30-day soft-delete grace window for account deletion.
 * Adds user_profiles.deleted_at; partial index supports the requireAuth gate
 * without slowing inserts/updates on active users.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql("ALTER TABLE public.user_profiles ADD COLUMN deleted_at timestamptz");
  pgm.sql("CREATE INDEX idx_user_profiles_deleted_at ON public.user_profiles(user_id) WHERE deleted_at IS NOT NULL");
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql("DROP INDEX IF EXISTS public.idx_user_profiles_deleted_at");
  pgm.sql("ALTER TABLE public.user_profiles DROP COLUMN IF EXISTS deleted_at");
}
