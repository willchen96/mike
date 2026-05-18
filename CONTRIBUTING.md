# Contributing

Thanks for helping improve Mike. Please keep contributions small, focused, and easy to review.

## Guidelines

- Prefer targeted edits over broad refactors.
- Keep each PR focused on one bug, feature, or cleanup.
- Update docs or env examples when changing setup, config, or user-facing behavior.
- Please do not propose local-hosting refactors for the main app, such as local LLMs, local databases, or local filesystem storage. Those ideas are better suited to a future fully local version of the project.
- Do not commit secrets, API keys, private documents, or local `.env` files.

## Before Opening a PR

- Run the relevant build or test command for the area you changed.
- Check `git diff` and remove unrelated changes.
- Write a concise Markdown PR description with:
    - summary
    - changes
    - why
    - testing

## Security

Do not open a public issue for security vulnerabilities. Use [GitHub's private vulnerability reporting](https://github.com/willchen96/mike/security/advisories/new) instead.

We will aim to respond promptly and coordinate a disclosure timeline with you.

## Local Development

Backend:

```bash
npm run build --prefix backend
```

Frontend:

```bash
npm run build --prefix frontend
```

## Database Migrations

The schema lives in two places:

- `backend/schema.sql` — used for fresh installs of a new Supabase database.
- `backend/migrations/YYYYMMDD_<name>.sql` — incremental scripts applied to existing deployments. Each migration should ship with a paired `.down.sql` rollback.

### Row Level Security

Every new table in the `public` schema must have RLS enabled with a deny-all policy for the `anon` and `authenticated` roles. An event trigger (`enforce_rls_on_public_tables`) installed by `20260516_enable_rls_deny_all.sql` does this automatically for any `CREATE TABLE` in `public`, so in normal flow you do not need to repeat the policy. If you disable the trigger temporarily, restore it before merging.

The service role bypasses RLS, so the backend (`createServerSupabase()` via `SUPABASE_SECRET_KEY`) is unaffected; only direct PostgREST access by `anon` / `authenticated` is blocked. Do not grant direct table privileges to those roles — all application data access goes through the backend.

After a migration touching the schema, verify:

```bash
psql -v ON_ERROR_STOP=1 -f backend/scripts/verify-rls.sql "$DATABASE_URL"
```

This exits non-zero if any `public` base table is missing RLS or a deny-all policy.
