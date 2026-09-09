import {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { randomUUID } from "node:crypto";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import {
  catalogWorkflowToLegacy,
  ensureDefaultWorkflows,
  findCatalogWorkflow,
  listActiveCatalogWorkflows,
  type LegacyCatalogWorkflow,
} from "../lib/workflowCatalog";
import {
  findMissingUserEmails,
  loadProfileUsersByEmail,
} from "../lib/userLookup";
import { workflowNameFromSkillMd } from "../lib/workflowName";
import { parsePaginationQuery } from "../lib/pagination";
import { normalizeSearchTerm } from "../lib/search";
import { parseWorkflowSort } from "../lib/sort";
import {
  buildWorkflowIdsOverviewRpcArgs,
  buildWorkflowsOverviewRpcArgs,
  parseWorkflowScope,
} from "../lib/workflowsOverview";
import { sendInternalError } from "../lib/httpError";
import {
  checkWorkflowAccess,
  ensureDocAccess,
  getOrgRole,
} from "../lib/access";
import { can, type ProjectRole } from "../lib/permissions";
import {
  deleteOrgAccessOverride,
  findOrgMemberByEmail,
  isOrgAssignableRole,
  listOrgAccessPeople,
  setOrgAccessOverrides,
} from "../lib/orgAccessOverrides";
import { convertedPdfKey } from "../lib/convert";
import { copyFile, storageKey } from "../lib/storage";
import { enqueueStorageCleanup } from "../lib/dbq/enqueue";
import {
  attachActiveVersionPaths,
  attachLatestVersionNumbers,
} from "../lib/documentVersions";
import { ensureResourceAccessSummaries } from "../lib/resourceAccessSummary";

export const workflowsRouter = Router();

type Db = ReturnType<typeof createServerSupabase>;
const isDev = process.env.NODE_ENV !== "production";
const devLog = (...args: Parameters<typeof console.log>) => {
  if (isDev) console.log(...args);
};

type WorkflowRecord = {
  id: string;
  user_id: string | null;
  org_id?: string | null;
  access_scope?: "private" | "shared" | "organization";
  organization_name?: string | null;
  direct_grant_count?: number;
  is_system?: boolean;
  title?: string;
  type?: string;
  prompt_md?: string | null;
  columns_config?: unknown;
  language?: string | null;
  version?: string | null;
  practice?: string | null;
  jurisdictions?: string[] | null;
  created_at?: string;
  [key: string]: unknown;
};

type WorkflowType = "assistant" | "tabular";

type WorkflowContributor = {
  name: string;
  organisation: string | null;
  role: string | null;
  linkedin: string | null;
};

type WorkflowMetadata = {
  name: string | null;
  title: string;
  description: string | null;
  type: WorkflowType;
  contributors: WorkflowContributor[];
  language: string;
  version: string | null;
  practice: string | null;
  jurisdictions: string[] | null;
};
type OpenSourceSubmissionStatus = "pending" | "approved" | "rejected";

type OpenSourceSubmissionRow = {
  id: string;
  workflow_id: string;
  submitted_by_user_id: string;
  submitter_email: string | null;
  submitter_name: string | null;
  contributor_mode?: "named" | "anonymous";
  status: OpenSourceSubmissionStatus;
  snapshot: unknown;
  submitted_at: string;
  updated_at: string;
  reviewed_at?: string | null;
  review_notes?: string | null;
};

type OpenSourceSubmissionSummary = Pick<
  OpenSourceSubmissionRow,
  "id" | "status" | "submitted_at" | "updated_at"
> & {
  reviewed_at?: string | null;
};

const DEFAULT_WORKFLOW_CONTRIBUTOR: WorkflowContributor = {
  name: "Mike",
  organisation: null,
  role: null,
  linkedin: null,
};
const DEFAULT_WORKFLOW_LANGUAGE = "English";
const DEFAULT_WORKFLOW_PRACTICE = "General Transactions";
const DEFAULT_WORKFLOW_JURISDICTIONS = ["General"];
const WORKFLOW_CONTRIBUTIONS_ENABLED =
  process.env.WORKFLOW_CONTRIBUTIONS_ENABLED === "true";

type WorkflowAccess = {
  workflow: WorkflowRecord;
  role: ProjectRole;
  allowEdit: boolean;
  isOwner: boolean;
} | null;

type AsyncRoute = (req: Request, res: Response) => Promise<unknown>;

function asyncRoute(handler: AsyncRoute) {
  return (req: Request, res: Response, next: NextFunction) => {
    void handler(req, res).catch(next);
  };
}

async function ensureDefaultsForRequest(
  userId: string,
  db: Db,
  res: Response,
): Promise<boolean> {
  try {
    await ensureDefaultWorkflows(userId, db);
    return true;
  } catch (error) {
    sendInternalError(res, error);
    return false;
  }
}

function withWorkflowAccess<T extends object>(
  workflow: T,
  access: {
    role: ProjectRole;
    allowEdit: boolean;
    isOwner: boolean;
    sharedByName?: string | null;
  },
) {
  return {
    ...workflow,
    access_role: access.role,
    allow_edit: access.allowEdit,
    is_owner: access.isOwner,
    shared_by_name: access.sharedByName ?? null,
  };
}

function withOpenSourceSubmission<T extends object>(
  workflow: T,
  submission: OpenSourceSubmissionSummary | null,
) {
  return {
    ...workflow,
    open_source_submission: submission,
  };
}

function withSystemWorkflowAccess(workflow: LegacyCatalogWorkflow) {
  return withWorkflowAccess(workflow, {
    role: "viewer",
    allowEdit: false,
    isOwner: false,
  });
}

function workflowTypeFrom(value: unknown): WorkflowType {
  return value === "tabular" ? "tabular" : "assistant";
}

function rejectAssetsForTabularWorkflow(
  access: NonNullable<WorkflowAccess>,
  res: Response,
): boolean {
  if (workflowTypeFrom(access.workflow.type) === "assistant") return false;
  res.status(400).json({
    detail: "Assets are only available for assistant workflows",
  });
  return true;
}

function metadataFromWorkflowRecord(
  workflow: WorkflowRecord,
): WorkflowMetadata {
  const type = workflowTypeFrom(workflow.type);
  return {
    name: workflowNameFromSkillMd(workflow.prompt_md),
    title: workflow.title ?? "",
    description: null,
    type,
    contributors: normalizeContributors(workflow.contributors) ?? [
      DEFAULT_WORKFLOW_CONTRIBUTOR,
    ],
    language: workflow.language ?? DEFAULT_WORKFLOW_LANGUAGE,
    version: workflow.version ?? null,
    practice: workflow.practice ?? DEFAULT_WORKFLOW_PRACTICE,
    jurisdictions: workflow.jurisdictions ?? DEFAULT_WORKFLOW_JURISDICTIONS,
  };
}

function withDatabaseWorkflow(workflow: WorkflowRecord) {
  const {
    title: _title,
    type: _type,
    contributors: _contributors,
    language: _language,
    version: _version,
    practice: _practice,
    jurisdictions: _jurisdictions,
    prompt_md,
    ...rest
  } = workflow;
  return {
    ...rest,
    metadata: metadataFromWorkflowRecord(workflow),
    skill_md: prompt_md ?? null,
    is_system: false,
  };
}

function withDatabaseWorkflowSummary(workflow: WorkflowRecord) {
  return {
    ...withDatabaseWorkflow(workflow),
    // List pages only need metadata. The detail route loads the full content.
    skill_md: null,
    columns_config: null,
  };
}

async function markDefaultWorkflows<T extends { id: string }>(
  db: Db,
  userId: string,
  workflows: T[],
): Promise<Array<T & { is_default: boolean; default_key: string | null }>> {
  if (workflows.length === 0) return [];
  const { data, error } = await db
    .from("default_workflow_installations")
    .select("workflow_id, default_key")
    .eq("user_id", userId)
    .in(
      "workflow_id",
      workflows.map((workflow) => workflow.id),
    );
  if (error) throw error;
  const defaultKeyByWorkflowId = new Map(
    (data ?? []).flatMap((row) =>
      row.workflow_id && row.default_key
        ? [[row.workflow_id, row.default_key] as const]
        : [],
    ),
  );
  return workflows.map((workflow) => ({
    ...workflow,
    is_default: defaultKeyByWorkflowId.has(workflow.id),
    default_key: defaultKeyByWorkflowId.get(workflow.id) ?? null,
  }));
}

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeJurisdictions(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const items = value
    .map((item) => normalizeOptionalString(item))
    .filter((item): item is string => !!item);
  return items.length > 0 ? Array.from(new Set(items)) : null;
}

function normalizeContributors(value: unknown): WorkflowContributor[] | null {
  if (!Array.isArray(value)) return null;
  const contributors = value
    .map((item): WorkflowContributor | null => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return null;
      const record = item as Record<string, unknown>;
      const name = normalizeOptionalString(record.name);
      if (!name) return null;
      return {
        name,
        organisation: normalizeOptionalString(record.organisation),
        role: normalizeOptionalString(record.role),
        linkedin: normalizeOptionalString(record.linkedin),
      };
    })
    .filter((item): item is WorkflowContributor => !!item);
  return contributors.length ? contributors : null;
}

