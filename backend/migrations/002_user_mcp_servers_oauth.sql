-- OAuth 2.1 support for user-configured MCP connectors.
-- Adds auth-mode toggle + storage for the discovered authorization-server
-- metadata, the dynamically-registered client info, the access/refresh
-- tokens, and the (transient) PKCE verifier between /oauth/start and
-- /oauth/callback.
--
-- Tokens are stored at-rest in jsonb (RLS owner-only). Per-row encryption
-- is intentionally deferred to a separate hardening PR — this matches the
-- existing precedent for user_profiles.{claude,gemini}_api_key.

alter table public.user_mcp_servers
  add column if not exists auth_type text not null default 'headers'
    check (auth_type in ('headers', 'oauth')),
  add column if not exists oauth_metadata jsonb,
  add column if not exists oauth_tokens jsonb,
  add column if not exists oauth_code_verifier text;
