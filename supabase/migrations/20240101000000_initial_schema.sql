-- Mike Supabase schema
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
  tier text not null default 'Free',
  message_credits_used integer not null default 0,
  credits_reset_date timestamptz not null default (now() + interval '30 days'),
  tabular_model text not null default 'gemini-3-flash-preview',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_user_profiles_user
  on public.user_profiles(user_id);

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

create table if not exists public.user_api_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('claude', 'gemini')),
  encrypted_key text not null,
  iv text not null,
  auth_tag text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, provider)
);

create index if not exists idx_user_api_keys_user
  on public.user_api_keys(user_id);

alter table public.user_api_keys enable row level security;

-- ---------------------------------------------------------------------------
-- Projects and documents
-- ---------------------------------------------------------------------------

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
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
  user_id text not null,
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
  user_id text not null,
  filename text not null,
  file_type text,
  size_bytes integer not null default 0,
  page_count integer,
  structure_tree jsonb,
  status text not null default 'pending',
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
  user_id text,
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
  user_id text not null,
  workflow_id text not null,
  created_at timestamptz not null default now(),
  unique(user_id, workflow_id)
);

create index if not exists idx_hidden_workflows_user
  on public.hidden_workflows(user_id);

create table if not exists public.workflow_shares (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references public.workflows(id) on delete cascade,
  shared_by_user_id text not null,
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
  user_id text not null,
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
  user_id text not null,
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
  user_id text not null,
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
-- Row-level security
-- ---------------------------------------------------------------------------

create or replace function public.current_user_id_text()
returns text
language sql
stable
set search_path = public, auth
as $$
  select auth.uid()::text;
$$;

create or replace function public.current_user_email()
returns text
language sql
stable
set search_path = public, auth
as $$
  select lower(coalesce(auth.jwt() ->> 'email', ''));
$$;

create or replace function public.email_is_shared(shared_with jsonb)
returns boolean
language sql
stable
set search_path = public
as $$
  select public.current_user_email() <> ''
    and exists (
      select 1
      from jsonb_array_elements_text(coalesce(shared_with, '[]'::jsonb)) as emails(email)
      where lower(emails.email) = public.current_user_email()
    );
$$;

create or replace function public.project_is_accessible(target_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1
    from public.projects p
    where p.id = target_project_id
      and (
        p.user_id = public.current_user_id_text()
        or public.email_is_shared(p.shared_with)
      )
  );
$$;

create or replace function public.review_is_accessible(target_review_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1
    from public.tabular_reviews r
    where r.id = target_review_id
      and (
        r.user_id = public.current_user_id_text()
        or public.email_is_shared(r.shared_with)
        or (
          r.project_id is not null
          and public.project_is_accessible(r.project_id)
        )
      )
  );
$$;

create or replace function public.workflow_can_view(target_workflow_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1
    from public.workflows w
    where w.id = target_workflow_id
      and (
        w.is_system
        or w.user_id = public.current_user_id_text()
        or exists (
          select 1
          from public.workflow_shares s
          where s.workflow_id = w.id
            and s.shared_with_email = public.current_user_email()
        )
      )
  );
$$;

create or replace function public.workflow_can_edit(target_workflow_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1
    from public.workflows w
    where w.id = target_workflow_id
      and (
        w.user_id = public.current_user_id_text()
        or exists (
          select 1
          from public.workflow_shares s
          where s.workflow_id = w.id
            and s.shared_with_email = public.current_user_email()
            and s.allow_edit
        )
      )
  );
$$;

alter table public.user_profiles enable row level security;
alter table public.user_api_keys enable row level security;
alter table public.projects enable row level security;
alter table public.project_subfolders enable row level security;
alter table public.documents enable row level security;
alter table public.document_versions enable row level security;
alter table public.document_edits enable row level security;
alter table public.workflows enable row level security;
alter table public.hidden_workflows enable row level security;
alter table public.workflow_shares enable row level security;
alter table public.chats enable row level security;
alter table public.chat_messages enable row level security;
alter table public.tabular_reviews enable row level security;
alter table public.tabular_cells enable row level security;
alter table public.tabular_review_chats enable row level security;
alter table public.tabular_review_chat_messages enable row level security;

drop policy if exists "Users can insert their own profile" on public.user_profiles;
create policy "Users can insert their own profile"
  on public.user_profiles for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can view their own profile" on public.user_profiles;
create policy "Users can view their own profile"
  on public.user_profiles for select
  using (auth.uid() = user_id);

drop policy if exists "Users can update their own profile" on public.user_profiles;
create policy "Users can update their own profile"
  on public.user_profiles for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- user_api_keys is intentionally service-role only. The browser can only see
-- key status through backend routes, never encrypted key material.

drop policy if exists "Users can view accessible projects" on public.projects;
create policy "Users can view accessible projects"
  on public.projects for select
  using (
    user_id = public.current_user_id_text()
    or public.email_is_shared(shared_with)
  );

drop policy if exists "Users can insert their own projects" on public.projects;
create policy "Users can insert their own projects"
  on public.projects for insert
  with check (user_id = public.current_user_id_text());

drop policy if exists "Owners can update projects" on public.projects;
create policy "Owners can update projects"
  on public.projects for update
  using (user_id = public.current_user_id_text())
  with check (user_id = public.current_user_id_text());

drop policy if exists "Owners can delete projects" on public.projects;
create policy "Owners can delete projects"
  on public.projects for delete
  using (user_id = public.current_user_id_text());

drop policy if exists "Users can view accessible project folders" on public.project_subfolders;
create policy "Users can view accessible project folders"
  on public.project_subfolders for select
  using (
    user_id = public.current_user_id_text()
    or public.project_is_accessible(project_id)
  );

drop policy if exists "Users can insert their own project folders" on public.project_subfolders;
create policy "Users can insert their own project folders"
  on public.project_subfolders for insert
  with check (
    user_id = public.current_user_id_text()
    and public.project_is_accessible(project_id)
  );

drop policy if exists "Owners can update project folders" on public.project_subfolders;
create policy "Owners can update project folders"
  on public.project_subfolders for update
  using (user_id = public.current_user_id_text())
  with check (user_id = public.current_user_id_text());

drop policy if exists "Owners can delete project folders" on public.project_subfolders;
create policy "Owners can delete project folders"
  on public.project_subfolders for delete
  using (user_id = public.current_user_id_text());

drop policy if exists "Users can view accessible documents" on public.documents;
create policy "Users can view accessible documents"
  on public.documents for select
  using (
    user_id = public.current_user_id_text()
    or (
      project_id is not null
      and public.project_is_accessible(project_id)
    )
  );

drop policy if exists "Users can insert their own documents" on public.documents;
create policy "Users can insert their own documents"
  on public.documents for insert
  with check (
    user_id = public.current_user_id_text()
    and (
      project_id is null
      or public.project_is_accessible(project_id)
    )
  );

drop policy if exists "Owners can update documents" on public.documents;
create policy "Owners can update documents"
  on public.documents for update
  using (user_id = public.current_user_id_text())
  with check (user_id = public.current_user_id_text());

drop policy if exists "Owners can delete documents" on public.documents;
create policy "Owners can delete documents"
  on public.documents for delete
  using (user_id = public.current_user_id_text());

drop policy if exists "Users can view accessible document versions" on public.document_versions;
create policy "Users can view accessible document versions"
  on public.document_versions for select
  using (
    exists (
      select 1
      from public.documents d
      where d.id = document_id
        and (
          d.user_id = public.current_user_id_text()
          or (
            d.project_id is not null
            and public.project_is_accessible(d.project_id)
          )
        )
    )
  );

drop policy if exists "Document owners can insert versions" on public.document_versions;
create policy "Document owners can insert versions"
  on public.document_versions for insert
  with check (
    exists (
      select 1
      from public.documents d
      where d.id = document_id
        and d.user_id = public.current_user_id_text()
    )
  );

drop policy if exists "Document owners can update versions" on public.document_versions;
create policy "Document owners can update versions"
  on public.document_versions for update
  using (
    exists (
      select 1
      from public.documents d
      where d.id = document_id
        and d.user_id = public.current_user_id_text()
    )
  )
  with check (
    exists (
      select 1
      from public.documents d
      where d.id = document_id
        and d.user_id = public.current_user_id_text()
    )
  );

drop policy if exists "Document owners can delete versions" on public.document_versions;
create policy "Document owners can delete versions"
  on public.document_versions for delete
  using (
    exists (
      select 1
      from public.documents d
      where d.id = document_id
        and d.user_id = public.current_user_id_text()
    )
  );

drop policy if exists "Users can view accessible document edits" on public.document_edits;
create policy "Users can view accessible document edits"
  on public.document_edits for select
  using (
    exists (
      select 1
      from public.documents d
      where d.id = document_id
        and (
          d.user_id = public.current_user_id_text()
          or (
            d.project_id is not null
            and public.project_is_accessible(d.project_id)
          )
        )
    )
  );

drop policy if exists "Document owners can insert edits" on public.document_edits;
create policy "Document owners can insert edits"
  on public.document_edits for insert
  with check (
    exists (
      select 1
      from public.documents d
      where d.id = document_id
        and d.user_id = public.current_user_id_text()
    )
  );

drop policy if exists "Document owners can update edits" on public.document_edits;
create policy "Document owners can update edits"
  on public.document_edits for update
  using (
    exists (
      select 1
      from public.documents d
      where d.id = document_id
        and d.user_id = public.current_user_id_text()
    )
  )
  with check (
    exists (
      select 1
      from public.documents d
      where d.id = document_id
        and d.user_id = public.current_user_id_text()
    )
  );

drop policy if exists "Document owners can delete edits" on public.document_edits;
create policy "Document owners can delete edits"
  on public.document_edits for delete
  using (
    exists (
      select 1
      from public.documents d
      where d.id = document_id
        and d.user_id = public.current_user_id_text()
    )
  );

drop policy if exists "Users can view accessible workflows" on public.workflows;
create policy "Users can view accessible workflows"
  on public.workflows for select
  using (public.workflow_can_view(id));

drop policy if exists "Users can insert their own workflows" on public.workflows;
create policy "Users can insert their own workflows"
  on public.workflows for insert
  with check (user_id = public.current_user_id_text());

drop policy if exists "Workflow owners can update workflows" on public.workflows;
create policy "Workflow owners can update workflows"
  on public.workflows for update
  using (user_id = public.current_user_id_text())
  with check (user_id = public.current_user_id_text());

drop policy if exists "Workflow owners can delete workflows" on public.workflows;
create policy "Workflow owners can delete workflows"
  on public.workflows for delete
  using (user_id = public.current_user_id_text());

drop policy if exists "Users can manage their hidden workflows" on public.hidden_workflows;
create policy "Users can manage their hidden workflows"
  on public.hidden_workflows for all
  using (user_id = public.current_user_id_text())
  with check (user_id = public.current_user_id_text());

drop policy if exists "Users can view relevant workflow shares" on public.workflow_shares;
create policy "Users can view relevant workflow shares"
  on public.workflow_shares for select
  using (
    shared_by_user_id = public.current_user_id_text()
    or shared_with_email = public.current_user_email()
  );

drop policy if exists "Workflow owners can insert shares" on public.workflow_shares;
create policy "Workflow owners can insert shares"
  on public.workflow_shares for insert
  with check (
    shared_by_user_id = public.current_user_id_text()
    and exists (
      select 1
      from public.workflows w
      where w.id = workflow_id
        and w.user_id = public.current_user_id_text()
    )
  );

drop policy if exists "Workflow owners can update shares" on public.workflow_shares;
create policy "Workflow owners can update shares"
  on public.workflow_shares for update
  using (shared_by_user_id = public.current_user_id_text())
  with check (shared_by_user_id = public.current_user_id_text());

drop policy if exists "Workflow owners can delete shares" on public.workflow_shares;
create policy "Workflow owners can delete shares"
  on public.workflow_shares for delete
  using (shared_by_user_id = public.current_user_id_text());

drop policy if exists "Users can view accessible chats" on public.chats;
create policy "Users can view accessible chats"
  on public.chats for select
  using (
    user_id = public.current_user_id_text()
    or (
      project_id is not null
      and public.project_is_accessible(project_id)
    )
  );

drop policy if exists "Users can insert their own chats" on public.chats;
create policy "Users can insert their own chats"
  on public.chats for insert
  with check (
    user_id = public.current_user_id_text()
    and (
      project_id is null
      or public.project_is_accessible(project_id)
    )
  );

drop policy if exists "Chat owners can update chats" on public.chats;
create policy "Chat owners can update chats"
  on public.chats for update
  using (user_id = public.current_user_id_text())
  with check (user_id = public.current_user_id_text());

drop policy if exists "Chat owners can delete chats" on public.chats;
create policy "Chat owners can delete chats"
  on public.chats for delete
  using (user_id = public.current_user_id_text());

drop policy if exists "Users can view accessible chat messages" on public.chat_messages;
create policy "Users can view accessible chat messages"
  on public.chat_messages for select
  using (
    exists (
      select 1
      from public.chats c
      where c.id = chat_id
        and (
          c.user_id = public.current_user_id_text()
          or (
            c.project_id is not null
            and public.project_is_accessible(c.project_id)
          )
        )
    )
  );

drop policy if exists "Chat owners can insert messages" on public.chat_messages;
create policy "Chat owners can insert messages"
  on public.chat_messages for insert
  with check (
    exists (
      select 1
      from public.chats c
      where c.id = chat_id
        and c.user_id = public.current_user_id_text()
    )
  );

drop policy if exists "Chat owners can update messages" on public.chat_messages;
create policy "Chat owners can update messages"
  on public.chat_messages for update
  using (
    exists (
      select 1
      from public.chats c
      where c.id = chat_id
        and c.user_id = public.current_user_id_text()
    )
  )
  with check (
    exists (
      select 1
      from public.chats c
      where c.id = chat_id
        and c.user_id = public.current_user_id_text()
    )
  );

drop policy if exists "Chat owners can delete messages" on public.chat_messages;
create policy "Chat owners can delete messages"
  on public.chat_messages for delete
  using (
    exists (
      select 1
      from public.chats c
      where c.id = chat_id
        and c.user_id = public.current_user_id_text()
    )
  );

drop policy if exists "Users can view accessible tabular reviews" on public.tabular_reviews;
create policy "Users can view accessible tabular reviews"
  on public.tabular_reviews for select
  using (
    user_id = public.current_user_id_text()
    or public.email_is_shared(shared_with)
    or (
      project_id is not null
      and public.project_is_accessible(project_id)
    )
  );

drop policy if exists "Users can insert their own tabular reviews" on public.tabular_reviews;
create policy "Users can insert their own tabular reviews"
  on public.tabular_reviews for insert
  with check (
    user_id = public.current_user_id_text()
    and (
      project_id is null
      or public.project_is_accessible(project_id)
    )
  );

drop policy if exists "Review owners can update tabular reviews" on public.tabular_reviews;
create policy "Review owners can update tabular reviews"
  on public.tabular_reviews for update
  using (user_id = public.current_user_id_text())
  with check (user_id = public.current_user_id_text());

drop policy if exists "Review owners can delete tabular reviews" on public.tabular_reviews;
create policy "Review owners can delete tabular reviews"
  on public.tabular_reviews for delete
  using (user_id = public.current_user_id_text());

drop policy if exists "Users can view accessible tabular cells" on public.tabular_cells;
create policy "Users can view accessible tabular cells"
  on public.tabular_cells for select
  using (public.review_is_accessible(review_id));

drop policy if exists "Review owners can insert tabular cells" on public.tabular_cells;
create policy "Review owners can insert tabular cells"
  on public.tabular_cells for insert
  with check (
    exists (
      select 1
      from public.tabular_reviews r
      where r.id = review_id
        and r.user_id = public.current_user_id_text()
    )
  );

drop policy if exists "Review owners can update tabular cells" on public.tabular_cells;
create policy "Review owners can update tabular cells"
  on public.tabular_cells for update
  using (
    exists (
      select 1
      from public.tabular_reviews r
      where r.id = review_id
        and r.user_id = public.current_user_id_text()
    )
  )
  with check (
    exists (
      select 1
      from public.tabular_reviews r
      where r.id = review_id
        and r.user_id = public.current_user_id_text()
    )
  );

drop policy if exists "Review owners can delete tabular cells" on public.tabular_cells;
create policy "Review owners can delete tabular cells"
  on public.tabular_cells for delete
  using (
    exists (
      select 1
      from public.tabular_reviews r
      where r.id = review_id
        and r.user_id = public.current_user_id_text()
    )
  );

drop policy if exists "Users can view accessible tabular review chats" on public.tabular_review_chats;
create policy "Users can view accessible tabular review chats"
  on public.tabular_review_chats for select
  using (
    user_id = public.current_user_id_text()
    or public.review_is_accessible(review_id)
  );

drop policy if exists "Users can insert their own tabular review chats" on public.tabular_review_chats;
create policy "Users can insert their own tabular review chats"
  on public.tabular_review_chats for insert
  with check (
    user_id = public.current_user_id_text()
    and public.review_is_accessible(review_id)
  );

drop policy if exists "Tabular chat owners can update chats" on public.tabular_review_chats;
create policy "Tabular chat owners can update chats"
  on public.tabular_review_chats for update
  using (user_id = public.current_user_id_text())
  with check (user_id = public.current_user_id_text());

drop policy if exists "Tabular chat owners can delete chats" on public.tabular_review_chats;
create policy "Tabular chat owners can delete chats"
  on public.tabular_review_chats for delete
  using (user_id = public.current_user_id_text());

drop policy if exists "Users can view accessible tabular chat messages" on public.tabular_review_chat_messages;
create policy "Users can view accessible tabular chat messages"
  on public.tabular_review_chat_messages for select
  using (
    exists (
      select 1
      from public.tabular_review_chats c
      where c.id = chat_id
        and (
          c.user_id = public.current_user_id_text()
          or public.review_is_accessible(c.review_id)
        )
    )
  );

drop policy if exists "Tabular chat owners can insert messages" on public.tabular_review_chat_messages;
create policy "Tabular chat owners can insert messages"
  on public.tabular_review_chat_messages for insert
  with check (
    exists (
      select 1
      from public.tabular_review_chats c
      where c.id = chat_id
        and c.user_id = public.current_user_id_text()
    )
  );

drop policy if exists "Tabular chat owners can update messages" on public.tabular_review_chat_messages;
create policy "Tabular chat owners can update messages"
  on public.tabular_review_chat_messages for update
  using (
    exists (
      select 1
      from public.tabular_review_chats c
      where c.id = chat_id
        and c.user_id = public.current_user_id_text()
    )
  )
  with check (
    exists (
      select 1
      from public.tabular_review_chats c
      where c.id = chat_id
        and c.user_id = public.current_user_id_text()
    )
  );

drop policy if exists "Tabular chat owners can delete messages" on public.tabular_review_chat_messages;
create policy "Tabular chat owners can delete messages"
  on public.tabular_review_chat_messages for delete
  using (
    exists (
      select 1
      from public.tabular_review_chats c
      where c.id = chat_id
        and c.user_id = public.current_user_id_text()
    )
  );