function contributorFromName(name: unknown): WorkflowContributor {
  return {
    ...DEFAULT_WORKFLOW_CONTRIBUTOR,
    name: normalizeOptionalString(name) ?? DEFAULT_WORKFLOW_CONTRIBUTOR.name,
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
  const verdict = await checkWorkflowAccess(workflowId, userId, userEmail, db);
  if (!verdict.ok) return null;
  return {
    workflow: workflow as WorkflowRecord,
    role: verdict.projectRole,
    allowEdit: can(verdict.projectRole, "content.edit"),
    isOwner: can(verdict.projectRole, "access.manage"),
  };
}

// Owner-scoped workflow operations use the same effective resource role as
// the rest of the application. The creator is always an Owner, an org Admin
// defaults to Owner, and explicit organization overrides may assign another
// member Owner access.
async function resolveCreatorScopedWorkflow(
  workflowId: string,
  userId: string,
  userEmail: string | null | undefined,
  db: Db,
): Promise<WorkflowRecord | null> {
  const access = await resolveWorkflowAccess(workflowId, userId, userEmail, db);
  return access?.isOwner ? access.workflow : null;
}

function toOpenSourceSubmissionSummary(
  row: OpenSourceSubmissionRow,
): OpenSourceSubmissionSummary {
  return {
    id: row.id,
    status: row.status,
    submitted_at: row.submitted_at,
    updated_at: row.updated_at,
    reviewed_at: row.reviewed_at ?? null,
  };
}

async function getLatestOpenSourceSubmission(
  db: Db,
  workflowId: string,
  userId: string,
): Promise<OpenSourceSubmissionSummary | null> {
  const { data, error } = await db
    .from("workflow_open_source_submissions")
    .select("id, status, submitted_at, updated_at, reviewed_at")
    .eq("workflow_id", workflowId)
    .eq("submitted_by_user_id", userId)
    .order("submitted_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data
    ? toOpenSourceSubmissionSummary(data as OpenSourceSubmissionRow)
    : null;
}

function buildOpenSourceSnapshot(
  workflow: WorkflowRecord,
  contributors: WorkflowContributor[],
  contributorMode: "named" | "anonymous",
) {
  return {
    workflow_id: workflow.id,
    metadata: {
      ...metadataFromWorkflowRecord(workflow),
      contributors,
    },
    skill_md: workflow.prompt_md ?? null,
    columns_config: workflow.columns_config ?? null,
    contributor_mode: contributorMode,
    created_at: workflow.created_at ?? null,
  };
}

function validateOpenSourceWorkflow(workflow: WorkflowRecord): string | null {
  if (workflow.type === "assistant") {
    return typeof workflow.prompt_md === "string" && workflow.prompt_md.trim()
      ? null
      : "Assistant workflows need instructions before they can be opened source.";
  }
  if (workflow.type === "tabular") {
    return Array.isArray(workflow.columns_config) &&
      workflow.columns_config.length > 0
      ? null
      : "Tabular workflows need at least one column before they can be opened source.";
  }
  return "Workflow type must be 'assistant' or 'tabular'.";
}

const WORKFLOW_PAGINATION_QUERY_KEYS = [
  "limit",
  "offset",
  "search",
  "sort_key",
  "key",
  "sort_direction",
  "direction",
  "scope",
  "practice",
  "language",
  "jurisdiction",
];

// GET /workflows
workflowsRouter.get(
  "/",
  requireAuth,
  asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { type } = req.query as { type?: string };
    const db = createServerSupabase();
    const workflowType = typeof type === "string" && type ? type : null;

    if (!(await ensureDefaultsForRequest(userId, db, res))) return;

    const hasPaginationParams = WORKFLOW_PAGINATION_QUERY_KEYS.some(
      (key) => req.query[key] !== undefined,
    );
    if (hasPaginationParams) {
      const rpcArgs = buildWorkflowsOverviewRpcArgs({
        userId,
        userEmail,
        type: workflowType,
        scope: parseWorkflowScope(req.query.scope),
        pagination: parsePaginationQuery(req.query as Record<string, unknown>),
        searchTerm: normalizeSearchTerm(req.query.search),
        sort: parseWorkflowSort(req.query as Record<string, unknown>),
        practice: normalizeSearchTerm(req.query.practice),
        language: normalizeSearchTerm(req.query.language),
        jurisdiction: normalizeSearchTerm(req.query.jurisdiction),
      });
      const { data, error } = await db.rpc("get_workflows_overview", rpcArgs);
      if (error) return void sendInternalError(res, error);
      const accessSummary = await ensureResourceAccessSummaries(
        db,
        "workflow",
        (data ?? []) as WorkflowRecord[],
      );
      if (accessSummary.error)
        return void sendInternalError(res, accessSummary.error);
      const workflows = accessSummary.rows.map(withDatabaseWorkflowSummary);
      return void res.json(await markDefaultWorkflows(db, userId, workflows));
    }

    const { data, error } = await db.rpc("get_workflows_overview", {
      p_user_id: userId,
      p_user_email: userEmail ?? null,
      p_type: workflowType,
    });
    if (error) {
      return void sendInternalError(res, error);
    }

    const accessSummary = await ensureResourceAccessSummaries(
      db,
      "workflow",
      (data ?? []) as WorkflowRecord[],
    );
    if (accessSummary.error)
      return void sendInternalError(res, accessSummary.error);
    const databaseWorkflows = accessSummary.rows.map(withDatabaseWorkflow);
    res.json(await markDefaultWorkflows(db, userId, databaseWorkflows));
  }),
);

