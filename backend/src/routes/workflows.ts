import { Router, type NextFunction, type Request, type Response } from "express";
import { requireAuth } from "../middleware/auth";
import { createServerDb } from "../lib/db";

export const workflowsRouter = Router();

type Db = ReturnType<typeof createServerDb>;

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

type AsyncRoute = (req: Request, res: Response) => Promise<unknown>;

function asyncRoute(handler: AsyncRoute) {
  return (req: Request, res: Response, next: NextFunction) => {
    void handler(req, res).catch(next);
  };
}

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

async function loadSharerNames(
  db: Db,
  sharerIds: string[],
): Promise<Map<string, string>> {
  const uniqueIds = [...new Set(sharerIds.filter(Boolean))];
  const names = new Map<string, string>();
  if (uniqueIds.length === 0) return names;

  try {
    const { data: profiles, error } = await db
      .selectFrom("userProfiles")
      .select(["userId", "displayName"])
      .where("userId", "in", uniqueIds);

    if (error) {
      console.warn("[workflows] failed to load sharer profiles", error);
    } else {
      for (const profile of profiles ?? []) {
        if (profile.user_id && profile.display_name) {
          names.set(profile.user_id, profile.display_name);
        }
      }
    }
  } catch (err) {
    console.warn("[workflows] sharer profile lookup threw", err);
  }

  const missingIds = uniqueIds.filter((id) => !names.has(id));
  const results = await Promise.allSettled(
    missingIds.map(async (id) => {
      const { data, error } = await db.auth.admin.getUserById(id);
      if (error) throw error;
      return { id, email: data.user?.email ?? null };
    }),
  );

  for (const result of results) {
    if (result.status === "fulfilled" && result.value.email) {
      names.set(result.value.id, result.value.email);
    } else if (result.status === "rejected") {
      console.warn("[workflows] failed to load sharer email", result.reason);
    }
  }

  return names;
}

async function resolveWorkflowAccess(
  workflowId: string,
  userId: string,
  userEmail: string | null | undefined,
  db: Db,
): Promise<WorkflowAccess> {
  const { data: workflow } = await db
    .selectFrom("workflows")
    .selectAll()
    .where("id", "=", workflowId)
    .single();
  if (!workflow) return null;
  const workflowRecord = workflow as WorkflowRecord;
  if (workflowRecord.user_id === userId) {
    return { workflow: workflowRecord, allowEdit: true, isOwner: true };
  }

  const normalizedUserEmail = (userEmail ?? "").trim().toLowerCase();
  if (!normalizedUserEmail) return null;

  const { data: share } = await db
    .selectFrom("workflowShares")
    .select(["allowEdit"])
    .where("workflowId", "=", workflowId)
    .where("sharedWithEmail", "=", normalizedUserEmail)
    .maybeSingle();
  if (!share) return null;

  return { workflow: workflowRecord, allowEdit: !!share.allow_edit, isOwner: false };
}

// GET /workflows
workflowsRouter.get("/", requireAuth, asyncRoute(async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string;
  const { type } = req.query as { type?: string };
  const db = createServerDb();

  // Own workflows
  let ownQuery = db
    .selectFrom("workflows")
    .selectAll()
    .where("userId", "=", userId)
    .where("isSystem", "=", false)
    .orderBy("createdAt", "desc");
  if (type) ownQuery = ownQuery.where("type", "=", type);
  const { data: own, error: ownErr } = await ownQuery;
  if (ownErr) return void res.status(500).json({ detail: ownErr.message });

  // Shared workflows (where the current user's email appears in workflow_shares)
  const normalizedUserEmail = userEmail.trim().toLowerCase();
  const { data: shares } = await db
    .selectFrom("workflowShares")
    .select(["workflowId", "sharedByUserId", "allowEdit"])
    .where("sharedWithEmail", "=", normalizedUserEmail);

  let sharedWorkflows: Record<string, unknown>[] = [];
  if (shares && shares.length > 0) {
    const sharedIds = (shares as any[]).map((s) => s.workflow_id);
    let sharedQuery = db.selectFrom("workflows").selectAll().where("id", "in", sharedIds);
    if (type) sharedQuery = sharedQuery.where("type", "=", type);
    const { data: wfs } = await sharedQuery;

    if (wfs && wfs.length > 0) {
      const sharerIds = [...new Set((shares as any[]).map((s) => s.shared_by_user_id).filter(Boolean))] as string[];
      const sharerNames = await loadSharerNames(db, sharerIds);

      sharedWorkflows = (wfs as any[]).map((wf) => {
        const share = (shares as any[]).find((s) => s.workflow_id === wf.id);
        const sharerId = share?.shared_by_user_id;
        const shared_by_name = sharerId ? sharerNames.get(sharerId) ?? null : null;
        return withWorkflowAccess(wf, {
          allowEdit: !!share?.allow_edit,
          isOwner: false,
          sharedByName: shared_by_name,
        });
      });
    }
  }

  const ownWithFlag = ((own ?? []) as any[]).map((wf) =>
    withWorkflowAccess(wf, { allowEdit: true, isOwner: true }),
  );
  res.json([...ownWithFlag, ...sharedWorkflows]);
}));

