-- Migration date: 2026-09-04

-- Direct structural transition from the schema on main to the final
-- organization and resource-access model. Legacy sharing columns remain
-- temporarily so the following data migration can preserve their recipients.
--
-- Safe to re-run. Every statement below carries its own guard, so a partial
-- application is replayed rather than repaired by hand:
--
--   * `if exists` / `if not exists` on drops, tables, columns and indexes;
--   * `create or replace` for functions (with check_function_bodies off, so
--     the order they are declared in does not matter);
--   * drop-before-create for triggers;
--   * `add constraint` behind a pg_constraint existence check.
--
-- Constraints are guarded by NAME rather than dropped and re-added, because
-- several of them are depended on: org_members_org_id_user_id_key backs the
-- composite foreign keys from both *_org_access_overrides tables, and
-- organizations_pkey backs every org_id reference in the schema. Dropping
-- those to re-add them fails on the dependency, and dropping a foreign key
-- only to re-add it re-validates the whole table for nothing.
--
-- The check is a name lookup and not an exception handler because the errors
-- are not uniform: re-adding a duplicate primary key raises
-- invalid_table_definition ("multiple primary keys ... are not allowed"),
-- not the duplicate_object a check or foreign key raises. Swallowing a code
-- that broad would also swallow real mistakes; asking whether the constraint
-- is already there answers the actual question and lets everything else fail.
--
-- The whole file is one transaction, so a failure rolls back to the state the
-- replay started from.

begin;

set local check_function_bodies = false;
DROP FUNCTION IF EXISTS public.get_chats_overview(IN p_user_id text, IN p_limit integer, IN p_offset integer);
DROP FUNCTION IF EXISTS public.get_projects_overview(IN p_user_id text, IN p_user_email text, IN p_scope text, IN p_limit integer, IN p_offset integer, IN p_search_term text, IN p_sort_key text, IN p_sort_direction text, IN p_practice text, IN p_owner_user_id text);
DROP FUNCTION IF EXISTS public.get_projects_overview(IN p_user_id text, IN p_user_email text);
DROP FUNCTION IF EXISTS public.get_tabular_reviews_overview(IN p_user_id text, IN p_user_email text, IN p_project_id text, IN p_scope text, IN p_limit integer, IN p_offset integer, IN p_search_term text, IN p_sort_key text, IN p_sort_direction text);
DROP FUNCTION IF EXISTS public.get_tabular_reviews_overview(IN p_user_id text, IN p_user_email text, IN p_project_id text);
DROP FUNCTION IF EXISTS public.get_workflows_overview(IN p_user_id text, IN p_user_email text, IN p_type text, IN p_scope text, IN p_limit integer, IN p_offset integer, IN p_search_term text, IN p_sort_key text, IN p_sort_direction text, IN p_practice text, IN p_language text, IN p_jurisdiction text);
DROP FUNCTION IF EXISTS public.get_workflows_overview(IN p_user_id text, IN p_user_email text, IN p_type text);
ALTER TABLE public.chats DROP CONSTRAINT IF EXISTS chats_user_id_fkey;
ALTER TABLE public.documents DROP CONSTRAINT IF EXISTS documents_user_id_fkey;
ALTER TABLE public.project_subfolders DROP CONSTRAINT IF EXISTS project_subfolders_user_id_fkey;
ALTER TABLE public.projects DROP CONSTRAINT IF EXISTS projects_user_id_fkey;
ALTER TABLE public.tabular_review_chats DROP CONSTRAINT IF EXISTS tabular_review_chats_user_id_fkey;
ALTER TABLE public.tabular_reviews DROP CONSTRAINT IF EXISTS tabular_reviews_user_id_fkey;
ALTER TABLE public.workflows DROP CONSTRAINT IF EXISTS workflows_user_id_fkey;
CREATE OR REPLACE FUNCTION public.chat_access_role(p_chat_id uuid, p_chat_user_id uuid, p_project_id uuid, p_org_id uuid, p_user_id text, p_user_email text)
 RETURNS text
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
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
$function$;
GRANT ALL ON FUNCTION public.chat_access_role(uuid, uuid, uuid, uuid, text, text) TO service_role;
CREATE OR REPLACE FUNCTION public.cleanup_inherited_direct_grants()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
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
$function$;
CREATE OR REPLACE FUNCTION public.cleanup_org_admin_access_overrides()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  if new.role = 'admin' then
    delete from public.project_org_access_overrides
    where org_id = new.org_id and user_id = new.user_id;
    delete from public.workflow_org_access_overrides
    where org_id = new.org_id and user_id = new.user_id;
  end if;
  return new;
end;
$function$;
CREATE OR REPLACE FUNCTION public.cleanup_removed_org_member_overrides()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  delete from public.project_org_access_overrides
  where org_id = old.org_id and user_id = old.user_id;
  delete from public.workflow_org_access_overrides
  where org_id = old.org_id and user_id = old.user_id;
  return old;
end;
$function$;
CREATE OR REPLACE FUNCTION public.get_chats_overview(p_user_id text, p_user_email text, p_limit integer DEFAULT NULL::integer, p_offset integer DEFAULT 0)
 RETURNS TABLE(id uuid, project_id uuid, user_id text, title text, model text, created_at timestamp with time zone, project_name text, is_owner boolean, access_role text)
 LANGUAGE sql
 STABLE
AS $function$
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
$function$;
CREATE OR REPLACE FUNCTION public.get_project_filter_options(p_user_id text, p_user_email text DEFAULT NULL::text)
 RETURNS TABLE(practices text[], owners jsonb)
 LANGUAGE sql
 STABLE