// Retained as a compatibility endpoint for older clients. The restructured
// Workflows page no longer exposes a System tab; non-default catalog entries
// are presented through /workflow-addons instead.
workflowsRouter.get(
  "/system",
  requireAuth,
  asyncRoute(async (req, res) => {
    const workflowType =
      req.query.type === "assistant" || req.query.type === "tabular"
        ? req.query.type
        : null;
    const db = createServerSupabase();
    const catalog = await listActiveCatalogWorkflows(db, {
      type: workflowType,
    });
    res.json(
      catalog.map(catalogWorkflowToLegacy).map(withSystemWorkflowAccess),
    );
  }),
);

// GET /workflows/filter-options (must come before /:workflowId routes)
workflowsRouter.get(
  "/filter-options",
  requireAuth,
  asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const type =
      req.query.type === "assistant" || req.query.type === "tabular"
        ? req.query.type
        : null;
    const scope = parseWorkflowScope(req.query.scope);
    const db = createServerSupabase();
    if (!(await ensureDefaultsForRequest(userId, db, res))) return;
    const { data, error } = await db.rpc("get_workflow_filter_options", {
      p_user_id: userId,
      p_user_email: userEmail ?? null,
      p_type: type,
      p_scope: scope,
    });
    if (error) return void sendInternalError(res, error);

    const row = (data?.[0] ?? {}) as Record<string, unknown>;
    const strings = (value: unknown) =>
      Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string")
        : [];
    res.json({
      practices: strings(row.practices),
      languages: strings(row.languages),
      jurisdictions: strings(row.jurisdictions),
    });
  }),
);

const WORKFLOW_IDS_PAGE_SIZE = 1000;
const WORKFLOW_IDS_MAX_PAGES = 200;

// GET /workflows/ids (must come before /:workflowId routes)
workflowsRouter.get(
  "/ids",
  requireAuth,
  asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const db = createServerSupabase();
    if (!(await ensureDefaultsForRequest(userId, db, res))) return;

    const workflowType =
      typeof req.query.type === "string" && req.query.type
        ? req.query.type
        : null;
    const searchTerm = normalizeSearchTerm(req.query.search);
    const scope = parseWorkflowScope(req.query.scope);
    const practice = normalizeSearchTerm(req.query.practice);
    const language = normalizeSearchTerm(req.query.language);
    const jurisdiction = normalizeSearchTerm(req.query.jurisdiction);

    const ids: { id: string; user_id: string }[] = [];
    let offset = 0;
    for (let page = 0; page < WORKFLOW_IDS_MAX_PAGES; page += 1) {
      const rpcArgs = buildWorkflowIdsOverviewRpcArgs({
        userId,
        userEmail,
        type: workflowType,
        scope,
        searchTerm,
        practice,
        language,
        jurisdiction,
        pagination: { limit: WORKFLOW_IDS_PAGE_SIZE, offset },
      });
      const { data, error } = await db.rpc(
        "get_workflow_ids_overview",
        rpcArgs,
      );
      if (error) return void sendInternalError(res, error);
      const rows = (data ?? []) as { id: string; user_id: string }[];
      if (rows.length === 0) break;
      ids.push(...rows);
      offset += rows.length;
    }

    res.json(ids);
  }),
);

