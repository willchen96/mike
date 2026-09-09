-- Migration date: 2026-09-04

-- Preserve the sharing state that exists on main, then remove the three
-- superseded storage shapes. This runs after the final grant tables and
-- workflow role column exist.
--
-- Project-contained chats and reviews now inherit access exclusively from
-- their project. Only standalone reviews can retain a resource-specific
-- direct grant without broadening access to the entire project.

begin;

-- Archive for direct review shares the new model has nowhere to put. See the
-- header comment on this table in schema.sql, and the review backfill below,
-- for why they are neither converted nor discarded.
create table if not exists public.tabular_review_legacy_shares (
  id uuid primary key default gen_random_uuid(),
  -- NO foreign key, deliberately, and for the same reason project_id has
  -- none: this is a historical record of who lost access at upgrade, and it
  -- has to outlive the rows it describes. An ON DELETE CASCADE here meant
  -- deleting the review -- or the project, which cascades to its reviews --
  -- silently destroyed the only record of the recipients an operator was
  -- supposed to re-grant, which is exactly the outcome the table exists to
  -- prevent.
  tabular_review_id uuid not null,
  project_id uuid,
  email text not null,
  archived_at timestamptz not null default now(),
  unique(tabular_review_id, email),
  constraint tabular_review_legacy_shares_email_lowercase
    check (email = lower(email))
);

-- Replay-safe: `create table if not exists` above leaves an EXISTING table
-- untouched, so a deployment that applied the first cut of this migration
-- still carries the cascade. Drop it explicitly.
alter table public.tabular_review_legacy_shares
  drop constraint if exists tabular_review_legacy_shares_tabular_review_id_fkey;

create index if not exists idx_tabular_review_legacy_shares_review
  on public.tabular_review_legacy_shares(tabular_review_id);

alter table public.tabular_review_legacy_shares enable row level security;
revoke all on public.tabular_review_legacy_shares from anon, authenticated;
grant select, insert, update, delete
  on public.tabular_review_legacy_shares to service_role;