AS $function$
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
$function$;
CREATE OR REPLACE FUNCTION public.get_project_ids_overview(p_user_id text, p_user_email text, p_scope text, p_search_term text, p_practice text, p_owner_user_id text, p_limit integer, p_offset integer)
 RETURNS TABLE(id uuid, user_id text)
 LANGUAGE sql
 STABLE
AS $function$
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
$function$;
CREATE OR REPLACE FUNCTION public.get_project_summaries(p_user_id text, p_user_email text, p_limit integer, p_offset integer)
 RETURNS TABLE(id uuid, user_id text, name text, created_at timestamp with time zone, updated_at timestamp with time zone, is_owner boolean)
 LANGUAGE sql
 STABLE
AS $function$
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
$function$;
CREATE OR REPLACE FUNCTION public.get_projects_overview(p_user_id text, p_user_email text, p_scope text, p_limit integer, p_offset integer, p_search_term text, p_sort_key text, p_sort_direction text, p_practice text, p_owner_user_id text)
 RETURNS TABLE(id uuid, user_id text, org_id uuid, access_scope text, organization_name text, name text, cm_number text, practice text, created_at timestamp with time zone, updated_at timestamp with time zone, is_owner boolean, owner_display_name text, owner_email text, access_role text, document_count integer, chat_count integer, review_count integer)
 LANGUAGE sql
 STABLE
AS $function$
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
$function$;
CREATE OR REPLACE FUNCTION public.get_projects_overview(p_user_id text, p_user_email text DEFAULT NULL::text)
 RETURNS TABLE(id uuid, user_id text, org_id uuid, access_scope text, organization_name text, name text, cm_number text, practice text, created_at timestamp with time zone, updated_at timestamp with time zone, is_owner boolean, owner_display_name text, owner_email text, access_role text, document_count integer, chat_count integer, review_count integer)
 LANGUAGE sql
 STABLE
AS $function$
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
$function$;
CREATE OR REPLACE FUNCTION public.get_tabular_review_ids_overview(p_user_id text, p_user_email text, p_project_id text, p_scope text, p_search_term text, p_limit integer, p_offset integer)
 RETURNS TABLE(id uuid, user_id text)
 LANGUAGE sql
 STABLE
AS $function$
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
$function$;
CREATE OR REPLACE FUNCTION public.get_tabular_reviews_overview(p_user_id text, p_user_email text, p_project_id text, p_scope text, p_limit integer, p_offset integer, p_search_term text, p_sort_key text, p_sort_direction text)
 RETURNS TABLE(id uuid, project_id uuid, user_id text, title text, columns_config jsonb, document_ids jsonb, workflow_id uuid, created_at timestamp with time zone, updated_at timestamp with time zone, is_owner boolean, access_role text, document_count integer)
 LANGUAGE sql
 STABLE
AS $function$
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
$function$;
CREATE OR REPLACE FUNCTION public.get_tabular_reviews_overview(p_user_id text, p_user_email text DEFAULT NULL::text, p_project_id text DEFAULT NULL::text)
 RETURNS TABLE(id uuid, project_id uuid, user_id text, title text, columns_config jsonb, document_ids jsonb, workflow_id uuid, created_at timestamp with time zone, updated_at timestamp with time zone, is_owner boolean, access_role text, document_count integer)
 LANGUAGE sql
 STABLE
AS $function$
  select *
  from public.get_tabular_reviews_overview(
    p_user_id, p_user_email, p_project_id, 'all', 2147483647, 0,
    null, 'created', 'desc'
  );
$function$;
CREATE OR REPLACE FUNCTION public.get_workflow_filter_options(p_user_id text, p_user_email text DEFAULT NULL::text, p_type text DEFAULT NULL::text, p_scope text DEFAULT 'all'::text)
 RETURNS TABLE(practices text[], languages text[], jurisdictions text[])
 LANGUAGE sql
 STABLE
AS $function$
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
    -- Same org-membership arm as get_workflows_overview. The `shared` arm
    -- above takes only org_id IS NULL workflows and this one only org_id IS
    -- NOT NULL, so the two are disjoint by construction and a row visible via
    -- both routes still contributes its options exactly once -- no dedup
    -- predicate is needed. Tagged 'shared' to match the overview's scope
    -- bucketing.
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
$function$;
CREATE OR REPLACE FUNCTION public.get_workflow_ids_overview(p_user_id text, p_user_email text, p_type text, p_scope text, p_search_term text, p_practice text, p_language text, p_jurisdiction text, p_limit integer, p_offset integer)
 RETURNS TABLE(id uuid, user_id text)
 LANGUAGE sql
 STABLE
AS $function$
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
$function$;
CREATE OR REPLACE FUNCTION public.get_workflows_overview(p_user_id text, p_user_email text, p_type text, p_scope text, p_limit integer, p_offset integer, p_search_term text, p_sort_key text, p_sort_direction text, p_practice text, p_language text, p_jurisdiction text)
 RETURNS TABLE(id uuid, user_id text, org_id uuid, access_scope text, organization_name text, title text, type text, prompt_md text, columns_config jsonb, language text, practice text, jurisdictions text[], is_system boolean, created_at timestamp with time zone, allow_edit boolean, is_owner boolean, shared_by_name text)
 LANGUAGE sql
 STABLE
