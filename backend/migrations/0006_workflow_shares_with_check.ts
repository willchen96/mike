import type { MigrationBuilder } from "node-pg-migrate";

// CR-03 (Phase 11 verification gap): workflow_shares UPDATE policy was missing WITH CHECK.
//
// The policy created in 0005_rls_policies.ts:494-506 has only a USING clause. PostgreSQL
// defaults WITH CHECK to the USING expression when WITH CHECK is omitted, which protects
// against re-pointing workflow_id to a workflow the caller does not own — but leaves
// shared_by_user_id unconstrained. A workflow owner can mutate shared_by_user_id on their
// own share row to a foreign UUID, forging the audit trail of who shared the workflow.
//
// Fix (additive — does NOT edit 0005 in place):
//   1. Drop the buggy USING-only policy.
//   2. Recreate with both USING and an explicit WITH CHECK that matches the INSERT policy
//      (workflows.user_id = auth.uid() — owner-only).
//
// The same SQL is mirrored into backend/migrations/000_one_shot_schema.sql so fresh
// installs land at the corrected state.

export const shorthands = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  // Drop the buggy USING-only policy created by 0005.
  pgm.sql(`drop policy if exists "workflow_shares_update_workflow_owner" on public.workflow_shares;`);

  // Recreate with explicit WITH CHECK that pins BOTH workflow_id and shared_by_user_id.
  // USING gates the pre-update row (caller must own the workflow). WITH CHECK gates the
  // post-update row: (a) the updated workflow_id must still point to a workflow the
  // caller owns, AND (b) shared_by_user_id must remain the caller's own uid so the
  // audit trail of who shared the workflow cannot be re-attributed to a foreign user.
  pgm.sql(`
    create policy "workflow_shares_update_workflow_owner"
      on public.workflow_shares for update
      to authenticated
      using (
        exists (
          select 1
          from public.workflows w
          where w.id = workflow_id
            and w.user_id = auth.uid()
        )
      )
      with check (
        exists (
          select 1
          from public.workflows w
          where w.id = workflow_id
            and w.user_id = auth.uid()
        )
        and shared_by_user_id = auth.uid()
      );
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  // Reverse to the (buggy) USING-only state created by 0005 so the migration is reversible.
  // This is intentional — the down() must restore the prior state, not "improve" it.
  pgm.sql(`drop policy if exists "workflow_shares_update_workflow_owner" on public.workflow_shares;`);

  pgm.sql(`
    create policy "workflow_shares_update_workflow_owner"
      on public.workflow_shares for update
      to authenticated
      using (
        exists (
          select 1
          from public.workflows w
          where w.id = workflow_id
            and w.user_id = auth.uid()
        )
      );
  `);
}
