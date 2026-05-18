-- Verification script for issue #144.
-- Asserts every public base table has Row Level Security enabled AND a
-- deny-all policy for the anon and authenticated roles (both read and write
-- walls). Run with:
--     psql -v ON_ERROR_STOP=1 -f backend/scripts/verify-rls.sql $DATABASE_URL
-- The script exits non-zero on any assertion failure.

do $$
declare
    missing_rls record;
    missing_policy record;
    failure_count int := 0;
begin
    -- 1. Every public base table must have RLS enabled (relrowsecurity = true).
    --    Join through pg_namespace so we never accidentally match a same-named
    --    table in a different schema.
    for missing_rls in
        select t.table_name
        from information_schema.tables t
        join pg_namespace n on n.nspname = t.table_schema
        join pg_class c on c.relname = t.table_name and c.relnamespace = n.oid
        where t.table_schema = 'public'
          and t.table_type = 'BASE TABLE'
          and c.relrowsecurity is false
        order by t.table_name
    loop
        raise warning 'RLS not enabled on public.%', missing_rls.table_name;
        failure_count := failure_count + 1;
    end loop;

    -- 2. Every public base table must have at least one policy that:
    --    - applies to both anon AND authenticated
    --    - denies reads (qual = false)
    --    - denies writes (with_check = false)
    --    Postgres has historically rendered USING (false) as the text 'false';
    --    accept '(false)' as well to be forward-compatible with any future
    --    rendering change. with_check is nullable in pg_policies (older policies
    --    may not have set it explicitly) — treat null as a failure so the
    --    write-wall is always explicit.
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
                and p.qual in ('false', '(false)')
                and p.with_check in ('false', '(false)')
          )
        order by t.table_name
    loop
        raise warning 'No deny-all policy (read+write) for anon+authenticated on public.%',
            missing_policy.table_name;
        failure_count := failure_count + 1;
    end loop;

    if failure_count > 0 then
        raise exception 'verify-rls: % assertion(s) failed', failure_count;
    end if;

    raise notice 'verify-rls: all public base tables have RLS enabled and a deny-all read+write policy.';
end$$;