AS $function$
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
$function$;
CREATE OR REPLACE FUNCTION public.get_workflows_overview(p_user_id text, p_user_email text DEFAULT NULL::text, p_type text DEFAULT NULL::text)
 RETURNS TABLE(id uuid, user_id text, org_id uuid, access_scope text, organization_name text, title text, type text, prompt_md text, columns_config jsonb, language text, practice text, jurisdictions text[], is_system boolean, created_at timestamp with time zone, allow_edit boolean, is_owner boolean, shared_by_name text)
 LANGUAGE sql
 STABLE
AS $function$
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
$function$;
CREATE OR REPLACE FUNCTION public.org_member_protect_resource_ownership()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
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
$function$;
CREATE OR REPLACE FUNCTION public.org_members_protect_last_admin()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$;
CREATE OR REPLACE FUNCTION public.project_access_role(p_project_id uuid, p_project_user_id uuid, p_org_id uuid, p_user_id text, p_user_email text)
 RETURNS text
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
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
$function$;
GRANT ALL ON FUNCTION public.project_access_role(uuid, uuid, uuid, text, text) TO service_role;
CREATE OR REPLACE FUNCTION public.review_access_role(p_review_id uuid, p_review_user_id uuid, p_project_id uuid, p_org_id uuid, p_user_id text, p_user_email text)
 RETURNS text
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
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
$function$;
GRANT ALL ON FUNCTION public.review_access_role(uuid, uuid, uuid, uuid, text, text) TO service_role;
CREATE OR REPLACE FUNCTION public.sync_project_child_org_id()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
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
$function$;
CREATE OR REPLACE FUNCTION public.validate_direct_access_scope()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
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
$function$;
CREATE OR REPLACE FUNCTION public.validate_org_access_override()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
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
$function$;
CREATE OR REPLACE FUNCTION public.workflow_access_role(p_workflow_id uuid, p_workflow_user_id uuid, p_org_id uuid, p_user_id text, p_user_email text)
 RETURNS text
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
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
      -- BOTH sides lowered. get_workflows_overview lists a share with
      -- lower() on both, so a legacy mixed-case row listed for its recipient
      -- and then 404'd the moment they opened it (and re-sharing produced a
      -- second row rather than updating the first). The 02 migration
      -- normalizes the stored values and adds a lowercase CHECK; this stays
      -- symmetrical with the overview regardless.
      select s.role from public.workflow_shares s
      where s.workflow_id = p_workflow_id
        and coalesce(p_user_email, '') <> ''
        and lower(s.shared_with_email) = lower(p_user_email)
      limit 1
    )
  end;
$function$;
GRANT ALL ON FUNCTION public.workflow_access_role(uuid, uuid, uuid, text, text) TO service_role;
ALTER TABLE public.chats ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE public.documents ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE public.project_subfolders ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE public.projects ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE public.tabular_review_chats ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE public.tabular_reviews ALTER COLUMN user_id DROP NOT NULL;
CREATE TABLE IF NOT EXISTS public.chat_access_grants (id uuid DEFAULT gen_random_uuid() NOT NULL, chat_id uuid NOT NULL, email text NOT NULL, role text DEFAULT 'editor'::text NOT NULL, created_by uuid, created_at timestamp with time zone DEFAULT now() NOT NULL, updated_at timestamp with time zone DEFAULT now() NOT NULL);
ALTER TABLE public.chat_access_grants ENABLE ROW LEVEL SECURITY;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chat_access_grants_chat_id_email_key' AND conrelid = 'public.chat_access_grants'::regclass) THEN
    ALTER TABLE public.chat_access_grants ADD CONSTRAINT chat_access_grants_chat_id_email_key UNIQUE (chat_id, email);
  END IF;
END $do$;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chat_access_grants_chat_id_fkey' AND conrelid = 'public.chat_access_grants'::regclass) THEN
    ALTER TABLE public.chat_access_grants ADD CONSTRAINT chat_access_grants_chat_id_fkey FOREIGN KEY (chat_id) REFERENCES public.chats(id) ON DELETE CASCADE;
  END IF;
END $do$;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chat_access_grants_created_by_fkey' AND conrelid = 'public.chat_access_grants'::regclass) THEN
    ALTER TABLE public.chat_access_grants ADD CONSTRAINT chat_access_grants_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;
END $do$;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chat_access_grants_email_lowercase' AND conrelid = 'public.chat_access_grants'::regclass) THEN
    ALTER TABLE public.chat_access_grants ADD CONSTRAINT chat_access_grants_email_lowercase CHECK (email = lower(email));
  END IF;
END $do$;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chat_access_grants_pkey' AND conrelid = 'public.chat_access_grants'::regclass) THEN
    ALTER TABLE public.chat_access_grants ADD CONSTRAINT chat_access_grants_pkey PRIMARY KEY (id);
  END IF;
END $do$;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chat_access_grants_role_check' AND conrelid = 'public.chat_access_grants'::regclass) THEN
    ALTER TABLE public.chat_access_grants ADD CONSTRAINT chat_access_grants_role_check CHECK (role = ANY (ARRAY['owner'::text, 'editor'::text, 'viewer'::text]));
  END IF;
END $do$;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.chat_access_grants TO service_role;
CREATE INDEX IF NOT EXISTS idx_chat_access_grants_email ON public.chat_access_grants (email);
CREATE INDEX IF NOT EXISTS idx_chat_access_grants_chat ON public.chat_access_grants (chat_id);
DROP TRIGGER IF EXISTS chat_access_grants_scope_guard ON public.chat_access_grants;
CREATE TRIGGER chat_access_grants_scope_guard BEFORE INSERT OR UPDATE ON public.chat_access_grants FOR EACH ROW EXECUTE FUNCTION public.validate_direct_access_scope();
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chats_user_id_fkey' AND conrelid = 'public.chats'::regclass) THEN
    ALTER TABLE public.chats ADD CONSTRAINT chats_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;