do $migration$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'projects'
      and column_name = 'shared_with'
  ) then
    -- The creator is EXCLUDED. A legacy shared_with array could contain the
    -- project owner's own address (their own invitation, echoed back), and
    -- turning that into an editor grant on their own project produces a state
    -- the API itself refuses to create: the project reads as "Shared with 1
    -- user" and the owner appears as a guest on their own matter.
    --
    -- position('@' ...) is measured on the TRIMMED value, which is the value
    -- actually inserted, and must be > 1: '@x.com' has an @ at position 1 and
    -- no local part.
    execute $sql$
      insert into public.project_access_grants (
        project_id, email, role, created_by
      )
      select distinct
        project.id,
        lower(trim(recipient.email)),
        'editor',
        project.user_id
      from public.projects project
      left join public.user_profiles creator
        on creator.user_id = project.user_id
      -- user_profiles is populated by a trigger and can be missing (a row
      -- deleted by hand, an account created before the trigger existed). With
      -- only that join, coalesce(creator.email,'') was '' for such a creator,
      -- the exclusion never matched, and they were handed an EDITOR grant on
      -- their own project -- the exact state this exclusion exists to
      -- prevent. auth.users is the authoritative address.
      left join auth.users creator_auth
        on creator_auth.id = project.user_id
      cross join lateral jsonb_array_elements_text(
        case
          when jsonb_typeof(project.shared_with) = 'array'
            then project.shared_with
          else '[]'::jsonb
        end
      ) recipient(email)
      where trim(recipient.email) <> ''
        and position('@' in trim(recipient.email)) > 1
        and lower(trim(recipient.email))
          is distinct from lower(trim(coalesce(
            creator.email, creator_auth.email, '')))
      on conflict (project_id, email) do nothing
    $sql$;
  end if;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'tabular_reviews'
      and column_name = 'shared_with'
  ) then
    -- Standalone reviews: the share becomes a real grant, same creator
    -- exclusion and same trimmed '@' test as the project backfill above.
    execute $sql$
      insert into public.tabular_review_access_grants (
        tabular_review_id, email, role, created_by
      )
      select distinct
        review.id,
        lower(trim(recipient.email)),
        'editor',
        review.user_id
      from public.tabular_reviews review
      left join public.user_profiles creator
        on creator.user_id = review.user_id
      left join auth.users creator_auth
        on creator_auth.id = review.user_id
      cross join lateral jsonb_array_elements_text(
        case
          when jsonb_typeof(review.shared_with) = 'array'
            then review.shared_with
          else '[]'::jsonb
        end
      ) recipient(email)
      where review.project_id is null
        and trim(recipient.email) <> ''
        and position('@' in trim(recipient.email)) > 1
        and lower(trim(recipient.email))
          is distinct from lower(trim(coalesce(
            creator.email, creator_auth.email, '')))
      on conflict (tabular_review_id, email) do nothing
    $sql$;
  end if;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'tabular_reviews'
      and column_name = 'shared_with'
  ) then
    -- Project-contained reviews: NOT convertible. A contained review inherits
    -- access from its project, and validate_direct_access_scope refuses a
    -- review-level grant on one, so there is no row shape that preserves
    -- "this person may see this review and nothing else in the matter".
    --
    -- Promoting these to project-level viewer grants was REJECTED: a share on
    -- one review is not consent to see the whole matter, and widening access
    -- silently during a migration is worse than losing it. Dropping the
    -- column with the recipients unrecorded was rejected too -- main honoured
    -- these shares, so people lose access at upgrade and nobody can say who
    -- they were. Archive the triples; an operator re-grants deliberately.
    execute $sql$
      insert into public.tabular_review_legacy_shares (
        tabular_review_id, project_id, email
      )
      select distinct
        review.id,
        review.project_id,
        lower(trim(recipient.email))
      from public.tabular_reviews review
      left join public.user_profiles creator
        on creator.user_id = review.user_id
      left join auth.users creator_auth
        on creator_auth.id = review.user_id
      cross join lateral jsonb_array_elements_text(
        case
          when jsonb_typeof(review.shared_with) = 'array'
            then review.shared_with
          else '[]'::jsonb
        end
      ) recipient(email)
      where review.project_id is not null
        and trim(recipient.email) <> ''
        and position('@' in trim(recipient.email)) > 1
        -- Same creator exclusion as the two backfills above. Without it the
        -- archive lists the review's own creator as somebody who lost
        -- access, and an operator "restoring" it grants the owner a guest
        -- role on their own review.
        and lower(trim(recipient.email))
          is distinct from lower(trim(coalesce(
            creator.email, creator_auth.email, '')))
      on conflict (tabular_review_id, email) do nothing
    $sql$;
  end if;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'workflow_shares'
      and column_name = 'allow_edit'
  ) then
    execute $sql$
      update public.workflow_shares
      set role = case when allow_edit then 'editor' else 'viewer' end
    $sql$;
  end if;
end;
$migration$;

-- Canonicalize workflow share recipients, the way the four sibling grant
-- tables already store them.
--
-- workflow_access_role and lib/access.ts look a recipient up by their
-- normalized (lowercased) address, while get_workflows_overview lowers both
-- sides -- so a legacy mixed-case row LISTED for its recipient and then 404'd
-- when they opened it, and re-sharing inserted a second row instead of
-- updating the first (the unique constraint is on the raw value).
--
-- Collapse first, keeping the strongest role, because the unique constraint
-- on (workflow_id, shared_with_email) cannot separate 'A@x.com' from
-- 'a@x.com' once both are lowered. Ordering by role strength means a
-- recipient never LOSES access to a workflow they could already edit.
with ranked as (
  select
    id,
    row_number() over (
      partition by workflow_id, lower(trim(shared_with_email))
      order by
        case role when 'owner' then 0 when 'editor' then 1 else 2 end,
        created_at asc,
        id asc
    ) as dup_rank
  from public.workflow_shares
)
delete from public.workflow_shares s
using ranked
where ranked.id = s.id
  and ranked.dup_rank > 1;

update public.workflow_shares
set shared_with_email = lower(trim(shared_with_email))
where shared_with_email is distinct from lower(trim(shared_with_email));

do $do$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'workflow_shares_email_lowercase'
      and conrelid = 'public.workflow_shares'::regclass
  ) then
    alter table public.workflow_shares
      add constraint workflow_shares_email_lowercase
      check (shared_with_email = lower(shared_with_email));
  end if;
end $do$;

drop index if exists public.projects_shared_with_idx;
alter table public.projects drop column if exists shared_with;

drop index if exists public.tabular_reviews_shared_with_idx;
alter table public.tabular_reviews drop column if exists shared_with;

alter table public.workflow_shares drop column if exists allow_edit;

notify pgrst, 'reload schema';

commit;
