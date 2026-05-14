import type { MigrationBuilder } from "node-pg-migrate";

export async function up(pgm: MigrationBuilder): Promise<void> {
    pgm.sql(`
        create or replace function public.get_auth_user_by_email(p_email text)
        returns table (id uuid, email text)
        language sql
        security definer
        set search_path = ''
        as $$
            select u.id, u.email
            from auth.users u
            where lower(u.email) = lower(p_email)
            limit 1;
        $$;

        revoke all on function public.get_auth_user_by_email(text) from public, anon, authenticated;
        grant execute on function public.get_auth_user_by_email(text) to service_role;

        create or replace function public.get_auth_user_by_id(p_id uuid)
        returns table (id uuid, email text)
        language sql
        security definer
        set search_path = ''
        as $$
            select u.id, u.email
            from auth.users u
            where u.id = p_id
            limit 1;
        $$;

        revoke all on function public.get_auth_user_by_id(uuid) from public, anon, authenticated;
        grant execute on function public.get_auth_user_by_id(uuid) to service_role;
    `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
    pgm.sql(`
        drop function if exists public.get_auth_user_by_email(text);
        drop function if exists public.get_auth_user_by_id(uuid);
    `);
}
