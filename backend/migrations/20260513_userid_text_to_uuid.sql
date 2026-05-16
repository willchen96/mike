-- Migration: convert user_id text columns to uuid with FK to auth.users
--
-- APPLY CAREFULLY — this is a breaking schema change.
-- Run in a transaction; it will abort on the first invalid value.
--
-- Pre-flight check (run manually before applying):
--   SELECT table_name, user_id
--   FROM (
--     SELECT 'projects'       AS table_name, user_id FROM public.projects
--     UNION ALL
--     SELECT 'documents',      user_id FROM public.documents
--     UNION ALL
--     SELECT 'project_subfolders', user_id FROM public.project_subfolders
--     UNION ALL
--     SELECT 'chats',          user_id FROM public.chats
--     UNION ALL
--     SELECT 'tabular_reviews',user_id FROM public.tabular_reviews
--     UNION ALL
--     SELECT 'workflows',      user_id FROM public.workflows WHERE user_id IS NOT NULL
--     UNION ALL
--     SELECT 'hidden_workflows',user_id FROM public.hidden_workflows
--     UNION ALL
--     SELECT 'tabular_review_chats', user_id FROM public.tabular_review_chats
--     UNION ALL
--     SELECT 'workflow_shares (shared_by)', shared_by_user_id FROM public.workflow_shares
--   ) t
--   WHERE t.user_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
--
-- If that returns any rows, fix or remove them before applying this migration.

BEGIN;

-- ---------------------------------------------------------------------------
-- projects
-- ---------------------------------------------------------------------------
ALTER TABLE public.projects
  ALTER COLUMN user_id TYPE uuid USING user_id::uuid;

ALTER TABLE public.projects
  ADD CONSTRAINT projects_user_id_fkey
  FOREIGN KEY (user_id)
  REFERENCES auth.users(id)
  ON DELETE CASCADE;

-- ---------------------------------------------------------------------------
-- project_subfolders
-- ---------------------------------------------------------------------------
ALTER TABLE public.project_subfolders
  ALTER COLUMN user_id TYPE uuid USING user_id::uuid;

ALTER TABLE public.project_subfolders
  ADD CONSTRAINT project_subfolders_user_id_fkey
  FOREIGN KEY (user_id)
  REFERENCES auth.users(id)
  ON DELETE CASCADE;

-- ---------------------------------------------------------------------------
-- documents
-- ---------------------------------------------------------------------------
ALTER TABLE public.documents
  ALTER COLUMN user_id TYPE uuid USING user_id::uuid;

ALTER TABLE public.documents
  ADD CONSTRAINT documents_user_id_fkey
  FOREIGN KEY (user_id)
  REFERENCES auth.users(id)
  ON DELETE CASCADE;

-- ---------------------------------------------------------------------------
-- chats
-- ---------------------------------------------------------------------------
ALTER TABLE public.chats
  ALTER COLUMN user_id TYPE uuid USING user_id::uuid;

ALTER TABLE public.chats
  ADD CONSTRAINT chats_user_id_fkey
  FOREIGN KEY (user_id)
  REFERENCES auth.users(id)
  ON DELETE CASCADE;

-- ---------------------------------------------------------------------------
-- tabular_reviews
-- ---------------------------------------------------------------------------
ALTER TABLE public.tabular_reviews
  ALTER COLUMN user_id TYPE uuid USING user_id::uuid;

ALTER TABLE public.tabular_reviews
  ADD CONSTRAINT tabular_reviews_user_id_fkey
  FOREIGN KEY (user_id)
  REFERENCES auth.users(id)
  ON DELETE CASCADE;

-- ---------------------------------------------------------------------------
-- tabular_review_chats
-- ---------------------------------------------------------------------------
ALTER TABLE public.tabular_review_chats
  ALTER COLUMN user_id TYPE uuid USING user_id::uuid;

ALTER TABLE public.tabular_review_chats
  ADD CONSTRAINT tabular_review_chats_user_id_fkey
  FOREIGN KEY (user_id)
  REFERENCES auth.users(id)
  ON DELETE CASCADE;

-- ---------------------------------------------------------------------------
-- workflows (user_id is nullable — system workflows have NULL)
-- ON DELETE SET NULL rather than CASCADE: deleting a user orphans their
-- workflows rather than deleting them, preserving shared workflow access
-- for other users who have workflow_shares rows referencing these workflows.
-- ---------------------------------------------------------------------------
ALTER TABLE public.workflows
  ALTER COLUMN user_id TYPE uuid USING user_id::uuid;

ALTER TABLE public.workflows
  ADD CONSTRAINT workflows_user_id_fkey
  FOREIGN KEY (user_id)
  REFERENCES auth.users(id)
  ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- hidden_workflows
-- ---------------------------------------------------------------------------
ALTER TABLE public.hidden_workflows
  ALTER COLUMN user_id TYPE uuid USING user_id::uuid;

ALTER TABLE public.hidden_workflows
  ADD CONSTRAINT hidden_workflows_user_id_fkey
  FOREIGN KEY (user_id)
  REFERENCES auth.users(id)
  ON DELETE CASCADE;

-- ---------------------------------------------------------------------------
-- workflow_shares (shared_by_user_id)
-- ---------------------------------------------------------------------------
ALTER TABLE public.workflow_shares
  ALTER COLUMN shared_by_user_id TYPE uuid USING shared_by_user_id::uuid;

ALTER TABLE public.workflow_shares
  ADD CONSTRAINT workflow_shares_shared_by_user_id_fkey
  FOREIGN KEY (shared_by_user_id)
  REFERENCES auth.users(id)
  ON DELETE CASCADE;

COMMIT;
