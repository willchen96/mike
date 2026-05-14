import { Router } from "express";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import { parseBody } from "../lib/validate";
import { BUILTIN_WORKFLOWS } from "../lib/builtinWorkflows";

function getAdminClient() {
  return createClient(
    process.env.SUPABASE_URL ?? "",
    process.env.SUPABASE_SECRET_KEY ?? "",
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

const CreateWorkflowSchema = z.object({
  title: z.string().min(1),
  type: z.enum(["assistant", "tabular"]),
  prompt_md: z.string().optional(),
  columns_config: z.unknown().optional(),
  practice: z.string().optional().nullable(),
});

const PatchWorkflowSchema = z.object({
  title: z.string().min(1).optional(),
  prompt_md: z.string().optional(),
  columns_config: z.unknown().optional(),
  practice: z.string().optional().nullable(),
});

const ShareWorkflowSchema = z.object({
  emails: z.array(z.string().email()).min(1),
  allow_edit: z.boolean(),
});

export const workflowsRouter = Router();

// CLEAN-49: single source of truth — return canonical backend BUILTIN_WORKFLOWS
// (mounted before /:id to avoid route shadowing)
workflowsRouter.get("/builtin", requireAuth, (_req, res) => {
    res.json({ workflows: BUILTIN_WORKFLOWS });
});

type Db = ReturnType<typeof createServerSupabase>;

type WorkflowRecord = {
  id: string;
  user_id: string | null;
  is_system: boolean;
  [key: string]: unknown;
};

type WorkflowAccess =
  | {
      workflow: WorkflowRecord;
      allowEdit: boolean;
      isOwner: boolean;
    }
  | null;

function withWorkflowAccess<T extends Record<string, unknown>>(
  workflow: T,
  access: { allowEdit: boolean; isOwner: boolean; sharedByName?: string | null },
) {
  return {
    ...workflow,
    allow_edit: access.allowEdit,
    is_owner: access.isOwner,
    shared_by_name: access.sharedByName ?? null,
  };
}

async function resolveWorkflowAccess(
  workflowId: string,
  userId: string,
  userEmail: string | null | undefined,
  db: Db,
): Promise<WorkflowAccess> {
  const { data: workflow } = await db
    .from("workflows")
    .select("*")
    .eq("id", workflowId)
    .single();
  if (!workflow) return null;
  const workflowRecord = workflow as WorkflowRecord;
  if (workflowRecord.user_id === userId) {
    return { workflow: workflowRecord, allowEdit: true, isOwner: true };
  }

  const normalizedUserEmail = (userEmail ?? "").trim().toLowerCase();
  if (!normalizedUserEmail) return null;

  const { data: share } = await db
    .from("workflow_shares")
    .select("allow_edit")
    .eq("workflow_id", workflowId)
    .eq("shared_with_email", normalizedUserEmail)
    .maybeSingle();
  if (!share) return null;

  return { workflow: workflowRecord, allowEdit: !!share.allow_edit, isOwner: false };
}

// GET /workflows
workflowsRouter.get("/", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string;
  const { type } = req.query as { type?: string };
  const db = createServerSupabase();

  // Own workflows
  let ownQuery = db
    .from("workflows")
    .select("*")
    .eq("user_id", userId)
    .eq("is_system", false)
    .order("created_at", { ascending: false });
  if (type) ownQuery = ownQuery.eq("type", type);
  const { data: own, error: ownErr } = await ownQuery;
  if (ownErr) return void res.status(500).json({ detail: ownErr.message });

  // Shared workflows (where the current user's email appears in workflow_shares)
  const normalizedUserEmail = userEmail.trim().toLowerCase();
  const { data: shares } = await db
    .from("workflow_shares")
    .select("workflow_id, shared_by_user_id, allow_edit")
    .eq("shared_with_email", normalizedUserEmail);

  let sharedWorkflows: Record<string, unknown>[] = [];
  if (shares && shares.length > 0) {
    const sharedIds = shares.map((s) => s.workflow_id);
    let sharedQuery = db.from("workflows").select("*").in("id", sharedIds);
    if (type) sharedQuery = sharedQuery.eq("type", type);
    const { data: wfs } = await sharedQuery;

    if (wfs && wfs.length > 0) {
      // Fetch sharer profiles
      const sharerIds = [...new Set(shares.map((s) => s.shared_by_user_id).filter(Boolean))];
      const { data: profiles } = sharerIds.length > 0
        ? await db.from("user_profiles").select("user_id, display_name").in("user_id", sharerIds)
        : { data: [] };

      // Fetch sharer emails via admin client
      const admin = getAdminClient();
      const { data: authData } = await admin.auth.admin.listUsers({ perPage: 1000 });
      const authUsers = authData?.users ?? [];

      sharedWorkflows = wfs.map((wf) => {
        const share = shares.find((s) => s.workflow_id === wf.id);
        const sharerId = share?.shared_by_user_id;
        const profile = profiles?.find((p) => p.user_id === sharerId);
        const authUser = authUsers.find((u) => u.id === sharerId);
        const shared_by_name = profile?.display_name || authUser?.email || null;
        return withWorkflowAccess(wf, {
          allowEdit: !!share?.allow_edit,
          isOwner: false,
          sharedByName: shared_by_name,
        });
      });
    }
  }

  const ownWithFlag = (own ?? []).map((wf) =>
    withWorkflowAccess(wf, { allowEdit: true, isOwner: true }),
  );
  res.json([...ownWithFlag, ...sharedWorkflows]);
});

// POST /workflows
workflowsRouter.post("/", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const wfBody = parseBody(CreateWorkflowSchema, req, res);
  if (!wfBody) return;
  const { title, type, prompt_md, columns_config, practice } = wfBody;

  const db = createServerSupabase();
  const { data, error } = await db
    .from("workflows")
    .insert({
      user_id: userId,
      title: title.trim(),
      type,
      prompt_md: prompt_md ?? null,
      columns_config: columns_config ?? null,
      practice: practice ?? null,
      is_system: false,
    })
    .select("*")
    .single();
  if (error) return void res.status(500).json({ detail: error.message });
  res.status(201).json(data);
});