END $do$;
ALTER TABLE public.chats ADD COLUMN IF NOT EXISTS org_id uuid;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chats_org_requires_project' AND conrelid = 'public.chats'::regclass) THEN
    ALTER TABLE public.chats ADD CONSTRAINT chats_org_requires_project CHECK (org_id IS NULL OR project_id IS NOT NULL);
  END IF;
END $do$;
CREATE INDEX IF NOT EXISTS idx_chats_org ON public.chats (org_id);
DROP TRIGGER IF EXISTS chats_cleanup_direct_grants ON public.chats;
CREATE TRIGGER chats_cleanup_direct_grants AFTER INSERT OR UPDATE OF project_id, org_id ON public.chats FOR EACH ROW EXECUTE FUNCTION public.cleanup_inherited_direct_grants();
DROP TRIGGER IF EXISTS chats_sync_project_org ON public.chats;
CREATE TRIGGER chats_sync_project_org BEFORE INSERT OR UPDATE OF project_id, org_id ON public.chats FOR EACH ROW EXECUTE FUNCTION public.sync_project_child_org_id();
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'documents_user_id_fkey' AND conrelid = 'public.documents'::regclass) THEN
    ALTER TABLE public.documents ADD CONSTRAINT documents_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;
END $do$;
ALTER TABLE public.documents ADD COLUMN IF NOT EXISTS org_id uuid;
CREATE INDEX IF NOT EXISTS idx_documents_org ON public.documents (org_id);
DROP TRIGGER IF EXISTS documents_sync_project_org ON public.documents;
CREATE TRIGGER documents_sync_project_org BEFORE INSERT OR UPDATE OF project_id, org_id ON public.documents FOR EACH ROW EXECUTE FUNCTION public.sync_project_child_org_id();
CREATE TABLE IF NOT EXISTS public.org_invitations (id uuid DEFAULT gen_random_uuid() NOT NULL, org_id uuid NOT NULL, email text NOT NULL, role text DEFAULT 'member'::text NOT NULL, invited_by uuid, status text DEFAULT 'pending'::text NOT NULL, expires_at timestamp with time zone DEFAULT (now() + '14 days'::interval) NOT NULL, created_at timestamp with time zone DEFAULT now() NOT NULL, accepted_at timestamp with time zone, declined_at timestamp with time zone, cancelled_at timestamp with time zone);
ALTER TABLE public.org_invitations ENABLE ROW LEVEL SECURITY;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'org_invitations_email_lowercase' AND conrelid = 'public.org_invitations'::regclass) THEN
    ALTER TABLE public.org_invitations ADD CONSTRAINT org_invitations_email_lowercase CHECK (email = lower(email));
  END IF;
END $do$;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'org_invitations_invited_by_fkey' AND conrelid = 'public.org_invitations'::regclass) THEN
    ALTER TABLE public.org_invitations ADD CONSTRAINT org_invitations_invited_by_fkey FOREIGN KEY (invited_by) REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;
END $do$;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'org_invitations_pkey' AND conrelid = 'public.org_invitations'::regclass) THEN
    ALTER TABLE public.org_invitations ADD CONSTRAINT org_invitations_pkey PRIMARY KEY (id);
  END IF;
END $do$;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'org_invitations_role_check' AND conrelid = 'public.org_invitations'::regclass) THEN
    ALTER TABLE public.org_invitations ADD CONSTRAINT org_invitations_role_check CHECK (role = ANY (ARRAY['admin'::text, 'member'::text]));
  END IF;
END $do$;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'org_invitations_status_check' AND conrelid = 'public.org_invitations'::regclass) THEN
    ALTER TABLE public.org_invitations ADD CONSTRAINT org_invitations_status_check CHECK (status = ANY (ARRAY['pending'::text, 'accepted'::text, 'declined'::text, 'cancelled'::text, 'expired'::text]));
  END IF;
END $do$;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.org_invitations TO service_role;
CREATE INDEX IF NOT EXISTS idx_org_invitations_org ON public.org_invitations (org_id);
CREATE INDEX IF NOT EXISTS idx_org_invitations_email ON public.org_invitations (email) WHERE status = 'pending'::text;
CREATE UNIQUE INDEX IF NOT EXISTS org_invitations_active_unique ON public.org_invitations (org_id, email) WHERE status = 'pending'::text;
CREATE TABLE IF NOT EXISTS public.org_members (id uuid DEFAULT gen_random_uuid() NOT NULL, org_id uuid NOT NULL, user_id uuid NOT NULL, role text DEFAULT 'member'::text NOT NULL, created_at timestamp with time zone DEFAULT now() NOT NULL, updated_at timestamp with time zone DEFAULT now() NOT NULL);
ALTER TABLE public.org_members ENABLE ROW LEVEL SECURITY;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'org_members_org_id_user_id_key' AND conrelid = 'public.org_members'::regclass) THEN
    ALTER TABLE public.org_members ADD CONSTRAINT org_members_org_id_user_id_key UNIQUE (org_id, user_id);
  END IF;
END $do$;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'org_members_pkey' AND conrelid = 'public.org_members'::regclass) THEN
    ALTER TABLE public.org_members ADD CONSTRAINT org_members_pkey PRIMARY KEY (id);
  END IF;
