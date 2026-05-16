import type { MigrationBuilder } from "node-pg-migrate";

// CLEAN-47: RLS defense-in-depth.
// - 5 SECURITY DEFINER helper functions (language sql + STABLE so the planner inlines and uses GIN).
// - Enable RLS on every user-owned table (14 total — includes tabular_review_chats* per RESEARCH §10 RESOLVED).
// - Closed-by-default policies (owner-only mutations; share-aware SELECT for projects/tabular_reviews/workflows).
// - Parallel jsonb_path_ops GIN indexes for faster @> lookups (research §5).
// Backend continues to use service_role JWT which bypasses RLS — RLS is the floor for anon-key paths.

export const shorthands = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  // ── SECTION 1: Helper functions ────────────────────────────────────────────
  // Each helper is language sql (NOT plpgsql) so the planner can inline it and
  // push the @> filter down into the GIN index.
  // See: RESEARCH.md §2 Pitfall 1, Pattern 1.

  // -- DO NOT change to plpgsql — breaks GIN-pushdown (RESEARCH §2 Pitfall 1).
  // Helper 1: is_project_member(uuid) → boolean
  // Used by: documents (project-scoped), chats (project-scoped), document_versions
  // (transitively), document_edits (transitively), tabular_cells (project-scoped),
  // chat_messages (transitively), is_document_member (wraps this).
  // GIN-pushable: shared_with @> jsonb_build_array(lower(auth.email())) uses
  // projects_shared_with_idx.
  pgm.sql(`
    create or replace function public.is_project_member(p_id uuid)
    returns boolean
    language sql
    security definer
    stable
    set search_path = public
    as $$
      select exists (
        select 1
        from public.projects
        where id = p_id
          and (
            user_id = auth.uid()
            or shared_with @> jsonb_build_array(lower(auth.email()))
          )
      );
    $$;
  `);
  pgm.sql(`revoke all on function public.is_project_member(uuid) from public;`);
  pgm.sql(`grant execute on function public.is_project_member(uuid) to authenticated, service_role;`);

  // -- DO NOT change to plpgsql — breaks GIN-pushdown (RESEARCH §2 Pitfall 1).
  // Helper 2: is_review_member(uuid) → boolean
  // Used by: tabular_reviews SELECT, tabular_cells (when project_id IS NULL —
  // direct-share path), tabular_review_chats (out of ROADMAP scope but parallel).
  // Two paths: owner OR direct-share via tabular_reviews.shared_with OR
  // (when project_id is set) project membership via is_project_member.
  pgm.sql(`
    create or replace function public.is_review_member(r_id uuid)
    returns boolean
    language sql
    security definer
    stable
    set search_path = public
    as $$
      select exists (
        select 1
        from public.tabular_reviews tr
        where tr.id = r_id
          and (
            tr.user_id = auth.uid()
            or tr.shared_with @> jsonb_build_array(lower(auth.email()))
            or (tr.project_id is not null and public.is_project_member(tr.project_id))
          )
      );
    $$;
  `);
  pgm.sql(`revoke all on function public.is_review_member(uuid) from public;`);
  pgm.sql(`grant execute on function public.is_review_member(uuid) to authenticated, service_role;`);

  // -- DO NOT change to plpgsql — breaks GIN-pushdown (RESEARCH §2 Pitfall 1).
  // Helper 3: is_workflow_visible(uuid) → boolean
  // Used by: workflows SELECT.
  // The only helper that consults a separate join table (workflow_shares) rather
  // than a JSONB column.
  pgm.sql(`
    create or replace function public.is_workflow_visible(w_id uuid)
    returns boolean
    language sql
    security definer
    stable
    set search_path = public
    as $$
      select exists (
        select 1
        from public.workflows w
        where w.id = w_id
          and w.user_id = auth.uid()
      )
      or exists (
        select 1
        from public.workflow_shares ws
        where ws.workflow_id = w_id
          and lower(ws.shared_with_email) = lower(auth.email())
      );
    $$;
  `);
  pgm.sql(`revoke all on function public.is_workflow_visible(uuid) from public;`);
  pgm.sql(`grant execute on function public.is_workflow_visible(uuid) to authenticated, service_role;`);

  // -- DO NOT change to plpgsql — breaks GIN-pushdown (RESEARCH §2 Pitfall 1).
  // Helper 4: is_chat_owner(uuid) → boolean
  // Used by: chat_messages.
  // Chat sharing is project-scoped, not direct. If the chat has a project_id,
  // project membership grants access; otherwise owner-only.
  pgm.sql(`
    create or replace function public.is_chat_owner(c_id uuid)
    returns boolean
    language sql
    security definer
    stable
    set search_path = public
    as $$
      select exists (
        select 1
        from public.chats c
        where c.id = c_id
          and (
            c.user_id = auth.uid()
            or (c.project_id is not null and public.is_project_member(c.project_id))
          )
      );
    $$;
  `);
  pgm.sql(`revoke all on function public.is_chat_owner(uuid) from public;`);
  pgm.sql(`grant execute on function public.is_chat_owner(uuid) to authenticated, service_role;`);

  // -- DO NOT change to plpgsql — breaks GIN-pushdown (RESEARCH §2 Pitfall 1).
  // Helper 5: is_document_member(uuid) → boolean
  // Used by: document_versions, document_edits.
  // Wraps is_project_member against documents.project_id; handles the orphan
  // case (project_id IS NULL → owner-only).
  pgm.sql(`
    create or replace function public.is_document_member(d_id uuid)
    returns boolean
    language sql
    security definer
    stable
    set search_path = public
    as $$
      select exists (
        select 1
        from public.documents d
        where d.id = d_id
          and (
            d.user_id = auth.uid()
            or (d.project_id is not null and public.is_project_member(d.project_id))
          )
      );
    $$;
  `);
  pgm.sql(`revoke all on function public.is_document_member(uuid) from public;`);
  pgm.sql(`grant execute on function public.is_document_member(uuid) to authenticated, service_role;`);

  // ── SECTION 2: Parallel jsonb_path_ops GIN indexes ────────────────────────
  // Adds a faster containment-only index alongside the existing jsonb_ops indexes.
  // Planner picks the cheaper of the two; existing jsonb_ops indexes are preserved.
  // See: RESEARCH.md §5.
  pgm.sql(`
    create index if not exists projects_shared_with_pathops_idx
      on public.projects using gin (shared_with jsonb_path_ops);
  `);
  pgm.sql(`
    create index if not exists tabular_reviews_shared_with_pathops_idx
      on public.tabular_reviews using gin (shared_with jsonb_path_ops);
  `);

  // ── SECTION 3: Enable RLS on all 14 user-owned tables ─────────────────────
  // Closed-by-default: no policy = no anon access. See: RESEARCH.md Pattern 2.
  // Includes tabular_review_chats* per RESEARCH.md §10 RESOLVED.
  // Per D-04: the existing user-profile RLS block is preserved — only the 14 tables below.
  pgm.sql(`alter table public.projects enable row level security;`);
  pgm.sql(`alter table public.project_subfolders enable row level security;`);
  pgm.sql(`alter table public.documents enable row level security;`);
  pgm.sql(`alter table public.document_versions enable row level security;`);
  pgm.sql(`alter table public.document_edits enable row level security;`);
  pgm.sql(`alter table public.chats enable row level security;`);
  pgm.sql(`alter table public.chat_messages enable row level security;`);
  pgm.sql(`alter table public.tabular_reviews enable row level security;`);
  pgm.sql(`alter table public.tabular_cells enable row level security;`);
  pgm.sql(`alter table public.tabular_review_chats enable row level security;`);
  pgm.sql(`alter table public.tabular_review_chat_messages enable row level security;`);
  pgm.sql(`alter table public.workflows enable row level security;`);
  pgm.sql(`alter table public.workflow_shares enable row level security;`);
  pgm.sql(`alter table public.hidden_workflows enable row level security;`);

  // ── SECTION 4: Per-table policies ─────────────────────────────────────────
  // Per D-03: mutation policies are owner-only on top-level tables.
  // Child tables (document_versions, document_edits, tabular_cells, chat_messages,
  // tabular_review_chat_messages) get NO mutation policy — closed-by-default service-role only.

  // ── 4.1: projects (4 policies) ──────────────────────────────────────────
  pgm.sql(`
    create policy "projects_select_owner_or_shared"
      on public.projects for select
      to authenticated
      using (
        user_id = auth.uid()
        or shared_with @> jsonb_build_array(lower(auth.email()))
      );
  `);
  pgm.sql(`
    create policy "projects_insert_owner"
      on public.projects for insert
      to authenticated
      with check (user_id = auth.uid());
  `);
  pgm.sql(`
    create policy "projects_update_owner"
      on public.projects for update
      to authenticated
      using (user_id = auth.uid())
      with check (user_id = auth.uid());
  `);
  pgm.sql(`
    create policy "projects_delete_owner"
      on public.projects for delete
      to authenticated
      using (user_id = auth.uid());
  `);

  // ── 4.2: project_subfolders (4 policies) ──────────────────────────────
  pgm.sql(`
    create policy "project_subfolders_select_member"
      on public.project_subfolders for select
      to authenticated
      using (public.is_project_member(project_id));
  `);
  pgm.sql(`
    create policy "project_subfolders_insert_owner"
      on public.project_subfolders for insert
      to authenticated
      with check (user_id = auth.uid());
  `);
  pgm.sql(`
    create policy "project_subfolders_update_owner"
      on public.project_subfolders for update
      to authenticated
      using (user_id = auth.uid())
      with check (user_id = auth.uid());
  `);
  pgm.sql(`
    create policy "project_subfolders_delete_owner"
      on public.project_subfolders for delete
      to authenticated
      using (user_id = auth.uid());
  `);

  // ── 4.3: documents (4 policies) ────────────────────────────────────────
  pgm.sql(`
    create policy "documents_select_member"
      on public.documents for select
      to authenticated
      using (
        user_id = auth.uid()
        or (project_id is not null and public.is_project_member(project_id))
      );
  `);
  pgm.sql(`
    create policy "documents_insert_owner"
      on public.documents for insert
      to authenticated
      with check (user_id = auth.uid());
  `);
  pgm.sql(`
    create policy "documents_update_owner"
      on public.documents for update
      to authenticated
      using (user_id = auth.uid())
      with check (user_id = auth.uid());
  `);
  pgm.sql(`
    create policy "documents_delete_owner"
      on public.documents for delete
      to authenticated
      using (user_id = auth.uid());
  `);

  // ── 4.4: document_versions (1 policy — SELECT only; no user_id column) ──
  // Mutations are service-role only — no INSERT/UPDATE/DELETE policy means
  // closed-by-default (anon-key cannot write). Service role bypasses RLS.
  pgm.sql(`
    create policy "document_versions_select_member"
      on public.document_versions for select
      to authenticated
      using (public.is_document_member(document_id));
  `);

  // ── 4.5: document_edits (1 policy — SELECT only; no user_id column) ────
  // No INSERT/UPDATE/DELETE policy — service-role only. (Anon-key clients in
  // v1 do not need to mutate edits; UI accept/reject calls go through backend.)
  pgm.sql(`
    create policy "document_edits_select_member"
      on public.document_edits for select
      to authenticated
      using (public.is_document_member(document_id));
  `);

  // ── 4.6: chats (4 policies) ─────────────────────────────────────────────
  pgm.sql(`
    create policy "chats_select_owner_or_project_member"
      on public.chats for select
      to authenticated
      using (
        user_id = auth.uid()
        or (project_id is not null and public.is_project_member(project_id))
      );
  `);
  pgm.sql(`
    create policy "chats_insert_owner"
      on public.chats for insert
      to authenticated
      with check (user_id = auth.uid());
  `);
  pgm.sql(`
    create policy "chats_update_owner"
      on public.chats for update
      to authenticated
      using (user_id = auth.uid())
      with check (user_id = auth.uid());
  `);
  pgm.sql(`
    create policy "chats_delete_owner"
      on public.chats for delete
      to authenticated
      using (user_id = auth.uid());
  `);

  // ── 4.7: chat_messages (1 policy — SELECT only; no user_id column) ─────
  // No mutation policies — service-role-only writes (chat_messages are written
  // by the SSE stream loop, never by the anon client).
  pgm.sql(`
    create policy "chat_messages_select_chat_member"
      on public.chat_messages for select
      to authenticated
      using (public.is_chat_owner(chat_id));
  `);

  // ── 4.8: tabular_reviews (4 policies) ──────────────────────────────────
  pgm.sql(`
    create policy "tabular_reviews_select_member"
      on public.tabular_reviews for select
      to authenticated
      using (
        user_id = auth.uid()
        or shared_with @> jsonb_build_array(lower(auth.email()))
        or (project_id is not null and public.is_project_member(project_id))
      );
  `);
  pgm.sql(`
    create policy "tabular_reviews_insert_owner"
      on public.tabular_reviews for insert
      to authenticated
      with check (user_id = auth.uid());
  `);
  pgm.sql(`
    create policy "tabular_reviews_update_owner"
      on public.tabular_reviews for update
      to authenticated
      using (user_id = auth.uid())
      with check (user_id = auth.uid());
  `);
  pgm.sql(`
    create policy "tabular_reviews_delete_owner"
      on public.tabular_reviews for delete
      to authenticated
      using (user_id = auth.uid());
  `);

  // ── 4.9: tabular_cells (1 policy — SELECT only; no user_id column) ─────
  // tabular_cells has no user_id; gated through is_review_member (which itself
  // handles project_id IS NULL direct-share path).
  // No mutation policies — service-role only.
  pgm.sql(`
    create policy "tabular_cells_select_review_member"
      on public.tabular_cells for select
      to authenticated
      using (public.is_review_member(review_id));
  `);

  // ── 4.10: tabular_review_chats (4 policies) ─────────────────────────────
  // Per RESEARCH.md §10 RESOLVED: mirrors chats/chat_messages shape.
  // Owner-only mutations; member SELECT via review membership.
  pgm.sql(`
    create policy "tabular_review_chats_select_owner_or_review_member"
      on public.tabular_review_chats for select
      to authenticated
      using (auth.uid() = user_id or public.is_review_member(review_id));
  `);
  pgm.sql(`
    create policy "tabular_review_chats_insert_owner"
      on public.tabular_review_chats for insert
      to authenticated
      with check (auth.uid() = user_id);
  `);
  pgm.sql(`
    create policy "tabular_review_chats_update_owner"
      on public.tabular_review_chats for update
      to authenticated
      using (auth.uid() = user_id)
      with check (auth.uid() = user_id);
  `);
  pgm.sql(`
    create policy "tabular_review_chats_delete_owner"
      on public.tabular_review_chats for delete
      to authenticated
      using (auth.uid() = user_id);
  `);

  // ── 4.11: tabular_review_chat_messages (1 policy — SELECT only; no user_id) ─
  // Per RESEARCH.md §10 RESOLVED: mirrors chat_messages shape.
  // No mutation policies — service-role only; tabular_review_chat_messages has
  // no user_id column to anchor mutations on.
  pgm.sql(`
    create policy "tabular_review_chat_messages_select_chat_member"
      on public.tabular_review_chat_messages for select
      to authenticated
      using (
        exists (
          select 1 from public.tabular_review_chats c
          where c.id = chat_id
            and (c.user_id = auth.uid() or public.is_review_member(c.review_id))
        )
      );
  `);

  // ── 4.12: workflows (4 policies) ───────────────────────────────────────
  // workflows.user_id is NULLABLE (built-in workflows have user_id = NULL).
  // The SELECT policy must allow built-ins to be read by all authenticated users.
  pgm.sql(`
    create policy "workflows_select_visible_or_builtin"
      on public.workflows for select
      to authenticated
      using (
        is_system = true
        or user_id = auth.uid()
        or public.is_workflow_visible(id)
      );
  `);
  pgm.sql(`
    create policy "workflows_insert_owner"
      on public.workflows for insert
      to authenticated
      with check (user_id = auth.uid());
  `);
  pgm.sql(`
    create policy "workflows_update_owner"
      on public.workflows for update
      to authenticated
      using (user_id = auth.uid())
      with check (user_id = auth.uid());
  `);
  pgm.sql(`
    create policy "workflows_delete_owner"
      on public.workflows for delete
      to authenticated
      using (user_id = auth.uid());
  `);

  // ── 4.13: workflow_shares (4 policies) — D-05 ─────────────────────────
  // SELECT visible to owner AND recipient; mutations owner-only.
  pgm.sql(`
    create policy "workflow_shares_select_owner_or_recipient"
      on public.workflow_shares for select
      to authenticated
      using (
        exists (
          select 1
          from public.workflows w
          where w.id = workflow_shares.workflow_id
            and w.user_id = auth.uid()
        )
        or lower(shared_with_email) = lower(auth.email())
      );
  `);
  pgm.sql(`
    create policy "workflow_shares_insert_workflow_owner"
      on public.workflow_shares for insert
      to authenticated
      with check (
        exists (
          select 1
          from public.workflows w
          where w.id = workflow_id
            and w.user_id = auth.uid()
        )
      );
  `);
  pgm.sql(`
    create policy "workflow_shares_update_workflow_owner"
      on public.workflow_shares for update
      to authenticated
      using (
        exists (
          select 1
          from public.workflows w
          where w.id = workflow_id
            and w.user_id = auth.uid()
        )
      );
  `);
  pgm.sql(`
    create policy "workflow_shares_delete_workflow_owner"
      on public.workflow_shares for delete
      to authenticated
      using (
        exists (
          select 1
          from public.workflows w
          where w.id = workflow_id
            and w.user_id = auth.uid()
        )
      );
  `);

  // ── 4.14: hidden_workflows (4 policies — owner-only) ───────────────────
  pgm.sql(`
    create policy "hidden_workflows_select_owner"
      on public.hidden_workflows for select
      to authenticated
      using (user_id = auth.uid());
  `);
  pgm.sql(`
    create policy "hidden_workflows_insert_owner"
      on public.hidden_workflows for insert
      to authenticated
      with check (user_id = auth.uid());
  `);
  pgm.sql(`
    create policy "hidden_workflows_update_owner"
      on public.hidden_workflows for update
      to authenticated
      using (user_id = auth.uid())
      with check (user_id = auth.uid());
  `);
  pgm.sql(`
    create policy "hidden_workflows_delete_owner"
      on public.hidden_workflows for delete
      to authenticated
      using (user_id = auth.uid());
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  // Drop all policies in reverse order.
  const policies: Array<[string, string]> = [
    // hidden_workflows (4)
    ["hidden_workflows_delete_owner", "hidden_workflows"],
    ["hidden_workflows_update_owner", "hidden_workflows"],
    ["hidden_workflows_insert_owner", "hidden_workflows"],
    ["hidden_workflows_select_owner", "hidden_workflows"],
    // workflow_shares (4)
    ["workflow_shares_delete_workflow_owner", "workflow_shares"],
    ["workflow_shares_update_workflow_owner", "workflow_shares"],
    ["workflow_shares_insert_workflow_owner", "workflow_shares"],
    ["workflow_shares_select_owner_or_recipient", "workflow_shares"],
    // workflows (4)
    ["workflows_delete_owner", "workflows"],
    ["workflows_update_owner", "workflows"],
    ["workflows_insert_owner", "workflows"],
    ["workflows_select_visible_or_builtin", "workflows"],
    // tabular_review_chat_messages (1)
    ["tabular_review_chat_messages_select_chat_member", "tabular_review_chat_messages"],
    // tabular_review_chats (4)
    ["tabular_review_chats_delete_owner", "tabular_review_chats"],
    ["tabular_review_chats_update_owner", "tabular_review_chats"],
    ["tabular_review_chats_insert_owner", "tabular_review_chats"],
    ["tabular_review_chats_select_owner_or_review_member", "tabular_review_chats"],
    // tabular_cells (1)
    ["tabular_cells_select_review_member", "tabular_cells"],
    // tabular_reviews (4)
    ["tabular_reviews_delete_owner", "tabular_reviews"],
    ["tabular_reviews_update_owner", "tabular_reviews"],
    ["tabular_reviews_insert_owner", "tabular_reviews"],
    ["tabular_reviews_select_member", "tabular_reviews"],
    // chat_messages (1)
    ["chat_messages_select_chat_member", "chat_messages"],
    // chats (4)
    ["chats_delete_owner", "chats"],
    ["chats_update_owner", "chats"],
    ["chats_insert_owner", "chats"],
    ["chats_select_owner_or_project_member", "chats"],
    // document_edits (1)
    ["document_edits_select_member", "document_edits"],
    // document_versions (1)
    ["document_versions_select_member", "document_versions"],
    // documents (4)
    ["documents_delete_owner", "documents"],
    ["documents_update_owner", "documents"],
    ["documents_insert_owner", "documents"],
    ["documents_select_member", "documents"],
    // project_subfolders (4)
    ["project_subfolders_delete_owner", "project_subfolders"],
    ["project_subfolders_update_owner", "project_subfolders"],
    ["project_subfolders_insert_owner", "project_subfolders"],
    ["project_subfolders_select_member", "project_subfolders"],
    // projects (4)
    ["projects_delete_owner", "projects"],
    ["projects_update_owner", "projects"],
    ["projects_insert_owner", "projects"],
    ["projects_select_owner_or_shared", "projects"],
  ];
  for (const [name, table] of policies) {
    pgm.sql(`drop policy if exists "${name}" on public.${table};`);
  }

  // Disable RLS — same 14 tables as up, in reverse order.
  pgm.sql(`alter table public.hidden_workflows disable row level security;`);
  pgm.sql(`alter table public.workflow_shares disable row level security;`);
  pgm.sql(`alter table public.workflows disable row level security;`);
  pgm.sql(`alter table public.tabular_review_chat_messages disable row level security;`);
  pgm.sql(`alter table public.tabular_review_chats disable row level security;`);
  pgm.sql(`alter table public.tabular_cells disable row level security;`);
  pgm.sql(`alter table public.tabular_reviews disable row level security;`);
  pgm.sql(`alter table public.chat_messages disable row level security;`);
  pgm.sql(`alter table public.chats disable row level security;`);
  pgm.sql(`alter table public.document_edits disable row level security;`);
  pgm.sql(`alter table public.document_versions disable row level security;`);
  pgm.sql(`alter table public.documents disable row level security;`);
  pgm.sql(`alter table public.project_subfolders disable row level security;`);
  pgm.sql(`alter table public.projects disable row level security;`)

  // Drop the parallel jsonb_path_ops indexes.
  pgm.sql(`drop index if exists public.projects_shared_with_pathops_idx;`);
  pgm.sql(`drop index if exists public.tabular_reviews_shared_with_pathops_idx;`);

  // Drop helpers in reverse dependency order.
  pgm.sql(`drop function if exists public.is_document_member(uuid);`);
  pgm.sql(`drop function if exists public.is_chat_owner(uuid);`);
  pgm.sql(`drop function if exists public.is_workflow_visible(uuid);`);
  pgm.sql(`drop function if exists public.is_review_member(uuid);`);
  pgm.sql(`drop function if exists public.is_project_member(uuid);`);
}