async function handleWorkflowUpdate(req: import("express").Request, res: import("express").Response) {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { workflowId } = req.params;
  const patchBody = parseBody(PatchWorkflowSchema, req, res);
  if (!patchBody) return;
  const updates: Record<string, unknown> = {};
  if (patchBody.title != null) updates.title = patchBody.title;
  if (patchBody.prompt_md != null) updates.prompt_md = patchBody.prompt_md;
  if (patchBody.columns_config != null)
    updates.columns_config = patchBody.columns_config;
  if ("practice" in patchBody) updates.practice = patchBody.practice ?? null;

  const db = createServerSupabase();
  const access = await resolveWorkflowAccess(workflowId, userId, userEmail, db);
  if (!access || access.workflow.is_system || !access.allowEdit) {
    return void res
      .status(404)
      .json({ detail: "Workflow not found or not editable" });
  }
  const { data, error } = await db
    .from("workflows")
    .update(updates)
    .eq("id", workflowId)
    .eq("is_system", false)
    .select("*")
    .single();
  if (error || !data)
    return void res
      .status(404)
      .json({ detail: "Workflow not found or not editable" });
  res.json(
    withWorkflowAccess(data, {
      allowEdit: access.allowEdit,
      isOwner: access.isOwner,
    }),
  );
}

// PUT /workflows/:workflowId
workflowsRouter.put("/:workflowId", requireAuth, handleWorkflowUpdate);

// PATCH /workflows/:workflowId
workflowsRouter.patch("/:workflowId", requireAuth, handleWorkflowUpdate);

// DELETE /workflows/:workflowId
workflowsRouter.delete("/:workflowId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const { workflowId } = req.params;
  const db = createServerSupabase();
  const { data, error } = await db
    .from("workflows")
    .delete()
    .eq("id", workflowId)
    .eq("user_id", userId)
    .eq("is_system", false)
    .select("id");
  if (error) return void res.status(500).json({ detail: error.message });
  if (!data || data.length === 0)
    return void res.status(404).json({ detail: "Workflow not found" });
  res.status(204).send();
});

