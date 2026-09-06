-- Migration date: 2026-09-06
-- Native Google Drive integration.
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

-- Grant hardening, mirroring backend/schema.sql. On hosted Supabase, default
-- privileges hand anon/authenticated access to every new table in public;
-- these tables hold encrypted OAuth tokens, so strip the browser roles and
-- grant the backend's service_role its data privileges explicitly.
revoke all on public.user_google_drive_tokens from anon, authenticated;
revoke all on public.google_drive_oauth_states from anon, authenticated;

grant select, insert, update, delete
  on public.user_google_drive_tokens
  to service_role;
grant select, insert, update, delete
  on public.google_drive_oauth_states
  to service_role;