// POST /workflows
workflowsRouter.post(
  "/",
  requireAuth,
  asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const { metadata, skill_md, columns_config, org_id } = req.body as {
      metadata?: Partial<WorkflowMetadata>;
      skill_md?: string;
      columns_config?: unknown;
      org_id?: unknown;
    };
    const title = metadata?.title;
    const type = metadata?.type;
    if (!title?.trim())
      return void res
        .status(400)
        .json({ detail: "metadata.title is required" });
    if (type !== "assistant" && type !== "tabular")
      return void res
        .status(400)
        .json({ detail: "metadata.type must be 'assistant' or 'tabular'" });

    const db = createServerSupabase();
    // Tenant assignment, exactly as POST /projects does it: an explicit
    // org_id must be one the caller belongs to, and its absence means
    // personal (org_id stays NULL, which IS the representation of personal
    // now that hidden personal orgs are gone). Workflows have no project to
    // inherit from, so an explicit id is the only context available.
    let orgId: string | null = null;
    if (org_id != null) {
      if (typeof org_id !== "string" || !org_id.trim())
        return void res
          .status(400)
          .json({ detail: "org_id must be a non-empty string" });
      const role = await getOrgRole(userId, org_id, db);
      if (!role)
        return void res
          .status(400)
          .json({ detail: "You are not a member of that organization." });
      orgId = org_id;
    }
    devLog("[workflows/create] request", {
      userId,
      title: title.trim(),
      type,
      hasSkill: typeof skill_md === "string" && skill_md.length > 0,
      columnCount: Array.isArray(columns_config) ? columns_config.length : null,
      language:
        normalizeOptionalString(metadata?.language) ??
        DEFAULT_WORKFLOW_LANGUAGE,
      practice: metadata?.practice ?? null,
      jurisdictions:
        normalizeJurisdictions(metadata?.jurisdictions) ??
        DEFAULT_WORKFLOW_JURISDICTIONS,
    });
    const { data, error } = await db
      .from("workflows")
      .insert({
        user_id: userId,
        title: title.trim(),
        type,
        prompt_md: skill_md ?? null,
        columns_config: columns_config ?? null,
        language:
          normalizeOptionalString(metadata?.language) ??
          DEFAULT_WORKFLOW_LANGUAGE,
        practice:
          normalizeOptionalString(metadata?.practice) ??
          DEFAULT_WORKFLOW_PRACTICE,
        jurisdictions:
          normalizeJurisdictions(metadata?.jurisdictions) ??
          DEFAULT_WORKFLOW_JURISDICTIONS,
        org_id: orgId,
      })
      .select("*")
      .single();
    if (error) {
      devLog("[workflows/create] insert error", {
        userId,
        title: title.trim(),
        type,
        code: error.code,
        message: error.message,
        details: error.details,
        hint: error.hint,
      });
      return void sendInternalError(res, error);
    }
    devLog("[workflows/create] inserted", {
      id: data?.id,
      user_id: data?.user_id,
      title: data?.title,
      type: data?.type,
    });
    res.status(201).json(
      withWorkflowAccess(
        withDatabaseWorkflow({
          ...(data as WorkflowRecord),
          access_scope: orgId ? "organization" : "private",
          organization_name: null,
        }),
        {
          role: "owner",
          allowEdit: true,
          isOwner: true,
        },
      ),
    );
  }),
);

async function handleWorkflowUpdate(req: Request, res: Response) {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { workflowId } = req.params;
  const updates: Record<string, unknown> = {};
  const metadata = req.body.metadata as Partial<WorkflowMetadata> | undefined;
  if (metadata?.title != null) updates.title = metadata.title;
  if (req.body.skill_md != null) updates.prompt_md = req.body.skill_md;
  if (req.body.columns_config != null)
    updates.columns_config = req.body.columns_config;
  if (metadata && "language" in metadata)
    updates.language = normalizeOptionalString(metadata.language);
  if (metadata && "practice" in metadata)
    updates.practice = metadata.practice ?? null;
  if (metadata && "jurisdictions" in metadata)
    updates.jurisdictions = normalizeJurisdictions(metadata.jurisdictions);

  const db = createServerSupabase();
  const access = await resolveWorkflowAccess(workflowId, userId, userEmail, db);
  if (!access || !access.allowEdit) {
    return void res
      .status(404)
      .json({ detail: "Workflow not found or not editable" });
  }
  const { data, error } = await db
    .from("workflows")
    .update(updates)
    .eq("id", workflowId)
    .select("*")
    .single();
  if (error || !data)
    return void res
      .status(404)
      .json({ detail: "Workflow not found or not editable" });
  res.json(
    withWorkflowAccess(withDatabaseWorkflow(data as WorkflowRecord), {
      role: access.role,
      allowEdit: access.allowEdit,
      isOwner: access.isOwner,
    }),
  );
}

// PUT /workflows/:workflowId
workflowsRouter.put(
  "/:workflowId",
  requireAuth,
  asyncRoute(handleWorkflowUpdate),
);

// PATCH /workflows/:workflowId
workflowsRouter.patch(
  "/:workflowId",
  requireAuth,
  asyncRoute(handleWorkflowUpdate),
);

// DELETE /workflows/:workflowId
workflowsRouter.delete(
  "/:workflowId",
  requireAuth,
  asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { workflowId } = req.params;
    const db = createServerSupabase();
    const catalogWorkflow = await findCatalogWorkflow(workflowId, db);
    if (catalogWorkflow) {
      return void res.json(
        withSystemWorkflowAccess(catalogWorkflowToLegacy(catalogWorkflow)),
      );
    }

    const workflow = await resolveCreatorScopedWorkflow(
      workflowId,
      userId,
      userEmail,
      db,
    );
    if (!workflow)
      return void res.status(404).json({ detail: "Workflow not found" });

    // Asset files are collected by workflow, not by creator: on a detached
    // workflow their user_id is NULL too, and scoping the cleanup to the
    // caller would orphan the storage objects the row delete is about to
    // strand.
    const { data: assets } = await db
      .from("documents")
      .select("id")
      .eq("workflow_id", workflowId);
    const assetIds = (assets ?? []).map((asset) => asset.id as string);
    const { data: assetVersions } = assetIds.length
      ? await db
          .from("document_versions")
          .select("storage_path, pdf_storage_path")
          .in("document_id", assetIds)
      : { data: [] };
    const { data: deleted, error } = await db
      .from("workflows")
      .delete()
      .eq("id", workflowId)
      .select("id");
    if (error) return void sendInternalError(res, error);
    if ((deleted ?? []).length > 0) {
      // Durable storage.cleanup job — previously fire-and-forget deletes
      // that leaked the files on any storage hiccup.
      await enqueueStorageCleanup(
        db,
        (assetVersions ?? []).flatMap((version) =>
          [version.storage_path, version.pdf_storage_path].filter(
            (path): path is string => !!path,
          ),
        ),
      );
    }
    res.status(204).send();
  }),
);

