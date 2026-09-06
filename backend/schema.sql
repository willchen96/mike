-- Mike Supabase schema
-- Use this for a fresh Supabase database. Existing deployments should instead
-- apply the dated incremental migration files in backend/migrations that are
-- newer than the version of Mike they currently have deployed.

create extension if not exists "pgcrypto";
create extension if not exists "pg_trgm";

-- ---------------------------------------------------------------------------
-- User profiles
-- ---------------------------------------------------------------------------

create table if not exists public.user_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  email text,
  display_name text,
  organisation text,
  jurisdiction text,
  practice_setting text
    check (
      practice_setting is null
      or practice_setting in ('private_practice', 'in_house', 'not_practising')
    ),
  professional_title text
    check (
      professional_title is null
      or professional_title in (
        'Partner',
        'Senior Associate',
        'Associate',
        'Law Clerk',
        'Counsel',
        'General Counsel',
        'Legal Counsel',
        'Other'
      )
    ),
  practice_areas text[] not null default '{}'::text[],
  onboarding_version smallint
    check (onboarding_version is null or onboarding_version >= 0),
  password_set_at timestamptz,
  tier text not null default 'Free',
  message_credits_used integer not null default 0,
  credits_reset_date timestamptz not null default (now() + interval '30 days'),
  title_model text,
  tabular_model text,
  last_selected_chat_model text,
  last_selected_reasoning_level text check (last_selected_reasoning_level in ('none', 'low', 'medium', 'high', 'xhigh', 'max')),
  quote_model text,
  mfa_on_login boolean not null default false,
  legal_research_us boolean not null default true,
  quick_actions_visible boolean not null default true,
  dark_mode boolean not null default false,
  transparent_tables boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_user_profiles_user
  on public.user_profiles(user_id);

create unique index if not exists user_profiles_email_lower_unique
  on public.user_profiles (lower(email))
  where email is not null and btrim(email) <> '';

create index if not exists idx_user_profiles_email
  on public.user_profiles(email);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.user_profiles (
    user_id,
    email,
    display_name,
    organisation
  )
  values (
    new.id,
    lower(new.email),
    nullif(left(btrim(coalesce(
      new.raw_user_meta_data ->> 'display_name',
      new.raw_user_meta_data ->> 'full_name',
      new.raw_user_meta_data ->> 'name',
      ''
    )), 200), ''),
    nullif(left(btrim(coalesce(new.raw_user_meta_data ->> 'organisation', '')), 200), '')
  )
  on conflict (user_id) do update
    set email = excluded.email,
        display_name = coalesce(
          nullif(btrim(user_profiles.display_name), ''),
          excluded.display_name
        ),
        organisation = coalesce(
          nullif(btrim(user_profiles.organisation), ''),
          excluded.organisation
        ),
        updated_at = now();
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

create or replace function public.sync_user_password_set(p_user_id uuid)
returns timestamptz
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  recorded_at timestamptz;
begin
  update public.user_profiles as profile
  set password_set_at = coalesce(profile.password_set_at, now()),
      updated_at = now()
  where profile.user_id = p_user_id
    and exists (
      select 1
      from auth.users as auth_user
      where auth_user.id = p_user_id
        and auth_user.encrypted_password is not null
        and auth_user.encrypted_password::text <> ''
    )
  returning profile.password_set_at into recorded_at;

  return recorded_at;
end;
$$;

revoke all on function public.sync_user_password_set(uuid)
  from public, anon, authenticated;
grant execute on function public.sync_user_password_set(uuid)
  to service_role;

create or replace function public.handle_user_email_updated()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.user_profiles
  set email = lower(new.email),
      updated_at = now()
  where user_id = new.id;
  return new;
end;
$$;

drop trigger if exists on_auth_user_email_updated on auth.users;
create trigger on_auth_user_email_updated
  after update of email on auth.users
  for each row
  when (old.email is distinct from new.email)
  execute procedure public.handle_user_email_updated();

-- Short-lived OAuth handoffs let an Office dialog establish a separate,
-- partitioned HttpOnly session in the embedded Word task pane. Supabase tokens
-- are encrypted at rest and the opaque browser-visible ticket is single-use.
create table if not exists public.auth_handoff_tickets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  ticket_hash text not null unique,
  request_id text not null,
  origin text not null,
  encrypted_session text not null,
  session_iv text not null,
  session_tag text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_auth_handoff_tickets_expires
  on public.auth_handoff_tickets(expires_at);

alter table public.auth_handoff_tickets enable row level security;

-- ---------------------------------------------------------------------------
-- Organizations / RBAC (multi-tenant)
-- Defined before projects/documents/workflows/tabular_reviews because those
-- carry an org_id FK to organizations(id). See lib/access.ts for the
-- admin/member enforcement. SSO/SAML/SCIM are intentional extension points
-- (future organizations.sso_config / scim_token).
--
-- Personal content is simply `org_id is null`. There is no hidden personal
-- organization: an extra org row and owner-membership per account bought
-- nothing that `user_id` did not already anchor, while making every query
-- carry a tenant that existed only to be ignored.
-- ---------------------------------------------------------------------------

create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.organizations enable row level security;

-- Exactly two roles. `admin` administers the org and inherits Owner across its
-- content; `member` collaborates and inherits Editor. Membership
-- rows are written only by org creation (the creator) and by invitation
-- acceptance.
create table if not exists public.org_members (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member'
    check (role in ('admin', 'member')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(org_id, user_id)
);

create index if not exists idx_org_members_user on public.org_members(user_id);
create index if not exists idx_org_members_org on public.org_members(org_id);

alter table public.org_members enable row level security;

-- DB-level guard for "an organization must keep at least one admin". The
-- service layer checks this too, but its read-then-act check races: two
-- concurrent departures of two different admins can both pass and strand the
-- org with nobody able to invite, re-role or remove anyone. The trigger
-- serializes admin departures per org by locking the organizations row, and
-- steps aside for the two legitimate cascades: org deletion (the org row is
-- already gone in this transaction) and auth-user deletion (the member's auth
-- row is already gone). security definer so the auth.users probe works
-- regardless of the calling role, mirroring handle_new_user.
create or replace function public.org_members_protect_last_admin()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.role <> 'admin' then
    return coalesce(new, old);
  end if;
  if tg_op = 'UPDATE' and new.role = 'admin' then
    return new;
  end if;

  -- Serialize concurrent admin departures on this org. If the org row is
  -- already deleted in this transaction (delete cascade), stand aside.
  perform 1 from public.organizations where id = old.org_id for update;
  if not found then
    return coalesce(new, old);
  end if;

  -- Member's auth user being deleted (cascade from auth.users): stand aside.
  if tg_op = 'DELETE' and not exists (
    select 1 from auth.users where id = old.user_id
  ) then
    return old;
  end if;

  if not exists (
    select 1 from public.org_members
    where org_id = old.org_id and role = 'admin' and user_id <> old.user_id
  ) then
    raise exception 'An organization must keep at least one admin'
      using errcode = '23514';
  end if;

  return coalesce(new, old);
end;
$$;

drop trigger if exists org_members_last_admin_guard on public.org_members;
create trigger org_members_last_admin_guard
  before delete or update of role on public.org_members
  for each row execute procedure public.org_members_protect_last_admin();

-- Invitations. Joining a firm's workspace exposes confidential material, so
-- membership requires the recipient's consent: an admin creates a pending
-- invitation, and org_members only appears when the invited account accepts.
-- A pending invitation grants NOTHING on its own.
--
-- Addressed by normalized email rather than user id so an invitation can be
-- created before the recipient has an account and claimed after they sign up.
-- Expiry is evaluated lazily on read (a pending row past expires_at reports as
-- expired and cannot be accepted), so no sweeper job races the accept path.
create table if not exists public.org_invitations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  email text not null,
  role text not null default 'member'
    check (role in ('admin', 'member')),
  invited_by uuid references auth.users(id) on delete set null,
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'declined', 'cancelled', 'expired')),
  expires_at timestamptz not null default (now() + interval '14 days'),
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  declined_at timestamptz,
  cancelled_at timestamptz,
  constraint org_invitations_email_lowercase check (email = lower(email))
);

-- One live invitation per (org, email); answered ones may accumulate.
create unique index if not exists org_invitations_active_unique
  on public.org_invitations(org_id, email)
  where status = 'pending';

create index if not exists idx_org_invitations_email
  on public.org_invitations(email) where status = 'pending';
create index if not exists idx_org_invitations_org
  on public.org_invitations(org_id);

alter table public.org_invitations enable row level security;

create table if not exists public.user_api_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('claude', 'gemini', 'openai', 'openrouter', 'vercel', 'opencode-go', 'courtlistener')),
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