// POST /workflows
workflowsRouter.post("/", requireAuth, asyncRoute(async (req, res) => {
  const userId = res.locals.userId as string;
  const { title, type, prompt_md, columns_config, practice } = req.body as {
    title: string;
    type: string;
    prompt_md?: string;
    columns_config?: unknown;
    practice?: string | null;
  };
  if (!title?.trim())
    return void res.status(400).json({ detail: "title is required" });
  if (!["assistant", "tabular"].includes(type))
    return void res
      .status(400)
      .json({ detail: "type must be 'assistant' or 'tabular'" });

  const db = createServerDb();
  const { data, error } = await db
    .insertInto("workflows")
    .values({
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
}));

async function handleWorkflowUpdate(req: Request, res: Response) {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { workflowId } = req.params;
  const updates: Record<string, unknown> = {};
  if (req.body.title != null) updates.title = req.body.title;
  if (req.body.prompt_md != null) updates.prompt_md = req.body.prompt_md;
  if (req.body.columns_config != null)
    updates.columns_config = req.body.columns_config;
  if ("practice" in req.body) updates.practice = req.body.practice ?? null;

  const db = createServerDb();
  const access = await resolveWorkflowAccess(workflowId, userId, userEmail, db);
  if (!access || access.workflow.is_system || !access.allowEdit) {
    return void res
      .status(404)
      .json({ detail: "Workflow not found or not editable" });
  }
  const { data, error } = await db
    .updateTable("workflows")
    .set(updates)
    .where("id", "=", workflowId)
    .where("isSystem", "=", false)
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
workflowsRouter.put("/:workflowId", requireAuth, asyncRoute(handleWorkflowUpdate));

// PATCH /workflows/:workflowId
workflowsRouter.patch("/:workflowId", requireAuth, asyncRoute(handleWorkflowUpdate));

// DELETE /workflows/:workflowId
workflowsRouter.delete("/:workflowId", requireAuth, asyncRoute(async (req, res) => {
  const userId = res.locals.userId as string;
  const { workflowId } = req.params;
  const db = createServerDb();
  const { error } = await db
    .deleteFrom("workflows")
    .where("id", "=", workflowId)
    .where("userId", "=", userId)
    .where("isSystem", "=", false);
  if (error) return void res.status(500).json({ detail: error.message });
  res.status(204).send();
}));

// GET /workflows/hidden
workflowsRouter.get("/hidden", requireAuth, asyncRoute(async (req, res) => {
  const userId = res.locals.userId as string;
  const db = createServerDb();
  const { data, error } = await db
    .selectFrom("hiddenWorkflows")
    .select(["workflowId"])
    .where("userId", "=", userId);
  if (error) return void res.status(500).json({ detail: error.message });
  res.json(((data ?? []) as any[]).map((r) => r.workflow_id));
}));

// POST /workflows/hidden
workflowsRouter.post("/hidden", requireAuth, asyncRoute(async (req, res) => {
  const userId = res.locals.userId as string;
  const { workflow_id } = req.body as { workflow_id: string };
  if (!workflow_id?.trim())
    return void res.status(400).json({ detail: "workflow_id is required" });
  const db = createServerDb();
  const { error } = await db
    .insertInto("hiddenWorkflows")
    .upsert({ user_id: userId, workflow_id }, { onConflict: "user_id,workflow_id" });
  if (error) return void res.status(500).json({ detail: error.message });
  res.status(204).send();
}));

// DELETE /workflows/hidden/:workflowId
workflowsRouter.delete("/hidden/:workflowId", requireAuth, asyncRoute(async (req, res) => {
  const userId = res.locals.userId as string;
  const { workflowId } = req.params;
  const db = createServerDb();
  const { error } = await db
    .deleteFrom("hiddenWorkflows")
    .where("userId", "=", userId)
    .where("workflowId", "=", workflowId);
  if (error) return void res.status(500).json({ detail: error.message });
  res.status(204).send();
}));

// GET /workflows/:workflowId
workflowsRouter.get("/:workflowId", requireAuth, asyncRoute(async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { workflowId } = req.params;
  const db = createServerDb();
  const access = await resolveWorkflowAccess(workflowId, userId, userEmail, db);
  if (!access)
    return void res.status(404).json({ detail: "Workflow not found" });
  res.json(
    withWorkflowAccess(access.workflow, {
      allowEdit: access.allowEdit,
      isOwner: access.isOwner,
    }),
  );
}));

// GET /workflows/:workflowId/shares
workflowsRouter.get("/:workflowId/shares", requireAuth, asyncRoute(async (req, res) => {
  const userId = res.locals.userId as string;
  const { workflowId } = req.params;
  const db = createServerDb();

  const { data: wf } = await db
    .selectFrom("workflows")
    .select(["id"])
    .where("id", "=", workflowId)
    .where("userId", "=", userId)
    .where("isSystem", "=", false)
    .single();
  if (!wf) return void res.status(404).json({ detail: "Workflow not found or not editable" });

  const { data: shares, error } = await db
    .selectFrom("workflowShares")
    .select(["id", "sharedWithEmail", "allowEdit", "createdAt"])
    .where("workflowId", "=", workflowId)
    .orderBy("createdAt", "asc");
  if (error) return void res.status(500).json({ detail: error.message });

  res.json(shares ?? []);
}));

// DELETE /workflows/:workflowId/shares/:shareId
workflowsRouter.delete("/:workflowId/shares/:shareId", requireAuth, asyncRoute(async (req, res) => {
  const userId = res.locals.userId as string;
  const { workflowId, shareId } = req.params;
  const db = createServerDb();

  const { data: wf } = await db
    .selectFrom("workflows")
    .select(["id"])
    .where("id", "=", workflowId)
    .where("userId", "=", userId)
    .single();
  if (!wf) return void res.status(404).json({ detail: "Workflow not found" });

  await db.deleteFrom("workflowShares").where("id", "=", shareId).where("workflowId", "=", workflowId);
  res.status(204).send();
}));

// POST /workflows/:workflowId/share
workflowsRouter.post("/:workflowId/share", requireAuth, asyncRoute(async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { workflowId } = req.params;
  const { emails, allow_edit } = req.body as { emails: string[]; allow_edit: boolean };

  if (!emails?.length) return void res.status(400).json({ detail: "emails is required" });
  const normalizedEmails = [
    ...new Set(
      emails
        .map((email) => email.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  if (normalizedEmails.length === 0) {
    return void res.status(400).json({ detail: "emails is required" });
  }
  const normalizedUserEmail = userEmail?.trim().toLowerCase();
  if (normalizedUserEmail && normalizedEmails.includes(normalizedUserEmail)) {
    return void res
      .status(400)
      .json({ detail: "You cannot share a workflow with yourself." });
  }

  const db = createServerDb();
  // Verify ownership
  const { data: wf } = await db
    .selectFrom("workflows")
    .select(["id"])
    .where("id", "=", workflowId)
    .where("userId", "=", userId)
    .where("isSystem", "=", false)
    .single();
  if (!wf) return void res.status(404).json({ detail: "Workflow not found or not editable" });

  const rows = normalizedEmails.map((email: string) => ({
    workflow_id: workflowId,
    shared_by_user_id: userId,
    shared_with_email: email,
    allow_edit: allow_edit ?? false,
  }));
  // Upsert on (workflow_id, shared_with_email) so re-sharing to the same
  // person updates the existing row instead of stacking duplicates.
  const { error } = await db
    .insertInto("workflowShares")
    .upsert(rows, { onConflict: "workflow_id,shared_with_email" });
  if (error) return void res.status(500).json({ detail: error.message });

  res.status(204).send();
}));

workflowsRouter.use(
  (err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    console.error("[workflows] unhandled route error", err);
    res.status(500).json({ detail: "Failed to process workflow request" });
  },
);