// GET /workflows/hidden
workflowsRouter.get(
  "/hidden",
  requireAuth,
  asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    const { data, error } = await db
      .from("hidden_workflows")
      .select("workflow_id")
      .eq("user_id", userId);
    if (error) return void sendInternalError(res, error);
    res.json((data ?? []).map((r) => r.workflow_id));
  }),
);

// POST /workflows/hidden
workflowsRouter.post(
  "/hidden",
  requireAuth,
  asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const { workflow_id } = req.body as { workflow_id: string };
    if (!workflow_id?.trim())
      return void res.status(400).json({ detail: "workflow_id is required" });
    const db = createServerSupabase();
    const { error } = await db
      .from("hidden_workflows")
      .upsert(
        { user_id: userId, workflow_id },
        { onConflict: "user_id,workflow_id" },
      );
    if (error) return void sendInternalError(res, error);
    res.status(204).send();
  }),
);

// DELETE /workflows/hidden/:workflowId
workflowsRouter.delete(
  "/hidden/:workflowId",
  requireAuth,
  asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const { workflowId } = req.params;
    const db = createServerSupabase();
    const { error } = await db
      .from("hidden_workflows")
      .delete()
      .eq("user_id", userId)
      .eq("workflow_id", workflowId);
    if (error) return void sendInternalError(res, error);
    res.status(204).send();
  }),
);

// POST /workflows/:workflowId/open-source
workflowsRouter.post(
  "/:workflowId/open-source",
  requireAuth,
  asyncRoute(async (req, res) => {
    if (!WORKFLOW_CONTRIBUTIONS_ENABLED) {
      return void res
        .status(404)
        .json({ detail: "Workflow contributions are disabled" });
    }

    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { workflowId } = req.params;
    const openSourceBody = req.body as {
      contributor_mode?: unknown;
      contributor?: unknown;
    };
    const requestedContributorMode =
      openSourceBody.contributor_mode === "named" ? "named" : "anonymous";
    const db = createServerSupabase();

    const { data: workflow, error: workflowError } = await db
      .from("workflows")
      .select("*")
      .eq("id", workflowId)
      .eq("user_id", userId)
      .maybeSingle();
    if (workflowError) {
      return void sendInternalError(res, workflowError);
    }
    if (!workflow) {
      return void res
        .status(404)
        .json({ detail: "Workflow not found or not open-sourceable" });
    }

    const workflowRecord = workflow as WorkflowRecord;
    const validationError = validateOpenSourceWorkflow(workflowRecord);
    if (validationError) {
      return void res.status(400).json({ detail: validationError });
    }

    const { data: profile } = await db
      .from("user_profiles")
      .select("display_name")
      .eq("user_id", userId)
      .maybeSingle();
    const submitterName =
      typeof profile?.display_name === "string" && profile.display_name.trim()
        ? profile.display_name.trim()
        : null;
    const submittedContributor =
      normalizeContributors([openSourceBody.contributor])?.[0] ??
      contributorFromName(submitterName || userEmail);
    const publicContributors =
      requestedContributorMode === "named"
        ? [submittedContributor]
        : [DEFAULT_WORKFLOW_CONTRIBUTOR];
    const now = new Date().toISOString();
    const snapshot = buildOpenSourceSnapshot(
      workflowRecord,
      publicContributors,
      requestedContributorMode,
    );

    const { data: pendingSubmission, error: pendingError } = await db
      .from("workflow_open_source_submissions")
      .select("*")
      .eq("workflow_id", workflowId)
      .eq("submitted_by_user_id", userId)
      .eq("status", "pending")
      .maybeSingle();
    if (pendingError) {
      return void sendInternalError(res, pendingError);
    }

    if (pendingSubmission) {
      const { data: updated, error: updateError } = await db
        .from("workflow_open_source_submissions")
        .update({
          submitter_email: userEmail ?? null,
          submitter_name:
            requestedContributorMode === "named" ? submitterName : null,
          contributor_mode: requestedContributorMode,
          snapshot,
          updated_at: now,
        })
        .eq("id", pendingSubmission.id)
        .select("id, status, submitted_at, updated_at, reviewed_at")
        .single();
      if (updateError || !updated) {
        return void sendInternalError(
          res,
          updateError ?? new Error("Submission update returned no data"),
        );
      }
      return void res.json({
        ...toOpenSourceSubmissionSummary(updated as OpenSourceSubmissionRow),
        mode: "updated",
      });
    }

    const { data: created, error: createError } = await db
      .from("workflow_open_source_submissions")
      .insert({
        workflow_id: workflowId,
        submitted_by_user_id: userId,
        submitter_email: userEmail ?? null,
        submitter_name:
          requestedContributorMode === "named" ? submitterName : null,
        contributor_mode: requestedContributorMode,
        status: "pending",
        snapshot,
        submitted_at: now,
        updated_at: now,
      })
      .select("id, status, submitted_at, updated_at, reviewed_at")
      .single();
    if (createError || !created) {
      return void sendInternalError(
        res,
        createError ?? new Error("Submission create returned no data"),
      );
    }

    res.status(201).json({
      ...toOpenSourceSubmissionSummary(created as OpenSourceSubmissionRow),
      mode: "created",
    });
  }),
);

// GET /workflows/:workflowId/assets
workflowsRouter.get(
  "/:workflowId/assets",
  requireAuth,
  asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const db = createServerSupabase();
    const access = await resolveWorkflowAccess(
      req.params.workflowId,
      userId,
      userEmail,
      db,
    );
    if (!access)
      return void res.status(404).json({ detail: "Workflow not found" });
    if (rejectAssetsForTabularWorkflow(access, res)) return;

    const { data, error } = await db
      .from("documents")
      .select("*")
      .eq("workflow_id", req.params.workflowId)
      .order("created_at", { ascending: true });
    if (error) return void sendInternalError(res, error);
    const assets = (data ?? []) as Array<{
      id: string;
      current_version_id?: string | null;
      latest_version_number?: number | null;
      [key: string]: unknown;
    }>;
    await attachLatestVersionNumbers(db, assets);
    await attachActiveVersionPaths(db, assets);
    res.json(assets);
  }),
);