END $do$;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'org_members_role_check' AND conrelid = 'public.org_members'::regclass) THEN
    ALTER TABLE public.org_members ADD CONSTRAINT org_members_role_check CHECK (role = ANY (ARRAY['admin'::text, 'member'::text]));
  END IF;
END $do$;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'org_members_user_id_fkey' AND conrelid = 'public.org_members'::regclass) THEN
    ALTER TABLE public.org_members ADD CONSTRAINT org_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
  END IF;
END $do$;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.org_members TO service_role;
CREATE INDEX IF NOT EXISTS idx_org_members_org ON public.org_members (org_id);
CREATE INDEX IF NOT EXISTS idx_org_members_user ON public.org_members (user_id);
DROP TRIGGER IF EXISTS org_members_cleanup_access_overrides ON public.org_members;
CREATE TRIGGER org_members_cleanup_access_overrides AFTER DELETE ON public.org_members FOR EACH ROW EXECUTE FUNCTION public.cleanup_removed_org_member_overrides();
DROP TRIGGER IF EXISTS org_members_cleanup_admin_overrides ON public.org_members;
CREATE TRIGGER org_members_cleanup_admin_overrides AFTER INSERT OR UPDATE OF role ON public.org_members FOR EACH ROW EXECUTE FUNCTION public.cleanup_org_admin_access_overrides();
DROP TRIGGER IF EXISTS org_members_last_admin_guard ON public.org_members;
CREATE TRIGGER org_members_last_admin_guard BEFORE DELETE OR UPDATE OF role ON public.org_members FOR EACH ROW EXECUTE FUNCTION public.org_members_protect_last_admin();
DROP TRIGGER IF EXISTS org_members_resource_owner_guard ON public.org_members;
CREATE TRIGGER org_members_resource_owner_guard BEFORE DELETE ON public.org_members FOR EACH ROW EXECUTE FUNCTION public.org_member_protect_resource_ownership();
CREATE TABLE IF NOT EXISTS public.organizations (id uuid DEFAULT gen_random_uuid() NOT NULL, name text NOT NULL, created_by uuid, created_at timestamp with time zone DEFAULT now() NOT NULL, updated_at timestamp with time zone DEFAULT now() NOT NULL);
ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'organizations_created_by_fkey' AND conrelid = 'public.organizations'::regclass) THEN
    ALTER TABLE public.organizations ADD CONSTRAINT organizations_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;
END $do$;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'organizations_pkey' AND conrelid = 'public.organizations'::regclass) THEN
    ALTER TABLE public.organizations ADD CONSTRAINT organizations_pkey PRIMARY KEY (id);
  END IF;
END $do$;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chats_org_id_fkey' AND conrelid = 'public.chats'::regclass) THEN
    ALTER TABLE public.chats ADD CONSTRAINT chats_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE RESTRICT;
  END IF;
END $do$;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'documents_org_id_fkey' AND conrelid = 'public.documents'::regclass) THEN
    ALTER TABLE public.documents ADD CONSTRAINT documents_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE RESTRICT;
  END IF;
END $do$;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'org_invitations_org_id_fkey' AND conrelid = 'public.org_invitations'::regclass) THEN
    ALTER TABLE public.org_invitations ADD CONSTRAINT org_invitations_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
  END IF;
END $do$;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'org_members_org_id_fkey' AND conrelid = 'public.org_members'::regclass) THEN
    ALTER TABLE public.org_members ADD CONSTRAINT org_members_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
  END IF;
END $do$;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.organizations TO service_role;
CREATE TABLE IF NOT EXISTS public.project_access_grants (id uuid DEFAULT gen_random_uuid() NOT NULL, project_id uuid NOT NULL, email text NOT NULL, role text DEFAULT 'editor'::text NOT NULL, created_by uuid, created_at timestamp with time zone DEFAULT now() NOT NULL, updated_at timestamp with time zone DEFAULT now() NOT NULL);
ALTER TABLE public.project_access_grants ENABLE ROW LEVEL SECURITY;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'project_access_grants_created_by_fkey' AND conrelid = 'public.project_access_grants'::regclass) THEN
    ALTER TABLE public.project_access_grants ADD CONSTRAINT project_access_grants_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;
END $do$;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'project_access_grants_email_lowercase' AND conrelid = 'public.project_access_grants'::regclass) THEN
    ALTER TABLE public.project_access_grants ADD CONSTRAINT project_access_grants_email_lowercase CHECK (email = lower(email));
  END IF;
END $do$;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'project_access_grants_pkey' AND conrelid = 'public.project_access_grants'::regclass) THEN
    ALTER TABLE public.project_access_grants ADD CONSTRAINT project_access_grants_pkey PRIMARY KEY (id);
  END IF;
END $do$;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'project_access_grants_project_id_email_key' AND conrelid = 'public.project_access_grants'::regclass) THEN
    ALTER TABLE public.project_access_grants ADD CONSTRAINT project_access_grants_project_id_email_key UNIQUE (project_id, email);
  END IF;
END $do$;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'project_access_grants_project_id_fkey' AND conrelid = 'public.project_access_grants'::regclass) THEN
    ALTER TABLE public.project_access_grants ADD CONSTRAINT project_access_grants_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;
  END IF;
END $do$;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'project_access_grants_role_check' AND conrelid = 'public.project_access_grants'::regclass) THEN
    ALTER TABLE public.project_access_grants ADD CONSTRAINT project_access_grants_role_check CHECK (role = ANY (ARRAY['owner'::text, 'editor'::text, 'viewer'::text]));
  END IF;
