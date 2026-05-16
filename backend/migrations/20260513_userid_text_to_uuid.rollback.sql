-- Rollback: revert user_id uuid FK migration
-- Run this ONLY if the forward migration needs to be undone.
-- This will NOT restore data that was deleted by ON DELETE CASCADE/SET NULL.

BEGIN;

-- workflow_shares
ALTER TABLE public.workflow_shares DROP CONSTRAINT IF EXISTS workflow_shares_shared_by_user_id_fkey;
ALTER TABLE public.workflow_shares ALTER COLUMN shared_by_user_id TYPE text;

-- hidden_workflows
ALTER TABLE public.hidden_workflows DROP CONSTRAINT IF EXISTS hidden_workflows_user_id_fkey;
ALTER TABLE public.hidden_workflows ALTER COLUMN user_id TYPE text;

-- workflows
ALTER TABLE public.workflows DROP CONSTRAINT IF EXISTS workflows_user_id_fkey;
ALTER TABLE public.workflows ALTER COLUMN user_id TYPE text;

-- tabular_review_chats
ALTER TABLE public.tabular_review_chats DROP CONSTRAINT IF EXISTS tabular_review_chats_user_id_fkey;
ALTER TABLE public.tabular_review_chats ALTER COLUMN user_id TYPE text;

-- tabular_reviews
ALTER TABLE public.tabular_reviews DROP CONSTRAINT IF EXISTS tabular_reviews_user_id_fkey;
ALTER TABLE public.tabular_reviews ALTER COLUMN user_id TYPE text;

-- chats
ALTER TABLE public.chats DROP CONSTRAINT IF EXISTS chats_user_id_fkey;
ALTER TABLE public.chats ALTER COLUMN user_id TYPE text;

-- documents
ALTER TABLE public.documents DROP CONSTRAINT IF EXISTS documents_user_id_fkey;
ALTER TABLE public.documents ALTER COLUMN user_id TYPE text;

-- project_subfolders
ALTER TABLE public.project_subfolders DROP CONSTRAINT IF EXISTS project_subfolders_user_id_fkey;
ALTER TABLE public.project_subfolders ALTER COLUMN user_id TYPE text;

-- projects
ALTER TABLE public.projects DROP CONSTRAINT IF EXISTS projects_user_id_fkey;
ALTER TABLE public.projects ALTER COLUMN user_id TYPE text;

COMMIT;