// POST /workflows/:workflowId/assets/from-documents
workflowsRouter.post(
  "/:workflowId/assets/from-documents",
  requireAuth,
  asyncRoute(async (req, res) => {
    const documentIds = Array.isArray(req.body?.document_ids)
      ? [
          ...new Set(
            req.body.document_ids.filter(
              (documentId: unknown): documentId is string =>
                typeof documentId === "string" && documentId.trim().length > 0,
            ),
          ),
        ]
      : [];
    if (
      !Array.isArray(req.body?.document_ids) ||
      documentIds.length === 0 ||
      documentIds.length > 50 ||
      documentIds.length !== req.body.document_ids.length
    ) {
      return void res.status(400).json({
        detail: "document_ids must contain between 1 and 50 unique file IDs",
      });
    }

    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const workflowId = req.params.workflowId;
    const db = createServerSupabase();
    const access = await resolveWorkflowAccess(
      workflowId,
      userId,
      userEmail,
      db,
    );
    if (!access || !access.allowEdit) {
      return void res
        .status(404)
        .json({ detail: "Workflow not found or not editable" });
    }
    if (rejectAssetsForTabularWorkflow(access, res)) return;

    const { data: sourceDocuments, error: documentsError } = await db
      .from("documents")
      // org_id and workflow_id are part of the VERDICT, not decoration:
      // ensureDocAccess falls through project -> workflow -> org, so a
      // document selected without them looks container-less and is refused.
      // Omitting org_id made every organization-library file unattachable —
      // "One or more files could not be found" for a file the caller is
      // looking straight at.
      .select(
        "id, user_id, project_id, org_id, workflow_id, current_version_id",
      )
      .in("id", documentIds);
    if (documentsError) return void sendInternalError(res, documentsError);
    if (!sourceDocuments || sourceDocuments.length !== documentIds.length) {
      return void res
        .status(404)
        .json({ detail: "One or more files could not be found" });
    }

    const accessResults = await Promise.all(
      sourceDocuments.map((document) =>
        ensureDocAccess(document, userId, userEmail, db),
      ),
    );
    if (accessResults.some((result) => !result.ok)) {
      return void res
        .status(404)
        .json({ detail: "One or more files could not be found" });
    }

    const versionIds = sourceDocuments.flatMap((document) =>
      document.current_version_id ? [document.current_version_id] : [],
    );
    if (versionIds.length !== documentIds.length) {
      return void res
        .status(409)
        .json({ detail: "One or more files are not ready" });
    }
    const { data: sourceVersions, error: versionsError } = await db
      .from("document_versions")
      .select(
        "id, document_id, storage_path, pdf_storage_path, filename, file_type, size_bytes, page_count, content_sha256",
      )
      .in("id", versionIds)
      .is("deleted_at", null);
    if (versionsError) return void sendInternalError(res, versionsError);
    if (
      !sourceVersions ||
      sourceVersions.length !== documentIds.length ||
      sourceVersions.some(
        (version) => !version.storage_path || !version.filename,
      )
    ) {
      return void res
        .status(409)
        .json({ detail: "One or more files are not ready" });
    }

    const sourceDocumentById = new Map(
      sourceDocuments.map((document) => [document.id, document]),
    );
    const sourceVersionById = new Map(
      sourceVersions.map((version) => [version.id, version]),
    );
    if (
      sourceDocuments.some(
        (document) =>
          sourceVersionById.get(document.current_version_id)?.document_id !==
          document.id,
      )
    ) {
      return void res
        .status(409)
        .json({ detail: "One or more files are not ready" });
    }
    const plans = documentIds.map((sourceDocumentId) => {
      const sourceDocument = sourceDocumentById.get(sourceDocumentId)!;
      const sourceVersion = sourceVersionById.get(
        sourceDocument.current_version_id,
      )!;
      const documentId = randomUUID();
      const versionId = randomUUID();
      const sourcePath = storageKey(userId, documentId, sourceVersion.filename);
      const pdfPath = sourceVersion.pdf_storage_path
        ? sourceVersion.pdf_storage_path === sourceVersion.storage_path
          ? sourcePath
          : convertedPdfKey(userId, documentId)
        : null;
      return {
        documentId,
        versionId,
        sourceVersion,
        sourcePath,
        pdfPath,
      };
    });
    const copiedPaths = new Set<string>();

    try {
      for (const plan of plans) {
        copiedPaths.add(plan.sourcePath);
        await copyFile(plan.sourceVersion.storage_path, plan.sourcePath);
        if (
          plan.pdfPath &&
          plan.pdfPath !== plan.sourcePath &&
          plan.sourceVersion.pdf_storage_path
        ) {
          copiedPaths.add(plan.pdfPath);
          await copyFile(plan.sourceVersion.pdf_storage_path, plan.pdfPath);
        }
      }

      const { error: insertDocumentsError } = await db.from("documents").insert(
        plans.map((plan) => ({
          id: plan.documentId,
          project_id: null,
          user_id: userId,
          status: "ready",
          folder_id: null,
          library_kind: "workflow_asset",
          library_folder_id: null,
          workflow_id: workflowId,
        })),
      );
      if (insertDocumentsError) throw insertDocumentsError;

      const { error: insertVersionsError } = await db
        .from("document_versions")
        .insert(
          plans.map((plan) => ({
            id: plan.versionId,
            document_id: plan.documentId,
            storage_path: plan.sourcePath,
            pdf_storage_path: plan.pdfPath,
            source: "upload",
            version_number: 1,
            filename: plan.sourceVersion.filename,
            file_type: plan.sourceVersion.file_type,
            size_bytes: plan.sourceVersion.size_bytes,
            page_count: plan.sourceVersion.page_count,
            content_sha256: plan.sourceVersion.content_sha256,
          })),
        );
      if (insertVersionsError) throw insertVersionsError;

      for (const plan of plans) {
        const { error: updateError } = await db
          .from("documents")
          .update({
            current_version_id: plan.versionId,
            updated_at: new Date().toISOString(),
          })
          .eq("id", plan.documentId);
        if (updateError) throw updateError;
      }

      const createdIds = plans.map((plan) => plan.documentId);
      const { data: createdDocuments, error: createdDocumentsError } = await db
        .from("documents")
        .select("*")
        .in("id", createdIds);
      if (
        createdDocumentsError ||
        !createdDocuments ||
        createdDocuments.length !== createdIds.length
      ) {
        throw (
          createdDocumentsError ??
          new Error("Workflow asset copy returned no documents")
        );
      }
      await attachLatestVersionNumbers(db, createdDocuments);
      await attachActiveVersionPaths(db, createdDocuments);
      const createdById = new Map(
        createdDocuments.map((document) => [document.id, document]),
      );
      res.status(201).json(createdIds.map((id) => createdById.get(id)));
    } catch (error) {
      const createdIds = plans.map((plan) => plan.documentId);
      await db.from("documents").delete().in("id", createdIds);
      await enqueueStorageCleanup(db, [...copiedPaths]);
      sendInternalError(res, error);
    }
  }),
);

