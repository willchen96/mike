-- User-configurable MCP (Model Context Protocol) servers.
-- Each row points the chat backend at a Streamable-HTTP MCP endpoint that
-- exposes additional tools. Tools discovered from these endpoints are merged
-- into the per-request tool list and routed under the `mcp__<slug>__` prefix.
--
-- Sensitive header values (e.g. Authorization tokens) live in the `headers`
-- jsonb column. Access is gated by Postgres RLS — owner-only — matching the
-- precedent set by user_profiles.claude_api_key / gemini_api_key.

create table if not exists public.user_mcp_servers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  slug text not null,
  name text not null,
  url text not null,
  headers jsonb not null default '{}'::jsonb,
  enabled boolean not null default true,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint user_mcp_servers_slug_format
    check (slug ~ '^[a-z0-9_-]{1,24}$'),
  unique (user_id, slug)
);

create index if not exists idx_user_mcp_servers_user
  on public.user_mcp_servers(user_id, enabled);

alter table public.user_mcp_servers enable row level security;

drop policy if exists "Users can view their own MCP servers" on public.user_mcp_servers;
create policy "Users can view their own MCP servers"
  on public.user_mcp_servers for select
  using (auth.uid() = user_id);

drop policy if exists "Users can insert their own MCP servers" on public.user_mcp_servers;
create policy "Users can insert their own MCP servers"
  on public.user_mcp_servers for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can update their own MCP servers" on public.user_mcp_servers;
create policy "Users can update their own MCP servers"
  on public.user_mcp_servers for update
  using (auth.uid() = user_id);

drop policy if exists "Users can delete their own MCP servers" on public.user_mcp_servers;
create policy "Users can delete their own MCP servers"
  on public.user_mcp_servers for delete
  using (auth.uid() = user_id);