END $do$;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.project_access_grants TO service_role;
CREATE INDEX IF NOT EXISTS idx_project_access_grants_email ON public.project_access_grants (email);
CREATE INDEX IF NOT EXISTS idx_project_access_grants_project ON public.project_access_grants (project_id);
DROP TRIGGER IF EXISTS project_access_grants_scope_guard ON public.project_access_grants;
CREATE TRIGGER project_access_grants_scope_guard BEFORE INSERT OR UPDATE ON public.project_access_grants FOR EACH ROW EXECUTE FUNCTION public.validate_direct_access_scope();
CREATE TABLE IF NOT EXISTS public.project_org_access_overrides (id uuid DEFAULT gen_random_uuid() NOT NULL, project_id uuid NOT NULL, org_id uuid NOT NULL, user_id uuid NOT NULL, role text NOT NULL, assigned_by uuid, created_at timestamp with time zone DEFAULT now() NOT NULL, updated_at timestamp with time zone DEFAULT now() NOT NULL);
ALTER TABLE public.project_org_access_overrides ENABLE ROW LEVEL SECURITY;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'project_org_access_overrides_assigned_by_fkey' AND conrelid = 'public.project_org_access_overrides'::regclass) THEN
    ALTER TABLE public.project_org_access_overrides ADD CONSTRAINT project_org_access_overrides_assigned_by_fkey FOREIGN KEY (assigned_by) REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;
END $do$;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'project_org_access_overrides_org_id_fkey' AND conrelid = 'public.project_org_access_overrides'::regclass) THEN
    ALTER TABLE public.project_org_access_overrides ADD CONSTRAINT project_org_access_overrides_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
  END IF;
END $do$;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'project_org_access_overrides_org_id_user_id_fkey' AND conrelid = 'public.project_org_access_overrides'::regclass) THEN
    ALTER TABLE public.project_org_access_overrides ADD CONSTRAINT project_org_access_overrides_org_id_user_id_fkey FOREIGN KEY (org_id, user_id) REFERENCES public.org_members(org_id, user_id) ON DELETE CASCADE;
  END IF;
END $do$;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'project_org_access_overrides_pkey' AND conrelid = 'public.project_org_access_overrides'::regclass) THEN
    ALTER TABLE public.project_org_access_overrides ADD CONSTRAINT project_org_access_overrides_pkey PRIMARY KEY (id);
  END IF;
END $do$;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'project_org_access_overrides_project_id_fkey' AND conrelid = 'public.project_org_access_overrides'::regclass) THEN
    ALTER TABLE public.project_org_access_overrides ADD CONSTRAINT project_org_access_overrides_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;
  END IF;
END $do$;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'project_org_access_overrides_project_id_user_id_key' AND conrelid = 'public.project_org_access_overrides'::regclass) THEN
    ALTER TABLE public.project_org_access_overrides ADD CONSTRAINT project_org_access_overrides_project_id_user_id_key UNIQUE (project_id, user_id);
  END IF;
END $do$;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'project_org_access_overrides_role_check' AND conrelid = 'public.project_org_access_overrides'::regclass) THEN
    ALTER TABLE public.project_org_access_overrides ADD CONSTRAINT project_org_access_overrides_role_check CHECK (role = ANY (ARRAY['owner'::text, 'editor'::text, 'viewer'::text, 'deny'::text]));
  END IF;
END $do$;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.project_org_access_overrides TO service_role;
CREATE INDEX IF NOT EXISTS idx_project_org_access_overrides_user ON public.project_org_access_overrides (user_id);
DROP TRIGGER IF EXISTS project_org_access_overrides_guard ON public.project_org_access_overrides;
CREATE TRIGGER project_org_access_overrides_guard BEFORE INSERT OR UPDATE ON public.project_org_access_overrides FOR EACH ROW EXECUTE FUNCTION public.validate_org_access_override();
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'project_subfolders_user_id_fkey' AND conrelid = 'public.project_subfolders'::regclass) THEN
    ALTER TABLE public.project_subfolders ADD CONSTRAINT project_subfolders_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;
END $do$;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'projects_user_id_fkey' AND conrelid = 'public.projects'::regclass) THEN
    ALTER TABLE public.projects ADD CONSTRAINT projects_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;
END $do$;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS org_id uuid;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'projects_org_id_fkey' AND conrelid = 'public.projects'::regclass) THEN
    ALTER TABLE public.projects ADD CONSTRAINT projects_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE RESTRICT;
  END IF;
END $do$;
CREATE INDEX IF NOT EXISTS idx_projects_org ON public.projects (org_id);
DROP TRIGGER IF EXISTS projects_cleanup_direct_grants ON public.projects;
CREATE TRIGGER projects_cleanup_direct_grants AFTER INSERT OR UPDATE OF org_id ON public.projects FOR EACH ROW EXECUTE FUNCTION public.cleanup_inherited_direct_grants();
CREATE TABLE IF NOT EXISTS public.tabular_review_access_grants (id uuid DEFAULT gen_random_uuid() NOT NULL, tabular_review_id uuid NOT NULL, email text NOT NULL, role text DEFAULT 'editor'::text NOT NULL, created_by uuid, created_at timestamp with time zone DEFAULT now() NOT NULL, updated_at timestamp with time zone DEFAULT now() NOT NULL);
ALTER TABLE public.tabular_review_access_grants ENABLE ROW LEVEL SECURITY;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tabular_review_access_grants_created_by_fkey' AND conrelid = 'public.tabular_review_access_grants'::regclass) THEN
    ALTER TABLE public.tabular_review_access_grants ADD CONSTRAINT tabular_review_access_grants_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;