// DELETE /workflows/:workflowId/assets/:assetId
workflowsRouter.delete(
  "/:workflowId/assets/:assetId",
  requireAuth,
  asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const db = createServerSupabase();
    const access = await resolveWorkflowAccess(
      req.params.workflowId,
      userId,
      userEmail,
      db,
    );
    if (!access || !access.allowEdit) {
      return void res
        .status(404)
        .json({ detail: "Workflow not found or not editable" });
    }
    if (rejectAssetsForTabularWorkflow(access, res)) return;
    const { data: asset } = await db
      .from("documents")
      .select("id")
      .eq("id", req.params.assetId)
      .eq("workflow_id", req.params.workflowId)
      .maybeSingle();
    if (!asset) {
      return void res.status(404).json({ detail: "Asset not found" });
    }
    const { data: versions, error: versionsError } = await db
      .from("document_versions")
      .select("storage_path, pdf_storage_path")
      .eq("document_id", asset.id);
    if (versionsError) return void sendInternalError(res, versionsError);
    const { error } = await db
      .from("documents")
      .delete()
      .eq("id", asset.id)
      .eq("workflow_id", req.params.workflowId);
    if (error) return void sendInternalError(res, error);
    // Row first, file second (durable): a failed row delete leaves the file
    // referenced and intact; a crash after it still cleans the file up.
    await enqueueStorageCleanup(
      db,
      (versions ?? []).flatMap((version) =>
        [version.storage_path, version.pdf_storage_path].filter(
          (path): path is string => !!path,
        ),
      ),
    );
    res.status(204).send();
  }),
);

// GET /workflows/:workflowId
workflowsRouter.get(
  "/:workflowId",
  requireAuth,
  asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { workflowId } = req.params;
    const db = createServerSupabase();
    const catalogWorkflow = await findCatalogWorkflow(workflowId, db);
    if (catalogWorkflow) {
      return void res.json(
        withSystemWorkflowAccess(catalogWorkflowToLegacy(catalogWorkflow)),
      );
    }

    const access = await resolveWorkflowAccess(
      workflowId,
      userId,
      userEmail,
      db,
    );
    if (!access)
      return void res.status(404).json({ detail: "Workflow not found" });
    const openSourceSubmission = access.isOwner
      ? await getLatestOpenSourceSubmission(db, workflowId, userId)
      : null;
    const { data: installation } = access.isOwner
      ? await db
          .from("default_workflow_installations")
          .select("id")
          .eq("workflow_id", workflowId)
          .eq("user_id", userId)
          .maybeSingle()
      : { data: null };
    res.json({
      ...withOpenSourceSubmission(
        withWorkflowAccess(withDatabaseWorkflow(access.workflow), {
          role: access.role,
          allowEdit: access.allowEdit,
          isOwner: access.isOwner,
        }),
        openSourceSubmission,
      ),
      is_default: !!installation,
    });
  }),
);

// GET /workflows/:workflowId/shares
workflowsRouter.get(
  "/:workflowId/people",
  requireAuth,
  asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { workflowId } = req.params;
    const db = createServerSupabase();
    const access = await resolveWorkflowAccess(
      workflowId,
      userId,
      userEmail,
      db,
    );
    if (!access)
      return void res.status(404).json({ detail: "Workflow not found" });

    const orgId =
      (access.workflow as { org_id?: string | null }).org_id ?? null;
    if (orgId) {
      const listed = await listOrgAccessPeople(db, {
        kind: "workflow",
        resourceId: workflowId,
        orgId,
        creatorId: access.workflow.user_id,
      });
      if (!listed.ok) return void sendInternalError(res, listed.detail);
      const creator = listed.people.find(
        (person) => person.user_id === access.workflow.user_id,
      );
      return void res.json({
        scope: "organization",
        owner: creator
          ? {
              user_id: creator.user_id,
              email: creator.email,
              display_name: creator.display_name,
              role: "owner",
            }
          : null,
        members: listed.people.filter(
          (person) => person.user_id !== access.workflow.user_id,
        ),
      });
    }

    const { data: shares, error } = await db
      .from("workflow_shares")
      .select("shared_with_email, role")
      .eq("workflow_id", workflowId);
    if (error) return void sendInternalError(res, error);
    const { userByEmail, userById } = await loadProfileUsersByEmail(db);
    const creator = access.workflow.user_id
      ? userById.get(access.workflow.user_id)
      : undefined;
    res.json({
      scope: "direct",
      owner: access.workflow.user_id
        ? {
            user_id: access.workflow.user_id,
            email: creator?.email ?? null,
            display_name: creator?.display_name ?? null,
            role: "owner",
          }
        : null,
      members: (
        (shares ?? []) as {
          shared_with_email: string;
          role: ProjectRole;
        }[]
      ).map((share) => ({
        email: share.shared_with_email,
        display_name:
          userByEmail.get(share.shared_with_email)?.display_name ?? null,
        role: share.role,
      })),
    });
  }),
);

