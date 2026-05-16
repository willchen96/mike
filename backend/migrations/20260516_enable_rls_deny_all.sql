-- Migration: enable RLS + deny-all policy on every public base table.
-- Issue: #144 — defense-in-depth second wall against accidental GRANTs.
--
-- The service role bypasses RLS, so the backend (createServerSupabase)
-- continues to function unchanged. Direct PostgREST access by anon and
-- authenticated roles is blocked by both the existing REVOKE statements
-- in schema.sql and the policy created below.
--
-- Idempotent — safe to re-run.

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