END $do$;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tabular_review_access_grants_email_lowercase' AND conrelid = 'public.tabular_review_access_grants'::regclass) THEN
    ALTER TABLE public.tabular_review_access_grants ADD CONSTRAINT tabular_review_access_grants_email_lowercase CHECK (email = lower(email));
  END IF;
END $do$;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tabular_review_access_grants_pkey' AND conrelid = 'public.tabular_review_access_grants'::regclass) THEN
    ALTER TABLE public.tabular_review_access_grants ADD CONSTRAINT tabular_review_access_grants_pkey PRIMARY KEY (id);
  END IF;
END $do$;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tabular_review_access_grants_role_check' AND conrelid = 'public.tabular_review_access_grants'::regclass) THEN
    ALTER TABLE public.tabular_review_access_grants ADD CONSTRAINT tabular_review_access_grants_role_check CHECK (role = ANY (ARRAY['owner'::text, 'editor'::text, 'viewer'::text]));
  END IF;
END $do$;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tabular_review_access_grants_tabular_review_id_email_key' AND conrelid = 'public.tabular_review_access_grants'::regclass) THEN
    ALTER TABLE public.tabular_review_access_grants ADD CONSTRAINT tabular_review_access_grants_tabular_review_id_email_key UNIQUE (tabular_review_id, email);
  END IF;
END $do$;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tabular_review_access_grants_tabular_review_id_fkey' AND conrelid = 'public.tabular_review_access_grants'::regclass) THEN
    ALTER TABLE public.tabular_review_access_grants ADD CONSTRAINT tabular_review_access_grants_tabular_review_id_fkey FOREIGN KEY (tabular_review_id) REFERENCES public.tabular_reviews(id) ON DELETE CASCADE;
  END IF;
END $do$;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.tabular_review_access_grants TO service_role;
CREATE INDEX IF NOT EXISTS idx_tabular_review_access_grants_review ON public.tabular_review_access_grants (tabular_review_id);
CREATE INDEX IF NOT EXISTS idx_tabular_review_access_grants_email ON public.tabular_review_access_grants (email);
DROP TRIGGER IF EXISTS tabular_review_access_grants_scope_guard ON public.tabular_review_access_grants;
CREATE TRIGGER tabular_review_access_grants_scope_guard BEFORE INSERT OR UPDATE ON public.tabular_review_access_grants FOR EACH ROW EXECUTE FUNCTION public.validate_direct_access_scope();
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tabular_review_chats_user_id_fkey' AND conrelid = 'public.tabular_review_chats'::regclass) THEN
    ALTER TABLE public.tabular_review_chats ADD CONSTRAINT tabular_review_chats_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;
END $do$;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tabular_reviews_user_id_fkey' AND conrelid = 'public.tabular_reviews'::regclass) THEN
    ALTER TABLE public.tabular_reviews ADD CONSTRAINT tabular_reviews_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;
END $do$;
ALTER TABLE public.tabular_reviews ADD COLUMN IF NOT EXISTS org_id uuid;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tabular_reviews_org_id_fkey' AND conrelid = 'public.tabular_reviews'::regclass) THEN
    ALTER TABLE public.tabular_reviews ADD CONSTRAINT tabular_reviews_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE RESTRICT;
  END IF;
END $do$;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tabular_reviews_org_requires_project' AND conrelid = 'public.tabular_reviews'::regclass) THEN
    ALTER TABLE public.tabular_reviews ADD CONSTRAINT tabular_reviews_org_requires_project CHECK (org_id IS NULL OR project_id IS NOT NULL);
  END IF;
END $do$;
CREATE INDEX IF NOT EXISTS idx_tabular_reviews_org ON public.tabular_reviews (org_id);
DROP TRIGGER IF EXISTS tabular_reviews_cleanup_direct_grants ON public.tabular_reviews;
CREATE TRIGGER tabular_reviews_cleanup_direct_grants AFTER INSERT OR UPDATE OF project_id, org_id ON public.tabular_reviews FOR EACH ROW EXECUTE FUNCTION public.cleanup_inherited_direct_grants();
DROP TRIGGER IF EXISTS tabular_reviews_sync_project_org ON public.tabular_reviews;
CREATE TRIGGER tabular_reviews_sync_project_org BEFORE INSERT OR UPDATE OF project_id, org_id ON public.tabular_reviews FOR EACH ROW EXECUTE FUNCTION public.sync_project_child_org_id();
CREATE TABLE IF NOT EXISTS public.workflow_org_access_overrides (id uuid DEFAULT gen_random_uuid() NOT NULL, workflow_id uuid NOT NULL, org_id uuid NOT NULL, user_id uuid NOT NULL, role text NOT NULL, assigned_by uuid, created_at timestamp with time zone DEFAULT now() NOT NULL, updated_at timestamp with time zone DEFAULT now() NOT NULL);
ALTER TABLE public.workflow_org_access_overrides ENABLE ROW LEVEL SECURITY;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflow_org_access_overrides_assigned_by_fkey' AND conrelid = 'public.workflow_org_access_overrides'::regclass) THEN
    ALTER TABLE public.workflow_org_access_overrides ADD CONSTRAINT workflow_org_access_overrides_assigned_by_fkey FOREIGN KEY (assigned_by) REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;
