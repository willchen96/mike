import type { MigrationBuilder } from "node-pg-migrate";

/**
 * CLEAN-44 — persistent state for the 30-day delayed account-deletion worker.
 * One row per soft-deleted user; the worker polls scheduled_for <= now() WHERE status='pending'.
 * FK CASCADE means the row vanishes once admin.deleteUser fires — operator log is the audit trail.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    CREATE TABLE public.account_deletion_jobs (
      user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
      scheduled_for timestamptz NOT NULL,
      status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'running', 'done', 'failed', 'cancelled')),
      last_continuation_token jsonb,
      restore_token_used_at timestamptz,
      claimed_by text,
      claimed_at timestamptz,
      attempts int NOT NULL DEFAULT 0,
      last_error text,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  pgm.sql("CREATE INDEX idx_account_deletion_jobs_due ON public.account_deletion_jobs(scheduled_for) WHERE status = 'pending'");
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql("DROP TABLE IF EXISTS public.account_deletion_jobs");
}
