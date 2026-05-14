import type { MigrationBuilder } from "node-pg-migrate";

export async function up(pgm: MigrationBuilder): Promise<void> {
  // 1. Drop indexes covering user_id columns (Postgres requires this before ALTER COLUMN TYPE)
  pgm.sql("DROP INDEX IF EXISTS public.idx_projects_user");
  pgm.sql("DROP INDEX IF EXISTS public.idx_documents_user_project");
  pgm.sql("DROP INDEX IF EXISTS public.idx_workflows_user");
  pgm.sql("DROP INDEX IF EXISTS public.idx_hidden_workflows_user");
  pgm.sql("DROP INDEX IF EXISTS public.idx_chats_user");
  pgm.sql("DROP INDEX IF EXISTS public.idx_tabular_reviews_user");
  pgm.sql("DROP INDEX IF EXISTS public.tabular_review_chats_user_idx");

  // 2. Drop composite UNIQUE on hidden_workflows (Postgres blocks type change of constrained column — Pitfall 4)
  pgm.sql("ALTER TABLE public.hidden_workflows DROP CONSTRAINT IF EXISTS hidden_workflows_user_id_workflow_id_key");

  // 3. Alter NOT NULL user_id columns to uuid + add FK CASCADE
  const notNullTables = [
    "projects",
    "project_subfolders",
    "documents",
    "chats",
    "tabular_reviews",
    "tabular_review_chats",
    "hidden_workflows",
  ];
  for (const t of notNullTables) {
    pgm.sql(`ALTER TABLE public.${t} ALTER COLUMN user_id TYPE uuid USING user_id::uuid`);
    pgm.sql(`ALTER TABLE public.${t} ADD CONSTRAINT ${t}_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE`);
  }

  // 4. workflows.user_id is NULLABLE (Pitfall 3) — keep nullable, FK MATCH SIMPLE allows NULL
  pgm.sql("ALTER TABLE public.workflows ALTER COLUMN user_id TYPE uuid USING user_id::uuid");
  pgm.sql("ALTER TABLE public.workflows ADD CONSTRAINT workflows_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE");

  // 5. workflow_shares.shared_by_user_id (NOT NULL)
  pgm.sql("ALTER TABLE public.workflow_shares ALTER COLUMN shared_by_user_id TYPE uuid USING shared_by_user_id::uuid");
  pgm.sql("ALTER TABLE public.workflow_shares ADD CONSTRAINT workflow_shares_shared_by_user_id_fkey FOREIGN KEY (shared_by_user_id) REFERENCES auth.users(id) ON DELETE CASCADE");

  // 6. Re-add hidden_workflows composite UNIQUE
  pgm.sql("ALTER TABLE public.hidden_workflows ADD CONSTRAINT hidden_workflows_user_id_workflow_id_key UNIQUE (user_id, workflow_id)");

  // 7. Re-create dropped indexes
  pgm.sql("CREATE INDEX IF NOT EXISTS idx_projects_user ON public.projects(user_id)");
  pgm.sql("CREATE INDEX IF NOT EXISTS idx_documents_user_project ON public.documents(user_id, project_id)");
  pgm.sql("CREATE INDEX IF NOT EXISTS idx_workflows_user ON public.workflows(user_id)");
  pgm.sql("CREATE INDEX IF NOT EXISTS idx_hidden_workflows_user ON public.hidden_workflows(user_id)");
  pgm.sql("CREATE INDEX IF NOT EXISTS idx_chats_user ON public.chats(user_id)");
  pgm.sql("CREATE INDEX IF NOT EXISTS idx_tabular_reviews_user ON public.tabular_reviews(user_id)");
  pgm.sql("CREATE INDEX IF NOT EXISTS tabular_review_chats_user_idx ON public.tabular_review_chats(user_id)");

  // 8. UNIQUE constraint on document_versions (backs CLEAN-08 retry pattern)
  pgm.sql("ALTER TABLE public.document_versions ADD CONSTRAINT document_versions_doc_version_unique UNIQUE (document_id, version_number)");

  // 9. Drop dead billing columns (CLEAN-48 — out of scope per REQUIREMENTS.md)
  pgm.sql("ALTER TABLE public.user_profiles DROP COLUMN IF EXISTS tier");
  pgm.sql("ALTER TABLE public.user_profiles DROP COLUMN IF EXISTS message_credits_used");
  pgm.sql("ALTER TABLE public.user_profiles DROP COLUMN IF EXISTS credits_reset_date");
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  // 1. Restore billing columns
  pgm.sql("ALTER TABLE public.user_profiles ADD COLUMN IF NOT EXISTS tier text NOT NULL DEFAULT 'Free'");
  pgm.sql("ALTER TABLE public.user_profiles ADD COLUMN IF NOT EXISTS message_credits_used integer NOT NULL DEFAULT 0");
  pgm.sql("ALTER TABLE public.user_profiles ADD COLUMN IF NOT EXISTS credits_reset_date timestamptz NOT NULL DEFAULT (now() + interval '30 days')");

  // 2. Drop UNIQUE on document_versions
  pgm.sql("ALTER TABLE public.document_versions DROP CONSTRAINT IF EXISTS document_versions_doc_version_unique");

  // 3. Drop re-created indexes
  pgm.sql("DROP INDEX IF EXISTS public.idx_projects_user");
  pgm.sql("DROP INDEX IF EXISTS public.idx_documents_user_project");
  pgm.sql("DROP INDEX IF EXISTS public.idx_workflows_user");
  pgm.sql("DROP INDEX IF EXISTS public.idx_hidden_workflows_user");
  pgm.sql("DROP INDEX IF EXISTS public.idx_chats_user");
  pgm.sql("DROP INDEX IF EXISTS public.idx_tabular_reviews_user");
  pgm.sql("DROP INDEX IF EXISTS public.tabular_review_chats_user_idx");

  // 4. Drop hidden_workflows composite UNIQUE constraint (recreated as text-based below)
  pgm.sql("ALTER TABLE public.hidden_workflows DROP CONSTRAINT IF EXISTS hidden_workflows_user_id_workflow_id_key");

  // 5. Drop FK constraints and revert uuid columns back to text (not null tables)
  const notNullTables = [
    "projects",
    "project_subfolders",
    "documents",
    "chats",
    "tabular_reviews",
    "tabular_review_chats",
    "hidden_workflows",
  ];
  for (const t of notNullTables) {
    pgm.sql(`ALTER TABLE public.${t} DROP CONSTRAINT IF EXISTS ${t}_user_id_fkey`);
    pgm.sql(`ALTER TABLE public.${t} ALTER COLUMN user_id TYPE text USING user_id::text`);
  }

  // 6. Drop FK and revert workflows.user_id (nullable)
  pgm.sql("ALTER TABLE public.workflows DROP CONSTRAINT IF EXISTS workflows_user_id_fkey");
  pgm.sql("ALTER TABLE public.workflows ALTER COLUMN user_id TYPE text USING user_id::text");

  // 7. Drop FK and revert workflow_shares.shared_by_user_id
  pgm.sql("ALTER TABLE public.workflow_shares DROP CONSTRAINT IF EXISTS workflow_shares_shared_by_user_id_fkey");
  pgm.sql("ALTER TABLE public.workflow_shares ALTER COLUMN shared_by_user_id TYPE text USING shared_by_user_id::text");

  // 8. Re-add hidden_workflows composite UNIQUE (now text-based)
  pgm.sql("ALTER TABLE public.hidden_workflows ADD CONSTRAINT hidden_workflows_user_id_workflow_id_key UNIQUE (user_id, workflow_id)");

  // 9. Restore indexes
  pgm.sql("CREATE INDEX IF NOT EXISTS idx_projects_user ON public.projects(user_id)");
  pgm.sql("CREATE INDEX IF NOT EXISTS idx_documents_user_project ON public.documents(user_id, project_id)");
  pgm.sql("CREATE INDEX IF NOT EXISTS idx_workflows_user ON public.workflows(user_id)");
  pgm.sql("CREATE INDEX IF NOT EXISTS idx_hidden_workflows_user ON public.hidden_workflows(user_id)");
  pgm.sql("CREATE INDEX IF NOT EXISTS idx_chats_user ON public.chats(user_id)");
  pgm.sql("CREATE INDEX IF NOT EXISTS idx_tabular_reviews_user ON public.tabular_reviews(user_id)");
  pgm.sql("CREATE INDEX IF NOT EXISTS tabular_review_chats_user_idx ON public.tabular_review_chats(user_id)");
}
