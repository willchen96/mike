-- Migration: enable RLS + deny-all policy on every public base table, and
-- install an event trigger that does the same for any future public table.
-- Issue: #144 — defense-in-depth second wall against accidental GRANTs.
--
-- The service role bypasses RLS, so the backend (createServerSupabase)
-- continues to function unchanged. Direct PostgREST access by anon and
-- authenticated roles is blocked by both the existing REVOKE statements
-- in schema.sql and the policy created below.
--
-- Idempotent — safe to re-run. A matching DOWN script lives at
-- 20260516_enable_rls_deny_all.down.sql.

do $$
declare
    tbl text;
    policy_name text;
begin
    for tbl in
        select table_name
        from information_schema.tables
        where table_schema = 'public'
          and table_type = 'BASE TABLE'
    loop
        execute format('alter table public.%I enable row level security', tbl);
        policy_name := 'deny_client_access_' || tbl;
        if not exists (
            select 1 from pg_policies
            where schemaname = 'public'
              and tablename = tbl
              and policyname = policy_name
        ) then
            execute format(
                'create policy %I on public.%I for all to anon, authenticated using (false) with check (false)',
                policy_name, tbl
            );
        end if;
    end loop;
end$$;

-- Auto-enforcement for future tables. See schema.sql for the longer
-- explanation; in short: any new public table automatically receives the
-- same deny-all treatment, eliminating the "developer forgot to add RLS"
-- foot-gun.

create or replace function public.enforce_rls_on_public_tables()
returns event_trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    obj record;
    tbl_name text;
    policy_name text;
begin
    for obj in
        select objid, schema_name
        from pg_event_trigger_ddl_commands()
        where command_tag = 'CREATE TABLE' and schema_name = 'public'
    loop
        select c.relname into tbl_name
        from pg_class c
        where c.oid = obj.objid and c.relkind in ('r', 'p');
        if tbl_name is null then
            continue;
        end if;
        execute format('alter table public.%I enable row level security', tbl_name);
        policy_name := 'deny_client_access_' || tbl_name;
        if not exists (
            select 1 from pg_policies
            where schemaname = 'public'
              and tablename = tbl_name
              and policyname = policy_name
        ) then
            execute format(
                'create policy %I on public.%I for all to anon, authenticated using (false) with check (false)',
                policy_name, tbl_name
            );
        end if;
    end loop;
end$$;

drop event trigger if exists enforce_rls_on_public_tables;
create event trigger enforce_rls_on_public_tables
    on ddl_command_end
    when tag in ('CREATE TABLE')
    execute procedure public.enforce_rls_on_public_tables();
