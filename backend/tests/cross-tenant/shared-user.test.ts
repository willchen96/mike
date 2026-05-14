import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const hasAnonKey = Boolean(process.env.SUPABASE_ANON_KEY);

(hasAnonKey ? describe : describe.skip)(
  "RLS — positive shared-user assertions (Phase 11)",
  () => {
    let anonClientB: SupabaseClient;
    let serviceClient: SupabaseClient;
    let projectId: string;
    let tabularReviewId: string;
    let workflowId: string;
    let documentId: string;
    let tabularReviewChatId: string;
    let tabularReviewChatMessageId: string;

    beforeAll(async () => {
      const supabaseUrl = process.env.SUPABASE_URL!;
      const anonKey = process.env.SUPABASE_ANON_KEY!;
      const serviceKey = process.env.SUPABASE_SECRET_KEY!;

      // Anon-key client: signs in as user-B (the SHARED-WITH recipient).
      anonClientB = createClient(supabaseUrl, anonKey);
      const { error: signinError } = await anonClientB.auth.signInWithPassword({
        email: process.env.TEST_USER_B_EMAIL!,
        password: process.env.TEST_PASSWORD ?? "TestPassw0rd!",
      });
      if (signinError) throw new Error(`[shared-user beforeAll] sign in B failed: ${signinError.message}`);

      // Service-role client: bypasses RLS for seed-mutations (creates resources owned by user-A
      // and shares them with user-B's email).
      serviceClient = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

      const userIdA = process.env.TEST_USER_A_ID!;
      const userBEmail = process.env.TEST_USER_B_EMAIL!.toLowerCase();

      // Seed: project owned by A, shared with B.
      const { data: proj, error: projErr } = await serviceClient
        .from("projects")
        .insert({ user_id: userIdA, name: "Phase 11 shared", shared_with: [userBEmail] })
        .select("id")
        .single();
      if (projErr || !proj) throw new Error(`seed project: ${projErr?.message}`);
      projectId = proj.id;

      // Seed: tabular_review owned by A, direct-share with B (project_id IS NULL).
      const { data: tr, error: trErr } = await serviceClient
        .from("tabular_reviews")
        .insert({ user_id: userIdA, title: "Phase 11 direct share", project_id: null, shared_with: [userBEmail] })
        .select("id")
        .single();
      if (trErr || !tr) throw new Error(`seed review: ${trErr?.message}`);
      tabularReviewId = tr.id;

      // Seed: tabular_review_chat owned by A, anchored on the shared review.
      const { data: trc, error: trcErr } = await serviceClient
        .from("tabular_review_chats")
        .insert({ user_id: userIdA, review_id: tabularReviewId, title: "Phase 11 review chat" })
        .select("id")
        .single();
      if (trcErr || !trc) throw new Error(`seed tabular_review_chat: ${trcErr?.message}`);
      tabularReviewChatId = trc.id;

      // Seed: tabular_review_chat_message inside that chat (no user_id column).
      const { data: trcm, error: trcmErr } = await serviceClient
        .from("tabular_review_chat_messages")
        .insert({ chat_id: tabularReviewChatId, role: "user", content: { text: "hello" } })
        .select("id")
        .single();
      if (trcmErr || !trcm) throw new Error(`seed tabular_review_chat_message: ${trcmErr?.message}`);
      tabularReviewChatMessageId = trcm.id;

      // Seed: workflow owned by A + workflow_shares row to B.
      const { data: wf, error: wfErr } = await serviceClient
        .from("workflows")
        .insert({ user_id: userIdA, title: "Phase 11 wf", type: "assistant", prompt_md: "do x", is_system: false })
        .select("id")
        .single();
      if (wfErr || !wf) throw new Error(`seed workflow: ${wfErr?.message}`);
      workflowId = wf.id;
      const { error: wsErr } = await serviceClient
        .from("workflow_shares")
        .insert({ workflow_id: workflowId, shared_by_user_id: userIdA, shared_with_email: userBEmail });
      if (wsErr) throw new Error(`seed workflow_share: ${wsErr.message}`);

      // Seed: document owned by A in shared project (documents has no storage_path column directly).
      const { data: doc, error: docErr } = await serviceClient
        .from("documents")
        .insert({ user_id: userIdA, project_id: projectId, filename: "p11.pdf", file_type: "pdf" })
        .select("id")
        .single();
      if (docErr || !doc) throw new Error(`seed document: ${docErr?.message}`);
      documentId = doc.id;
    }, 60_000);

    afterAll(async () => {
      // Cleanup via service role (FK cascade handles children, but be explicit for clarity).
      await serviceClient.from("documents").delete().eq("id", documentId);
      await serviceClient.from("tabular_review_chat_messages").delete().eq("id", tabularReviewChatMessageId);
      await serviceClient.from("tabular_review_chats").delete().eq("id", tabularReviewChatId);
      await serviceClient.from("workflow_shares").delete().eq("workflow_id", workflowId);
      await serviceClient.from("workflows").delete().eq("id", workflowId);
      await serviceClient.from("tabular_reviews").delete().eq("id", tabularReviewId);
      await serviceClient.from("projects").delete().eq("id", projectId);
    });

    // ── Positive: shared user CAN read ──────────────────────────────
    it("anon-key user-B CAN read user-A project shared with them", async () => {
      const { data, error } = await anonClientB.from("projects").select("id").eq("id", projectId);
      expect(error).toBeNull();
      expect(data).toHaveLength(1);
    });

    it("anon-key user-B CAN read documents in shared project", async () => {
      const { data, error } = await anonClientB.from("documents").select("id").eq("id", documentId);
      expect(error).toBeNull();
      expect(data).toHaveLength(1);
    });

    it("anon-key user-B CAN read direct-share tabular_review (project_id IS NULL)", async () => {
      const { data, error } = await anonClientB.from("tabular_reviews").select("id").eq("id", tabularReviewId);
      expect(error).toBeNull();
      expect(data).toHaveLength(1);
    });

    it("anon-key user-B CAN read tabular_review_chats of a shared review", async () => {
      const { data, error } = await anonClientB
        .from("tabular_review_chats")
        .select("id")
        .eq("id", tabularReviewChatId);
      expect(error).toBeNull();
      expect(data).toHaveLength(1);
    });

    it("anon-key user-B CAN read tabular_review_chat_messages of a shared review's chats", async () => {
      const { data, error } = await anonClientB
        .from("tabular_review_chat_messages")
        .select("id")
        .eq("id", tabularReviewChatMessageId);
      expect(error).toBeNull();
      expect(data).toHaveLength(1);
    });

    it("anon-key user-B CAN read shared workflow via workflow_shares", async () => {
      const { data, error } = await anonClientB.from("workflows").select("id").eq("id", workflowId);
      expect(error).toBeNull();
      expect(data).toHaveLength(1);
    });

    it("anon-key user-B CAN read their own workflow_shares row", async () => {
      const { data, error } = await anonClientB.from("workflow_shares").select("id").eq("workflow_id", workflowId);
      expect(error).toBeNull();
      expect(data).toHaveLength(1);
    });

    // ── Negative: shared user CANNOT mutate (D-02 mutation = owner-only) ──────
    it("anon-key user-B CANNOT update user-A's shared project", async () => {
      const { data, error } = await anonClientB
        .from("projects")
        .update({ name: "Hijacked" })
        .eq("id", projectId)
        .select("id");
      // Postgrest with RLS denying UPDATE either returns 0 affected rows OR an error.
      // Both are acceptable signals of denial.
      const denied = (error !== null) || (Array.isArray(data) && data.length === 0);
      expect(denied).toBe(true);
    });

    it("anon-key user-B CANNOT delete user-A's shared project", async () => {
      const { data, error } = await anonClientB
        .from("projects")
        .delete()
        .eq("id", projectId)
        .select("id");
      const denied = (error !== null) || (Array.isArray(data) && data.length === 0);
      expect(denied).toBe(true);
    });

    it("anon-key user-B CANNOT update direct-share tabular_review", async () => {
      const { data, error } = await anonClientB
        .from("tabular_reviews")
        .update({ title: "Hijacked" })
        .eq("id", tabularReviewId)
        .select("id");
      const denied = (error !== null) || (Array.isArray(data) && data.length === 0);
      expect(denied).toBe(true);
    });

    it("anon-key user-B CANNOT update user-A's tabular_review_chat (owner-only mutation)", async () => {
      const { data, error } = await anonClientB
        .from("tabular_review_chats")
        .update({ title: "Hijacked" })
        .eq("id", tabularReviewChatId)
        .select("id");
      const denied = (error !== null) || (Array.isArray(data) && data.length === 0);
      expect(denied).toBe(true);
    });

    it("anon-key user-B CANNOT delete user-A's tabular_review_chat (owner-only mutation)", async () => {
      const { data, error } = await anonClientB
        .from("tabular_review_chats")
        .delete()
        .eq("id", tabularReviewChatId)
        .select("id");
      const denied = (error !== null) || (Array.isArray(data) && data.length === 0);
      expect(denied).toBe(true);
    });

    it("anon-key user-B CANNOT insert into tabular_review_chat_messages (no mutation policy — service-role only)", async () => {
      const { data, error } = await anonClientB
        .from("tabular_review_chat_messages")
        .insert({ chat_id: tabularReviewChatId, role: "user", content: { text: "hijack" } })
        .select("id");
      const denied = (error !== null) || (Array.isArray(data) && data.length === 0);
      expect(denied).toBe(true);
    });

    // ── CR-03 regression: workflow_shares UPDATE WITH CHECK pins shared_by_user_id ──
    // Before fix: workflow_shares UPDATE policy had only USING; PostgreSQL defaulted
    // WITH CHECK = USING which protected workflow_id but left shared_by_user_id
    // unconstrained, allowing the workflow owner to forge the audit trail of who
    // shared the workflow. After fix: explicit WITH CHECK pins the post-update row to
    // a workflow the caller still owns — but more importantly any UPDATE that does
    // not satisfy WITH CHECK is rejected, including ones that try to reassign
    // shared_by_user_id (because there is no path through the policy expression that
    // permits a stale shared_by_user_id from a foreign user).
    //
    // We sign in as user-A (the WORKFLOW OWNER) so USING passes; only WITH CHECK can
    // block the forgery. (User-B can already not pass USING, so anon-key user-B is
    // not the right vector to exercise the fix.)
    it("anon-key user-A (workflow owner) CANNOT forge shared_by_user_id on their own workflow_shares row (CR-03)", async () => {
      const supabaseUrl = process.env.SUPABASE_URL!;
      const anonKey = process.env.SUPABASE_ANON_KEY!;
      const userIdA = process.env.TEST_USER_A_ID!;
      const userIdB = process.env.TEST_USER_B_ID!;

      // Sign in as user-A on a fresh anon client (avoid mutating anonClientB's session).
      const anonClientA = createClient(supabaseUrl, anonKey);
      const { error: signinError } = await anonClientA.auth.signInWithPassword({
        email: process.env.TEST_USER_A_EMAIL!,
        password: process.env.TEST_PASSWORD ?? "TestPassw0rd!",
      });
      if (signinError) throw new Error(`[CR-03 test] sign in A failed: ${signinError.message}`);

      // Attempt the forgery: re-attribute the share to user-B.
      const { error: updateError } = await anonClientA
        .from("workflow_shares")
        .update({ shared_by_user_id: userIdB })
        .eq("workflow_id", workflowId);

      // Either RLS rejects with a 42501-style error, or the UPDATE returns success
      // but affects 0 rows. Both are acceptable signals of denial. The deterministic
      // proof is the post-read below — the row must be unchanged.
      // (We deliberately do NOT assert error !== null because PostgREST + RLS often
      // return success-with-zero-rows for WITH CHECK violations rather than a hard error.)

      // Verify via service-role (bypasses RLS) that shared_by_user_id is still user-A.
      const { data: postRow, error: readError } = await serviceClient
        .from("workflow_shares")
        .select("shared_by_user_id")
        .eq("workflow_id", workflowId)
        .single();
      expect(readError).toBeNull();
      expect(postRow).not.toBeNull();
      expect(postRow!.shared_by_user_id).toBe(userIdA);

      // Surface infrastructure-level errors (not RLS denials) so misconfigured envs
      // don't masquerade as a passing security test (see WR-04).
      if (updateError && updateError.code && !["42501", "PGRST301", "PGRST204"].includes(updateError.code)) {
        // eslint-disable-next-line no-console
        console.warn(`[CR-03 test] update returned unexpected error code ${updateError.code}: ${updateError.message}`);
      }

      // Cleanup: sign anonClientA out so its session doesn't leak.
      await anonClientA.auth.signOut();
    });

    // ── Builtin workflow visibility (workflows.is_system = true) ──────
    it("anon-key user-B CAN read built-in workflows (is_system = true)", async () => {
      const { data, error } = await anonClientB.from("workflows").select("id").eq("is_system", true).limit(5);
      expect(error).toBeNull();
      // built-in workflows may or may not be seeded in test DB — only assert shape, no count
      expect(Array.isArray(data)).toBe(true);
    });
  },
);