END $do$;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflow_org_access_overrides_org_id_fkey' AND conrelid = 'public.workflow_org_access_overrides'::regclass) THEN
    ALTER TABLE public.workflow_org_access_overrides ADD CONSTRAINT workflow_org_access_overrides_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
  END IF;
END $do$;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflow_org_access_overrides_org_id_user_id_fkey' AND conrelid = 'public.workflow_org_access_overrides'::regclass) THEN
    ALTER TABLE public.workflow_org_access_overrides ADD CONSTRAINT workflow_org_access_overrides_org_id_user_id_fkey FOREIGN KEY (org_id, user_id) REFERENCES public.org_members(org_id, user_id) ON DELETE CASCADE;
  END IF;
END $do$;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflow_org_access_overrides_pkey' AND conrelid = 'public.workflow_org_access_overrides'::regclass) THEN
    ALTER TABLE public.workflow_org_access_overrides ADD CONSTRAINT workflow_org_access_overrides_pkey PRIMARY KEY (id);
  END IF;
END $do$;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflow_org_access_overrides_role_check' AND conrelid = 'public.workflow_org_access_overrides'::regclass) THEN
    ALTER TABLE public.workflow_org_access_overrides ADD CONSTRAINT workflow_org_access_overrides_role_check CHECK (role = ANY (ARRAY['owner'::text, 'editor'::text, 'viewer'::text, 'deny'::text]));
  END IF;
END $do$;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflow_org_access_overrides_workflow_id_fkey' AND conrelid = 'public.workflow_org_access_overrides'::regclass) THEN
    ALTER TABLE public.workflow_org_access_overrides ADD CONSTRAINT workflow_org_access_overrides_workflow_id_fkey FOREIGN KEY (workflow_id) REFERENCES public.workflows(id) ON DELETE CASCADE;
  END IF;
END $do$;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflow_org_access_overrides_workflow_id_user_id_key' AND conrelid = 'public.workflow_org_access_overrides'::regclass) THEN
    ALTER TABLE public.workflow_org_access_overrides ADD CONSTRAINT workflow_org_access_overrides_workflow_id_user_id_key UNIQUE (workflow_id, user_id);
  END IF;
END $do$;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.workflow_org_access_overrides TO service_role;
CREATE INDEX IF NOT EXISTS idx_workflow_org_access_overrides_user ON public.workflow_org_access_overrides (user_id);
DROP TRIGGER IF EXISTS workflow_org_access_overrides_guard ON public.workflow_org_access_overrides;
CREATE TRIGGER workflow_org_access_overrides_guard BEFORE INSERT OR UPDATE ON public.workflow_org_access_overrides FOR EACH ROW EXECUTE FUNCTION public.validate_org_access_override();
ALTER TABLE public.workflow_shares ADD COLUMN IF NOT EXISTS role text DEFAULT 'viewer'::text NOT NULL;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflow_shares_role_check' AND conrelid = 'public.workflow_shares'::regclass) THEN
    ALTER TABLE public.workflow_shares ADD CONSTRAINT workflow_shares_role_check CHECK (role = ANY (ARRAY['owner'::text, 'editor'::text, 'viewer'::text]));
  END IF;
END $do$;
DROP TRIGGER IF EXISTS workflow_shares_scope_guard ON public.workflow_shares;
CREATE TRIGGER workflow_shares_scope_guard BEFORE INSERT OR UPDATE ON public.workflow_shares FOR EACH ROW EXECUTE FUNCTION public.validate_direct_access_scope();
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflows_user_id_fkey' AND conrelid = 'public.workflows'::regclass) THEN
    ALTER TABLE public.workflows ADD CONSTRAINT workflows_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;
END $do$;
ALTER TABLE public.workflows ADD COLUMN IF NOT EXISTS org_id uuid;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflows_org_id_fkey' AND conrelid = 'public.workflows'::regclass) THEN
    ALTER TABLE public.workflows ADD CONSTRAINT workflows_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE RESTRICT;
  END IF;
END $do$;
CREATE INDEX IF NOT EXISTS idx_workflows_org ON public.workflows (org_id);
DROP TRIGGER IF EXISTS workflows_cleanup_direct_grants ON public.workflows;
CREATE TRIGGER workflows_cleanup_direct_grants AFTER INSERT OR UPDATE OF org_id ON public.workflows FOR EACH ROW EXECUTE FUNCTION public.cleanup_inherited_direct_grants();

-- Every new table is service-role only, like every other table in this
-- schema: the API is the only thing that reads them, and RLS ENABLE with no
-- policy is not by itself a grant boundary — `anon` and `authenticated`
-- inherit table privileges from PUBLIC unless they are revoked. schema.sql
-- revokes all eight for fresh installs; without these lines an UPGRADED
-- deployment ends up with a different, weaker posture than a fresh one for
-- precisely the tables that decide who can see a firm's matters.
-- Idempotent: revoking a privilege that is not held is a no-op.
REVOKE ALL ON public.organizations FROM anon, authenticated;
REVOKE ALL ON public.org_members FROM anon, authenticated;
REVOKE ALL ON public.org_invitations FROM anon, authenticated;
REVOKE ALL ON public.project_access_grants FROM anon, authenticated;
REVOKE ALL ON public.project_org_access_overrides FROM anon, authenticated;
REVOKE ALL ON public.chat_access_grants FROM anon, authenticated;
REVOKE ALL ON public.tabular_review_access_grants FROM anon, authenticated;
REVOKE ALL ON public.workflow_org_access_overrides FROM anon, authenticated;

notify pgrst, 'reload schema';

commit;
