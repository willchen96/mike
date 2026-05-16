-- Rollback for 20260516_enable_rls_deny_all.sql (issue #144).
--
-- Drops the deny_client_access_<tbl> policy and disables RLS on every public
-- base table. The REVOKE statements in schema.sql remain in force so client
-- roles still cannot reach these tables — this rollback only removes the
-- second wall, not the first.
--
-- Idempotent — safe to re-run.

drop event trigger if exists enforce_rls_on_public_tables;
drop function if exists public.enforce_rls_on_public_tables();

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
        policy_name := 'deny_client_access_' || tbl;
        execute format('drop policy if exists %I on public.%I', policy_name, tbl);
        execute format('alter table public.%I disable row level security', tbl);
    end loop;
end$$;
