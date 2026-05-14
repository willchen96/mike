-- Mike one-shot Supabase schema
-- Based on supabase-migration.sql plus the later backend/migrations/*.sql files.
-- Use this for a fresh Supabase database. Existing deployments should continue
-- to apply the incremental migration files instead.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- User profiles
-- ---------------------------------------------------------------------------

create table if not exists public.user_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  display_name text,
  organisation text,
  tabular_model text not null default 'gemini-3-flash-preview',
  -- Phase 12: encrypted API keys + soft-delete
  claude_api_key_ciphertext bytea,
  claude_api_key_iv bytea,
  claude_api_key_auth_tag bytea,
  gemini_api_key_ciphertext bytea,
  gemini_api_key_iv bytea,
  gemini_api_key_auth_tag bytea,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_user_profiles_user
  on public.user_profiles(user_id);

-- Phase 12: partial index for soft-delete auth gate (CLEAN-44)
create index if not exists idx_user_profiles_deleted_at
  on public.user_profiles(user_id) where deleted_at is not null;

alter table public.user_profiles enable row level security;

drop policy if exists "Users can view their own profile" on public.user_profiles;
create policy "Users can view their own profile"
  on public.user_profiles for select
  using (auth.uid() = user_id);

drop policy if exists "Users can update their own profile" on public.user_profiles;
create policy "Users can update their own profile"
  on public.user_profiles for update
  using (auth.uid() = user_id);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.user_profiles (user_id)
  values (new.id)
  on conflict (user_id) do nothing;
  return new;
exception when others then
  -- Never block signup if the profile insert fails.
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Projects and documents
-- ---------------------------------------------------------------------------

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  cm_number text,
  visibility text not null default 'private',
  shared_with jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_projects_user
  on public.projects(user_id);

create index if not exists projects_shared_with_idx
  on public.projects using gin (shared_with);

create table if not exists public.project_subfolders (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  parent_folder_id uuid references public.project_subfolders(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_project_subfolders_project
  on public.project_subfolders(project_id);

create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  filename text not null,
  file_type text,
  size_bytes integer not null default 0,
  page_count integer,
  structure_tree jsonb,
  status text not null default 'pending',
  pdf_conversion_status text not null default 'ok' check (pdf_conversion_status in ('pending', 'ok', 'failed')),
  folder_id uuid references public.project_subfolders(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_documents_user_project
  on public.documents(user_id, project_id);

create index if not exists idx_documents_project_folder
  on public.documents(project_id, folder_id);

create table if not exists public.document_versions (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  storage_path text not null,
  pdf_storage_path text,
  source text not null default 'upload',
  version_number integer,
  display_name text,
  created_at timestamptz not null default now(),
  constraint document_versions_source_check
    check (source = any (array[
      'upload'::text,
      'user_upload'::text,
      'assistant_edit'::text,
      'user_accept'::text,
      'user_reject'::text,
      'generated'::text
    ]))
);

create index if not exists document_versions_document_id_idx
  on public.document_versions(document_id, created_at desc);

create index if not exists document_versions_doc_vnum_idx
  on public.document_versions(document_id, version_number);

alter table public.document_versions
  add constraint document_versions_doc_version_unique unique (document_id, version_number);

alter table public.documents
  add column if not exists current_version_id uuid
  references public.document_versions(id) on delete set null;

create table if not exists public.document_edits (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  chat_message_id uuid,
  version_id uuid not null references public.document_versions(id) on delete cascade,
  change_id text not null,
  del_w_id text,
  ins_w_id text,
  deleted_text text not null default '',
  inserted_text text not null default '',
  context_before text,
  context_after text,
  status text not null default 'pending'
    check (status = any (array[
      'pending'::text,
      'accepted'::text,
      'rejected'::text
    ])),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index if not exists document_edits_document_id_idx
  on public.document_edits(document_id, created_at desc);

create index if not exists document_edits_message_id_idx
  on public.document_edits(chat_message_id);

create index if not exists document_edits_version_id_idx
  on public.document_edits(version_id);

-- ---------------------------------------------------------------------------
-- Workflows
-- ---------------------------------------------------------------------------

create table if not exists public.workflows (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  title text not null,
  type text not null,
  prompt_md text,
  columns_config jsonb,
  practice text,
  is_system boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists idx_workflows_user
  on public.workflows(user_id);

create table if not exists public.hidden_workflows (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  workflow_id text not null,
  created_at timestamptz not null default now(),
  unique(user_id, workflow_id)
);

create index if not exists idx_hidden_workflows_user
  on public.hidden_workflows(user_id);

create table if not exists public.workflow_shares (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references public.workflows(id) on delete cascade,
  shared_by_user_id uuid not null references auth.users(id) on delete cascade,
  shared_with_email text not null,
  allow_edit boolean not null default false,
  created_at timestamptz not null default now(),
  constraint workflow_shares_workflow_email_unique
    unique(workflow_id, shared_with_email)
);

create index if not exists workflow_shares_workflow_id_idx
  on public.workflow_shares(workflow_id);

create index if not exists workflow_shares_email_idx
  on public.workflow_shares(shared_with_email);

-- ---------------------------------------------------------------------------
-- Assistant chats
-- ---------------------------------------------------------------------------

create table if not exists public.chats (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text,
  created_at timestamptz not null default now()
);

create index if not exists idx_chats_user
  on public.chats(user_id);

create index if not exists idx_chats_project
  on public.chats(project_id);

create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references public.chats(id) on delete cascade,
  role text not null,
  content jsonb,
  files jsonb,
  annotations jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_chat_messages_chat
  on public.chat_messages(chat_id);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'document_edits_chat_message_id_fkey'
      and conrelid = 'public.document_edits'::regclass
  ) then
    alter table public.document_edits
      add constraint document_edits_chat_message_id_fkey
      foreign key (chat_message_id)
      references public.chat_messages(id)
      on delete set null;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Tabular reviews
-- ---------------------------------------------------------------------------

create table if not exists public.tabular_reviews (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text,
  columns_config jsonb,
  workflow_id uuid references public.workflows(id) on delete set null,
  practice text,
  shared_with jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_tabular_reviews_user
  on public.tabular_reviews(user_id);

create index if not exists idx_tabular_reviews_project
  on public.tabular_reviews(project_id);

create index if not exists tabular_reviews_shared_with_idx
  on public.tabular_reviews using gin (shared_with);

create table if not exists public.tabular_cells (
  id uuid primary key default gen_random_uuid(),
  review_id uuid not null references public.tabular_reviews(id) on delete cascade,
  document_id uuid not null references public.documents(id) on delete cascade,
  column_index integer not null,
  content text,
  citations jsonb,
  status text not null default 'pending',
  created_at timestamptz not null default now()
);

create index if not exists idx_tabular_cells_review
  on public.tabular_cells(review_id, document_id, column_index);

create table if not exists public.tabular_review_chats (
  id uuid primary key default gen_random_uuid(),
  review_id uuid not null references public.tabular_reviews(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists tabular_review_chats_review_idx
  on public.tabular_review_chats(review_id, updated_at desc);

create index if not exists tabular_review_chats_user_idx
  on public.tabular_review_chats(user_id);

create table if not exists public.tabular_review_chat_messages (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references public.tabular_review_chats(id) on delete cascade,
  role text not null,
  content jsonb,
  annotations jsonb,
  created_at timestamptz not null default now()
);

create index if not exists tabular_review_chat_messages_chat_idx
  on public.tabular_review_chat_messages(chat_id, created_at);

-- ---------------------------------------------------------------------------
-- RPCs — server-side aggregations (CLEAN-28)
-- ---------------------------------------------------------------------------

-- Returns distinct document counts per tabular review.
-- EXPLAIN confirms idx_tabular_cells_review (review_id, document_id, column_index)
-- covers the (review_id, document_id) prefix via leftmost prefix — no new index needed.
create or replace function public.select_review_doc_counts(review_ids uuid[])
returns table (review_id uuid, doc_count bigint)
language sql
stable
security definer
set search_path = ''
as $$
    select review_id, count(distinct document_id) as doc_count
    from public.tabular_cells
    where review_id = any(review_ids)
    group by review_id;
$$;

revoke all on function public.select_review_doc_counts(uuid[]) from public, anon, authenticated;
grant execute on function public.select_review_doc_counts(uuid[]) to service_role;

-- CLEAN-29: document shared_with JSONB canonical shape on the two tables that carry it.
comment on column public.projects.shared_with is
    'Canonical shape: to_jsonb(array[lower(email)]) — array of lowercased email strings. Normalized at write in routes/projects.ts:265-275. Consolidation to a resource_shares table deferred to v2 (Phase 10 / CLEAN-29).';

comment on column public.tabular_reviews.shared_with is
    'Canonical shape: to_jsonb(array[lower(email)]) — array of lowercased email strings. Normalized at write in routes/tabular.ts. Consolidation to a resource_shares table deferred to v2 (Phase 10 / CLEAN-29).';

-- ---------------------------------------------------------------------------
-- Phase 12: encrypted API keys + soft-delete + deletion jobs (CLEAN-05, CLEAN-44)
-- (mirrors backend/migrations/0009_account_deletion_jobs.ts)
-- ---------------------------------------------------------------------------

create table if not exists public.account_deletion_jobs (
  user_id uuid primary key references auth.users(id) on delete cascade,
  scheduled_for timestamptz not null,
  status text not null default 'pending'
    check (status in ('pending', 'running', 'done', 'failed', 'cancelled')),
  last_continuation_token jsonb,
  restore_token_used_at timestamptz,
  claimed_by text,
  claimed_at timestamptz,
  attempts int not null default 0,
  last_error text,
  created_at timestamptz not null default now()
);

create index if not exists idx_account_deletion_jobs_due
  on public.account_deletion_jobs(scheduled_for) where status = 'pending';

-- ---------------------------------------------------------------------------
-- CLEAN-47: RLS defense-in-depth (mirrors backend/migrations/0005_rls_policies.ts)
-- See .planning/phases/11-rls-defense-in-depth/11-RESEARCH.md §2-§3 + §10 RESOLVED.
-- ---------------------------------------------------------------------------

-- ── Helper functions ────────────────────────────────────────────────────────
-- All helpers: language sql security definer stable set search_path = public.
-- DO NOT change to plpgsql — breaks GIN-pushdown (RESEARCH §2 Pitfall 1).

-- Helper 1: is_project_member(uuid) → boolean
-- Used by: documents, chats, document_versions, document_edits, tabular_cells,
-- chat_messages (transitively), is_document_member (wraps this).
create or replace function public.is_project_member(p_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1
    from public.projects
    where id = p_id
      and (
        user_id = auth.uid()
        or shared_with @> jsonb_build_array(lower(auth.email()))
      )
  );
$$;

revoke all on function public.is_project_member(uuid) from public;
grant execute on function public.is_project_member(uuid) to authenticated, service_role;

-- Helper 2: is_review_member(uuid) → boolean
-- Used by: tabular_reviews SELECT, tabular_cells, tabular_review_chats.
create or replace function public.is_review_member(r_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1
    from public.tabular_reviews tr
    where tr.id = r_id
      and (
        tr.user_id = auth.uid()
        or tr.shared_with @> jsonb_build_array(lower(auth.email()))
        or (tr.project_id is not null and public.is_project_member(tr.project_id))
      )
  );
$$;

revoke all on function public.is_review_member(uuid) from public;
grant execute on function public.is_review_member(uuid) to authenticated, service_role;

-- Helper 3: is_workflow_visible(uuid) → boolean
-- Used by: workflows SELECT.
create or replace function public.is_workflow_visible(w_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1
    from public.workflows w
    where w.id = w_id
      and w.user_id = auth.uid()
  )
  or exists (
    select 1
    from public.workflow_shares ws
    where ws.workflow_id = w_id
      and lower(ws.shared_with_email) = lower(auth.email())
  );
$$;

revoke all on function public.is_workflow_visible(uuid) from public;
grant execute on function public.is_workflow_visible(uuid) to authenticated, service_role;

-- Helper 4: is_chat_owner(uuid) → boolean
-- Used by: chat_messages.
create or replace function public.is_chat_owner(c_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1
    from public.chats c
    where c.id = c_id
      and (
        c.user_id = auth.uid()
        or (c.project_id is not null and public.is_project_member(c.project_id))
      )
  );
$$;

revoke all on function public.is_chat_owner(uuid) from public;
grant execute on function public.is_chat_owner(uuid) to authenticated, service_role;

-- Helper 5: is_document_member(uuid) → boolean
-- Used by: document_versions, document_edits.
create or replace function public.is_document_member(d_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1
    from public.documents d
    where d.id = d_id
      and (
        d.user_id = auth.uid()
        or (d.project_id is not null and public.is_project_member(d.project_id))
      )
  );
$$;

revoke all on function public.is_document_member(uuid) from public;
grant execute on function public.is_document_member(uuid) to authenticated, service_role;

-- ── Parallel jsonb_path_ops GIN indexes ────────────────────────────────────
-- Adds faster containment-only index; planner picks cheaper of the two.
-- Existing jsonb_ops indexes (projects_shared_with_idx, tabular_reviews_shared_with_idx)
-- are preserved — only additive.
create index if not exists projects_shared_with_pathops_idx
  on public.projects using gin (shared_with jsonb_path_ops);

create index if not exists tabular_reviews_shared_with_pathops_idx
  on public.tabular_reviews using gin (shared_with jsonb_path_ops);

-- ── Enable RLS on 14 user-owned tables ─────────────────────────────────────
-- Closed-by-default: no policy = no anon access.
-- The existing user-profile RLS block (above) is preserved per D-04.
alter table public.projects enable row level security;
alter table public.project_subfolders enable row level security;
alter table public.documents enable row level security;
alter table public.document_versions enable row level security;
alter table public.document_edits enable row level security;
alter table public.chats enable row level security;
alter table public.chat_messages enable row level security;
alter table public.tabular_reviews enable row level security;
alter table public.tabular_cells enable row level security;
alter table public.tabular_review_chats enable row level security;
alter table public.tabular_review_chat_messages enable row level security;
alter table public.workflows enable row level security;
alter table public.workflow_shares enable row level security;
alter table public.hidden_workflows enable row level security;

-- ── Per-table policies (idempotent drop-then-create pairs) ─────────────────

-- projects (4 policies)
drop policy if exists "projects_select_owner_or_shared" on public.projects;
create policy "projects_select_owner_or_shared"
  on public.projects for select
  to authenticated
  using (
    user_id = auth.uid()
    or shared_with @> jsonb_build_array(lower(auth.email()))
  );

drop policy if exists "projects_insert_owner" on public.projects;
create policy "projects_insert_owner"
  on public.projects for insert
  to authenticated
  with check (user_id = auth.uid());

drop policy if exists "projects_update_owner" on public.projects;
create policy "projects_update_owner"
  on public.projects for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "projects_delete_owner" on public.projects;
create policy "projects_delete_owner"
  on public.projects for delete
  to authenticated
  using (user_id = auth.uid());

-- project_subfolders (4 policies)
drop policy if exists "project_subfolders_select_member" on public.project_subfolders;
create policy "project_subfolders_select_member"
  on public.project_subfolders for select
  to authenticated
  using (public.is_project_member(project_id));

drop policy if exists "project_subfolders_insert_owner" on public.project_subfolders;
create policy "project_subfolders_insert_owner"
  on public.project_subfolders for insert
  to authenticated
  with check (user_id = auth.uid());

drop policy if exists "project_subfolders_update_owner" on public.project_subfolders;
create policy "project_subfolders_update_owner"
  on public.project_subfolders for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "project_subfolders_delete_owner" on public.project_subfolders;
create policy "project_subfolders_delete_owner"
  on public.project_subfolders for delete
  to authenticated
  using (user_id = auth.uid());

-- documents (4 policies)
drop policy if exists "documents_select_member" on public.documents;
create policy "documents_select_member"
  on public.documents for select
  to authenticated
  using (
    user_id = auth.uid()
    or (project_id is not null and public.is_project_member(project_id))
  );

drop policy if exists "documents_insert_owner" on public.documents;
create policy "documents_insert_owner"
  on public.documents for insert
  to authenticated
  with check (user_id = auth.uid());

drop policy if exists "documents_update_owner" on public.documents;
create policy "documents_update_owner"
  on public.documents for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "documents_delete_owner" on public.documents;
create policy "documents_delete_owner"
  on public.documents for delete
  to authenticated
  using (user_id = auth.uid());

-- document_versions (1 policy — SELECT only; no user_id column)
-- Mutations are service-role only.
drop policy if exists "document_versions_select_member" on public.document_versions;
create policy "document_versions_select_member"
  on public.document_versions for select
  to authenticated
  using (public.is_document_member(document_id));

-- document_edits (1 policy — SELECT only; no user_id column)
-- Mutations are service-role only.
drop policy if exists "document_edits_select_member" on public.document_edits;
create policy "document_edits_select_member"
  on public.document_edits for select
  to authenticated
  using (public.is_document_member(document_id));

-- chats (4 policies)
drop policy if exists "chats_select_owner_or_project_member" on public.chats;
create policy "chats_select_owner_or_project_member"
  on public.chats for select
  to authenticated
  using (
    user_id = auth.uid()
    or (project_id is not null and public.is_project_member(project_id))
  );

drop policy if exists "chats_insert_owner" on public.chats;
create policy "chats_insert_owner"
  on public.chats for insert
  to authenticated
  with check (user_id = auth.uid());

drop policy if exists "chats_update_owner" on public.chats;
create policy "chats_update_owner"
  on public.chats for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "chats_delete_owner" on public.chats;
create policy "chats_delete_owner"
  on public.chats for delete
  to authenticated
  using (user_id = auth.uid());

-- chat_messages (1 policy — SELECT only; no user_id column)
-- Mutations are service-role only.
drop policy if exists "chat_messages_select_chat_member" on public.chat_messages;
create policy "chat_messages_select_chat_member"
  on public.chat_messages for select
  to authenticated
  using (public.is_chat_owner(chat_id));

-- tabular_reviews (4 policies)
drop policy if exists "tabular_reviews_select_member" on public.tabular_reviews;
create policy "tabular_reviews_select_member"
  on public.tabular_reviews for select
  to authenticated
  using (
    user_id = auth.uid()
    or shared_with @> jsonb_build_array(lower(auth.email()))
    or (project_id is not null and public.is_project_member(project_id))
  );

drop policy if exists "tabular_reviews_insert_owner" on public.tabular_reviews;
create policy "tabular_reviews_insert_owner"
  on public.tabular_reviews for insert
  to authenticated
  with check (user_id = auth.uid());

drop policy if exists "tabular_reviews_update_owner" on public.tabular_reviews;
create policy "tabular_reviews_update_owner"
  on public.tabular_reviews for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "tabular_reviews_delete_owner" on public.tabular_reviews;
create policy "tabular_reviews_delete_owner"
  on public.tabular_reviews for delete
  to authenticated
  using (user_id = auth.uid());

-- tabular_cells (1 policy — SELECT only; no user_id column)
-- Mutations are service-role only.
drop policy if exists "tabular_cells_select_review_member" on public.tabular_cells;
create policy "tabular_cells_select_review_member"
  on public.tabular_cells for select
  to authenticated
  using (public.is_review_member(review_id));

-- tabular_review_chats (4 policies) — per RESEARCH.md §10 RESOLVED
-- Owner-only mutations; member SELECT via review membership.
drop policy if exists "tabular_review_chats_select_owner_or_review_member" on public.tabular_review_chats;
create policy "tabular_review_chats_select_owner_or_review_member"
  on public.tabular_review_chats for select
  to authenticated
  using (auth.uid() = user_id or public.is_review_member(review_id));

drop policy if exists "tabular_review_chats_insert_owner" on public.tabular_review_chats;
create policy "tabular_review_chats_insert_owner"
  on public.tabular_review_chats for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "tabular_review_chats_update_owner" on public.tabular_review_chats;
create policy "tabular_review_chats_update_owner"
  on public.tabular_review_chats for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "tabular_review_chats_delete_owner" on public.tabular_review_chats;
create policy "tabular_review_chats_delete_owner"
  on public.tabular_review_chats for delete
  to authenticated
  using (auth.uid() = user_id);

-- tabular_review_chat_messages (1 policy — SELECT only; no user_id column)
-- Mutations are service-role only; mirrors chat_messages pattern.
drop policy if exists "tabular_review_chat_messages_select_chat_member" on public.tabular_review_chat_messages;
create policy "tabular_review_chat_messages_select_chat_member"
  on public.tabular_review_chat_messages for select
  to authenticated
  using (
    exists (
      select 1 from public.tabular_review_chats c
      where c.id = chat_id
        and (c.user_id = auth.uid() or public.is_review_member(c.review_id))
    )
  );

-- workflows (4 policies)
-- workflows.user_id is NULLABLE (built-in workflows have user_id = NULL).
drop policy if exists "workflows_select_visible_or_builtin" on public.workflows;
create policy "workflows_select_visible_or_builtin"
  on public.workflows for select
  to authenticated
  using (
    is_system = true
    or user_id = auth.uid()
    or public.is_workflow_visible(id)
  );

drop policy if exists "workflows_insert_owner" on public.workflows;
create policy "workflows_insert_owner"
  on public.workflows for insert
  to authenticated
  with check (user_id = auth.uid());

drop policy if exists "workflows_update_owner" on public.workflows;
create policy "workflows_update_owner"
  on public.workflows for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "workflows_delete_owner" on public.workflows;
create policy "workflows_delete_owner"
  on public.workflows for delete
  to authenticated
  using (user_id = auth.uid());

-- workflow_shares (4 policies) — D-05: SELECT visible to owner AND recipient
drop policy if exists "workflow_shares_select_owner_or_recipient" on public.workflow_shares;
create policy "workflow_shares_select_owner_or_recipient"
  on public.workflow_shares for select
  to authenticated
  using (
    exists (
      select 1
      from public.workflows w
      where w.id = workflow_shares.workflow_id
        and w.user_id = auth.uid()
    )
    or lower(shared_with_email) = lower(auth.email())
  );

drop policy if exists "workflow_shares_insert_workflow_owner" on public.workflow_shares;
create policy "workflow_shares_insert_workflow_owner"
  on public.workflow_shares for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.workflows w
      where w.id = workflow_id
        and w.user_id = auth.uid()
    )
  );

drop policy if exists "workflow_shares_update_workflow_owner" on public.workflow_shares;
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

drop policy if exists "workflow_shares_delete_workflow_owner" on public.workflow_shares;
create policy "workflow_shares_delete_workflow_owner"
  on public.workflow_shares for delete
  to authenticated
  using (
    exists (
      select 1
      from public.workflows w
      where w.id = workflow_id
        and w.user_id = auth.uid()
    )
  );

-- hidden_workflows (4 policies — owner-only)
drop policy if exists "hidden_workflows_select_owner" on public.hidden_workflows;
create policy "hidden_workflows_select_owner"
  on public.hidden_workflows for select
  to authenticated
  using (user_id = auth.uid());

drop policy if exists "hidden_workflows_insert_owner" on public.hidden_workflows;
create policy "hidden_workflows_insert_owner"
  on public.hidden_workflows for insert
  to authenticated
  with check (user_id = auth.uid());

drop policy if exists "hidden_workflows_update_owner" on public.hidden_workflows;
create policy "hidden_workflows_update_owner"
  on public.hidden_workflows for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "hidden_workflows_delete_owner" on public.hidden_workflows;
create policy "hidden_workflows_delete_owner"
  on public.hidden_workflows for delete
  to authenticated
  using (user_id = auth.uid());