workflowsRouter.get(
  "/:workflowId/shares",
  requireAuth,
  asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { workflowId } = req.params;
    const db = createServerSupabase();

    const wf = await resolveCreatorScopedWorkflow(
      workflowId,
      userId,
      userEmail,
      db,
    );
    if (!wf)
      return void res
        .status(404)
        .json({ detail: "Workflow not found or not editable" });

    const orgId = (wf as { org_id?: string | null }).org_id ?? null;
    if (orgId) {
      const listed = await listOrgAccessPeople(db, {
        kind: "workflow",
        resourceId: workflowId,
        orgId,
        creatorId: wf.user_id,
      });
      if (!listed.ok) return void sendInternalError(res, listed.detail);
      return void res.json(
        listed.people
          .filter(
            (person) => person.user_id !== wf.user_id && person.has_override,
          )
          .map((person) => ({
            id: person.user_id,
            user_id: person.user_id,
            shared_with_email: person.email,
            display_name: person.display_name,
            role: person.role,
          })),
      );
    }

    const { data: shares, error } = await db
      .from("workflow_shares")
      .select("id, shared_with_email, role, created_at")
      .eq("workflow_id", workflowId)
      .order("created_at", { ascending: true });
    if (error) return void sendInternalError(res, error);

    res.json(shares ?? []);
  }),
);

// DELETE /workflows/:workflowId/shares/:shareId
workflowsRouter.delete(
  "/:workflowId/shares/:shareId",
  requireAuth,
  asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { workflowId, shareId } = req.params;
    const db = createServerSupabase();

    const wf = await resolveCreatorScopedWorkflow(
      workflowId,
      userId,
      userEmail,
      db,
    );
    if (!wf) return void res.status(404).json({ detail: "Workflow not found" });

    const orgId = (wf as { org_id?: string | null }).org_id ?? null;
    if (orgId) {
      const result = await deleteOrgAccessOverride(db, {
        kind: "workflow",
        resourceId: workflowId,
        userId: shareId,
      });
      if (!result.ok) return void sendInternalError(res, result.detail);
      if (!result.removed)
        return void res
          .status(404)
          .json({ detail: "Access override not found" });
    } else {
      // Read the result. Ignoring it made a failed delete and an unknown
      // share id indistinguishable from a real revocation: both answered
      // 204, so the client removed the row from its list while the person
      // it named kept access. Mirrors DELETE /projects/:id/access/:email.
      const { data: removed, error } = await db
        .from("workflow_shares")
        .delete()
        .eq("id", shareId)
        .eq("workflow_id", workflowId)
        .select("id");
      if (error) return void sendInternalError(res, error);
      if (((removed ?? []) as unknown[]).length === 0)
        return void res.status(404).json({ detail: "Access grant not found" });
    }
    res.status(204).send();
  }),
);

// POST /workflows/:workflowId/share
workflowsRouter.post(
  "/:workflowId/share",
  requireAuth,
  asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { workflowId } = req.params;
    const { emails, role } = req.body as {
      emails: string[];
      role: unknown;
    };

    if (!emails?.length)
      return void res.status(400).json({ detail: "emails is required" });
    const normalizedEmails = [
      ...new Set(
        emails.map((email) => email.trim().toLowerCase()).filter(Boolean),
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

    const db = createServerSupabase();

    // Any effective Owner may manage access. Personal grants are stored by
    // normalized email and may only target an existing user; organization
    // overrides require a current organization member.
    const wf = await resolveCreatorScopedWorkflow(
      workflowId,
      userId,
      userEmail,
      db,
    );
    if (!wf)
      return void res
        .status(404)
        .json({ detail: "Workflow not found or not editable" });

    const orgId = (wf as { org_id?: string | null }).org_id ?? null;
    if (orgId) {
      if (!isOrgAssignableRole(role))
        return void res.status(400).json({
          detail: "role must be owner, editor, viewer or deny",
        });
      // Validate EVERY target before writing ANY override. Interleaving the
      // two loops meant a rejected third email — a non-member, the creator,
      // an admin — returned 400 with the first two overrides already
      // persisted: the caller read "nothing happened" while access had
      // silently changed for two people.
      const targets: { userId: string }[] = [];
      for (const email of normalizedEmails) {
        const target = await findOrgMemberByEmail(db, orgId, email);
        if (!target.ok) {
          if (target.kind === "not_found")
            return void res.status(400).json({ detail: target.detail });
          return void sendInternalError(res, target.detail);
        }
        if (target.member.userId === wf.user_id)
          return void res
            .status(400)
            .json({ detail: "The creator is always an owner" });
        if (target.member.orgRole === "admin")
          return void res.status(400).json({
            detail: "Organization admins always have owner access",
          });
        targets.push({ userId: target.member.userId });
      }
      // Validation is complete, so only a database failure can still stop
      // this — and it must not stop it HALF WAY. One bulk upsert is one
      // statement: the org-membership triggers on the override table can
      // still refuse a row, and when they do the whole batch rolls back
      // instead of leaving the people ahead of the refusal already granted.
      const written = await setOrgAccessOverrides(db, {
        kind: "workflow",
        resourceId: workflowId,
        orgId,
        userIds: targets.map((target) => target.userId),
        role,
        assignedBy: userId,
      });
      if (!written.ok) return void sendInternalError(res, written.detail);
      return void res.status(204).send();
    }

    if (role !== "owner" && role !== "editor" && role !== "viewer")
      return void res.status(400).json({
        detail: "role must be owner, editor or viewer",
      });

    let missingEmails: string[];
    try {
      missingEmails = await findMissingUserEmails(db, normalizedEmails);
    } catch (error) {
      return void sendInternalError(res, error);
    }
    if (missingEmails.length > 0)
      return void res.status(400).json({
        detail: `${missingEmails[0]} does not belong to a Mike user.`,
      });

    const rows = normalizedEmails.map((email: string) => ({
      workflow_id: workflowId,
      shared_by_user_id: userId,
      shared_with_email: email,
      role,
    }));
    // Upsert on (workflow_id, shared_with_email) so re-sharing to the same
    // person updates the existing row instead of stacking duplicates.
    const { error } = await db
      .from("workflow_shares")
      .upsert(rows, { onConflict: "workflow_id,shared_with_email" });
    if (error) return void sendInternalError(res, error);

    res.status(204).send();
  }),
);

workflowsRouter.use(
  (err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    console.error("[workflows] unhandled route error", err);
    res.status(500).json({ detail: "Failed to process workflow request" });
  },
);
