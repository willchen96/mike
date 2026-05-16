-- Verification script for issue #144.
-- Asserts every public base table has Row Level Security enabled AND a
-- deny-all policy for the anon and authenticated roles. Run with:
--     psql -v ON_ERROR_STOP=1 -f backend/scripts/verify-rls.sql $DATABASE_URL
-- The script exits non-zero on any assertion failure.

do $$
declare
    missing_rls record;
    missing_policy record;
    failure_count int := 0;
begin
    -- 1. Every public base table must have RLS enabled (relrowsecurity = true).
    for missing_rls in
        select t.table_name
        from information_schema.tables t
        join pg_class c on c.relname = t.table_name
        join pg_namespace n on n.oid = c.relnamespace
        where t.table_schema = 'public'
          and t.table_type = 'BASE TABLE'
          and n.nspname = 'public'
          and c.relrowsecurity is false
        order by t.table_name
    loop
        raise warning 'RLS not enabled on public.%', missing_rls.table_name;
        failure_count := failure_count + 1;
    end loop;

    -- 2. Every public base table must have at least one policy that applies
    --    to anon and authenticated and denies access (USING (false)).
    for missing_policy in
        select t.table_name
        from information_schema.tables t
        where t.table_schema = 'public'
          and t.table_type = 'BASE TABLE'
          and not exists (
              select 1
              from pg_policies p
              where p.schemaname = 'public'
                and p.tablename = t.table_name
                and 'anon' = any(p.roles)
                and 'authenticated' = any(p.roles)
                and p.qual = 'false'
          )
        order by t.table_name
    loop
        raise warning 'No deny-all policy for anon+authenticated on public.%',
            missing_policy.table_name;
        failure_count := failure_count + 1;
    end loop;

    if failure_count > 0 then
        raise exception 'verify-rls: % assertion(s) failed', failure_count;
    end if;

    raise notice 'verify-rls: all public base tables have RLS enabled and a deny-all policy.';
end$$;