// GET /workflows/hidden
workflowsRouter.get("/hidden", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const db = createServerSupabase();
  const { data, error } = await db
    .from("hidden_workflows")
    .select("workflow_id")
    .eq("user_id", userId);
  if (error) return void res.status(500).json({ detail: error.message });
  res.json((data ?? []).map((r) => r.workflow_id));
});

const HideWorkflowSchema = z.object({
  workflow_id: z.string().min(1),
});

// POST /workflows/hidden
workflowsRouter.post("/hidden", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const hideBody = parseBody(HideWorkflowSchema, req, res);
  if (!hideBody) return;
  const { workflow_id } = hideBody;
  const db = createServerSupabase();
  const { error } = await db
    .from("hidden_workflows")
    .upsert({ user_id: userId, workflow_id }, { onConflict: "user_id,workflow_id" });
  if (error) return void res.status(500).json({ detail: error.message });
  res.status(204).send();
});

// DELETE /workflows/hidden/:workflowId
workflowsRouter.delete("/hidden/:workflowId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const { workflowId } = req.params;
  const db = createServerSupabase();
  const { error } = await db
    .from("hidden_workflows")
    .delete()
    .eq("user_id", userId)
    .eq("workflow_id", workflowId);
  if (error) return void res.status(500).json({ detail: error.message });
  res.status(204).send();
});

// GET /workflows/:workflowId
workflowsRouter.get("/:workflowId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { workflowId } = req.params;
  const db = createServerSupabase();
  const access = await resolveWorkflowAccess(workflowId, userId, userEmail, db);
  if (!access)
    return void res.status(404).json({ detail: "Workflow not found" });
  res.json(
    withWorkflowAccess(access.workflow, {
      allowEdit: access.allowEdit,
      isOwner: access.isOwner,
    }),
  );
});

// GET /workflows/:workflowId/shares
workflowsRouter.get("/:workflowId/shares", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const { workflowId } = req.params;
  const db = createServerSupabase();

  const { data: wf } = await db
    .from("workflows")
    .select("id")
    .eq("id", workflowId)
    .eq("user_id", userId)
    .eq("is_system", false)
    .single();
  if (!wf) return void res.status(404).json({ detail: "Workflow not found or not editable" });

  const { data: shares, error } = await db
    .from("workflow_shares")
    .select("id, shared_with_email, allow_edit, created_at")
    .eq("workflow_id", workflowId)
    .order("created_at", { ascending: true });
  if (error) return void res.status(500).json({ detail: error.message });

  res.json(shares ?? []);
});

// DELETE /workflows/:workflowId/shares/:shareId
workflowsRouter.delete("/:workflowId/shares/:shareId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const { workflowId, shareId } = req.params;
  const db = createServerSupabase();

  const { data: wf } = await db
    .from("workflows")
    .select("id")
    .eq("id", workflowId)
    .eq("user_id", userId)
    .single();
  if (!wf) return void res.status(404).json({ detail: "Workflow not found" });

  await db.from("workflow_shares").delete().eq("id", shareId).eq("workflow_id", workflowId);
  res.status(204).send();
});

// POST /workflows/:workflowId/share
workflowsRouter.post("/:workflowId/share", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const { workflowId } = req.params;
  const shareBody = parseBody(ShareWorkflowSchema, req, res);
  if (!shareBody) return;
  const { emails, allow_edit } = shareBody;

  const db = createServerSupabase();
  // Verify ownership
  const { data: wf } = await db
    .from("workflows")
    .select("id")
    .eq("id", workflowId)
    .eq("user_id", userId)
    .eq("is_system", false)
    .single();
  if (!wf) return void res.status(404).json({ detail: "Workflow not found or not editable" });

  const rows = emails.map((email: string) => ({
    workflow_id: workflowId,
    shared_by_user_id: userId,
    shared_with_email: email.trim().toLowerCase(),
    allow_edit: allow_edit ?? false,
  }));
  // Upsert on (workflow_id, shared_with_email) so re-sharing to the same
  // person updates the existing row instead of stacking duplicates.
  const { error } = await db
    .from("workflow_shares")
    .upsert(rows, { onConflict: "workflow_id,shared_with_email" });
  if (error) return void res.status(500).json({ detail: error.message });

  res.status(204).send();
});