-- Ordered, user-selected models for API routing gateways. Router slugs are
-- deliberately provider-neutral (for example `openrouter` or `vercel`).
create table if not exists public.user_router_models (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  router text not null
    check (router ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  model_id text not null
    check (
      model_id = btrim(model_id)
      and char_length(model_id) between 1 and 200
      and model_id !~ '\s'
    ),
  sort_order integer not null default 0 check (sort_order >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, router, model_id)
);

create index if not exists idx_user_router_models_user_router_order
  on public.user_router_models (user_id, router, sort_order, created_at);

alter table public.user_router_models enable row level security;

create or replace function public.replace_user_router_models(
  target_user_id uuid,
  target_router text,
  target_model_ids text[]
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  if target_router !~ '^[a-z0-9][a-z0-9_-]{0,63}$' then
    raise exception 'Invalid router slug';
  end if;

  if coalesce(array_length(target_model_ids, 1), 0) > 50 then
    raise exception 'A router can have at most 50 selected models';
  end if;

  -- Serialize concurrent replacements of the SAME user+router selection.
  -- Two overlapping PATCHes would otherwise interleave delete+insert and one
  -- of them would die on the (user_id, router, model_id) unique constraint.
  -- An advisory xact lock is keyed by an application-chosen value (here a
  -- hash of user+router), blocks only the matching key, and releases itself
  -- at commit/rollback — no table-wide locking, nothing left behind.
  -- hashtextextended (int8, the repo's convention for advisory locks) rather
  -- than hashtext (int4): the wider namespace makes an accidental collision
  -- with an unrelated lock key vastly less likely, and every other advisory
  -- lock in this schema is already keyed the same way.
  perform pg_advisory_xact_lock(
    hashtextextended(target_user_id::text || ':' || target_router, 0)
  );

  delete from public.user_router_models
  where user_id = target_user_id and router = target_router;

  insert into public.user_router_models (
    user_id,
    router,
    model_id,
    sort_order
  )
  select
    target_user_id,
    target_router,
    model_id,
    ordinality - 1
  from unnest(coalesce(target_model_ids, '{}'::text[]))
    with ordinality as selected(model_id, ordinality);
end;
$$;

create table if not exists public.user_mcp_connectors (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  transport text not null default 'streamable_http'
    check (transport in ('streamable_http')),
  server_url text not null,
  auth_type text not null default 'none'
    check (auth_type in ('none', 'bearer', 'oauth')),
  enabled boolean not null default true,
  tool_policy jsonb not null default '{}'::jsonb,
  encrypted_auth_config text,
  auth_config_iv text,
  auth_config_tag text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_user_mcp_connectors_user
  on public.user_mcp_connectors(user_id);

alter table public.user_mcp_connectors enable row level security;

create table if not exists public.user_mcp_oauth_tokens (
  id uuid primary key default gen_random_uuid(),
  connector_id uuid not null references public.user_mcp_connectors(id) on delete cascade,
  encrypted_access_token text,
  access_token_iv text,
  access_token_tag text,
  encrypted_refresh_token text,
  refresh_token_iv text,
  refresh_token_tag text,
  token_type text,
  scope text,
  expires_at timestamptz,
  authorization_server text,
  token_endpoint text,
  client_id text,
  encrypted_client_secret text,
  client_secret_iv text,
  client_secret_tag text,
  resource text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(connector_id)
);

alter table public.user_mcp_oauth_tokens enable row level security;

create table if not exists public.user_mcp_oauth_states (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  connector_id uuid not null references public.user_mcp_connectors(id) on delete cascade,
  state_hash text not null unique,
  encrypted_state_config text not null,
  state_config_iv text not null,
  state_config_tag text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_user_mcp_oauth_states_expires
  on public.user_mcp_oauth_states(expires_at);

alter table public.user_mcp_oauth_states enable row level security;

create table if not exists public.user_mcp_connector_tools (
  id uuid primary key default gen_random_uuid(),
  connector_id uuid not null references public.user_mcp_connectors(id) on delete cascade,
  tool_name text not null,
  openai_tool_name text not null,
  title text,
  description text,
  input_schema jsonb not null default '{"type":"object","properties":{}}'::jsonb,
  output_schema jsonb,
  annotations jsonb not null default '{}'::jsonb,
  enabled boolean not null default true,
  requires_confirmation boolean not null default false,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(connector_id, tool_name),
  unique(openai_tool_name)
);

create index if not exists idx_user_mcp_connector_tools_connector
  on public.user_mcp_connector_tools(connector_id);

alter table public.user_mcp_connector_tools enable row level security;

create table if not exists public.user_mcp_tool_audit_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  connector_id uuid not null references public.user_mcp_connectors(id) on delete cascade,
  tool_id uuid references public.user_mcp_connector_tools(id) on delete set null,
  tool_name text not null,
  openai_tool_name text not null,
  status text not null check (status in ('ok', 'error')),
  error_message text,
  duration_ms integer not null default 0,
  result_size_chars integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists idx_user_mcp_tool_audit_logs_user_created
  on public.user_mcp_tool_audit_logs(user_id, created_at desc);

alter table public.user_mcp_tool_audit_logs enable row level security;

-- ---------------------------------------------------------------------------
-- Projects and documents
-- ---------------------------------------------------------------------------

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  -- Nullable: an organization project outlives the account that created it.
  -- user_id is provenance ("who made this"), not the access rule — that flows
  -- from project_access_grants and org membership (lib/access.ts).
  user_id uuid references auth.users(id) on delete set null,
  -- Multi-tenant: nullable so system/global rows stay valid; user_id remains
  -- the hard cascade anchor (org_id uses SET NULL, not CASCADE).
  org_id uuid references public.organizations(id) on delete restrict,
  name text not null,
  cm_number text,
  practice text,
  visibility text not null default 'private',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_projects_user
  on public.projects(user_id);

create index if not exists projects_updated_at_idx
  on public.projects(updated_at desc, id);

create index if not exists idx_projects_org
  on public.projects(org_id);

-- ---------------------------------------------------------------------------
-- project_access_grants — direct, role-aware sharing
-- ---------------------------------------------------------------------------
-- Supersedes the roleless projects.shared_with email array, which could say
-- WHO had access but never WHAT they could do: read-only outside counsel and
-- a colleague restructuring the matter were the same grant.
--
-- Keyed by normalized email, not user id. Grant creation requires an existing
-- user profile. Organization projects use their organization membership and
-- override tables exclusively, so these direct grants apply only to personal
-- projects.
create table if not exists public.project_access_grants (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  email text not null,
  role text not null default 'editor'
    check (role in ('owner', 'editor', 'viewer')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(project_id, email),
  constraint project_access_grants_email_lowercase check (email = lower(email))
);

create index if not exists idx_project_access_grants_email
  on public.project_access_grants(email);
create index if not exists idx_project_access_grants_project
  on public.project_access_grants(project_id);

alter table public.project_access_grants enable row level security;

create table if not exists public.project_org_access_overrides (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  org_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null,
  role text not null constraint project_org_access_overrides_role_check
    check (role in ('owner', 'editor', 'viewer', 'deny')),
  assigned_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(project_id, user_id),
  foreign key (org_id, user_id)
    references public.org_members(org_id, user_id) on delete cascade
);

create index if not exists idx_project_org_access_overrides_user
  on public.project_org_access_overrides(user_id);

alter table public.project_org_access_overrides enable row level security;

-- ---------------------------------------------------------------------------
-- Role resolution, shared by every list RPC
-- ---------------------------------------------------------------------------
-- Resolve exactly one sharing scope in one place instead of once per RPC.
-- Organization projects ignore direct grants; personal projects use only a
-- creator or direct grant. Organization overrides replace inherited roles.
--
-- Returns null when the caller has no access at all, which is how the list
-- RPCs' visibility predicates and this column stay consistent with each other.
create or replace function public.project_access_role(
  p_project_id uuid,
  p_project_user_id uuid,
  p_org_id uuid,
  p_user_id text,
  p_user_email text
)
returns text
language sql
stable
set search_path = public
as $$
  select case
    when p_org_id is not null then (
      select case
        when p_project_user_id::text = p_user_id then 'owner'
        when m.role = 'admin' then 'owner'
        when o.role = 'deny' then null
        when o.role in ('owner', 'editor', 'viewer') then o.role
        else 'editor'
      end
      from public.org_members m
      left join public.project_org_access_overrides o
        on o.project_id = p_project_id
       and o.org_id = p_org_id
       and o.user_id = m.user_id
      where m.org_id = p_org_id and m.user_id::text = p_user_id
    )
    when p_project_user_id::text = p_user_id then 'owner'
    else (
      select g.role from public.project_access_grants g
      where g.project_id = p_project_id
        and coalesce(p_user_email, '') <> ''
        and g.email = lower(p_user_email)
      limit 1
    )
  end;
$$;

create table if not exists public.project_subfolders (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  -- Nullable + SET NULL: content inside an organization project survives its
  -- author's account deletion (userDataCleanup detaches rather than deletes).
  user_id uuid references auth.users(id) on delete set null,
  name text not null,
  parent_folder_id uuid references public.project_subfolders(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_project_subfolders_project
  on public.project_subfolders(project_id);

create table if not exists public.library_folders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  library_kind text not null default 'file',
  name text not null,
  parent_folder_id uuid references public.library_folders(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint library_folders_kind_check
    check (library_kind in ('file', 'template'))
);

create index if not exists idx_library_folders_user_kind
  on public.library_folders(user_id, library_kind);

create index if not exists idx_library_folders_parent
  on public.library_folders(parent_folder_id);

create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade,
  org_id uuid references public.organizations(id) on delete restrict,
  -- Nullable + SET NULL: content inside an organization project survives its
  -- author's account deletion (userDataCleanup detaches rather than deletes).
  user_id uuid references auth.users(id) on delete set null,
  status text not null default 'pending',
  folder_id uuid references public.project_subfolders(id) on delete set null,
  library_kind text not null default 'file',
  library_folder_id uuid references public.library_folders(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint documents_library_kind_check
    check (library_kind in ('file', 'template', 'workflow_asset'))
);

create index if not exists idx_documents_user_project
  on public.documents(user_id, project_id);

create index if not exists idx_documents_project_folder
  on public.documents(project_id, folder_id);

create index if not exists idx_documents_library_kind_folder
  on public.documents(user_id, library_kind, library_folder_id)
  where project_id is null;

create index if not exists idx_documents_org
  on public.documents(org_id);

create table if not exists public.document_versions (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  storage_path text,
  pdf_storage_path text,
  source text not null default 'upload',
  version_number integer,
  filename text,
  file_type text,
  size_bytes integer,
  page_count integer,
  content_sha256 text,
  deleted_at timestamptz,
  deleted_by uuid references auth.users(id) on delete set null,
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

create index if not exists document_versions_active_document_id_idx
  on public.document_versions(document_id, created_at desc)
  where deleted_at is null;

create index if not exists document_versions_doc_vnum_idx
  on public.document_versions(document_id, version_number);

create table if not exists public.upload_sessions (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  purpose text not null,
  destination jsonb not null,
  expected_file_count integer not null,
  expected_total_bytes bigint not null,
  status text not null default 'pending_upload',
  expires_at timestamptz not null,
  completed_at timestamptz,
  cancelled_at timestamptz,
  error_code text,
  cleaned_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  user_email text,
  constraint upload_sessions_purpose_check check (
    purpose in (
      'document_create',
      'document_version_create',
      'document_version_replace',
      'workflow_reference_create',
      'workflow_reference_replace'
    )
  ),
  constraint upload_sessions_destination_object_check
    check (jsonb_typeof(destination) = 'object'),
  constraint upload_sessions_file_count_check
    check (expected_file_count between 1 and 50),
  constraint upload_sessions_total_bytes_check
    check (expected_total_bytes between 1 and 2147483648),
  constraint upload_sessions_status_check check (
    status in (
      'pending_upload',
      'verifying',
      'uploaded',
      'processing',
      'completed',
      'cancelled',
      'expired',
      'error'
    )
  )
);

create or replace function public.capture_upload_session_user_email()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  select email
    into new.user_email
  from auth.users
  where id = new.user_id;
  return new;
end;
$$;

drop trigger if exists capture_upload_session_user_email on public.upload_sessions;
create trigger capture_upload_session_user_email
  before insert on public.upload_sessions
  for each row
  execute function public.capture_upload_session_user_email();

revoke all on function public.capture_upload_session_user_email()
  from public, anon, authenticated;

create index if not exists upload_sessions_user_created_idx
  on public.upload_sessions(user_id, created_at desc);

drop index if exists public.upload_sessions_active_idx;
create index upload_sessions_active_idx
  on public.upload_sessions(user_id, expires_at)
  where status in ('pending_upload', 'verifying', 'uploaded', 'processing');

create table if not exists public.upload_session_files (
  id uuid primary key,
  session_id uuid not null references public.upload_sessions(id) on delete cascade,
  resource_id uuid not null,
  client_id text not null,
  filename text not null,
  target_folder_id uuid,
  file_type text not null,
  content_type text not null,
  expected_size_bytes bigint not null,
  observed_size_bytes bigint,
  staging_storage_path text not null,
  sealed_storage_path text not null,
  etag text,
  status text not null default 'pending_upload',
  error_code text,
  result jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint upload_session_files_client_id_check
    check (length(client_id) between 1 and 128),
  constraint upload_session_files_filename_check
    check (length(filename) between 1 and 255),
  constraint upload_session_files_file_type_check
    check (file_type in ('pdf', 'docx', 'doc', 'xlsx', 'xlsm', 'xls', 'pptx', 'ppt')),
  constraint upload_session_files_content_type_check
    check (length(content_type) between 1 and 255),
  constraint upload_session_files_size_check
    check (expected_size_bytes between 1 and 104857600),
  constraint upload_session_files_observed_size_check
    check (observed_size_bytes is null or observed_size_bytes >= 0),
  constraint upload_session_files_status_check
    check (status in ('pending_upload', 'verifying', 'uploaded', 'processing', 'completed', 'error')),
  constraint upload_session_files_session_client_unique unique(session_id, client_id),
  constraint upload_session_files_session_resource_unique unique(session_id, resource_id),
  constraint upload_session_files_staging_path_unique unique(staging_storage_path),
  constraint upload_session_files_sealed_path_unique unique(sealed_storage_path)
);

create index if not exists upload_session_files_session_idx
  on public.upload_session_files(session_id, created_at);

create table if not exists public.upload_processing_jobs (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.upload_sessions(id) on delete cascade,
  file_id uuid not null unique references public.upload_session_files(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'queued',
  attempts integer not null default 0,
  available_at timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint upload_processing_jobs_status_check
    check (status in ('queued', 'running', 'completed', 'error')),
  constraint upload_processing_jobs_attempts_check
    check (attempts between 0 and 10)
);

create index if not exists upload_processing_jobs_ready_idx
  on public.upload_processing_jobs(status, available_at, created_at)
  where status = 'queued';

create index if not exists upload_processing_jobs_session_idx
  on public.upload_processing_jobs(session_id, created_at);

create index if not exists upload_processing_jobs_running_user_idx
  on public.upload_processing_jobs(user_id, locked_at)
  where status = 'running';

alter table public.upload_sessions enable row level security;
alter table public.upload_session_files enable row level security;
alter table public.upload_processing_jobs enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'document_versions_doc_version_unique'
      and conrelid = 'public.document_versions'::regclass
  ) then
    alter table public.document_versions
      add constraint document_versions_doc_version_unique
      unique (document_id, version_number);
  end if;
end;
$$;

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
  user_id uuid references auth.users(id) on delete set null,
  title text not null,
  type text not null,
  prompt_md text,
  columns_config jsonb,
  language text default 'English',
  practice text default 'General Transactions',
  jurisdictions text[] default array['General']::text[],
  org_id uuid references public.organizations(id) on delete restrict,
  created_at timestamptz not null default now()
);

create index if not exists idx_workflows_user
  on public.workflows(user_id);

create index if not exists idx_workflows_org
  on public.workflows(org_id);

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
  role text not null default 'viewer'
    check (role in ('owner', 'editor', 'viewer')),
  created_at timestamptz not null default now(),
  constraint workflow_shares_workflow_email_unique
    unique(workflow_id, shared_with_email)
);

create index if not exists workflow_shares_workflow_id_idx
  on public.workflow_shares(workflow_id);

create index if not exists workflow_shares_email_idx
  on public.workflow_shares(shared_with_email);

create table if not exists public.workflow_org_access_overrides (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references public.workflows(id) on delete cascade,
  org_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null,
  role text not null constraint workflow_org_access_overrides_role_check
    check (role in ('owner', 'editor', 'viewer', 'deny')),
  assigned_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(workflow_id, user_id),
  foreign key (org_id, user_id)
    references public.org_members(org_id, user_id) on delete cascade
);

create index if not exists idx_workflow_org_access_overrides_user
  on public.workflow_org_access_overrides(user_id);

alter table public.workflow_org_access_overrides enable row level security;

create or replace function public.workflow_access_role(
  p_workflow_id uuid,
  p_workflow_user_id uuid,
  p_org_id uuid,
  p_user_id text,
  p_user_email text
)
returns text
language sql
stable
set search_path = public
as $$
  select case
    when p_org_id is not null then (
      select case
        when p_workflow_user_id::text = p_user_id then 'owner'
        when m.role = 'admin' then 'owner'
        when o.role = 'deny' then null
        when o.role in ('owner', 'editor', 'viewer') then o.role
        else 'editor'
      end
      from public.org_members m
      left join public.workflow_org_access_overrides o
        on o.workflow_id = p_workflow_id
       and o.org_id = p_org_id
       and o.user_id = m.user_id
      where m.org_id = p_org_id and m.user_id::text = p_user_id
    )
    when p_workflow_user_id::text = p_user_id then 'owner'
    else (
      select s.role from public.workflow_shares s
      where s.workflow_id = p_workflow_id
        and coalesce(p_user_email, '') <> ''
        and s.shared_with_email = lower(p_user_email)
      limit 1
    )
  end;
$$;

create table if not exists public.default_workflow_installations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  default_key text not null,
  workflow_id uuid references public.workflows(id) on delete set null,
  installed_at timestamptz not null default now(),
  constraint default_workflow_installations_user_key_unique
    unique(user_id, default_key),
  constraint default_workflow_installations_workflow_unique
    unique(workflow_id)
);

create table if not exists public.quick_actions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  workflow_id uuid not null references public.workflows(id) on delete cascade,
  name text not null,
  prompt text not null default '',
  document_upload boolean not null default false,
  enabled boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  surface text not null default 'app',
  constraint quick_actions_surface_check check (surface in ('app', 'word'))
);

create index if not exists quick_actions_user_order_idx
  on public.quick_actions(user_id, sort_order, created_at);

create index if not exists quick_actions_user_surface_order_idx
  on public.quick_actions(user_id, surface, sort_order, created_at);

create index if not exists quick_actions_workflow_idx
  on public.quick_actions(workflow_id);

create table if not exists public.mike_workflows (
  id uuid primary key default gen_random_uuid(),
  workflow_key text not null,
  distribution text not null,
  version text,
  title text not null,
  description text,
  type text not null,
  prompt_md text,
  columns_config jsonb,
  contributors jsonb,
  language text,
  practice text,
  jurisdictions text[],
  pack_key text,
  pack_title text,
  pack_description text,
  pack_version text,
  default_sort_order integer,
  quick_action_name text,
  quick_action_prompt text,
  document_upload boolean not null default false,
  word_quick_action boolean not null default false,
  word_quick_action_prompt text,
  source_commit text,
  content_hash text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint mike_workflows_key_hash_unique
    unique(workflow_key, content_hash),
  constraint mike_workflows_distribution_check
    check(distribution in ('default', 'addon')),
  constraint mike_workflows_type_check
    check(type in ('assistant', 'tabular')),
  constraint mike_workflows_source_commit_check
    check(source_commit is null or source_commit ~ '^[0-9a-f]{40}$'),
  constraint mike_workflows_content_hash_check
    check(content_hash ~ '^[0-9a-f]{64}$')
);

create unique index if not exists mike_workflows_active_key_idx
  on public.mike_workflows(workflow_key)
  where active;

create index if not exists mike_workflows_active_distribution_type_idx
  on public.mike_workflows(active, distribution, type, title);

create index if not exists mike_workflows_active_pack_idx
  on public.mike_workflows(active, pack_key, title);

alter table public.documents
  add column if not exists workflow_id uuid
  references public.workflows(id) on delete cascade;

create index if not exists idx_documents_workflow
  on public.documents(workflow_id, created_at)
  where workflow_id is not null;

create table if not exists public.mike_workflow_assets (
  id uuid primary key default gen_random_uuid(),
  mike_workflow_id uuid not null
    references public.mike_workflows(id) on delete cascade,
  filename text not null,
  file_type text not null,
  storage_path text not null,
  size_bytes integer,
  content_hash text not null,
  created_at timestamptz not null default now(),
  constraint mike_workflow_assets_name_unique
    unique(mike_workflow_id, filename),
  constraint mike_workflow_assets_hash_check
    check(content_hash ~ '^[0-9a-f]{64}$')
);

-- Deprecated rollback-only objects. The unified-catalog backend never reads
-- or writes these tables; they remain for one phased rollout so an older
-- backend can be restored without losing the former add-on catalog.
create table if not exists public.workflow_addons (
  id uuid primary key default gen_random_uuid(),
  addon_key text not null unique,
  pack_key text,
  pack_title text,
  pack_description text,
  pack_version text,
  version text,
  title text not null,
  description text,
  type text not null,
  prompt_md text,
  columns_config jsonb,
  contributors jsonb,
  language text,
  practice text,
  jurisdictions text[],
  content_hash text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workflow_addons_type_check
    check(type in ('assistant', 'tabular'))
);

create index if not exists workflow_addons_active_type_idx
  on public.workflow_addons(active, type, title);

create index if not exists workflow_addons_active_pack_idx
  on public.workflow_addons(active, pack_key, title);

-- Replace the active catalog as one transaction. Content-addressed historical
-- rows remain available for old builtin-* workflow references.
create or replace function public.replace_mike_workflows(
  p_source_commit text,
  p_workflows jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  item jsonb;
  asset_item jsonb;
  asset_items jsonb;
  jurisdiction_values text[];
  workflow_uuid uuid;
begin
  if p_source_commit !~ '^[0-9a-f]{40}$' then
    raise exception 'invalid workflow catalog source commit';
  end if;
  if jsonb_typeof(p_workflows) <> 'array' then
    raise exception 'workflow catalog payload must be an array';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('mike_workflows', 0));
  update public.mike_workflows set active = false where active;

  for item in select value from jsonb_array_elements(p_workflows)
  loop
    jurisdiction_values := null;
    if jsonb_typeof(item->'jurisdictions') = 'array' then
      select array_agg(value)
        into jurisdiction_values
      from jsonb_array_elements_text(item->'jurisdictions');
    end if;

    insert into public.mike_workflows (
      workflow_key, distribution, version, title, description, type,
      prompt_md, columns_config, contributors, language, practice,
      jurisdictions, pack_key, pack_title, pack_description, pack_version,
      default_sort_order, quick_action_name, quick_action_prompt,
      document_upload, word_quick_action, word_quick_action_prompt,
      source_commit, content_hash, active, updated_at
    ) values (
      item->>'workflow_key',
      item->>'distribution',
      nullif(item->>'version', ''),
      item->>'title',
      nullif(item->>'description', ''),
      item->>'type',
      nullif(item->>'prompt_md', ''),
      case when jsonb_typeof(item->'columns_config') = 'array'
        then item->'columns_config' else null end,
      case when jsonb_typeof(item->'contributors') = 'array'
        then item->'contributors' else '[]'::jsonb end,
      nullif(item->>'language', ''),
      nullif(item->>'practice', ''),
      jurisdiction_values,
      nullif(item->>'pack_key', ''),
      nullif(item->>'pack_title', ''),
      nullif(item->>'pack_description', ''),
      nullif(item->>'pack_version', ''),
      nullif(item->>'default_sort_order', '')::integer,
      nullif(item->>'quick_action_name', ''),
      nullif(item->>'quick_action_prompt', ''),
      coalesce((item->>'document_upload')::boolean, false),
      coalesce((item->>'word_quick_action')::boolean, false),
      nullif(item->>'word_quick_action_prompt', ''),
      p_source_commit,
      item->>'content_hash',
      true,
      now()
    )
    on conflict (workflow_key, content_hash) do update set
      distribution = excluded.distribution,
      version = excluded.version,
      title = excluded.title,
      description = excluded.description,
      type = excluded.type,
      prompt_md = excluded.prompt_md,
      columns_config = excluded.columns_config,
      contributors = excluded.contributors,
      language = excluded.language,
      practice = excluded.practice,
      jurisdictions = excluded.jurisdictions,
      pack_key = excluded.pack_key,
      pack_title = excluded.pack_title,
      pack_description = excluded.pack_description,
      pack_version = excluded.pack_version,
      default_sort_order = excluded.default_sort_order,
      quick_action_name = excluded.quick_action_name,
      quick_action_prompt = excluded.quick_action_prompt,
      document_upload = excluded.document_upload,
      word_quick_action = excluded.word_quick_action,
      word_quick_action_prompt = excluded.word_quick_action_prompt,
      source_commit = excluded.source_commit,
      active = true,
      updated_at = now()
    returning id into workflow_uuid;

    delete from public.mike_workflow_assets
    where mike_workflow_id = workflow_uuid;

    -- reference_files remains a rollout-only alias for catalog payloads
    -- produced immediately before workflow assets were renamed.
    asset_items := coalesce(item->'assets', item->'reference_files');
    if asset_items is not null then
      if jsonb_typeof(asset_items) <> 'array' then
        raise exception 'workflow assets must be an array';
      end if;
      for asset_item in
        select value from jsonb_array_elements(asset_items)
      loop
        insert into public.mike_workflow_assets (
          mike_workflow_id, filename, file_type, storage_path,
          size_bytes, content_hash
        ) values (
          workflow_uuid,
          asset_item->>'filename',
          asset_item->>'file_type',
          asset_item->>'storage_path',
          nullif(asset_item->>'size_bytes', '')::integer,
          asset_item->>'content_hash'
        );
      end loop;
    end if;
  end loop;
end;
$$;

-- Install each user's editable defaults and Quick Actions atomically. The
-- installation row remains after a default workflow is deleted so it is not
-- silently recreated on a later request.
create or replace function public.install_missing_default_workflows(
  p_user_id text
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  catalog_item public.mike_workflows%rowtype;
  workflow_uuid uuid;
  installed_count integer := 0;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user_id, 0));

  for catalog_item in
    select catalog.*
    from public.mike_workflows catalog
    where catalog.active
      and catalog.distribution = 'default'
    order by catalog.default_sort_order nulls last, catalog.workflow_key
  loop
    if exists (
      select 1
      from public.default_workflow_installations installation
      where installation.user_id::text = p_user_id
        and installation.default_key = catalog_item.workflow_key
    ) then
      continue;
    end if;

    insert into public.workflows (
      user_id, title, type, prompt_md, columns_config,
      language, practice, jurisdictions
    ) values (
      p_user_id::uuid,
      catalog_item.title,
      catalog_item.type,
      catalog_item.prompt_md,
      catalog_item.columns_config,
      coalesce(nullif(catalog_item.language, ''), 'English'),
      coalesce(nullif(catalog_item.practice, ''), 'General Transactions'),
      coalesce(catalog_item.jurisdictions, array['General']::text[])
    )
    returning id into workflow_uuid;

    insert into public.default_workflow_installations (
      user_id, default_key, workflow_id
    ) values (
      p_user_id::uuid, catalog_item.workflow_key, workflow_uuid
    );

    if catalog_item.type = 'assistant'
       and catalog_item.quick_action_name is not null then
      insert into public.quick_actions (
        user_id, workflow_id, name, prompt, document_upload,
        enabled, sort_order, surface
      ) values (
        p_user_id::uuid,
        workflow_uuid,
        catalog_item.quick_action_name,
        coalesce(catalog_item.quick_action_prompt, ''),
        catalog_item.document_upload,
        true,
        coalesce(catalog_item.default_sort_order, installed_count),
        'app'
      );

      if catalog_item.word_quick_action then
        insert into public.quick_actions (
          user_id, workflow_id, name, prompt, document_upload,
          enabled, sort_order, surface
        ) values (
          p_user_id::uuid,
          workflow_uuid,
          catalog_item.quick_action_name,
          coalesce(
            catalog_item.word_quick_action_prompt,
            'Execute this workflow on this Word document.'
          ),
          false,
          true,
          coalesce(catalog_item.default_sort_order, installed_count),
          'word'
        );
      end if;
    end if;

    installed_count := installed_count + 1;
  end loop;

  return installed_count;
end;
$$;

-- Deprecated rollback-only overload used by backend releases that predate
-- mike_workflows. New code calls the one-argument function above.
create or replace function public.install_missing_default_workflows(
  p_user_id text,
  p_defaults jsonb
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  item jsonb;
  workflow_uuid uuid;
  installed_count integer := 0;
  jurisdiction_values text[];
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user_id, 0));

  for item in select value from jsonb_array_elements(coalesce(p_defaults, '[]'::jsonb))
  loop
    if nullif(trim(item->>'default_key'), '') is null then
      continue;
    end if;

    if exists (
      select 1
      from public.default_workflow_installations dwi
      where dwi.user_id::text = p_user_id
        and dwi.default_key = item->>'default_key'
    ) then
      continue;
    end if;

    select coalesce(array_agg(value), array['General']::text[])
      into jurisdiction_values
    from jsonb_array_elements_text(
      case
        when jsonb_typeof(item->'jurisdictions') = 'array'
          then item->'jurisdictions'
        else '["General"]'::jsonb
      end
    );

    insert into public.workflows (
      user_id,
      title,
      type,
      prompt_md,
      columns_config,
      language,
      practice,
      jurisdictions
    ) values (
      p_user_id::uuid,
      item->>'title',
      item->>'type',
      nullif(item->>'prompt_md', ''),
      case
        when jsonb_typeof(item->'columns_config') = 'array'
          then item->'columns_config'
        else null
      end,
      coalesce(nullif(item->>'language', ''), 'English'),
      coalesce(nullif(item->>'practice', ''), 'General Transactions'),
      jurisdiction_values
    )
    returning id into workflow_uuid;

    insert into public.default_workflow_installations (
      user_id,
      default_key,
      workflow_id
    ) values (
      p_user_id::uuid,
      item->>'default_key',
      workflow_uuid
    );

    if item->>'type' = 'assistant' then
      insert into public.quick_actions (
        user_id,
        workflow_id,
        name,
        prompt,
        document_upload,
        enabled,
        sort_order,
        surface
      ) values (
        p_user_id::uuid,
        workflow_uuid,
        coalesce(nullif(trim(item->>'quick_action_name'), ''), item->>'title'),
        coalesce(item->>'quick_action_prompt', ''),
        coalesce((item->>'document_upload')::boolean, false),
        true,
        coalesce((item->>'sort_order')::integer, installed_count),
        'app'
      );

      if coalesce((item->>'word_quick_action')::boolean, false) then
        insert into public.quick_actions (
          user_id,
          workflow_id,
          name,
          prompt,
          document_upload,
          enabled,
          sort_order,
          surface
        ) values (
          p_user_id::uuid,
          workflow_uuid,
          coalesce(nullif(trim(item->>'quick_action_name'), ''), item->>'title'),
          coalesce(
            item->>'word_quick_action_prompt',
            'Execute this workflow on this Word document.'
          ),
          false,
          true,
          coalesce((item->>'sort_order')::integer, installed_count),
          'word'
        );
      end if;
    end if;

    installed_count := installed_count + 1;
  end loop;

  return installed_count;
end;
$$;

-- Review queue for user-submitted workflows that may later be published to the
-- open-source workflow repository. The backend writes with the service role.
create table if not exists public.workflow_open_source_submissions (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references public.workflows(id) on delete cascade,
  submitted_by_user_id uuid not null references auth.users(id) on delete cascade,
  submitter_email text,
  submitter_name text,
  contributor_mode text not null default 'anonymous',
  status text not null default 'pending',
  snapshot jsonb not null,
  submitted_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  reviewed_at timestamptz,
  review_notes text,
  constraint workflow_open_source_submissions_status_check
    check (status in ('pending', 'approved', 'rejected')),
  constraint workflow_open_source_submissions_contributor_mode_check
    check (contributor_mode in ('named', 'anonymous'))
);

create unique index if not exists idx_workflow_open_source_submissions_pending
  on public.workflow_open_source_submissions(workflow_id, submitted_by_user_id)
  where status = 'pending';

create index if not exists idx_workflow_open_source_submissions_reviewer_queue
  on public.workflow_open_source_submissions(status, submitted_at desc);

create index if not exists idx_workflow_open_source_submissions_submitter
  on public.workflow_open_source_submissions(submitted_by_user_id, submitted_at desc);

alter table public.workflow_open_source_submissions enable row level security;

create or replace function public.get_workflows_overview(
  p_user_id text,
  p_user_email text default null,
  p_type text default null
)
returns table (
  id uuid,
  user_id text,
  org_id uuid,
  access_scope text,
  organization_name text,
  title text,
  type text,
  prompt_md text,
  columns_config jsonb,
  language text,
  practice text,
  jurisdictions text[],
  is_system boolean,
  created_at timestamptz,
  allow_edit boolean,
  is_owner boolean,
  shared_by_name text
)
language sql
stable
as $$
  with owned as (
    select
      w.id,
      w.user_id::text as user_id,
      w.org_id,
      case
        when w.org_id is not null then 'organization'
        when exists (
          select 1 from public.workflow_shares scope_share
          where scope_share.workflow_id = w.id
        ) then 'shared'
        else 'private'
      end as access_scope,
      (
        select nullif(trim(o.name), '')
        from public.organizations o
        where o.id = w.org_id
      ) as organization_name,
      w.title,
      w.type,
      w.prompt_md,
      w.columns_config,
      w.language,
      w.practice,
      w.jurisdictions,
      false as is_system,
      w.created_at,
      true as allow_edit,
      true as is_owner,
      null::text as shared_by_name,
      0 as sort_bucket
    from public.workflows w
    where w.user_id::text = p_user_id
      and public.workflow_access_role(
        w.id, w.user_id, w.org_id, p_user_id, p_user_email
      ) is not null
      and (p_type is null or w.type = p_type)
  ),
  shared as (
    select
      w.id,
      w.user_id::text as user_id,
      w.org_id,
      'shared'::text as access_scope,
      null::text as organization_name,
      w.title,
      w.type,
      w.prompt_md,
      w.columns_config,
      w.language,
      w.practice,
      w.jurisdictions,
      false as is_system,
      w.created_at,
      (ws.role in ('owner', 'editor')) as allow_edit,
      (ws.role = 'owner') as is_owner,
      nullif(trim(up.display_name), '') as shared_by_name,
      1 as sort_bucket
    from public.workflow_shares ws
    join public.workflows w
      on w.id = ws.workflow_id
    left join public.user_profiles up
      on up.user_id::text = ws.shared_by_user_id::text
    where lower(ws.shared_with_email) = lower(coalesce(p_user_email, ''))
      and w.org_id is null
      and (p_type is null or w.type = p_type)
  ),
  org_shared as (
    -- Workflows in an org the caller belongs to. Admins default to Owner and
    -- Members default to Editor; per-workflow overrides may narrow either.
    -- Mirrors resolveWorkflowAccess in routes/workflows.ts, so a row's
    -- affordances in the list match what the detail route will allow.
    select
      w.id,
      w.user_id::text as user_id,
      w.org_id,
      'organization'::text as access_scope,
      (
        select nullif(trim(o.name), '')
        from public.organizations o
        where o.id = w.org_id
      ) as organization_name,
      w.title,
      w.type,
      w.prompt_md,
      w.columns_config,
      w.language,
      w.practice,
      w.jurisdictions,
      false as is_system,
      w.created_at,
      (public.workflow_access_role(
        w.id, w.user_id, w.org_id, p_user_id, p_user_email
      ) in ('owner', 'editor')) as allow_edit,
      (public.workflow_access_role(
        w.id, w.user_id, w.org_id, p_user_id, p_user_email
      ) = 'owner') as is_owner,
      nullif(trim(up.display_name), '') as shared_by_name,
      2 as sort_bucket
    from public.workflows w
    left join public.user_profiles up
      on up.user_id::text = w.user_id::text
    where w.org_id is not null
      and (w.user_id is null or w.user_id::text <> p_user_id)
      and (p_type is null or w.type = p_type)
      and public.workflow_access_role(
        w.id, w.user_id, w.org_id, p_user_id, p_user_email
      ) is not null
  ),
  visible_workflows as (
    select * from owned
    union all
    select * from shared
    union all
    select * from org_shared
  )
  select
    vw.id,
    vw.user_id,
    vw.org_id,
    vw.access_scope,
    vw.organization_name,
    vw.title,
    vw.type,
    vw.prompt_md,
    vw.columns_config,
    vw.language,
    vw.practice,
    vw.jurisdictions,
    vw.is_system,
    vw.created_at,
    vw.allow_edit,
    vw.is_owner,
    vw.shared_by_name
  from visible_workflows vw
  order by vw.sort_bucket asc, vw.created_at desc;
$$;

-- ---------------------------------------------------------------------------
-- Assistant chats
-- ---------------------------------------------------------------------------

create table if not exists public.chats (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade,
  -- Nullable + SET NULL: content inside an organization project survives its
  -- author's account deletion (userDataCleanup detaches rather than deletes).
  user_id uuid references auth.users(id) on delete set null,
  title text,
  model text,
  reasoning_level text check (reasoning_level in ('none', 'low', 'medium', 'high', 'xhigh', 'max')),
  org_id uuid references public.organizations(id) on delete restrict,
  constraint chats_org_requires_project
    check (org_id is null or project_id is not null),
  created_at timestamptz not null default now()
);

create index if not exists idx_chats_user
  on public.chats(user_id);

create index if not exists chats_user_created_idx
  on public.chats(user_id, created_at desc, id);

create index if not exists idx_chats_project
  on public.chats(project_id);

create index if not exists idx_chats_org on public.chats(org_id);

create table if not exists public.chat_access_grants (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references public.chats(id) on delete cascade,
  email text not null,
  role text not null default 'editor'
    check (role in ('owner', 'editor', 'viewer')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(chat_id, email),
  constraint chat_access_grants_email_lowercase check (email = lower(email))
);

create index if not exists idx_chat_access_grants_email
  on public.chat_access_grants(email);
create index if not exists idx_chat_access_grants_chat
  on public.chat_access_grants(chat_id);

alter table public.chat_access_grants enable row level security;

create or replace function public.chat_access_role(
  p_chat_id uuid,
  p_chat_user_id uuid,
  p_project_id uuid,
  p_org_id uuid,
  p_user_id text,
  p_user_email text
)
returns text
language sql
stable
set search_path = public
as $$
  select case
    when p_project_id is not null then (
      select public.project_access_role(
        p.id, p.user_id, p.org_id, p_user_id, p_user_email
      ) from public.projects p where p.id = p_project_id
    )
    when p_chat_user_id::text = p_user_id then 'owner'
    else (
      select g.role from public.chat_access_grants g
      where g.chat_id = p_chat_id
        and coalesce(p_user_email, '') <> ''
        and g.email = lower(p_user_email)
      limit 1
    )
  end;
$$;

create or replace function public.get_chats_overview(
  p_user_id text,
  p_user_email text,
  p_limit integer default null,
  p_offset integer default 0
)
returns table (
  id uuid,
  project_id uuid,
  user_id text,
  title text,
  model text,
  created_at timestamptz,
  project_name text,
  is_owner boolean,
  access_role text
)
language sql
stable
as $$
  select
    c.id,
    c.project_id,
    c.user_id::text as user_id,
    c.title,
    c.model,
    c.created_at,
    p.name as project_name,
    -- Provenance ("I started this thread"), not a role: the ladder itself is
    -- lib/permissions.ts, and the creator branch of ensureChatAccess is what
    -- turns this into Owner standing.
    coalesce(c.user_id::text = p_user_id, false) as is_owner,
    -- The SAME verdict the predicate below filters on, served to the caller.
    -- Serving only is_owner was not enough: the client must distinguish
    -- Editor and Viewer from Owner so its actions match the server verdict.
    -- One evaluation, one truth: the lateral computes the role once and both
    -- the column and the WHERE read it.
    verdict.role as access_role
  from public.chats c
  left join public.projects p on p.id = c.project_id
  cross join lateral (
    select public.chat_access_role(
             c.id,
             c.user_id,
             c.project_id,
             c.org_id,
             p_user_id,
             p_user_email
           ) as role
  ) verdict
  -- The whole predicate, in one call.
  -- The join above is for project_name only; the function resolves the
  -- project itself.
  where verdict.role is not null
  order by c.created_at desc, c.id asc
  limit case
    when p_limit is null then null
    else greatest(1, least(p_limit, 100))
  end
  offset greatest(coalesce(p_offset, 0), 0);
$$;

create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references public.chats(id) on delete cascade,
  role text not null,
  content jsonb,
  files jsonb,
  workflow jsonb,
  citations jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_chat_messages_chat
  on public.chat_messages(chat_id);

-- ---------------------------------------------------------------------------
-- Word add-in chats
-- ---------------------------------------------------------------------------
-- These conversations are document-scoped and deliberately separate from the
-- web assistant's chats/chat_messages history.

create table if not exists public.word_documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  client_document_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, client_document_id)
);

create index if not exists idx_word_documents_user_updated
  on public.word_documents(user_id, updated_at desc);

create table if not exists public.word_chats (
  id uuid primary key default gen_random_uuid(),
  word_document_id uuid not null
    references public.word_documents(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text,
  model text,
  reasoning_level text check (reasoning_level in ('none', 'low', 'medium', 'high', 'xhigh', 'max')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_word_chats_document_updated
  on public.word_chats(word_document_id, updated_at desc);

create index if not exists idx_word_chats_user
  on public.word_chats(user_id);

create table if not exists public.word_chat_messages (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references public.word_chats(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content jsonb,
  files jsonb,
  workflow jsonb,
  citations jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_word_chat_messages_chat_created
  on public.word_chat_messages(chat_id, created_at);

create table if not exists public.word_document_edits (
  id uuid primary key default gen_random_uuid(),
  word_chat_message_id uuid not null
    references public.word_chat_messages(id) on delete cascade,
  block_index integer not null check (block_index >= 0),
  original_text text not null check (length(original_text) > 0),
  replacement_text text not null default '',
  formats text[] not null default '{}',
  occurrence text check (occurrence is null or occurrence = 'all'),
  reason text,
  apply_mode text not null
    check (apply_mode in ('direct', 'approval')),
  apply_status text not null default 'proposed'
    check (apply_status in ('proposed', 'applied', 'unmanaged', 'failed')),
  resolution_status text
    check (resolution_status is null or resolution_status in ('accepted', 'rejected')),
  matched_occurrences integer check (matched_occurrences is null or matched_occurrences >= 0),
  applied_occurrences integer check (applied_occurrences is null or applied_occurrences >= 0),
  error_code text,
  error_message text,
  applied_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (word_chat_message_id, block_index),
  constraint word_document_edits_resolution_requires_application
    check (resolution_status is null or apply_status = 'applied')
);

create index if not exists word_document_edits_message_idx
  on public.word_document_edits(word_chat_message_id, block_index);

create index if not exists word_document_edits_unresolved_idx
  on public.word_document_edits(word_chat_message_id)
  where apply_status = 'applied' and resolution_status is null;

alter table public.word_documents enable row level security;
alter table public.word_chats enable row level security;
alter table public.word_chat_messages enable row level security;
alter table public.word_document_edits enable row level security;

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
  -- Nullable + SET NULL: content inside an organization project survives its
  -- author's account deletion (userDataCleanup detaches rather than deletes).
  user_id uuid references auth.users(id) on delete set null,
  title text,
  model text,
  columns_config jsonb,
  document_ids jsonb,
  workflow_id uuid references public.workflows(id) on delete set null,
  practice text,
  document_grouping text not null default 'document' check (document_grouping in ('document', 'folder')),
  active_generation_id uuid,
  generation_lease_expires_at timestamptz,
  org_id uuid references public.organizations(id) on delete restrict,
  constraint tabular_reviews_org_requires_project
    check (org_id is null or project_id is not null),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_tabular_reviews_user
  on public.tabular_reviews(user_id);

create index if not exists idx_tabular_reviews_project
  on public.tabular_reviews(project_id);

create index if not exists idx_tabular_reviews_org
  on public.tabular_reviews(org_id);

create index if not exists tabular_reviews_title_trgm_idx
  on public.tabular_reviews using gin (lower(title) gin_trgm_ops);

create table if not exists public.tabular_review_access_grants (
  id uuid primary key default gen_random_uuid(),
  tabular_review_id uuid not null
    references public.tabular_reviews(id) on delete cascade,
  email text not null,
  role text not null default 'editor'
    check (role in ('owner', 'editor', 'viewer')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(tabular_review_id, email),
  constraint tabular_review_access_grants_email_lowercase
    check (email = lower(email))
);

create index if not exists idx_tabular_review_access_grants_email
  on public.tabular_review_access_grants(email);
create index if not exists idx_tabular_review_access_grants_review
  on public.tabular_review_access_grants(tabular_review_id);

alter table public.tabular_review_access_grants enable row level security;

create or replace function public.review_access_role(
  p_review_id uuid,
  p_review_user_id uuid,
  p_project_id uuid,
  p_org_id uuid,
  p_user_id text,
  p_user_email text
)
returns text
language sql
stable
set search_path = public
as $$
  select case
    when p_project_id is not null then (
      select public.project_access_role(
        p.id, p.user_id, p.org_id, p_user_id, p_user_email
      ) from public.projects p where p.id = p_project_id
    )
    when p_review_user_id::text = p_user_id then 'owner'
    else (
      select g.role from public.tabular_review_access_grants g
      where g.tabular_review_id = p_review_id
        and coalesce(p_user_email, '') <> ''
        and g.email = lower(p_user_email)
      limit 1
    )
  end;
$$;

grant execute on function public.project_access_role(uuid, uuid, uuid, text, text)
  to service_role;
grant execute on function public.chat_access_role(uuid, uuid, uuid, uuid, text, text)
  to service_role;
grant execute on function public.review_access_role(uuid, uuid, uuid, uuid, text, text)
  to service_role;
grant execute on function public.workflow_access_role(uuid, uuid, uuid, text, text)
  to service_role;

create or replace function public.get_projects_overview(
  p_user_id text,
  p_user_email text default null
)
returns table (
  id uuid,
  user_id text,
  org_id uuid,
  access_scope text,
  organization_name text,
  name text,
  cm_number text,
  practice text,
  created_at timestamptz,
  updated_at timestamptz,
  is_owner boolean,
  owner_display_name text,
  owner_email text,
  access_role text,
  document_count integer,
  chat_count integer,
  review_count integer
)
language sql
stable
as $$
  with visible_projects as (
    select p.*
    from public.projects p
    where public.project_access_role(
      p.id, p.user_id, p.org_id, p_user_id, p_user_email
    ) is not null
  ),
  document_counts as (
    select d.project_id, count(*)::integer as document_count
    from public.documents d
    where d.project_id in (select vp.id from visible_projects vp)
    group by d.project_id
  ),
  chat_counts as (
    select c.project_id, count(*)::integer as chat_count
    from public.chats c
    where c.project_id in (select vp.id from visible_projects vp)
    group by c.project_id
  ),
  review_counts as (
    select tr.project_id, count(*)::integer as review_count
    from public.tabular_reviews tr
    where tr.project_id in (select vp.id from visible_projects vp)
    group by tr.project_id
  )
  select
    vp.id,
    vp.user_id::text as user_id,
    vp.org_id,
    case
      when vp.org_id is not null then 'organization'
      when exists (
        select 1 from public.project_access_grants g
        where g.project_id = vp.id
      ) then 'shared'
      else 'private'
    end as access_scope,
    (
      select nullif(trim(o.name), '')
      from public.organizations o
      where o.id = vp.org_id
    ) as organization_name,
    vp.name,
    vp.cm_number,
    vp.practice,
    vp.created_at,
    vp.updated_at,
    coalesce(vp.user_id::text = p_user_id, false) as is_owner,
    nullif(trim(up.display_name), '') as owner_display_name,
    -- Populated at last. The column has always been declared and always
    -- returned NULL, so the UI's "ask the project admin" line had no address
    -- to render and silently collapsed to nothing.
    up.email as owner_email,
    public.project_access_role(
      vp.id, vp.user_id, vp.org_id, p_user_id, p_user_email
    ) as access_role,
    coalesce(dc.document_count, 0) as document_count,
    coalesce(cc.chat_count, 0) as chat_count,
    coalesce(rc.review_count, 0) as review_count
  from visible_projects vp
  left join public.user_profiles up
    on up.user_id::text = vp.user_id::text
  left join document_counts dc
    on dc.project_id = vp.id
  left join chat_counts cc
    on cc.project_id = vp.id
  left join review_counts rc
    on rc.project_id = vp.id
  order by vp.created_at desc;
$$;

create table if not exists public.tabular_review_rows (
  id uuid primary key default gen_random_uuid(),
  review_id uuid not null references public.tabular_reviews(id) on delete cascade,
  label text not null,
  row_type text not null check (row_type in ('document', 'folder')),
  folder_id uuid references public.project_subfolders(id) on delete set null,
  library_folder_id uuid references public.library_folders(id) on delete set null,
  document_id uuid references public.documents(id) on delete set null,
  sort_index integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists idx_tabular_review_rows_review
  on public.tabular_review_rows(review_id, sort_index);

alter table public.tabular_review_rows enable row level security;

create table if not exists public.tabular_review_row_sources (
  row_id uuid not null references public.tabular_review_rows(id) on delete cascade,
  document_id uuid not null references public.documents(id) on delete cascade,
  sort_index integer not null default 0,
  created_at timestamptz not null default now(),
  primary key (row_id, document_id)
);

create index if not exists idx_tabular_review_row_sources_document
  on public.tabular_review_row_sources(document_id);

alter table public.tabular_review_row_sources enable row level security;

create table if not exists public.tabular_cells (
  id uuid primary key default gen_random_uuid(),
  review_id uuid not null references public.tabular_reviews(id) on delete cascade,
  row_id uuid not null references public.tabular_review_rows(id) on delete cascade,
  document_id uuid references public.documents(id) on delete cascade,
  column_index integer not null,
  content text,
  citations jsonb,
  status text not null default 'pending',
  generation_id uuid,
  created_at timestamptz not null default now()
);

create or replace function public.begin_tabular_review_generation(
  target_review_id uuid,
  expected_updated_at timestamptz,
  target_generation_id uuid,
  lease_seconds integer default 300
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_review public.tabular_reviews%rowtype;
begin
  select *
    into current_review
    from public.tabular_reviews
   where id = target_review_id
   for update;

  if not found then
    return 'not_found';
  end if;

  if current_review.active_generation_id is not null
     and current_review.generation_lease_expires_at > now() then
    return 'running';
  end if;

  if current_review.updated_at is distinct from expected_updated_at then
    return 'stale';
  end if;

  update public.tabular_reviews
     set active_generation_id = target_generation_id,
         generation_lease_expires_at = now()
           + make_interval(secs => greatest(60, least(lease_seconds, 3600)))
   where id = target_review_id;

  return 'started';
end;
$$;

create or replace function public.renew_tabular_review_generation(
  target_review_id uuid,
  target_generation_id uuid,
  lease_seconds integer default 300
)
returns boolean
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.tabular_reviews
     set generation_lease_expires_at = now()
       + make_interval(secs => greatest(60, least(lease_seconds, 3600)))
   where id = target_review_id
     and active_generation_id = target_generation_id
  returning true;
$$;

create or replace function public.finish_tabular_review_generation(
  target_review_id uuid,
  target_generation_id uuid
)
returns boolean
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.tabular_reviews
     set active_generation_id = null,
         generation_lease_expires_at = null
   where id = target_review_id
     and active_generation_id = target_generation_id
  returning true;
$$;

create index if not exists idx_tabular_cells_review
  on public.tabular_cells(review_id, document_id, column_index);

create index if not exists idx_tabular_cells_review_row
  on public.tabular_cells(review_id, row_id, column_index);

create or replace function public.get_tabular_reviews_overview(
  p_user_id text,
  p_user_email text,
  p_project_id text,
  p_scope text,
  p_limit integer,
  p_offset integer,
  p_search_term text,
  p_sort_key text,
  p_sort_direction text
)
returns table (
  id uuid,
  project_id uuid,
  user_id text,
  title text,
  columns_config jsonb,
  document_ids jsonb,
  workflow_id uuid,
  created_at timestamptz,
  updated_at timestamptz,
  is_owner boolean,
  access_role text,
  document_count integer
)
language sql
stable
as $$
  with accessible_projects as (
    select p.id
    from public.projects p
    where public.project_access_role(
      p.id, p.user_id, p.org_id, p_user_id, p_user_email
    ) is not null
  ),
  visible_reviews as (
    select tr.*
    from public.tabular_reviews tr
    where (p_project_id is null or tr.project_id::text = p_project_id)
      and (
        coalesce(p_scope, 'all') = 'all'
        or (p_scope = 'in-project' and tr.project_id is not null)
        or (p_scope = 'standalone' and tr.project_id is null)
      )
      and (
        p_search_term is null
        or p_search_term = ''
        or lower(tr.title) like
          '%' ||
          replace(
            replace(
              replace(lower(p_search_term), '\', '\\'),
              '%',
              '\%'
            ),
            '_',
            '\_'
          ) ||
          '%'
          escape '\'
      )
      and (
        p_project_id is null
        or exists (
          select 1
          from accessible_projects ap
          where ap.id::text = p_project_id
        )
      )
      and public.review_access_role(
        tr.id, tr.user_id, tr.project_id, tr.org_id,
        p_user_id, p_user_email
      ) is not null
  ),
  cell_document_counts as (
    select
      tc.review_id,
      count(distinct tc.document_id)::integer as document_count
    from public.tabular_cells tc
    where tc.review_id in (
      select vr.id
      from visible_reviews vr
      where jsonb_typeof(vr.document_ids) is distinct from 'array'
    )
    group by tc.review_id
  ),
  review_document_counts as (
    select
      vr.id,
      case
        when jsonb_typeof(vr.document_ids) = 'array'
          then (
            select count(distinct doc_id.value)::integer
            from jsonb_array_elements_text(vr.document_ids) as doc_id(value)
          )
        else coalesce(cdc.document_count, 0)
      end as document_count
    from visible_reviews vr
    left join cell_document_counts cdc
      on cdc.review_id = vr.id
  )
  select
    vr.id,
    vr.project_id,
    vr.user_id::text as user_id,
    vr.title,
    vr.columns_config,
    vr.document_ids,
    vr.workflow_id,
    vr.created_at,
    vr.updated_at,
    coalesce(vr.user_id::text = p_user_id, false) as is_owner,
    public.review_access_role(
      vr.id, vr.user_id, vr.project_id, vr.org_id,
      p_user_id, p_user_email
    ) as access_role,
    rdc.document_count
  from visible_reviews vr
  join review_document_counts rdc
    on rdc.id = vr.id
  order by
    case when p_sort_key = 'name' and p_sort_direction = 'asc' then lower(coalesce(vr.title, '')) else null end asc,
    case when p_sort_key = 'name' and p_sort_direction = 'desc' then lower(coalesce(vr.title, '')) else null end desc,
    case when p_sort_key = 'columns' and p_sort_direction = 'asc' then jsonb_array_length(coalesce(vr.columns_config, '[]'::jsonb)) else null end asc,
    case when p_sort_key = 'columns' and p_sort_direction = 'desc' then jsonb_array_length(coalesce(vr.columns_config, '[]'::jsonb)) else null end desc,
    case when p_sort_key = 'documents' and p_sort_direction = 'asc' then rdc.document_count else null end asc,
    case when p_sort_key = 'documents' and p_sort_direction = 'desc' then rdc.document_count else null end desc,
    case when p_sort_key = 'created' and p_sort_direction = 'asc' then vr.created_at else null end asc,
    case when p_sort_key = 'created' and p_sort_direction = 'desc' then vr.created_at else null end desc,
    vr.created_at desc,
    vr.id asc
  limit greatest(coalesce(p_limit, 20), 1)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

create or replace function public.get_tabular_reviews_overview(
  p_user_id text,
  p_user_email text default null,
  p_project_id text default null
)
returns table (
  id uuid,
  project_id uuid,
  user_id text,
  title text,
  columns_config jsonb,
  document_ids jsonb,
  workflow_id uuid,
  created_at timestamptz,
  updated_at timestamptz,
  is_owner boolean,
  access_role text,
  document_count integer
)
language sql
stable
as $$
  select *
  from public.get_tabular_reviews_overview(
    p_user_id, p_user_email, p_project_id, 'all', 2147483647, 0,
    null, 'created', 'desc'
  );
$$;

create or replace function public.get_tabular_review_ids_overview(
  p_user_id text,
  p_user_email text,
  p_project_id text,
  p_scope text,
  p_search_term text,
  p_limit integer,
  p_offset integer
)
returns table (
  id uuid,
  user_id text
)
language sql
stable
as $$
  with accessible_projects as (
    select p.id
    from public.projects p
    where public.project_access_role(
      p.id, p.user_id, p.org_id, p_user_id, p_user_email
    ) is not null
  )
  select tr.id, tr.user_id::text as user_id
  from public.tabular_reviews tr
  where (p_project_id is null or tr.project_id::text = p_project_id)
    and (
      coalesce(p_scope, 'all') = 'all'
      or (p_scope = 'in-project' and tr.project_id is not null)
      or (p_scope = 'standalone' and tr.project_id is null)
    )
    and (
      p_search_term is null
      or p_search_term = ''
      or lower(tr.title) like
        '%' ||
        replace(
          replace(
            replace(lower(p_search_term), '\', '\\'),
            '%',
            '\%'
          ),
          '_',
          '\_'
        ) ||
        '%'
        escape '\'
    )
    and (
      p_project_id is null
      or exists (
        select 1
        from accessible_projects ap
        where ap.id::text = p_project_id
      )
    )
    and public.review_access_role(
      tr.id, tr.user_id, tr.project_id, tr.org_id,
      p_user_id, p_user_email
    ) is not null
  order by tr.created_at desc, tr.id asc
  limit greatest(coalesce(p_limit, 1000), 1)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

create table if not exists public.tabular_review_chats (
  id uuid primary key default gen_random_uuid(),
  review_id uuid not null references public.tabular_reviews(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  title text,
  model text,
  reasoning_level text check (reasoning_level in ('none', 'low', 'medium', 'high', 'xhigh', 'max')),
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
-- CourtListener bulk-data indexes
-- ---------------------------------------------------------------------------

create table if not exists public.courtlistener_citation_index (
  id bigint primary key,
  volume text not null,
  reporter text not null,
  page text not null,
  type integer,
  cluster_id bigint not null,
  date_created timestamptz,
  date_modified timestamptz
);

create index if not exists courtlistener_citation_lookup_idx
  on public.courtlistener_citation_index(volume, reporter, page);

create index if not exists courtlistener_citation_cluster_idx
  on public.courtlistener_citation_index(cluster_id);

alter table public.courtlistener_citation_index enable row level security;

create table if not exists public.courtlistener_opinion_cluster_index (
  id bigint primary key,
  case_name text,
  case_name_short text,
  case_name_full text,
  slug text,
  date_filed date,
  citation_count integer,
  precedential_status text,
  filepath_pdf_harvard text,
  filepath_json_harvard text,
  docket_id bigint
);

alter table public.courtlistener_opinion_cluster_index enable row level security;

-- ---------------------------------------------------------------------------
-- Library search and lightweight overview facets
-- ---------------------------------------------------------------------------

create or replace function public.search_library_documents(
  p_user_id text,
  p_library_kind text,
  p_limit integer,
  p_offset integer,
  p_search_term text default null,
  p_file_type text default null,
  p_sort_key text default 'updated',
  p_sort_direction text default 'desc'
)
returns table (
  id uuid,
  project_id uuid,
  user_id text,
  status text,
  folder_id uuid,
  library_kind text,
  library_folder_id uuid,
  current_version_id uuid,
  created_at timestamptz,
  updated_at timestamptz,
  filename text,
  file_type text,
  storage_path text,
  pdf_storage_path text,
  size_bytes integer,
  page_count integer,
  active_version_number integer
)
language sql
stable
as $$
  select
    d.id,
    d.project_id,
    d.user_id::text as user_id,
    d.status,
    d.folder_id,
    d.library_kind,
    d.library_folder_id,
    d.current_version_id,
    d.created_at,
    d.updated_at,
    coalesce(nullif(trim(v.filename), ''), 'Untitled document') as filename,
    v.file_type,
    v.storage_path,
    v.pdf_storage_path,
    v.size_bytes,
    v.page_count,
    v.version_number as active_version_number
  from public.documents d
  left join public.document_versions v
    on v.id = d.current_version_id
   and v.deleted_at is null
  where d.user_id::text = p_user_id
    and d.project_id is null
    and (
      (p_library_kind = 'file' and coalesce(d.library_kind, 'file') = 'file')
      or d.library_kind = p_library_kind
    )
    and (
      p_search_term is null
      or p_search_term = ''
      or lower(coalesce(v.filename, '')) like
        '%' || replace(replace(replace(lower(p_search_term), '\', '\\'), '%', '\%'), '_', '\_') || '%'
        escape '\'
    )
    and (
      p_file_type is null
      or lower(coalesce(v.file_type, '')) = lower(p_file_type)
    )
  order by
    case when p_sort_key = 'name' and p_sort_direction = 'asc' then lower(coalesce(v.filename, '')) else null end asc,
    case when p_sort_key = 'name' and p_sort_direction = 'desc' then lower(coalesce(v.filename, '')) else null end desc,
    case when p_sort_key = 'type' and p_sort_direction = 'asc' then lower(coalesce(v.file_type, '')) else null end asc,
    case when p_sort_key = 'type' and p_sort_direction = 'desc' then lower(coalesce(v.file_type, '')) else null end desc,
    case when p_sort_key = 'size' and p_sort_direction = 'asc' then coalesce(v.size_bytes, 0) else null end asc,
    case when p_sort_key = 'size' and p_sort_direction = 'desc' then coalesce(v.size_bytes, 0) else null end desc,
    case when p_sort_key = 'version' and p_sort_direction = 'asc' then coalesce(v.version_number, 0) else null end asc,
    case when p_sort_key = 'version' and p_sort_direction = 'desc' then coalesce(v.version_number, 0) else null end desc,
    case when p_sort_key = 'created' and p_sort_direction = 'asc' then d.created_at else null end asc,
    case when p_sort_key = 'created' and p_sort_direction = 'desc' then d.created_at else null end desc,
    case when p_sort_key = 'updated' and p_sort_direction = 'asc' then d.updated_at else null end asc,
    case when p_sort_key = 'updated' and p_sort_direction = 'desc' then d.updated_at else null end desc,
    d.updated_at desc,
    d.id asc
  limit greatest(coalesce(p_limit, 50), 1)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

create or replace function public.get_library_filter_options(
  p_user_id text,
  p_library_kind text
)
returns table (file_types text[])
language sql
stable
as $$
  select coalesce(
    array_agg(distinct lower(v.file_type) order by lower(v.file_type))
      filter (where nullif(trim(v.file_type), '') is not null),
    array[]::text[]
  ) as file_types
  from public.documents d
  left join public.document_versions v
    on v.id = d.current_version_id
   and v.deleted_at is null
  where d.user_id::text = p_user_id
    and d.project_id is null
    and (
      (p_library_kind = 'file' and coalesce(d.library_kind, 'file') = 'file')
      or d.library_kind = p_library_kind
    );
$$;

create or replace function public.get_project_filter_options(
  p_user_id text,
  p_user_email text default null
)
returns table (practices text[], owners jsonb)
language sql
stable
as $$
  with visible_projects as (
    select p.user_id, nullif(trim(p.practice), '') as practice
    from public.projects p
    where public.project_access_role(
      p.id, p.user_id, p.org_id, p_user_id, p_user_email
    ) is not null
  ),
  distinct_owners as (
    -- NULL is not an owner. A project whose creator's account was deleted
    -- carries user_id = NULL (on delete set null), and emitting it here put
    -- an option with value null in the owner dropdown -- selecting which made
    -- `p_owner_user_id is null or ...` true for EVERY row, so the filter
    -- silently turned itself off instead of filtering.
    select distinct vp.user_id
    from visible_projects vp
    where vp.user_id is not null
  ),
  owner_options as (
    select
      o.user_id,
      case
        when o.user_id::text = p_user_id then 'Me'
        else coalesce(
          nullif(trim(up.display_name), ''),
          nullif(trim(up.email), ''),
          'Shared'
        )
      end as label
    from distinct_owners o
    left join public.user_profiles up
      on up.user_id::text = o.user_id::text
  )
  select
    coalesce(
      (select array_agg(distinct practice order by practice)
       from visible_projects
       where practice is not null),
      array[]::text[]
    ) as practices,
    coalesce(
      (select jsonb_agg(
          jsonb_build_object('value', user_id, 'label', label)
          order by label, user_id
       ) from owner_options),
      '[]'::jsonb
    ) as owners;
$$;

create or replace function public.get_workflow_filter_options(
  p_user_id text,
  p_user_email text default null,
  p_type text default null,
  p_scope text default 'all'
)
returns table (
  practices text[],
  languages text[],
  jurisdictions text[]
)
language sql
stable
as $$
  with owned as (
    select w.practice, w.language, w.jurisdictions, 'owned'::text as source
    from public.workflows w
    where w.user_id::text = p_user_id
      and public.workflow_access_role(
        w.id, w.user_id, w.org_id, p_user_id, p_user_email
      ) is not null
      and (p_type is null or w.type = p_type)
  ),
  shared as (
    select w.practice, w.language, w.jurisdictions, 'shared'::text as source
    from public.workflow_shares ws
    join public.workflows w on w.id = ws.workflow_id
    where lower(ws.shared_with_email) = lower(coalesce(p_user_email, ''))
      and w.org_id is null
      and (p_type is null or w.type = p_type)
  ),
  org_shared as (
    -- Same org-membership arm as get_workflows_overview, including the
    -- workflow_shares NOT EXISTS dedup, so a row visible via both routes
    -- contributes its options exactly once. Tagged 'shared' to match the
    -- overview's scope bucketing.
    select w.practice, w.language, w.jurisdictions, 'shared'::text as source
    from public.workflows w
    where w.org_id is not null
      and (w.user_id is null or w.user_id::text <> p_user_id)
      and (p_type is null or w.type = p_type)
      and public.workflow_access_role(
        w.id, w.user_id, w.org_id, p_user_id, p_user_email
      ) is not null
  ),
  visible as (
    select * from owned
    union all
    select * from shared
    union all
    select * from org_shared
  ),
  scoped as (
    select * from visible
    where coalesce(p_scope, 'all') = 'all' or source = p_scope
  )
  select
    coalesce(
      array_agg(distinct nullif(trim(practice), '') order by nullif(trim(practice), ''))
        filter (where nullif(trim(practice), '') is not null),
      array[]::text[]
    ) as practices,
    coalesce(
      array_agg(distinct nullif(trim(language), '') order by nullif(trim(language), ''))
        filter (where nullif(trim(language), '') is not null),
      array[]::text[]
    ) as languages,
    coalesce(
      (select array_agg(distinct jurisdiction order by jurisdiction)
       from scoped s
       cross join lateral unnest(coalesce(s.jurisdictions, array[]::text[])) jurisdiction
       where nullif(trim(jurisdiction), '') is not null),
      array[]::text[]
    ) as jurisdictions
  from scoped;
$$;

create index if not exists document_versions_filename_trgm_idx
  on public.document_versions using gin (lower(filename) gin_trgm_ops)
  where deleted_at is null;

-- ---------------------------------------------------------------------------
-- Paginated project/workflow overviews and collection summary helpers
-- ---------------------------------------------------------------------------

-- Server-side pagination for the Projects overview page (/projects) and the
-- Workflows list page (/workflows), added the same day and combined into one
-- migration. Both mirror the pattern already built for Tabular Reviews in
-- 20260726_01_tabular_reviews_pagination.sql /
-- 20260727_01_tabular_review_ids_overview.sql.

-- ============================================================================
-- Projects overview pagination
-- ============================================================================
--   * a trigram index so leading-wildcard search can use an index scan
--   * a new, higher-arity overload of get_projects_overview that adds
--     scope/search/practice/owner filters, server-side sort, and limit/offset
--   * the 2-arg get_projects_overview remains the back-compat path for callers
--     that do not ask for pagination (document-picker directory view and
--     tabular-review project pickers) — see backend/src/routes/projects.ts
--     for the routing logic that decides which overload to call.
--   * a lightweight get_project_ids_overview companion for "select all
--     matching" bulk actions.

create extension if not exists pg_trgm;

create index if not exists projects_name_trgm_idx
  on public.projects using gin (lower(name) gin_trgm_ops);

create index if not exists projects_updated_at_idx
  on public.projects(updated_at desc, id);

create or replace function public.get_projects_overview(
  p_user_id text,
  p_user_email text,
  p_scope text,
  p_limit integer,
  p_offset integer,
  p_search_term text,
  p_sort_key text,
  p_sort_direction text,
  p_practice text,
  p_owner_user_id text
)
returns table (
  id uuid,
  user_id text,
  org_id uuid,
  access_scope text,
  organization_name text,
  name text,
  cm_number text,
  practice text,
  created_at timestamptz,
  updated_at timestamptz,
  is_owner boolean,
  owner_display_name text,
  owner_email text,
  access_role text,
  document_count integer,
  chat_count integer,
  review_count integer
)
language sql
stable
as $$
  with visible_projects as (
    select p.*
    from public.projects p
    where public.project_access_role(
        p.id, p.user_id, p.org_id, p_user_id, p_user_email
      ) is not null
      and (
        coalesce(p_scope, 'all') = 'all'
        or (p_scope = 'mine' and p.user_id::text = p_user_id)
        or (p_scope = 'shared' and (p.user_id is null or p.user_id::text <> p_user_id))
        or (
          p_scope = 'collaborative'
          and (
            p.org_id is not null
            or p.user_id is null
            or p.user_id::text <> p_user_id
            or exists (
              select 1 from public.project_access_grants g
              where g.project_id = p.id
            )
          )
        )
        or (
          p_scope = 'private'
          and p.org_id is null
          and p.user_id::text = p_user_id
          and not exists (
            select 1 from public.project_access_grants g
            where g.project_id = p.id
          )
        )
      )
      and (
        p_search_term is null
        or p_search_term = ''
        or lower(coalesce(p.name, '')) like
          '%' || replace(replace(replace(lower(p_search_term), '\', '\\'), '%', '\%'), '_', '\_') || '%'
          escape '\'
        or lower(coalesce(p.cm_number, '')) like
          '%' || replace(replace(replace(lower(p_search_term), '\', '\\'), '%', '\%'), '_', '\_') || '%'
          escape '\'
        or lower(coalesce(p.practice, '')) like
          '%' || replace(replace(replace(lower(p_search_term), '\', '\\'), '%', '\%'), '_', '\_') || '%'
          escape '\'
      )
      and (p_practice is null or p.practice = p_practice)
      and (p_owner_user_id is null or p.user_id::text = p_owner_user_id)
  ),
  document_counts as (
    select d.project_id, count(*)::integer as document_count
    from public.documents d
    where d.project_id in (select vp.id from visible_projects vp)
    group by d.project_id
  ),
  chat_counts as (
    select c.project_id, count(*)::integer as chat_count
    from public.chats c
    where c.project_id in (select vp.id from visible_projects vp)
    group by c.project_id
  ),
  review_counts as (
    select tr.project_id, count(*)::integer as review_count
    from public.tabular_reviews tr
    where tr.project_id in (select vp.id from visible_projects vp)
    group by tr.project_id
  )
  select
    vp.id,
    vp.user_id::text as user_id,
    vp.org_id,
    case
      when vp.org_id is not null then 'organization'
      when exists (
        select 1 from public.project_access_grants g
        where g.project_id = vp.id
      ) then 'shared'
      else 'private'
    end as access_scope,
    (
      select nullif(trim(o.name), '')
      from public.organizations o
      where o.id = vp.org_id
    ) as organization_name,
    vp.name,
    vp.cm_number,
    vp.practice,
    vp.created_at,
    vp.updated_at,
    coalesce(vp.user_id::text = p_user_id, false) as is_owner,
    nullif(trim(up.display_name), '') as owner_display_name,
    -- Populated at last. The column has always been declared and always
    -- returned NULL, so the UI's "ask the project admin" line had no address
    -- to render and silently collapsed to nothing.
    up.email as owner_email,
    public.project_access_role(
      vp.id, vp.user_id, vp.org_id, p_user_id, p_user_email
    ) as access_role,
    coalesce(dc.document_count, 0) as document_count,
    coalesce(cc.chat_count, 0) as chat_count,
    coalesce(rc.review_count, 0) as review_count
  from visible_projects vp
  left join public.user_profiles up
    on up.user_id::text = vp.user_id::text
  left join document_counts dc
    on dc.project_id = vp.id
  left join chat_counts cc
    on cc.project_id = vp.id
  left join review_counts rc
    on rc.project_id = vp.id
  order by
    case when p_sort_key = 'name' and p_sort_direction = 'asc' then lower(coalesce(vp.name, '')) else null end asc,
    case when p_sort_key = 'name' and p_sort_direction = 'desc' then lower(coalesce(vp.name, '')) else null end desc,
    case when p_sort_key = 'cm' and p_sort_direction = 'asc' then lower(coalesce(vp.cm_number, '')) else null end asc,
    case when p_sort_key = 'cm' and p_sort_direction = 'desc' then lower(coalesce(vp.cm_number, '')) else null end desc,
    case when p_sort_key = 'files' and p_sort_direction = 'asc' then coalesce(dc.document_count, 0) else null end asc,
    case when p_sort_key = 'files' and p_sort_direction = 'desc' then coalesce(dc.document_count, 0) else null end desc,
    case when p_sort_key = 'chats' and p_sort_direction = 'asc' then coalesce(cc.chat_count, 0) else null end asc,
    case when p_sort_key = 'chats' and p_sort_direction = 'desc' then coalesce(cc.chat_count, 0) else null end desc,
    case when p_sort_key = 'reviews' and p_sort_direction = 'asc' then coalesce(rc.review_count, 0) else null end asc,
    case when p_sort_key = 'reviews' and p_sort_direction = 'desc' then coalesce(rc.review_count, 0) else null end desc,
    case when p_sort_key = 'created' and p_sort_direction = 'asc' then vp.created_at else null end asc,
    case when p_sort_key = 'created' and p_sort_direction = 'desc' then vp.created_at else null end desc,
    case when p_sort_key = 'updated' and p_sort_direction = 'asc' then vp.updated_at else null end asc,
    case when p_sort_key = 'updated' and p_sort_direction = 'desc' then vp.updated_at else null end desc,
    vp.created_at desc,
    vp.id asc
  limit greatest(coalesce(p_limit, 20), 1)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

-- Lightweight companion for bulk "select all matching" actions — id + owning
-- user only, no count joins. Duplicates visible_projects' predicate rather
-- than delegating to get_projects_overview (same rationale as
-- get_tabular_review_ids_overview: the count CTEs there would be pure waste
-- for a caller that only wants ids). Keep this predicate in sync by hand if
-- visible_projects above ever changes.
--
-- Paginated (not "return everything") because PostgREST enforces its own
-- row cap on every RPC response and truncates silently rather than erroring;
-- backend/src/routes/projects.ts pages through this on the caller's behalf.
create or replace function public.get_project_ids_overview(
  p_user_id text,
  p_user_email text,
  p_scope text,
  p_search_term text,
  p_practice text,
  p_owner_user_id text,
  p_limit integer,
  p_offset integer
)
returns table (
  id uuid,
  user_id text
)
language sql
stable
as $$
  select p.id, p.user_id::text as user_id
  from public.projects p
  where public.project_access_role(
      p.id, p.user_id, p.org_id, p_user_id, p_user_email
    ) is not null
    and (
      coalesce(p_scope, 'all') = 'all'
      or (p_scope = 'mine' and p.user_id::text = p_user_id)
      or (p_scope = 'shared' and (p.user_id is null or p.user_id::text <> p_user_id))
      or (
        p_scope = 'collaborative'
        and (
          p.org_id is not null
          or p.user_id is null
          or p.user_id::text <> p_user_id
          or exists (
            select 1 from public.project_access_grants g
            where g.project_id = p.id
          )
        )
      )
      or (
        p_scope = 'private'
        and p.org_id is null
        and p.user_id::text = p_user_id
        and not exists (
          select 1 from public.project_access_grants g
          where g.project_id = p.id
        )
      )
    )
    and (
      p_search_term is null
      or p_search_term = ''
      or lower(coalesce(p.name, '')) like
        '%' || replace(replace(replace(lower(p_search_term), '\', '\\'), '%', '\%'), '_', '\_') || '%'
        escape '\'
      or lower(coalesce(p.cm_number, '')) like
        '%' || replace(replace(replace(lower(p_search_term), '\', '\\'), '%', '\%'), '_', '\_') || '%'
        escape '\'
      or lower(coalesce(p.practice, '')) like
        '%' || replace(replace(replace(lower(p_search_term), '\', '\\'), '%', '\%'), '_', '\_') || '%'
        escape '\'
    )
    and (p_practice is null or p.practice = p_practice)
    and (p_owner_user_id is null or p.user_id::text = p_owner_user_id)
  order by p.created_at desc, p.id asc
  limit greatest(coalesce(p_limit, 1000), 1)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

-- ============================================================================
-- Workflows overview pagination
-- ============================================================================
-- Mirrors the Projects pagination above. Catalog workflows live in the shared
-- mike_workflows table and have no user-data growth. They are deliberately
-- NOT part of this RPC. This migration only
-- paginates the one part of /workflows with real growth: a user's owned +
-- shared workflows. Every other caller of GET /workflows (the workflow picker
-- modal, the chat slash-menu picker) keeps hitting that exact unpaginated
-- path, since the route only takes the new paginated branch when a
-- pagination-related query param is present.

create index if not exists workflows_title_trgm_idx
  on public.workflows using gin (lower(title) gin_trgm_ops);

create index if not exists workflows_jurisdictions_gin_idx
  on public.workflows using gin (jurisdictions);

-- "owned" and "shared" retain the original source grouping, while "private"
-- and "collaborative" filter by access model. Collaborative includes direct
-- grants and organization access, including resources created by the caller.
-- This RPC never includes system workflows.
create or replace function public.get_workflows_overview(
  p_user_id text,
  p_user_email text,
  p_type text,
  p_scope text,
  p_limit integer,
  p_offset integer,
  p_search_term text,
  p_sort_key text,
  p_sort_direction text,
  p_practice text,
  p_language text,
  p_jurisdiction text
)
returns table (
  id uuid,
  user_id text,
  org_id uuid,
  access_scope text,
  organization_name text,
  title text,
  type text,
  prompt_md text,
  columns_config jsonb,
  language text,
  practice text,
  jurisdictions text[],
  is_system boolean,
  created_at timestamptz,
  allow_edit boolean,
  is_owner boolean,
  shared_by_name text
)
language sql
stable
as $$
  with owned as (
    select
      w.id, w.user_id::text as user_id, w.org_id,
      case
        when w.org_id is not null then 'organization'
        when exists (
          select 1 from public.workflow_shares scope_share
          where scope_share.workflow_id = w.id
        ) then 'shared'
        else 'private'
      end as access_scope,
      (
        select nullif(trim(o.name), '')
        from public.organizations o
        where o.id = w.org_id
      ) as organization_name,
      w.title, w.type, w.prompt_md,
      w.columns_config, w.language, w.practice, w.jurisdictions,
      false as is_system, w.created_at,
      true as allow_edit, true as is_owner, null::text as shared_by_name,
      0 as sort_bucket
    from public.workflows w
    where w.user_id::text = p_user_id
      and public.workflow_access_role(
        w.id, w.user_id, w.org_id, p_user_id, p_user_email
      ) is not null
      and (p_type is null or w.type = p_type)
  ),
  shared as (
    select
      w.id, w.user_id::text as user_id, w.org_id,
      'shared'::text as access_scope, null::text as organization_name,
      w.title, w.type, w.prompt_md,
      w.columns_config, w.language, w.practice, w.jurisdictions,
      false as is_system, w.created_at,
      (ws.role in ('owner', 'editor')) as allow_edit,
      (ws.role = 'owner') as is_owner,
      nullif(trim(up.display_name), '') as shared_by_name,
      1 as sort_bucket
    from public.workflow_shares ws
    join public.workflows w
      on w.id = ws.workflow_id
    left join public.user_profiles up
      on up.user_id::text = ws.shared_by_user_id::text
    where lower(ws.shared_with_email) = lower(coalesce(p_user_email, ''))
      and w.org_id is null
      and (p_type is null or w.type = p_type)
  ),
  org_shared as (
    -- Workflows in an org the caller belongs to. Admins default to Owner and
    -- Members default to Editor; per-workflow overrides may narrow either.
    -- Mirrors resolveWorkflowAccess in routes/workflows.ts and the legacy
    -- 3-argument overload. Under the scope filter these rows count as
    -- "shared" — shared-with-me and shared-via-my-org are one bucket from
    -- the caller's point of view.
    select
      w.id, w.user_id::text as user_id, w.org_id,
      'organization'::text as access_scope,
      (
        select nullif(trim(o.name), '')
        from public.organizations o
        where o.id = w.org_id
      ) as organization_name,
      w.title, w.type, w.prompt_md,
      w.columns_config, w.language, w.practice, w.jurisdictions,
      false as is_system, w.created_at,
      (public.workflow_access_role(
        w.id, w.user_id, w.org_id, p_user_id, p_user_email
      ) in ('owner', 'editor')) as allow_edit,
      (public.workflow_access_role(
        w.id, w.user_id, w.org_id, p_user_id, p_user_email
      ) = 'owner') as is_owner,
      nullif(trim(up.display_name), '') as shared_by_name,
      2 as sort_bucket
    from public.workflows w
    left join public.user_profiles up
      on up.user_id::text = w.user_id::text
    where w.org_id is not null
      and (w.user_id is null or w.user_id::text <> p_user_id)
      and (p_type is null or w.type = p_type)
      and public.workflow_access_role(
        w.id, w.user_id, w.org_id, p_user_id, p_user_email
      ) is not null
  ),
  visible_workflows as (
    select * from owned
    union all
    select * from shared
    union all
    select * from org_shared
  )
  select
    vw.id, vw.user_id, vw.org_id, vw.access_scope, vw.organization_name,
    vw.title, vw.type, vw.prompt_md, vw.columns_config,
    vw.language, vw.practice, vw.jurisdictions, vw.is_system, vw.created_at,
    vw.allow_edit, vw.is_owner, vw.shared_by_name
  from visible_workflows vw
  where (
      coalesce(p_scope, 'all') = 'all'
      or (p_scope = 'owned' and vw.sort_bucket = 0)
      or (p_scope = 'shared' and vw.sort_bucket in (1, 2))
      or (p_scope = 'private' and vw.access_scope = 'private')
      or (
        p_scope = 'collaborative'
        and vw.access_scope in ('shared', 'organization')
      )
    )
    and (
      p_search_term is null
      or p_search_term = ''
      or lower(vw.title) like
        '%' || replace(replace(replace(lower(p_search_term), '\', '\\'), '%', '\%'), '_', '\_') || '%'
        escape '\'
    )
    and (p_practice is null or vw.practice = p_practice)
    and (p_language is null or vw.language = p_language)
    and (p_jurisdiction is null or vw.jurisdictions @> array[p_jurisdiction])
  order by
    case when p_sort_key = 'name' and p_sort_direction = 'asc' then lower(coalesce(vw.title, '')) else null end asc,
    case when p_sort_key = 'name' and p_sort_direction = 'desc' then lower(coalesce(vw.title, '')) else null end desc,
    case when p_sort_key = 'type' and p_sort_direction = 'asc' then vw.type else null end asc,
    case when p_sort_key = 'type' and p_sort_direction = 'desc' then vw.type else null end desc,
    case when p_sort_key = 'created' and p_sort_direction = 'asc' then vw.created_at else null end asc,
    case when p_sort_key = 'created' and p_sort_direction = 'desc' then vw.created_at else null end desc,
    vw.sort_bucket asc,
    vw.created_at desc,
    vw.id asc
  limit greatest(coalesce(p_limit, 20), 1)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

-- Lightweight companion for bulk "select all matching" actions (owned
-- workflows only — see the route/hook layer; shared workflows are excluded
-- from bulk-delete eligibility since only the owner can delete, and system
-- workflows never need this since all 37 are always already in memory).
-- Duplicates the owned predicate directly rather than delegating to
-- get_workflows_overview, same rationale as get_project_ids_overview: no
-- need for the shared-by-name join when the caller only wants ids.
create or replace function public.get_workflow_ids_overview(
  p_user_id text,
  p_user_email text,
  p_type text,
  p_scope text,
  p_search_term text,
  p_practice text,
  p_language text,
  p_jurisdiction text,
  p_limit integer,
  p_offset integer
)
returns table (
  id uuid,
  user_id text
)
language sql
stable
as $$
  with owned as (
    select
      w.id, w.user_id::text as user_id,
      case
        when w.org_id is not null then 'organization'
        when exists (
          select 1 from public.workflow_shares scope_share
          where scope_share.workflow_id = w.id
        ) then 'shared'
        else 'private'
      end as access_scope,
      w.title, w.practice, w.language, w.jurisdictions,
      w.created_at, 0 as sort_bucket
    from public.workflows w
    where w.user_id::text = p_user_id
      and public.workflow_access_role(
        w.id, w.user_id, w.org_id, p_user_id, p_user_email
      ) is not null
      and (p_type is null or w.type = p_type)
  ),
  shared as (
    select
      w.id, w.user_id::text as user_id, 'shared'::text as access_scope,
      w.title, w.practice, w.language, w.jurisdictions,
      w.created_at, 1 as sort_bucket
    from public.workflow_shares ws
    join public.workflows w
      on w.id = ws.workflow_id
    where lower(ws.shared_with_email) = lower(coalesce(p_user_email, ''))
      and w.org_id is null
      and (p_type is null or w.type = p_type)
  ),
  org_shared as (
    -- Same org-membership arm as get_workflows_overview: the ids RPC must
    -- compute the same visible set, or "select all matching" silently
    -- omits org-shared rows the list view shows.
    select
      w.id, w.user_id::text as user_id, 'organization'::text as access_scope,
      w.title, w.practice, w.language, w.jurisdictions,
      w.created_at, 2 as sort_bucket
    from public.workflows w
    where w.org_id is not null
      and (w.user_id is null or w.user_id::text <> p_user_id)
      and (p_type is null or w.type = p_type)
      and public.workflow_access_role(
        w.id, w.user_id, w.org_id, p_user_id, p_user_email
      ) is not null
  ),
  visible_workflows as (
    select * from owned
    union all
    select * from shared
    union all
    select * from org_shared
  )
  select vw.id, vw.user_id
  from visible_workflows vw
  where (
      coalesce(p_scope, 'all') = 'all'
      or (p_scope = 'owned' and vw.sort_bucket = 0)
      or (p_scope = 'shared' and vw.sort_bucket in (1, 2))
      or (p_scope = 'private' and vw.access_scope = 'private')
      or (
        p_scope = 'collaborative'
        and vw.access_scope in ('shared', 'organization')
      )
    )
    and (
      p_search_term is null
      or p_search_term = ''
      or lower(vw.title) like
        '%' || replace(replace(replace(lower(p_search_term), '\', '\\'), '%', '\%'), '_', '\_') || '%'
        escape '\'
    )
    and (p_practice is null or vw.practice = p_practice)
    and (p_language is null or vw.language = p_language)
    and (p_jurisdiction is null or vw.jurisdictions @> array[p_jurisdiction])
  order by vw.sort_bucket asc, vw.created_at desc, vw.id asc
  limit greatest(coalesce(p_limit, 1000), 1)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

-- Lightweight sidebar project feed. The Projects overview RPC intentionally
-- computes file/chat/review counts for table sorting; the sidebar needs none
-- of those aggregates.
create or replace function public.get_project_summaries(
  p_user_id text,
  p_user_email text,
  p_limit integer,
  p_offset integer
)
returns table (
  id uuid,
  user_id text,
  name text,
  created_at timestamptz,
  updated_at timestamptz,
  is_owner boolean
)
language sql
stable
as $$
  select
    p.id,
    p.user_id::text as user_id,
    p.name,
    p.created_at,
    p.updated_at,
    coalesce(p.user_id::text = p_user_id, false) as is_owner
  from public.projects p
  where public.project_access_role(
    p.id, p.user_id, p.org_id, p_user_id, p_user_email
  ) is not null
  order by p.updated_at desc, p.created_at desc, p.id asc
  limit greatest(coalesce(p_limit, 11), 1)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

-- ID-only Library query for select-all and bulk actions. This mirrors the
-- flat Library search predicate without returning document/version payloads.
create or replace function public.get_library_document_ids(
  p_user_id text,
  p_library_kind text,
  p_search_term text,
  p_file_type text,
  p_limit integer,
  p_offset integer
)
returns table (
  id uuid,
  user_id text
)
language sql
stable
as $$
  select d.id, d.user_id::text as user_id
  from public.documents d
  left join public.document_versions v
    on v.id = d.current_version_id
   and v.deleted_at is null
  where d.user_id::text = p_user_id
    and d.project_id is null
    and (
      (p_library_kind = 'file' and coalesce(d.library_kind, 'file') = 'file')
      or d.library_kind = p_library_kind
    )
    and (
      p_search_term is null
      or p_search_term = ''
      or lower(coalesce(v.filename, '')) like
        '%' || replace(replace(replace(lower(p_search_term), '\', '\\'), '%', '\%'), '_', '\_') || '%'
        escape '\'
    )
    and (
      p_file_type is null
      or lower(coalesce(v.file_type, '')) = lower(p_file_type)
    )
  order by d.updated_at desc, d.id asc
  limit greatest(coalesce(p_limit, 1000), 1)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

-- Resolve uploaded folder paths against the complete server-side hierarchy.
-- Advisory transaction locks serialize path creation within one project or
-- one user library so two concurrent folder uploads cannot create the same
-- path. Existing top-level folders are reported to the caller before any
-- mutation so the UI can ask whether to delete and replace them or create a
-- suffixed copy. The `reuse` mode is reserved for nested segments after that
-- top-level choice has already been made.

create or replace function public.resolve_project_folder_path(
  target_project_id uuid,
  target_user_id uuid,
  base_folder_id uuid,
  path_segments text[],
  conflict_resolution text default 'error'
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  current_parent_id uuid := base_folder_id;
  folder_row public.project_subfolders%rowtype;
  resolved_folders jsonb := '[]'::jsonb;
  segment text;
  resolved_name text;
  first_resolved_name text;
  candidate_name text;
  suffix integer;
  segment_index integer;
begin
  if conflict_resolution not in ('error', 'reuse', 'rename') then
    raise exception 'Invalid folder conflict resolution';
  end if;
  if coalesce(array_length(path_segments, 1), 0) = 0
     or array_length(path_segments, 1) > 100 then
    raise exception 'Folder path must contain between 1 and 100 segments';
  end if;
  if base_folder_id is not null and not exists (
    select 1 from public.project_subfolders
    where id = base_folder_id and project_id = target_project_id
  ) then
    raise exception 'Parent folder not found';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('project-folder-path:' || target_project_id::text, 0)
  );

  for segment_index in 1..array_length(path_segments, 1) loop
    segment := btrim(path_segments[segment_index]);
    if segment = '' or length(segment) > 255 then
      raise exception 'Folder names must contain between 1 and 255 characters';
    end if;
    resolved_name := segment;

    select * into folder_row
    from public.project_subfolders
    where project_id = target_project_id
      and parent_folder_id is not distinct from current_parent_id
      and lower(btrim(name)) = lower(segment)
    order by created_at, id
    limit 1;

    if folder_row.id is not null and segment_index = 1 then
      suffix := 2;
      loop
        candidate_name := segment || ' (' || suffix || ')';
        exit when not exists (
          select 1 from public.project_subfolders
          where project_id = target_project_id
            and parent_folder_id is not distinct from current_parent_id
            and lower(btrim(name)) = lower(candidate_name)
        );
        suffix := suffix + 1;
      end loop;

      if conflict_resolution = 'error' then
        return jsonb_build_object(
          'conflict', true,
          'folder_name', folder_row.name,
          'existing_folder_id', folder_row.id,
          'suggested_name', candidate_name
        );
      elsif conflict_resolution = 'rename' then
        folder_row := null;
        resolved_name := candidate_name;
      end if;
    end if;

    if folder_row.id is null then
      insert into public.project_subfolders (
        project_id, user_id, name, parent_folder_id
      ) values (
        target_project_id, target_user_id, resolved_name, current_parent_id
      ) returning * into folder_row;
    end if;

    if segment_index = 1 then
      first_resolved_name := folder_row.name;
    end if;
    current_parent_id := folder_row.id;
    resolved_folders := resolved_folders || jsonb_build_array(to_jsonb(folder_row));
    folder_row := null;
  end loop;

  return jsonb_build_object(
    'conflict', false,
    'folder_id', current_parent_id,
    'resolved_name', first_resolved_name,
    'folders', resolved_folders
  );
end;
$$;

create or replace function public.resolve_library_folder_path(
  target_user_id uuid,
  target_library_kind text,
  base_folder_id uuid,
  path_segments text[],
  conflict_resolution text default 'error'
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  current_parent_id uuid := base_folder_id;
  folder_row public.library_folders%rowtype;
  resolved_folders jsonb := '[]'::jsonb;
  segment text;
  resolved_name text;
  first_resolved_name text;
  candidate_name text;
  suffix integer;
  segment_index integer;
begin
  if target_library_kind not in ('file', 'template') then
    raise exception 'Invalid library kind';
  end if;
  if conflict_resolution not in ('error', 'reuse', 'rename') then
    raise exception 'Invalid folder conflict resolution';
  end if;
  if coalesce(array_length(path_segments, 1), 0) = 0
     or array_length(path_segments, 1) > 100 then
    raise exception 'Folder path must contain between 1 and 100 segments';
  end if;
  if base_folder_id is not null and not exists (
    select 1 from public.library_folders
    where id = base_folder_id
      and user_id = target_user_id
      and library_kind = target_library_kind
  ) then
    raise exception 'Parent folder not found';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'library-folder-path:' || target_user_id::text || ':' || target_library_kind,
      0
    )
  );

  for segment_index in 1..array_length(path_segments, 1) loop
    segment := btrim(path_segments[segment_index]);
    if segment = '' or length(segment) > 255 then
      raise exception 'Folder names must contain between 1 and 255 characters';
    end if;
    resolved_name := segment;

    select * into folder_row
    from public.library_folders
    where user_id = target_user_id
      and library_kind = target_library_kind
      and parent_folder_id is not distinct from current_parent_id
      and lower(btrim(name)) = lower(segment)
    order by created_at, id
    limit 1;

    if folder_row.id is not null and segment_index = 1 then
      suffix := 2;
      loop
        candidate_name := segment || ' (' || suffix || ')';
        exit when not exists (
          select 1 from public.library_folders
          where user_id = target_user_id
            and library_kind = target_library_kind
            and parent_folder_id is not distinct from current_parent_id
            and lower(btrim(name)) = lower(candidate_name)
        );
        suffix := suffix + 1;
      end loop;

      if conflict_resolution = 'error' then
        return jsonb_build_object(
          'conflict', true,
          'folder_name', folder_row.name,
          'existing_folder_id', folder_row.id,
          'suggested_name', candidate_name
        );
      elsif conflict_resolution = 'rename' then
        folder_row := null;
        resolved_name := candidate_name;
      end if;
    end if;

    if folder_row.id is null then
      insert into public.library_folders (
        user_id, library_kind, name, parent_folder_id
      ) values (
        target_user_id, target_library_kind, resolved_name, current_parent_id
      ) returning * into folder_row;
    end if;

    if segment_index = 1 then
      first_resolved_name := folder_row.name;
    end if;
    current_parent_id := folder_row.id;
    resolved_folders := resolved_folders || jsonb_build_array(to_jsonb(folder_row));
    folder_row := null;
  end loop;

  return jsonb_build_object(
    'conflict', false,
    'folder_id', current_parent_id,
    'resolved_name', first_resolved_name,
    'folders', resolved_folders
  );
end;
$$;

revoke all on function public.resolve_project_folder_path(uuid, uuid, uuid, text[], text)
  from public, anon, authenticated;
grant execute on function public.resolve_project_folder_path(uuid, uuid, uuid, text[], text)
  to service_role;

revoke all on function public.resolve_library_folder_path(uuid, text, uuid, text[], text)
  from public, anon, authenticated;
grant execute on function public.resolve_library_folder_path(uuid, text, uuid, text[], text)
  to service_role;

create or replace function public.create_upload_session(
  target_session_id uuid,
  target_user_id uuid,
  target_purpose text,
  target_destination jsonb,
  target_expires_at timestamptz,
  target_files jsonb,
  target_hourly_session_limit integer default 50
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  manifest_file_count integer;
  manifest_total_bytes bigint;
  recent_session_count integer;
begin
  if jsonb_typeof(target_files) <> 'array' then
    raise exception using errcode = '22023', message = 'invalid_upload_manifest';
  end if;
  -- The API issues a 30-minute expiry. Permit one minute of clock skew between
  -- the application host and Postgres while keeping the issued TTL unchanged.
  if target_expires_at <= now()
     or target_expires_at > now() + interval '31 minutes' then
    raise exception using errcode = '22023', message = 'invalid_upload_session_expiry';
  end if;
  if target_hourly_session_limit not between 1 and 1000000 then
    raise exception using errcode = '22023', message = 'invalid_upload_session_rate_limit';
  end if;

  select count(*), coalesce(sum(file_row.expected_size_bytes), 0)
    into manifest_file_count, manifest_total_bytes
  from jsonb_to_recordset(target_files) as file_row(
    id uuid,
    resource_id uuid,
    client_id text,
    filename text,
    target_folder_id uuid,
    file_type text,
    content_type text,
    expected_size_bytes bigint,
    staging_storage_path text,
    sealed_storage_path text
  );

  if manifest_file_count < 1 or manifest_file_count > 50 then
    raise exception using errcode = '22023', message = 'upload_file_count_limit_exceeded';
  end if;
  if manifest_total_bytes < 1 or manifest_total_bytes > 2147483648 then
    raise exception using errcode = '22023', message = 'upload_total_size_limit_exceeded';
  end if;
  if exists (
    select 1
    from jsonb_to_recordset(target_files) as file_row(
      id uuid,
      resource_id uuid,
      client_id text,
      filename text,
      target_folder_id uuid,
      file_type text,
      content_type text,
      expected_size_bytes bigint,
      staging_storage_path text,
      sealed_storage_path text
    )
    where file_row.id is null
       or file_row.resource_id is null
       or length(file_row.client_id) not between 1 and 128
       or length(file_row.filename) not between 1 and 255
       or file_row.file_type not in ('pdf', 'docx', 'doc', 'xlsx', 'xlsm', 'xls', 'pptx', 'ppt')
       or length(file_row.content_type) not between 1 and 255
       or file_row.expected_size_bytes not between 1 and 104857600
       or length(file_row.staging_storage_path) < 1
       or length(file_row.sealed_storage_path) < 1
  ) then
    raise exception using errcode = '22023', message = 'invalid_upload_manifest';
  end if;

  -- Namespace the advisory key: hashtextextended(user_id, 0) with no prefix is
  -- already taken by install_missing_default_workflows, and an un-namespaced
  -- key silently serializes unrelated features against each other (see the
  -- advisory-lock registry comment at the top of schema.sql).
  perform pg_advisory_xact_lock(
    hashtextextended('upload-session:' || target_user_id::text, 0)
  );

  -- Housekeeping runs FIRST, under the user lock: expire stale pending
  -- sessions and error out stale verifying ones before the busy check below.
  -- In the earlier draft these updates sat after the busy check, so the one
  -- branch where a stale session was exactly what blocked the caller
  -- (upload_target_busy) rolled them back and the 409 persisted until the
  -- 60-second background sweep happened to run.
  update public.upload_sessions
  set status = 'expired', updated_at = now()
  where user_id = target_user_id
    and status = 'pending_upload'
    and expires_at <= now();

  update public.upload_sessions
  set status = 'error', updated_at = now()
  where user_id = target_user_id
    and status = 'verifying'
    and updated_at <= now() - interval '5 minutes';

  if target_purpose in (
    'document_version_create',
    'document_version_replace',
    'workflow_reference_replace'
  ) and exists (
    select 1
    from public.upload_sessions
    where user_id = target_user_id
      and purpose = target_purpose
      and (
        (target_purpose = 'document_version_create'
          and destination ->> 'document_id' = target_destination ->> 'document_id')
        or (target_purpose = 'document_version_replace'
          and destination ->> 'document_id' = target_destination ->> 'document_id'
          and destination ->> 'version_id' = target_destination ->> 'version_id')
        or (target_purpose = 'workflow_reference_replace'
          and destination ->> 'workflow_id' = target_destination ->> 'workflow_id'
          and destination ->> 'reference_id' = target_destination ->> 'reference_id')
      )
      and status in ('pending_upload', 'verifying', 'uploaded', 'processing')
  ) then
    raise exception using errcode = 'P0001', message = 'upload_target_busy';
  end if;

  select count(*)
    into recent_session_count
  from public.upload_sessions
  where user_id = target_user_id
    and created_at > now() - interval '1 hour';

  if recent_session_count >= target_hourly_session_limit then
    raise exception using errcode = 'P0001', message = 'upload_session_rate_limit_exceeded';
  end if;

  insert into public.upload_sessions (
    id,
    user_id,
    purpose,
    destination,
    expected_file_count,
    expected_total_bytes,
    expires_at
  ) values (
    target_session_id,
    target_user_id,
    target_purpose,
    target_destination,
    manifest_file_count,
    manifest_total_bytes,
    target_expires_at
  );

  insert into public.upload_session_files (
    id,
    session_id,
    resource_id,
    client_id,
    filename,
    target_folder_id,
    file_type,
    content_type,
    expected_size_bytes,
    staging_storage_path,
    sealed_storage_path
  )
  select
    file_row.id,
    target_session_id,
    file_row.resource_id,
    file_row.client_id,
    file_row.filename,
    file_row.target_folder_id,
    file_row.file_type,
    file_row.content_type,
    file_row.expected_size_bytes,
    file_row.staging_storage_path,
    file_row.sealed_storage_path
  from jsonb_to_recordset(target_files) as file_row(
    id uuid,
    resource_id uuid,
    client_id text,
    filename text,
    target_folder_id uuid,
    file_type text,
    content_type text,
    expected_size_bytes bigint,
    staging_storage_path text,
    sealed_storage_path text
  );
end;
$$;

-- Extend a live session's deadline after per-file progress. Each successful
-- completion proves the client is still working, so the deadline slides
-- (never shrinks), capped at an absolute age so an abandoned-but-polling
-- client cannot keep a session alive forever.
create or replace function public.extend_upload_session_expiry(
  target_session_id uuid,
  target_extension_seconds integer default 1800,
  target_max_session_age_seconds integer default 14400
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if target_extension_seconds not between 60 and 3600
     or target_max_session_age_seconds not between 600 and 86400 then
    raise exception using errcode = '22023', message = 'invalid_upload_session_extension';
  end if;

  update public.upload_sessions
  set expires_at = greatest(
        expires_at,
        least(
          now() + make_interval(secs => target_extension_seconds),
          created_at + make_interval(secs => target_max_session_age_seconds)
        )
      ),
      updated_at = now()
  where id = target_session_id
    and status in ('pending_upload', 'verifying', 'uploaded', 'processing');
end;
$$;

create or replace function public.refresh_upload_session_status(
  target_session_id uuid
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  session_row public.upload_sessions%rowtype;
  pending_file_count integer;
  active_file_count integer;
  completed_file_count integer;
  failed_file_count integer;
  next_status text;
  next_error_code text;
  terminal_at timestamptz;
begin
  select *
    into session_row
  from public.upload_sessions
  where id = target_session_id
  for update;

  if session_row.id is null then
    raise exception using errcode = 'P0002', message = 'upload_session_not_found';
  end if;
  if session_row.status in ('cancelled', 'expired') then
    return session_row.status;
  end if;

  select
    count(*) filter (where status in ('pending_upload', 'verifying')),
    count(*) filter (where status in ('uploaded', 'processing')),
    count(*) filter (where status = 'completed'),
    count(*) filter (where status = 'error')
    into pending_file_count, active_file_count, completed_file_count, failed_file_count
  from public.upload_session_files
  where session_id = target_session_id;

  if pending_file_count > 0 then
    next_status := 'pending_upload';
    next_error_code := null;
    terminal_at := null;
  elsif active_file_count > 0 then
    next_status := 'processing';
    next_error_code := null;
    terminal_at := null;
  elsif completed_file_count > 0 then
    next_status := 'completed';
    next_error_code := case when failed_file_count > 0 then 'partial_failure' else null end;
    terminal_at := now();
  else
    next_status := 'error';
    next_error_code := 'all_uploads_failed';
    terminal_at := now();
  end if;

  -- cleaned_at means "this session's storage objects have been deleted".
  -- A COMPLETED session's objects were already removed by the worker as part
  -- of processing, so stamping it here is truthful. An ERROR session's
  -- objects may still exist (the worker that would have deleted them is
  -- often exactly what died), so cleaned_at must stay null — it is the
  -- object sweeper's cursor, and stamping it here permanently hid errored
  -- sessions from the sweep, orphaning their sealed objects.
  -- The write is also guarded so repeated refreshes of an already-terminal
  -- session do not advance completed_at/updated_at: retention filters on
  -- updated_at, and an unconditional bump let any polling client defer the
  -- retention delete indefinitely.
  update public.upload_sessions
  set status = next_status,
      error_code = next_error_code,
      completed_at = case
        when terminal_at is null then null
        else coalesce(completed_at, terminal_at)
      end,
      cleaned_at = case
        when next_status = 'completed' then coalesce(cleaned_at, terminal_at)
        else cleaned_at
      end,
      updated_at = now()
  where id = target_session_id
    and (status is distinct from next_status
      or error_code is distinct from next_error_code);

  return next_status;
end;
$$;

create or replace function public.queue_upload_session_file_processing(
  target_session_id uuid,
  target_user_id uuid,
  target_file_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  session_row public.upload_sessions%rowtype;
  file_row public.upload_session_files%rowtype;
  processing_job_id uuid;
begin
  -- Plain read: this function only needs to VALIDATE the session status, and
  -- taking FOR UPDATE here created a session->file->job lock order while
  -- claim_upload_processing_job acquires job->file->session — a genuine
  -- deadlock cycle on the documented completion-retry path (reproduced live
  -- during review). Locks below are acquired job-first to match the claim
  -- function's order.
  select *
    into session_row
  from public.upload_sessions
  where id = target_session_id
    and user_id = target_user_id;

  if session_row.id is null then
    raise exception using errcode = 'P0002', message = 'upload_session_not_found';
  end if;
  if session_row.status in ('cancelled', 'expired') then
    raise exception using errcode = 'P0001', message = 'upload_session_not_active';
  end if;

  if not exists (
    select 1
    from public.upload_session_files
    where id = target_file_id
      and session_id = target_session_id
  ) then
    raise exception using errcode = 'P0002', message = 'upload_session_file_not_found';
  end if;

  -- Job first (matches claim_upload_processing_job's lock order). The no-op
  -- conflict update exists only to make RETURNING yield the existing id, so a
  -- repeated completion call is idempotent.
  insert into public.upload_processing_jobs (session_id, file_id, user_id)
  values (target_session_id, target_file_id, target_user_id)
  on conflict (file_id) do update
    set file_id = excluded.file_id
  returning id into processing_job_id;

  -- File second. A failed readiness check raises, which rolls the job upsert
  -- back with the rest of the transaction.
  select *
    into file_row
  from public.upload_session_files
  where id = target_file_id
    and session_id = target_session_id
  for update;

  if file_row.status not in ('uploaded', 'processing', 'completed') then
    raise exception using errcode = 'P0001', message = 'upload_session_file_not_ready';
  end if;

  return processing_job_id;
end;
$$;

create or replace function public.claim_upload_processing_job(
  target_worker_id text,
  target_lease_seconds integer default 600,
  target_max_running_per_user integer default 4
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  candidate_ids uuid[];
  candidate record;
  active_user_jobs integer;
  claimed_job_id uuid;
  claimed_session_id uuid;
  claimed_file_id uuid;
begin
  if length(target_worker_id) not between 1 and 200
     or target_lease_seconds not between 60 and 3600
     or target_max_running_per_user not between 1 and 64 then
    raise exception using errcode = '22023', message = 'invalid_upload_worker_claim';
  end if;

  -- Bound the candidate set BEFORE the per-row fairness work. The lateral
  -- running-count below sits under a sort, so without this cap every ready
  -- job pays a count on every poll of every worker even when nothing is
  -- claimable — one 50-file batch meant 50 lateral counts x 16 workers x 1/s.
  -- 32 candidates is plenty: a worker claims at most one job per poll.
  select array_agg(id)
    into candidate_ids
  from (
    select id
    from public.upload_processing_jobs
    where attempts < 3
      and ((
        status = 'queued'
        and available_at <= now()
      ) or (
        status = 'running'
        and locked_at <= now() - make_interval(secs => target_lease_seconds)
      ))
    order by available_at, created_at
    limit 32
  ) as ready;

  if candidate_ids is null then
    return null;
  end if;

  for candidate in
    select
      job.id,
      job.session_id,
      job.file_id,
      job.user_id,
      active.running_count
    from public.upload_processing_jobs as job
    cross join lateral (
      select count(*)::integer as running_count
      from public.upload_processing_jobs as running_job
      where running_job.user_id = job.user_id
        and running_job.status = 'running'
        and running_job.locked_at >
          now() - make_interval(secs => target_lease_seconds)
    ) as active
    where job.id = any(candidate_ids)
      and job.attempts < 3
      and active.running_count < target_max_running_per_user
      and ((
        job.status = 'queued'
        and job.available_at <= now()
      ) or (
        job.status = 'running'
        and job.locked_at <=
          now() - make_interval(secs => target_lease_seconds)
      ))
    order by active.running_count, job.available_at, job.created_at
    for update of job skip locked
  loop
    -- Serialize the count-and-claim decision for this user across every
    -- backend replica. A hash collision only delays a claim until the next
    -- poll; it cannot let a user exceed the cap.
    if not pg_try_advisory_xact_lock(
      hashtextextended(candidate.user_id::text, 8242026)
    ) then
      continue;
    end if;

    select count(*)::integer
      into active_user_jobs
    from public.upload_processing_jobs
    where user_id = candidate.user_id
      and status = 'running'
      and locked_at > now() - make_interval(secs => target_lease_seconds);

    if active_user_jobs >= target_max_running_per_user then
      continue;
    end if;

    claimed_job_id := candidate.id;
    claimed_session_id := candidate.session_id;
    claimed_file_id := candidate.file_id;
    exit;
  end loop;

  if claimed_job_id is null then
    return null;
  end if;

  update public.upload_processing_jobs
  set status = 'running',
      attempts = attempts + 1,
      locked_at = now(),
      locked_by = target_worker_id,
      error_code = null,
      updated_at = now()
  where id = claimed_job_id;

  update public.upload_session_files
  set status = 'processing', error_code = null, updated_at = now()
  where id = claimed_file_id
    and session_id = claimed_session_id
    and (status = 'uploaded' or (status = 'error' and error_code = 'processing_failed'));

  perform public.refresh_upload_session_status(claimed_session_id);

  return claimed_job_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Direct client grant hardening
-- ---------------------------------------------------------------------------
--
-- The frontend uses Supabase directly only for authentication. Application
-- data access goes through the backend API with the service role after the
-- backend verifies the user's JWT. Do not grant the browser anon/authenticated
-- roles direct table privileges for backend-owned data.

-- Audit history of user actions (queried via the service-role backend only).
-- Defined here — above the service_role grant block — so `grant ... on all
-- tables in schema public` below covers it on a fresh install. Like every other
-- backend-owned table, direct browser roles are revoked and RLS is enabled with
-- no policies (defense in depth; service_role bypasses RLS for the backend path).
create table if not exists public.audit_events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  user_id uuid not null references auth.users(id) on delete cascade,
  user_email text,
  action text not null,
  status text not null default 'completed',
  title text,
  surface text,
  project_id uuid,
  chat_id uuid,
  document_id uuid,
  review_id uuid,
  model text,
  detail jsonb
);
create index if not exists audit_events_user_created on public.audit_events (user_id, created_at desc);
create index if not exists audit_events_project_created on public.audit_events (project_id, created_at desc);
alter table public.audit_events enable row level security;

-- Durable, Postgres-backed background jobs (the "DB queue"): default-on
-- at-least-once execution for audit trails, account deletion, storage
-- cleanup and export generation — workloads that must be durable in every
-- deployment, using the database every deployment already has. See the
-- 20260829_01_db_jobs migration header for the full design notes.
create table if not exists public.db_jobs (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending'
    check (status in ('pending', 'running', 'done', 'failed')),
  attempts integer not null default 0,
  max_attempts integer not null default 5 check (max_attempts >= 1),
  run_at timestamptz not null default now(),
  claimed_at timestamptz,
  finished_at timestamptz,
  last_error text,
  dedupe_key text,
  result jsonb,
  created_at timestamptz not null default now()
);
create index if not exists db_jobs_claim_idx
  on public.db_jobs (run_at)
  where status = 'pending';
create index if not exists db_jobs_running_idx
  on public.db_jobs (claimed_at)
  where status = 'running';
create unique index if not exists db_jobs_dedupe_live_idx
  on public.db_jobs (dedupe_key)
  where dedupe_key is not null and status in ('pending', 'running');
create index if not exists db_jobs_finished_idx
  on public.db_jobs (finished_at)
  where status in ('done', 'failed');
alter table public.db_jobs enable row level security;

-- Atomic batch claim with built-in stale-running recovery (crash resume).
-- FOR UPDATE SKIP LOCKED partitions work between concurrent claimers. The
-- attempt budget applies to stale recovery as well: a job that KILLS its
-- worker never reaches the runner's retry state machine, so without the
-- attempts < max_attempts guard it is reclaimed forever. Spent stale rows are
-- given the terminal 'failed' state by the first CTE.
create or replace function public.claim_db_jobs(
  p_limit integer default 5,
  p_stale_seconds integer default 600
)
returns setof public.db_jobs
language sql
as $$
  with abandoned as (
    update public.db_jobs
       set status = 'failed',
           finished_at = now(),
           last_error = coalesce(
             last_error,
             'abandoned: worker died mid-run and attempts are exhausted'
           )
     where status = 'running'
       and claimed_at < now() - make_interval(secs => p_stale_seconds)
       and attempts >= max_attempts
    returning id
  ), candidates as (
    select id
      from public.db_jobs
     where (status = 'pending' and run_at <= now())
        or (status = 'running'
            and claimed_at < now() - make_interval(secs => p_stale_seconds)
            and attempts < max_attempts)
     order by run_at
     limit p_limit
       for update skip locked
  )
  update public.db_jobs j
     set status = 'running',
         claimed_at = now(),
         attempts = j.attempts + 1
    from candidates c
   where j.id = c.id
  returning j.*;
$$;

-- Claim ONE job by id — the Redis-delivery path (transactional-outbox
-- pattern). When Redis is configured, enqueue also adds a BullMQ "delivery"
-- job carrying this row's id so pickup is instant; the worker still claims
-- through Postgres via this function, so a duplicate delivery (BullMQ retry,
-- poller backstop racing the delivery) can never double-run the job: the
-- second claimer matches zero rows. Same stale-running recovery as the batch
-- claim, including its attempt budget: a job that kills its worker must not be
-- redelivered forever. Terminally failing a spent stale row is left to the
-- batch claim above, which every deployment runs (as the delivery mechanism
-- without Redis, as the lost-delivery backstop with it).
create or replace function public.claim_db_job(
  p_id uuid,
  p_stale_seconds integer default 600
)
returns setof public.db_jobs
language sql
as $$
  update public.db_jobs j
     set status = 'running',
         claimed_at = now(),
         attempts = j.attempts + 1
   where j.id = p_id
     and ((j.status = 'pending' and j.run_at <= now())
       or (j.status = 'running'
           and j.claimed_at < now() - make_interval(secs => p_stale_seconds)
           and j.attempts < j.max_attempts))
  returning j.*;
$$;

-- Cancellation for dedupe-keyed jobs (clear-cells in Postgres-driver mode):
-- pending jobs are deleted outright; running jobs get a persisted
-- `canceled: true` stamped into their payload, which handlers check on each
-- (re)claim — mirroring the BullMQ Job#updateData cancellation path.
create or replace function public.cancel_db_jobs(p_dedupe_keys text[])
returns integer
language sql
as $$
  with deleted as (
    delete from public.db_jobs
     where dedupe_key = any(p_dedupe_keys)
       and status = 'pending'
    returning 1
  ), marked as (
    update public.db_jobs
       set payload = payload || jsonb_build_object('canceled', true)
     where dedupe_key = any(p_dedupe_keys)
       and status = 'running'
    returning 1
  )
  select coalesce((select count(*) from deleted), 0)::integer
       + coalesce((select count(*) from marked), 0)::integer;
$$;

-- Access-scope guards. The backend uses service_role and therefore bypasses
-- RLS; these triggers are the database's hard boundary against mixed direct
-- and organization access.
create or replace function public.validate_direct_access_scope()
returns trigger
language plpgsql
set search_path = public
as $$
declare invalid_scope boolean;
begin
  case tg_table_name
    when 'project_access_grants' then
      select p.org_id is not null into invalid_scope
      from public.projects p where p.id = new.project_id for update;
    when 'chat_access_grants' then
      select c.project_id is not null into invalid_scope
      from public.chats c where c.id = new.chat_id for update;
    when 'tabular_review_access_grants' then
      select tr.project_id is not null into invalid_scope
      from public.tabular_reviews tr where tr.id = new.tabular_review_id for update;
    when 'workflow_shares' then
      select w.org_id is not null into invalid_scope
      from public.workflows w where w.id = new.workflow_id for update;
    else
      raise exception 'Unsupported direct access table';
  end case;
  if coalesce(invalid_scope, true) then
    raise exception 'Direct grants are not allowed for organization or inherited content'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger project_access_grants_scope_guard before insert or update
  on public.project_access_grants for each row
  execute procedure public.validate_direct_access_scope();
create trigger chat_access_grants_scope_guard before insert or update
  on public.chat_access_grants for each row
  execute procedure public.validate_direct_access_scope();
create trigger tabular_review_access_grants_scope_guard before insert or update
  on public.tabular_review_access_grants for each row
  execute procedure public.validate_direct_access_scope();
create trigger workflow_shares_scope_guard before insert or update
  on public.workflow_shares for each row
  execute procedure public.validate_direct_access_scope();

create or replace function public.validate_org_access_override()
returns trigger
language plpgsql
set search_path = public
as $$
declare resource_org_id uuid;
declare resource_creator_id uuid;
declare member_role text;
begin
  case tg_table_name
    when 'project_org_access_overrides' then
      select p.org_id, p.user_id into resource_org_id, resource_creator_id
      from public.projects p where p.id = new.project_id for update;
    when 'workflow_org_access_overrides' then
      select w.org_id, w.user_id into resource_org_id, resource_creator_id
      from public.workflows w where w.id = new.workflow_id for update;
    else
      raise exception 'Unsupported organization override table';
  end case;

  if resource_org_id is null or resource_org_id is distinct from new.org_id then
    raise exception 'Organization override does not match the resource organization'
      using errcode = '23514';
  end if;
  if resource_creator_id = new.user_id then
    raise exception 'The creator is always an owner'
      using errcode = '23514';
  end if;
  select m.role into member_role
  from public.org_members m
  where m.org_id = new.org_id and m.user_id = new.user_id
  for key share;
  if not found then
    raise exception 'Organization access overrides require active membership'
      using errcode = '23514';
  end if;
  if member_role = 'admin' then
    raise exception 'Organization admins always have owner access'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger project_org_access_overrides_guard before insert or update
  on public.project_org_access_overrides for each row
  execute procedure public.validate_org_access_override();
create trigger workflow_org_access_overrides_guard before insert or update
  on public.workflow_org_access_overrides for each row
  execute procedure public.validate_org_access_override();

-- An Admin's Owner access is implicit and immutable. Remove any former member
-- override when they are promoted so management UIs never present it as an
-- editable assignment.
create or replace function public.cleanup_org_admin_access_overrides()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.role = 'admin' then
    delete from public.project_org_access_overrides
    where org_id = new.org_id and user_id = new.user_id;
    delete from public.workflow_org_access_overrides
    where org_id = new.org_id and user_id = new.user_id;
  end if;
  return new;
end;
$$;

drop trigger if exists org_members_cleanup_admin_overrides on public.org_members;
create trigger org_members_cleanup_admin_overrides
  after insert or update of role on public.org_members
  for each row execute procedure public.cleanup_org_admin_access_overrides();

create or replace function public.org_member_protect_resource_ownership()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  perform 1 from public.organizations where id = old.org_id for update;
  if not found then return old; end if;

  if exists (
    select 1 from public.projects p
    where p.org_id = old.org_id
      and public.project_access_role(
        p.id, p.user_id, p.org_id, old.user_id::text, null
      ) = 'owner'
      and not exists (
        select 1 from public.org_members other_member
        where other_member.org_id = p.org_id
          and other_member.user_id <> old.user_id
          and public.project_access_role(
            p.id, p.user_id, p.org_id, other_member.user_id::text, null
          ) = 'owner'
      )
  ) then
    raise exception 'Transfer ownership of organization projects before removing this member'
      using errcode = '23514';
  end if;

  if exists (
    select 1 from public.workflows w
    where w.org_id = old.org_id
      and public.workflow_access_role(
        w.id, w.user_id, w.org_id, old.user_id::text, null
      ) = 'owner'
      and not exists (
        select 1 from public.org_members other_member
        where other_member.org_id = w.org_id
          and other_member.user_id <> old.user_id
          and public.workflow_access_role(
            w.id, w.user_id, w.org_id, other_member.user_id::text, null
          ) = 'owner'
      )
  ) then
    raise exception 'Transfer ownership of organization workflows before removing this member'
      using errcode = '23514';
  end if;
  return old;
end;
$$;

create trigger org_members_resource_owner_guard before delete
  on public.org_members for each row
  execute procedure public.org_member_protect_resource_ownership();

create or replace function public.cleanup_removed_org_member_overrides()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  delete from public.project_org_access_overrides
  where org_id = old.org_id and user_id = old.user_id;
  delete from public.workflow_org_access_overrides
  where org_id = old.org_id and user_id = old.user_id;
  return old;
end;
$$;

create trigger org_members_cleanup_access_overrides after delete
  on public.org_members for each row
  execute procedure public.cleanup_removed_org_member_overrides();

create or replace function public.sync_project_child_org_id()
returns trigger
language plpgsql
set search_path = public
as $$
declare parent_org_id uuid;
begin
  if new.project_id is null then return new; end if;
  select p.org_id into parent_org_id
  from public.projects p where p.id = new.project_id for key share;
  if not found then
    raise exception 'Project not found' using errcode = '23503';
  end if;
  new.org_id := parent_org_id;
  return new;
end;
$$;

create trigger chats_sync_project_org before insert or update of project_id, org_id
  on public.chats for each row execute procedure public.sync_project_child_org_id();
create trigger tabular_reviews_sync_project_org before insert or update of project_id, org_id
  on public.tabular_reviews for each row execute procedure public.sync_project_child_org_id();
create trigger documents_sync_project_org before insert or update of project_id, org_id
  on public.documents for each row execute procedure public.sync_project_child_org_id();

create or replace function public.cleanup_inherited_direct_grants()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_table_name = 'projects' then
    if new.org_id is not null then
      delete from public.project_access_grants where project_id = new.id;
    end if;
    delete from public.project_org_access_overrides
    where project_id = new.id and org_id is distinct from new.org_id;
  elsif tg_table_name = 'chats' then
    if new.project_id is not null then
      delete from public.chat_access_grants where chat_id = new.id;
    end if;
  elsif tg_table_name = 'tabular_reviews' then
    if new.project_id is not null then
      delete from public.tabular_review_access_grants where tabular_review_id = new.id;
    end if;
  elsif tg_table_name = 'workflows' then
    if new.org_id is not null then
      delete from public.workflow_shares where workflow_id = new.id;
    end if;
    delete from public.workflow_org_access_overrides
    where workflow_id = new.id and org_id is distinct from new.org_id;
  end if;
  return new;
end;
$$;

create trigger projects_cleanup_direct_grants after insert or update of org_id
  on public.projects for each row execute procedure public.cleanup_inherited_direct_grants();
create trigger chats_cleanup_direct_grants after insert or update of project_id, org_id
  on public.chats for each row execute procedure public.cleanup_inherited_direct_grants();
create trigger tabular_reviews_cleanup_direct_grants after insert or update of project_id, org_id
  on public.tabular_reviews for each row execute procedure public.cleanup_inherited_direct_grants();
create trigger workflows_cleanup_direct_grants after insert or update of org_id
  on public.workflows for each row execute procedure public.cleanup_inherited_direct_grants();

revoke all on public.user_profiles from anon, authenticated;
revoke all on public.organizations from anon, authenticated;
revoke all on public.org_members from anon, authenticated;
revoke all on public.org_invitations from anon, authenticated;
revoke all on public.project_access_grants from anon, authenticated;
revoke all on public.project_org_access_overrides from anon, authenticated;
revoke all on public.projects from anon, authenticated;
revoke all on public.project_subfolders from anon, authenticated;
revoke all on public.library_folders from anon, authenticated;
revoke all on public.documents from anon, authenticated;
revoke all on public.document_versions from anon, authenticated;
revoke all on public.upload_sessions from anon, authenticated;
revoke all on public.upload_session_files from anon, authenticated;
revoke all on public.upload_processing_jobs from anon, authenticated;
revoke all on public.document_edits from anon, authenticated;
revoke all on public.workflows from anon, authenticated;
revoke all on public.hidden_workflows from anon, authenticated;
revoke all on public.workflow_shares from anon, authenticated;
revoke all on public.workflow_org_access_overrides from anon, authenticated;
revoke all on public.workflow_open_source_submissions from anon, authenticated;
revoke all on public.mike_workflows from anon, authenticated;
revoke all on public.mike_workflow_assets from anon, authenticated;
revoke all on public.workflow_addons from anon, authenticated;
revoke all on public.chats from anon, authenticated;
revoke all on public.chat_access_grants from anon, authenticated;
revoke all on public.chat_messages from anon, authenticated;
revoke all on public.word_documents from anon, authenticated;
revoke all on public.word_chats from anon, authenticated;
revoke all on public.word_chat_messages from anon, authenticated;
revoke all on public.word_document_edits from anon, authenticated;
revoke all on public.tabular_reviews from anon, authenticated;
revoke all on public.tabular_review_access_grants from anon, authenticated;
revoke all on public.tabular_cells from anon, authenticated;
revoke all on public.tabular_review_rows from anon, authenticated;
revoke all on public.tabular_review_row_sources from anon, authenticated;
revoke all on public.tabular_review_chats from anon, authenticated;
revoke all on public.tabular_review_chat_messages from anon, authenticated;
revoke all on public.user_api_keys from anon, authenticated;
revoke all on public.auth_handoff_tickets from anon, authenticated;
revoke all on public.user_router_models from anon, authenticated;
revoke all on public.user_mcp_connectors from anon, authenticated;
revoke all on public.user_mcp_oauth_tokens from anon, authenticated;
revoke all on public.user_mcp_oauth_states from anon, authenticated;
revoke all on public.user_mcp_connector_tools from anon, authenticated;
revoke all on public.user_mcp_tool_audit_logs from anon, authenticated;
revoke all on public.courtlistener_citation_index from anon, authenticated;
revoke all on public.courtlistener_opinion_cluster_index from anon, authenticated;
revoke all on public.audit_events from anon, authenticated;
revoke all on public.db_jobs from anon, authenticated;
revoke all on function public.replace_mike_workflows(text, jsonb)
  from public, anon, authenticated;
revoke all on function public.install_missing_default_workflows(text)
  from public, anon, authenticated;
revoke all on function public.install_missing_default_workflows(text, jsonb)
  from public, anon, authenticated;
revoke all on function public.claim_db_jobs(integer, integer)
  from public, anon, authenticated;
revoke all on function public.claim_db_job(uuid, integer)
  from public, anon, authenticated;
revoke all on function public.cancel_db_jobs(text[])
  from public, anon, authenticated;
revoke all on function public.replace_user_router_models(uuid, text, text[])
  from public, anon, authenticated;
revoke all on function public.begin_tabular_review_generation(uuid, timestamptz, uuid, integer)
  from public, anon, authenticated;
revoke all on function public.renew_tabular_review_generation(uuid, uuid, integer)
  from public, anon, authenticated;
revoke all on function public.finish_tabular_review_generation(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.create_upload_session(uuid, uuid, text, jsonb, timestamptz, jsonb, integer)
  from public, anon, authenticated;
revoke all on function public.extend_upload_session_expiry(uuid, integer, integer)
  from public, anon, authenticated;
revoke all on function public.refresh_upload_session_status(uuid)
  from public, anon, authenticated;
revoke all on function public.queue_upload_session_file_processing(uuid, uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.claim_upload_processing_job(text, integer, integer)
  from public, anon, authenticated;

grant select, insert, update, delete
  on public.default_workflow_installations,
     public.quick_actions,
     public.mike_workflows,
     public.workflow_addons,
     public.mike_workflow_assets
  to service_role;

grant execute
  on function public.replace_mike_workflows(text, jsonb)
  to service_role;
grant execute
  on function public.install_missing_default_workflows(text)
  to service_role;
grant execute
  on function public.install_missing_default_workflows(text, jsonb)
  to service_role;
grant execute
  on function public.replace_user_router_models(uuid, text, text[])
  to service_role;
grant execute
  on function public.begin_tabular_review_generation(uuid, timestamptz, uuid, integer)
  to service_role;
grant execute
  on function public.renew_tabular_review_generation(uuid, uuid, integer)
  to service_role;
grant execute
  on function public.finish_tabular_review_generation(uuid, uuid)
  to service_role;
grant execute
  on function public.claim_db_jobs(integer, integer)
  to service_role;
grant execute
  on function public.claim_db_job(uuid, integer)
  to service_role;
grant execute
  on function public.cancel_db_jobs(text[])
  to service_role;
grant execute
  on function public.create_upload_session(uuid, uuid, text, jsonb, timestamptz, jsonb, integer)
  to service_role;
grant execute
  on function public.extend_upload_session_expiry(uuid, integer, integer)
  to service_role;
grant execute
  on function public.refresh_upload_session_status(uuid)
  to service_role;
grant execute
  on function public.queue_upload_session_file_processing(uuid, uuid, uuid)
  to service_role;
grant execute
  on function public.claim_upload_processing_job(text, integer, integer)
  to service_role;

-- Tables created by this file are owned by the database bootstrap role. The
-- backend connects as service_role, so grant it only the data privileges that
-- the direct browser roles above intentionally do not have. RLS is still
-- enabled as defense in depth; service_role bypasses it for the backend path.
--
-- NOTE: this grant targets `all tables in schema public`, so every table it
-- must cover has to already exist above this point. audit_events is therefore
-- defined *before* this block (not after it) — otherwise a fresh plain-Postgres
-- install would create the table with no service_role privileges and the
-- backend's inserts would fail permission-denied (silently, since recordAudit
-- swallows errors).
grant select, insert, update, delete
  on all tables in schema public
  to service_role;
grant usage, select
  on all sequences in schema public
  to service_role;
-- 2026-09-06: Native Google Drive integration.
--
-- First-party Drive tools that call the GA Drive REST API directly with a
-- per-user OAuth token — no dependency on Google's preview-gated MCP server.
-- One token row per user (connecting again overwrites), plus short-lived
-- OAuth state rows for the PKCE flow. Both tables are service-role only:
-- RLS is enabled with no user policies, so only the backend (service key)
-- can read the encrypted tokens.

CREATE TABLE IF NOT EXISTS public.user_google_drive_tokens (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  encrypted_access_token text,
  access_token_iv text,
  access_token_tag text,
  encrypted_refresh_token text,
  refresh_token_iv text,
  refresh_token_tag text,
  scope text,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.user_google_drive_tokens ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.google_drive_oauth_states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  state_hash text NOT NULL UNIQUE,
  encrypted_state_config text NOT NULL,
  state_config_iv text NOT NULL,
  state_config_tag text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.google_drive_oauth_states ENABLE ROW LEVEL SECURITY;

-- These two tables are created after the "Direct client grant hardening"
-- section above ran, so its per-table revokes and its one-shot
-- `grant ... on all tables in schema public to service_role` never saw them.
-- Repeat both statements here explicitly, following the same pattern as the
-- MCP OAuth tables: browser roles get nothing (the backend fronts all
-- access), service_role gets the data privileges the backend needs.
revoke all on public.user_google_drive_tokens from anon, authenticated;
revoke all on public.google_drive_oauth_states from anon, authenticated;

grant select, insert, update, delete
  on public.user_google_drive_tokens
  to service_role;
grant select, insert, update, delete
  on public.google_drive_oauth_states
  to service_role;
