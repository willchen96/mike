import { Router, type Request, type Response } from "express";
import { requireAuth, requireMfaIfEnrolled } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import { enqueueStorageCleanup } from "../lib/dbq/enqueue";
import { createClient } from "@supabase/supabase-js";
import {
  attachActiveVersionPaths,
  attachLatestVersionNumbers,
  contentSha256,
} from "../lib/documentVersions";
import { sendInternalError } from "../lib/httpError";
import {
  buildProjectExportManifest,
  projectManifestFilename,
} from "../lib/userDataExport";
import {
  deleteFile,
  downloadFile,
  uploadFile,
  storageKey,
} from "../lib/storage";
import { convertedPdfKey } from "../lib/convert";
import {
  checkProjectAccess,
  getOrgRole,
  normalizeEmail,
  resolveContentOrgId,
} from "../lib/access";
import { can, type ProjectRole } from "../lib/permissions";
import {
  deleteProjectGrant,
  listProjectAdminContacts,
  listProjectGrants,
  upsertProjectGrant,
} from "../lib/projectAccess";
import {
  deleteOrgAccessOverride,
  findOrgMemberByEmail,
  isOrgAssignableRole,
  listOrgAccessPeople,
  setOrgAccessOverride,
} from "../lib/orgAccessOverrides";
import { deleteProjectsByIds } from "../lib/userDataCleanup";
import { contentTypeForDocumentType } from "../lib/documentTypes";
import { loadProfileUsersByEmail } from "../lib/userLookup";
import { parsePaginationQuery } from "../lib/pagination";
import { normalizeSearchTerm } from "../lib/search";
import { parseProjectSort } from "../lib/sort";
import {
  buildProjectIdsOverviewRpcArgs,
  buildProjectsOverviewRpcArgs,
  parseProjectScope,
} from "../lib/projectsOverview";
import { ensureResourceAccessSummaries } from "../lib/resourceAccessSummary";

export const projectsRouter = Router();

/**
 * A project the caller can open but not write to is not a missing project.
 * Collapsing "you cannot see this" and "your role is read-only" into one 404
 * told a Viewer their matter had vanished, so every write gate answers 404
 * only when checkProjectAccess itself refuses, and 403 with an intentional
 * message when the role is simply too low.
 */
const DOCS_ORGANIZE_FORBIDDEN =
  "You do not have permission to organize documents in this project.";

function normalizeOptionalString(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeDocumentFilename(nextName: unknown, currentName: string) {
  if (typeof nextName !== "string") return null;
  const trimmed = nextName.trim().slice(0, 200);
  if (!trimmed) return null;
  if (/\.[a-z0-9]{1,6}$/i.test(trimmed)) return trimmed;
  const ext = currentName.match(/\.[a-z0-9]{1,6}$/i)?.[0] ?? "";
  return `${trimmed}${ext}`;
}

async function deleteProjectDocumentsAndVersionFiles(
  db: ReturnType<typeof createServerSupabase>,
  projectId: string,
  documentIds: string[],
) {
  if (documentIds.length === 0) return null;
  const { data: versions, error: versionsError } = await db
    .from("document_versions")
    .select("storage_path, pdf_storage_path")
    .in("document_id", documentIds);
  if (versionsError) return versionsError;

  const paths = new Set<string>();
  for (const v of versions ?? []) {
    if (typeof v.storage_path === "string" && v.storage_path.length > 0) {
      paths.add(v.storage_path);
    }
    if (
      typeof v.pdf_storage_path === "string" &&
      v.pdf_storage_path.length > 0
    ) {
      paths.add(v.pdf_storage_path);
    }
  }
  const { error } = await db
    .from("documents")
    .delete()
    .eq("project_id", projectId)
    .in("id", documentIds);
  // Rows first, files second (durable storage.cleanup job) — previously each
  // file delete was fire-and-forget, so one storage hiccup leaked the bytes.
  if (!error) await enqueueStorageCleanup(db, [...paths]);
  return error ?? null;
}

async function attachDocumentOwnerLabels(
  db: ReturnType<typeof createServerSupabase>,
  docs: { user_id?: string | null }[],
) {
  const ownerIds = docs
    .map((doc) => doc.user_id)
    .filter((id): id is string => typeof id === "string" && id.length > 0)
    .filter((id, index, arr) => arr.indexOf(id) === index);
  if (ownerIds.length === 0) return;

  const displayNameByUserId = new Map<string, string>();
  const { data: profiles, error: profilesError } = await db
    .from("user_profiles")
    .select("user_id, display_name")
    .in("user_id", ownerIds);
  if (profilesError) {
    console.warn(
      "[projects] failed to load document owner profiles",
      profilesError,
    );
  }
  for (const profile of profiles ?? []) {
    const displayName =
      typeof profile.display_name === "string"
        ? profile.display_name.trim()
        : "";
    if (displayName) {
      displayNameByUserId.set(profile.user_id as string, displayName);
    }
  }

  for (const doc of docs as {
    user_id?: string | null;
    owner_email?: string | null;
    owner_display_name?: string | null;
  }[]) {
    if (!doc.user_id) continue;
    doc.owner_email = null;
    doc.owner_display_name = displayNameByUserId.get(doc.user_id) ?? null;
  }
}

async function attachChatCreatorLabels(
  db: ReturnType<typeof createServerSupabase>,
  chats: { user_id?: string | null }[],
) {
  const creatorIds = chats
    .map((chat) => chat.user_id)
    .filter((id): id is string => typeof id === "string" && id.length > 0)
    .filter((id, index, arr) => arr.indexOf(id) === index);
  if (creatorIds.length === 0) return;

  const displayNameByUserId = new Map<string, string>();
  const { data: profiles, error: profilesError } = await db
    .from("user_profiles")
    .select("user_id, display_name")
    .in("user_id", creatorIds);
  if (profilesError) {
    console.warn(
      "[projects] failed to load chat creator profiles",
      profilesError,
    );
  }
  for (const profile of profiles ?? []) {
    const displayName =
      typeof profile.display_name === "string"
        ? profile.display_name.trim()
        : "";
    if (displayName) {
      displayNameByUserId.set(profile.user_id as string, displayName);
    }
  }

  for (const chat of chats as {
    user_id?: string | null;
    creator_display_name?: string | null;
  }[]) {
    if (!chat.user_id) continue;
    chat.creator_display_name = displayNameByUserId.get(chat.user_id) ?? null;
  }
}

async function loadProjectDirectoryLevel(
  db: ReturnType<typeof createServerSupabase>,
  projectId: string,
  parentFolderId: string | null,
  pagination: { limit: number; offset: number },
) {
  let documentsQuery = db
    .from("documents")
    .select("*")
    .eq("project_id", projectId);
  let foldersQuery = db
    .from("project_subfolders")
    .select("*")
    .eq("project_id", projectId);
  documentsQuery = parentFolderId
    ? documentsQuery.eq("folder_id", parentFolderId)
    : documentsQuery.is("folder_id", null);
  foldersQuery = parentFolderId
    ? foldersQuery.eq("parent_folder_id", parentFolderId)
    : foldersQuery.is("parent_folder_id", null);

  const [
    { data: documents, error: documentsError },
    { data: folders, error: foldersError },
  ] = await Promise.all([
    documentsQuery
      .order("updated_at", { ascending: false })
      .range(pagination.offset, pagination.offset + pagination.limit),
    foldersQuery.order("updated_at", { ascending: false }),
  ]);
  if (documentsError)
    return { error: documentsError, documents: [], folders: [] };
  if (foldersError) return { error: foldersError, documents: [], folders: [] };

  const rows = documents ?? [];
  const documentsHasMore = rows.length > pagination.limit;
  const page = (documentsHasMore ? rows.slice(0, pagination.limit) : rows) as {
    id: string;
    user_id?: string | null;
    current_version_id?: string | null;
  }[];
  await attachLatestVersionNumbers(db, page);
  await attachActiveVersionPaths(db, page);
  await attachDocumentOwnerLabels(db, page);
  return {
    error: null,
    documents: page,
    folders: folders ?? [],
    documentsHasMore,
  };
}

// GET /projects
// Pass ?include=documents to also receive each project's documents in the
// same response. The directory pickers (useDirectoryData) previously fanned
// out one GET /projects/:id per project to obtain those documents; with N
// projects that burst — auth check plus several DB queries per request —
// could overwhelm the Supabase gateway. Batching keeps it at one request
// and a fixed number of queries regardless of project count.
//
// Pagination is opt-in via query params (limit/offset/search/sort_key or
// key/scope). ProjectsOverview.tsx sends them. Legacy tabular-review project
// pickers call this with no query params and must keep getting the full,
// unpaginated list, so the branch below must never default
// to paginating a request that didn't ask for it.
const PROJECT_PAGINATION_QUERY_KEYS = [
  "limit",
  "offset",
  "search",
  "sort_key",
  "key",
  "sort_direction",
  "direction",
  "scope",
  "practice",
  "owner_user_id",
];

projectsRouter.get("/", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const normalizedUserEmail = userEmail?.trim().toLowerCase();
  const includeDocuments = req.query.include === "documents";

  if (req.query.view === "directory-search") {
    return handleProjectDirectorySearch(req, res);
  }

  const db = createServerSupabase();
  if (req.query.view === "summary") {
    const pagination = parsePaginationQuery(
      req.query as Record<string, unknown>,
    );
    const { data, error } = await db.rpc("get_project_summaries", {
      p_user_id: userId,
      p_user_email: normalizedUserEmail ?? null,
      p_limit: pagination.limit,
      p_offset: pagination.offset,
    });
    if (error) return void sendInternalError(res, error);
    return void res.json(data ?? []);
  }

  const hasPaginationParams = PROJECT_PAGINATION_QUERY_KEYS.some(
    (key) => req.query[key] !== undefined,
  );

  const rpcArgs = hasPaginationParams
    ? buildProjectsOverviewRpcArgs({
        userId,
        userEmail: normalizedUserEmail,
        scope: parseProjectScope(req.query.scope),
        pagination: parsePaginationQuery(
          req.query as Record<string, unknown>,
        ),
        searchTerm: normalizeSearchTerm(req.query.search),
        sort: parseProjectSort(req.query as Record<string, unknown>),
        practice: normalizeSearchTerm(req.query.practice),
        ownerUserId: normalizeSearchTerm(req.query.owner_user_id),
      })
    : { p_user_id: userId, p_user_email: normalizedUserEmail ?? null };

  const { data, error } = await db.rpc("get_projects_overview", rpcArgs);
  if (error) return void sendInternalError(res, error);

  const accessSummary = await ensureResourceAccessSummaries(
    db,
    "project",
    (data ?? []) as { id: string }[],
  );
  if (accessSummary.error)
    return void sendInternalError(res, accessSummary.error);
  const projects = accessSummary.rows;
  if (!includeDocuments || projects.length === 0) {
    return void res.json(projects);
  }

  const projectIds = projects.map((p) => p.id);
  const [
    { data: docs, error: docsError },
    { data: folders, error: foldersError },
  ] = await Promise.all([
    db
      .from("documents")
      .select("*")
      .in("project_id", projectIds)
      .order("created_at", { ascending: true }),
    db
      .from("project_subfolders")
      .select("*")
      .in("project_id", projectIds)
      .order("created_at", { ascending: true }),
  ]);
  if (docsError)
    return void sendInternalError(res, docsError);
  if (foldersError)
    return void sendInternalError(res, foldersError);

  const docsTyped = (docs ?? []) as unknown as {
    id: string;
    project_id?: string | null;
    user_id?: string | null;
    current_version_id?: string | null;
  }[];
  await attachLatestVersionNumbers(db, docsTyped);
  await attachActiveVersionPaths(db, docsTyped);
  await attachDocumentOwnerLabels(db, docsTyped);

  const docsByProject = new Map<string, typeof docsTyped>();
  for (const doc of docsTyped) {
    if (!doc.project_id) continue;
    const bucket = docsByProject.get(doc.project_id);
    if (bucket) bucket.push(doc);
    else docsByProject.set(doc.project_id, [doc]);
  }
  const foldersByProject = new Map<string, NonNullable<typeof folders>>();
  for (const folder of folders ?? []) {
    const projectId = folder.project_id as string;
    const bucket = foldersByProject.get(projectId);
    if (bucket) bucket.push(folder);
    else foldersByProject.set(projectId, [folder]);
  }
  res.json(
    projects.map((p) => ({
      ...p,
      documents: docsByProject.get(p.id) ?? [],
      folders: foldersByProject.get(p.id) ?? [],
    })),
  );
});

// POST /projects
projectsRouter.post("/", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  if (
    req.body &&
    typeof req.body === "object" &&
    "shared_with" in req.body
  )
    return void res.status(400).json({
      detail:
        "shared_with is no longer supported; use the project access endpoints.",
    });
  const { name, cm_number, practice, org_id } = req.body as {
    name: string;
    cm_number?: string;
    practice?: string;
    org_id?: string | null;
  };
  if (!name?.trim())
    return void res.status(400).json({ detail: "name is required" });
  const db = createServerSupabase();

  // Tenant assignment: an explicit org_id must be one the caller belongs to.
  // No org_id means a personal project — org_id stays NULL, which is the
  // whole representation of "personal" now that hidden personal orgs are gone.
  let resolvedOrgId: string | null = null;
  if (org_id) {
    const role = await getOrgRole(userId, org_id, db);
    if (!role)
      return void res
        .status(400)
        .json({ detail: "You are not a member of that organization." });
    resolvedOrgId = org_id;
  }

  const { data, error } = await db
    .from("projects")
    .insert({
      user_id: userId,
      name: name.trim(),
      cm_number: normalizeOptionalString(cm_number),
      practice: normalizeOptionalString(practice),
      org_id: resolvedOrgId,
    })
    .select("*")
    .single();
  if (error) return void sendInternalError(res, error);
  res.status(201).json({
    ...data,
    documents: [],
    is_owner: true,
    access_role: "owner",
    access_scope: resolvedOrgId ? "organization" : "private",
    organization_name: null,
  });
});

// GET /projects?view=directory-search
// Flat filename/project matches for the document picker. Search results do
// not pretend that a partially loaded project tree is a complete result set.
async function handleProjectDirectorySearch(req: Request, res: Response) {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const searchTerm = normalizeSearchTerm(req.query.search);
  if (!searchTerm) return void res.json([]);
  const pagination = parsePaginationQuery(
    req.query as Record<string, unknown>,
  );
  const db = createServerSupabase();
  const normalizedUserEmail = userEmail?.trim().toLowerCase();

  const createdQuery = db.from("projects").select("*").eq("user_id", userId);
  const projectQueries = [createdQuery];
  if (normalizedUserEmail) {
    // Direct access now lives in project_access_grants (one row per
    // recipient, with a role) rather than the roleless shared_with array, so
    // the picker resolves ids first and then loads those projects.
    const { data: grantRows } = await db
      .from("project_access_grants")
      .select("project_id")
      .eq("email", normalizedUserEmail);
    const grantedProjectIds = [
      ...new Set(
        ((grantRows ?? []) as { project_id?: string | null }[])
          .map((row) => row.project_id)
          .filter((id): id is string => !!id),
      ),
    ];
    if (grantedProjectIds.length > 0) {
      projectQueries.push(
        db.from("projects").select("*").in("id", grantedProjectIds),
      );
    }
  }
  // Third access branch (multi-tenant): projects in an org the caller belongs
  // to are searchable, otherwise the document picker would hide org content
  // the project list shows. Membership alone is not the verdict, though:
  // every other path resolves the project through checkProjectAccess /
  // project_access_role, which return "no access" for a per-project deny
  // override. Without the same filter here the picker hands a walled-off
  // member the matter's name, cm_number and its document filenames.
  const { data: membershipRows, error: membershipError } = await db
    .from("org_members")
    .select("org_id, role")
    .eq("user_id", userId);
  if (membershipError) return void sendInternalError(res, membershipError);
  const orgRoleByOrgId = new Map<string, string>();
  for (const row of (membershipRows ?? []) as {
    org_id?: string | null;
    role?: string | null;
  }[]) {
    if (row.org_id) orgRoleByOrgId.set(row.org_id, row.role ?? "");
  }
  const orgIds = [...orgRoleByOrgId.keys()];
  const [projectResults, orgProjectsResult] = await Promise.all([
    Promise.all(projectQueries),
    orgIds.length > 0
      ? db.from("projects").select("*").in("org_id", orgIds)
      : Promise.resolve({
          data: [] as Record<string, unknown>[],
          error: null,
        }),
  ]);
  const projectError =
    projectResults.find((result) => result.error)?.error ??
    orgProjectsResult.error;
  if (projectError)
    return void sendInternalError(res, projectError);
  const projectsById = new Map<string, Record<string, unknown>>();
  const [createdResult, ...grantResults] = projectResults;
  // The "I created it" branch is NOT a verdict on its own. A creator who has
  // since LEFT the organization keeps the projects.user_id row, but
  // checkProjectAccess — which every other read path uses — answers "no
  // access" for them, so the picker was the one surface still offering an
  // org matter that 404s the moment it is opened. An org project is only
  // theirs to see while they are still in that org; the org branch below
  // re-admits it (with the deny override applied) when they are.
  for (const project of createdResult?.data ?? []) {
    const orgId = project.org_id as string | null | undefined;
    if (orgId && !orgRoleByOrgId.has(orgId)) continue;
    projectsById.set(project.id as string, project);
  }
  for (const result of grantResults) {
    for (const project of result.data ?? []) {
      projectsById.set(project.id as string, project);
    }
  }
  const orgProjects = (orgProjectsResult.data ?? []) as Record<
    string,
    unknown
  >[];
  if (orgProjects.length > 0) {
    // One batched read for the whole page, not a verdict per row: this is a
    // filter over a result set and must not become an N+1. Mirrors
    // listOrgResources, including its exemptions — the creator and org
    // admins keep Owner and cannot be denied.
    // Scoped by ORG, not by an .in() over every candidate project id: that
    // list grows with the firm's matters and is spliced verbatim into the
    // PostgREST query string, so a large tenant sent a URL past the server's
    // request-line limit and the read failed (fail-closed, so the picker went
    // blank). org_id is bounded by the caller's memberships, which is the
    // same shape listOrgResources uses.
    const { data: denialRows, error: denialError } = await db
      .from("project_org_access_overrides")
      .select("project_id")
      .in("org_id", orgIds)
      .eq("user_id", userId)
      .eq("role", "deny");
    // Fail closed: an unreadable override table must hide rows, never reveal
    // them.
    if (denialError) return void sendInternalError(res, denialError);
    const deniedProjectIds = new Set(
      ((denialRows ?? []) as { project_id?: string | null }[])
        .map((row) => row.project_id)
        .filter((id): id is string => !!id),
    );
    for (const project of orgProjects) {
      const projectId = project.id as string;
      const orgId = project.org_id as string | null;
      const isCreator = project.user_id === userId;
      const isOrgAdmin = !!orgId && orgRoleByOrgId.get(orgId) === "admin";
      if (!isCreator && !isOrgAdmin && deniedProjectIds.has(projectId))
        continue;
      projectsById.set(projectId, project);
    }
  }
  const accessibleProjectIds = [...projectsById.keys()];
  if (accessibleProjectIds.length === 0) return void res.json([]);

  const escaped = searchTerm.replace(/[%_]/g, (value) => `\\${value}`);
  const { data: versions, error: versionsError } = await db
    .from("document_versions")
    .select("id")
    .ilike("filename", `%${escaped}%`)
    .is("deleted_at", null);
  if (versionsError)
    return void sendInternalError(res, versionsError);

  const versionIds = (versions ?? []).map((version) => version.id as string);
  let matchedDocuments: Record<string, unknown>[] = [];
  if (versionIds.length > 0) {
    const { data, error } = await db
      .from("documents")
      .select("*")
      .in("project_id", accessibleProjectIds)
      .in("current_version_id", versionIds);
    if (error) return void sendInternalError(res, error);
    matchedDocuments = (data ?? []) as Record<string, unknown>[];
    await attachLatestVersionNumbers(
      db,
      matchedDocuments as { id: string; current_version_id?: string | null }[],
    );
    await attachActiveVersionPaths(
      db,
      matchedDocuments as { id: string; current_version_id?: string | null }[],
    );
    await attachDocumentOwnerLabels(
      db,
      matchedDocuments as { user_id?: string | null }[],
    );
  }

  const normalized = searchTerm.toLowerCase();
  const documentProjectIds = new Set(
    matchedDocuments.map((document) => document.project_id as string),
  );
  const matches = [...projectsById.values()]
    .filter((project) => {
      const name = String(project.name ?? "").toLowerCase();
      const cmNumber = String(project.cm_number ?? "").toLowerCase();
      return (
        name.includes(normalized) ||
        cmNumber.includes(normalized) ||
        documentProjectIds.has(project.id as string)
      );
    })
    .sort((a, b) =>
      String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")),
    )
    .slice(pagination.offset, pagination.offset + pagination.limit + 1)
    .map((project) => ({
      ...project,
      is_owner: project.user_id === userId,
      documents: matchedDocuments.filter(
        (document) => document.project_id === project.id,
      ),
      folders: [],
    }));
  res.json(matches);
}

// GET /projects/:projectId/directory
// Returns one folder level so file pickers can expand projects without
// downloading every document and subfolder for every project up front.
projectsRouter.get("/:projectId/directory", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId } = req.params;
  const db = createServerSupabase();
  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  if (!access.ok)
    return void res.status(404).json({ detail: "Project not found" });

  const pagination = parsePaginationQuery(req.query as Record<string, unknown>);
  const result = await loadProjectDirectoryLevel(
    db,
    projectId,
    normalizeOptionalString(req.query.parent_folder_id),
    pagination,
  );
  if (result.error)
    return void sendInternalError(res, result.error);
  res.json({
    documents: result.documents,
    folders: result.folders,
    documentsHasMore: result.documentsHasMore,
  });
});

// GET /projects/filter-options (must come before /:projectId routes)
projectsRouter.get("/filter-options", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const normalizedUserEmail = userEmail?.trim().toLowerCase();
  const db = createServerSupabase();
  const { data, error } = await db.rpc("get_project_filter_options", {
    p_user_id: userId,
    p_user_email: normalizedUserEmail ?? null,
  });
  if (error) return void sendInternalError(res, error);

  const row = (data?.[0] ?? {}) as {
    practices?: unknown;
    owners?: unknown;
  };
  const practices = Array.isArray(row.practices)
    ? row.practices.filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  const owners = Array.isArray(row.owners)
    ? row.owners.flatMap((value) => {
        if (!value || typeof value !== "object") return [];
        const option = value as { value?: unknown; label?: unknown };
        return typeof option.value === "string" &&
          typeof option.label === "string"
          ? [{ value: option.value, label: option.label }]
          : [];
      })
    : [];
  res.json({ practices, owners });
});

// GET /projects/ids (must come before /:projectId routes)
// Lightweight id + owner list for every project matching the current
// filters — backs "select all matching" bulk actions so the client doesn't
// have to page through full project payloads just to collect checkboxes.
//
// PostgREST enforces its own row cap on every RPC response (db-max-rows),
// independent of anything this route asks for, and truncates silently
// rather than failing. So this pages through the RPC itself — server-side,
// same-datacenter round trips — until a page comes back empty, rather than
// trusting one call to return everything.
const PROJECT_IDS_PAGE_SIZE = 1000;
const PROJECT_IDS_MAX_PAGES = 200; // guards a runaway loop, not a product limit

projectsRouter.get("/ids", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const db = createServerSupabase();

  const searchTerm = normalizeSearchTerm(req.query.search);
  const scope = parseProjectScope(req.query.scope);
  const practice = normalizeSearchTerm(req.query.practice);
  const ownerUserId = normalizeSearchTerm(req.query.owner_user_id);

  const ids: { id: string; user_id: string }[] = [];
  let offset = 0;
  for (let page = 0; page < PROJECT_IDS_MAX_PAGES; page++) {
    const rpcArgs = buildProjectIdsOverviewRpcArgs({
      userId,
      userEmail,
      scope,
      searchTerm,
      practice,
      ownerUserId,
      pagination: { limit: PROJECT_IDS_PAGE_SIZE, offset },
    });
    const { data, error } = await db.rpc("get_project_ids_overview", rpcArgs);
    if (error) return void sendInternalError(res, error);

    const rows = (data ?? []) as { id: string; user_id: string }[];
    if (rows.length === 0) break;
    ids.push(...rows);
    offset += rows.length;
  }

  res.json(ids);
});

// GET /projects/:projectId
projectsRouter.get("/:projectId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string;
  const { projectId } = req.params;
  const db = createServerSupabase();

  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  if (!access.ok)
    return void res.status(404).json({ detail: "Project not found" });

  const { data: project, error } = await db
    .from("projects")
    .select("*")
    .eq("id", projectId)
    .single();
  if (error || !project)
    return void res.status(404).json({ detail: "Project not found" });

  const [{ data: docs }, { data: folderData }] = await Promise.all([
    db
      .from("documents")
      .select("*")
      .eq("project_id", projectId)
      .order("created_at", { ascending: true }),
    db
      .from("project_subfolders")
      .select("*")
      .eq("project_id", projectId)
      .order("created_at", { ascending: true }),
  ]);
  const docsTyped = (docs ?? []) as unknown as {
    id: string;
    user_id?: string | null;
    current_version_id?: string | null;
  }[];
  await attachLatestVersionNumbers(db, docsTyped);
  await attachActiveVersionPaths(db, docsTyped);
  await attachDocumentOwnerLabels(db, docsTyped);
  // Contact details for the "you can't do that" popups. Without them the UI
  // can tell a viewer they were refused but never who to ask.
  const adminContacts = await listProjectAdminContacts(db, access.project);
  const creatorContact =
    adminContacts.find((c) => c.source === "creator") ?? null;
  res.json({
    ...project,
    is_owner: access.isCreator,
    access_role: access.projectRole,
    org_role: access.orgRole,
    owner_email: creatorContact?.email ?? null,
    owner_display_name: creatorContact?.display_name ?? null,
    admin_contacts: adminContacts,
    documents: docsTyped,
    folders: folderData ?? [],
  });
});

// GET /projects/:projectId/people
// Resolve the creator + every direct grantee to {email, display_name, role}.
// Used by the People modal so the UI can show display names where available,
// tag the current user as "You", and — new here — say what each person can
// actually do.
projectsRouter.get("/:projectId/people", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId } = req.params;
  const db = createServerSupabase();

  // Visible to anyone who can see the project, at every tier. "Who else is on
  // this matter?" is part of working on it even for a viewer, and the access
  // modal shows the same roster to everyone rather than a different one per
  // role. This deliberately matches GET /chat/:chatId/people and
  // GET /tabular-review/:reviewId/people, which resolve a project-owned row
  // through this same roster: tiering it here and not there only meant the
  // list was one request away.
  //
  // Note the split that remains: the roster is readable, but the MANAGEMENT
  // surface (GET /:projectId/access — who granted what, and the role pickers)
  // still requires `access.manage`.
  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  if (!access.ok)
    return void res.status(404).json({ detail: "Project not found" });
  const project = access.project;

  if (project.org_id) {
    const listed = await listOrgAccessPeople(db, {
      kind: "project",
      resourceId: projectId,
      orgId: project.org_id,
      creatorId: project.user_id,
    });
    if (!listed.ok) return void sendInternalError(res, listed.detail);
    const creator = listed.people.find(
      (person) => person.user_id === project.user_id,
    );
    return void res.json({
      scope: "organization",
      owner: creator
        ? {
            user_id: creator.user_id,
            email: creator.email,
            display_name: creator.display_name,
            role: "owner" as const,
          }
        : null,
      members: listed.people.filter(
        (person) => person.user_id !== project.user_id,
      ),
      admin_contacts: await listProjectAdminContacts(db, project),
    });
  }

  // Personal projects keep email-addressed direct grants.
  const { userByEmail, userById } = await loadProfileUsersByEmail(db);

  const ownerInfo = project.user_id
    ? userById.get(project.user_id)
    : undefined;
  // `owner` is the project's creator. It can be null now: an organization
  // project outlives the account that created it, and the org's admins
  // administer it from then on.
  const owner = project.user_id
    ? {
        user_id: project.user_id,
        email: ownerInfo?.email ?? null,
        display_name: ownerInfo?.display_name ?? null,
        role: "owner" as const,
      }
    : null;
  const listed = await listProjectGrants(db, projectId);
  if (!listed.ok) return void sendInternalError(res, listed.detail);
  const members = listed.grants.map((grant) => ({
    email: grant.email,
    display_name: userByEmail.get(grant.email)?.display_name ?? null,
    role: grant.role,
  }));

  res.json({
    scope: "direct",
    owner,
    members,
    admin_contacts: await listProjectAdminContacts(db, project),
  });
});

// ---------------------------------------------------------------------------
// Direct access grants
// ---------------------------------------------------------------------------
//
// Sharing is an Owner power (`access.manage`). Personal projects use direct
// email grants; organization projects use organization-member overrides.

// GET /projects/:projectId/access — the grant list, for whoever may manage
// it. This is the management surface: each row carries who granted it and
// when, and its one consumer is the People modal's role pickers, which only
// render for Owners. Serving it at mere reachability let any Viewer — the
// outside-counsel tier — enumerate every recipient, role and grantor on the
// matter.
projectsRouter.get("/:projectId/access", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId } = req.params;
  const db = createServerSupabase();

  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  if (!access.ok)
    return void res.status(404).json({ detail: "Project not found" });
  if (!can(access.projectRole, "access.manage"))
    return void res
      .status(403)
      .json({ detail: "Only a project owner can change who has access." });
  if (access.project.org_id) {
    const listed = await listOrgAccessPeople(db, {
      kind: "project",
      resourceId: projectId,
      orgId: access.project.org_id,
      creatorId: access.project.user_id,
    });
    if (!listed.ok) return void sendInternalError(res, listed.detail);
    return void res.json({
      scope: "organization",
      org_id: access.project.org_id,
      access_role: access.projectRole,
      grants: listed.people.filter(
        (person) =>
          person.user_id !== access.project.user_id && person.has_override,
      ),
    });
  }
  const listed = await listProjectGrants(db, projectId);
  if (!listed.ok) return void sendInternalError(res, listed.detail);
  res.json({
    scope: "direct",
    org_id: access.project.org_id ?? null,
    access_role: access.projectRole,
    grants: listed.grants,
  });
});

// POST /projects/:projectId/access — grant or re-role one recipient.
projectsRouter.post("/:projectId/access", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId } = req.params;
  const db = createServerSupabase();

  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  if (!access.ok)
    return void res.status(404).json({ detail: "Project not found" });
  if (!can(access.projectRole, "access.manage"))
    return void res
      .status(403)
      .json({ detail: "Only a project owner can change who has access." });

  const email = normalizeEmail(
    typeof req.body?.email === "string" ? req.body.email : null,
  );
  if (email && normalizeEmail(userEmail) === email)
    return void res
      .status(400)
      .json({ detail: "You cannot share a project with yourself." });

  if (access.project.org_id) {
    if (!email)
      return void res.status(400).json({ detail: "A valid email address is required" });
    if (!isOrgAssignableRole(req.body?.role))
      return void res.status(400).json({
        detail: "role must be owner, editor, viewer or deny",
      });
    const target = await findOrgMemberByEmail(db, access.project.org_id, email);
    if (!target.ok) {
      if (target.kind === "not_found")
        return void res.status(400).json({ detail: target.detail });
      return void sendInternalError(res, target.detail);
    }
    if (target.member.userId === access.project.user_id)
      return void res.status(400).json({ detail: "The creator is always an owner" });
    if (target.member.orgRole === "admin")
      return void res.status(400).json({
        detail: "Organization admins always have owner access",
      });
    const result = await setOrgAccessOverride(db, {
      kind: "project",
      resourceId: projectId,
      orgId: access.project.org_id,
      userId: target.member.userId,
      role: req.body.role,
      assignedBy: userId,
    });
    if (!result.ok) return void sendInternalError(res, result.detail);
    return void res.status(201).json({
      user_id: target.member.userId,
      email: target.member.email,
      role: req.body.role,
    });
  }

  if (req.body?.role === "deny")
    return void res.status(400).json({
      detail: "Deny is only available for organization members",
    });
  const creatorProfile = access.project.user_id
    ? await db
        .from("user_profiles")
        .select("email")
        .eq("user_id", access.project.user_id)
        .maybeSingle()
    : null;
  const result = await upsertProjectGrant(db, {
    projectId,
    email: req.body?.email,
    role: req.body?.role,
    createdBy: userId,
    creatorEmail:
      (creatorProfile?.data as { email?: string | null } | null)?.email ?? null,
  });
  if (!result.ok) {
    if (result.kind === "validation")
      return void res.status(400).json({ detail: result.detail });
    // result.detail is a raw driver message here — log it, never send it.
    return void sendInternalError(res, result.detail);
  }
  res.status(201).json(result.grant);
});

// DELETE /projects/:projectId/access/:email — revoke one recipient.
projectsRouter.delete(
  "/:projectId/access/:email",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { projectId } = req.params;
    const db = createServerSupabase();

    const access = await checkProjectAccess(projectId, userId, userEmail, db);
    if (!access.ok)
      return void res.status(404).json({ detail: "Project not found" });
    if (!can(access.projectRole, "access.manage"))
      return void res
        .status(403)
        .json({ detail: "Only a project owner can change who has access." });

    if (access.project.org_id) {
      const email = normalizeEmail(decodeURIComponent(req.params.email));
      if (!email)
        return void res.status(404).json({ detail: "Access override not found" });
      const target = await findOrgMemberByEmail(
        db,
        access.project.org_id,
        email,
      );
      if (!target.ok) {
        if (target.kind === "not_found")
          return void res.status(404).json({ detail: "Access override not found" });
        return void sendInternalError(res, target.detail);
      }
      const result = await deleteOrgAccessOverride(db, {
        kind: "project",
        resourceId: projectId,
        userId: target.member.userId,
      });
      if (!result.ok) return void sendInternalError(res, result.detail);
      if (!result.removed)
        return void res.status(404).json({ detail: "Access override not found" });
      return void res.status(204).send();
    }

    const result = await deleteProjectGrant(db, {
      projectId,
      email: decodeURIComponent(req.params.email),
    });
    if (!result.ok) return void sendInternalError(res, result.detail);
    if (!result.removed)
      return void res.status(404).json({ detail: "Access grant not found" });
    res.status(204).send();
  },
);

// PATCH /projects/:projectId
projectsRouter.patch("/:projectId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId } = req.params;
  if (
    req.body &&
    typeof req.body === "object" &&
    "shared_with" in req.body
  )
    return void res.status(400).json({
      detail:
        "shared_with is no longer supported; use the project access endpoints.",
    });
  const updates: Record<string, unknown> = {};
  if (req.body.name != null) updates.name = req.body.name;
  if (req.body.cm_number != null) updates.cm_number = req.body.cm_number;
  if ("practice" in req.body) {
    updates.practice = normalizeOptionalString(req.body.practice);
  }
  const db = createServerSupabase();
  // Project settings and access edits are Owner-only: the creator, a direct
  // Owner grant on a personal project, or an Admin of the project's org.
  // The user_id filter moves out of the UPDATE so Owners can act on rows they
  // did not create.
  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  if (!access.ok)
    return void res.status(404).json({ detail: "Project not found" });
  if (!can(access.projectRole, "access.manage"))
    return void res
      .status(403)
      .json({ detail: "Only a project owner can change project settings." });

  const { data, error } = await db
    .from("projects")
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq("id", projectId)
    .select("*")
    .single();
  if (error || !data)
    return void res.status(404).json({ detail: "Project not found" });

  const [{ data: docs }, { data: folderData }] = await Promise.all([
    db
      .from("documents")
      .select("*")
      .eq("project_id", projectId)
      .order("created_at", { ascending: true }),
    db
      .from("project_subfolders")
      .select("*")
      .eq("project_id", projectId)
      .order("created_at", { ascending: true }),
  ]);
  const docsTyped = (docs ?? []) as unknown as {
    id: string;
    user_id?: string | null;
    current_version_id?: string | null;
  }[];
  await attachActiveVersionPaths(db, docsTyped);
  await attachDocumentOwnerLabels(db, docsTyped);
  res.json({ ...data, documents: docsTyped, folders: folderData ?? [] });
});

// DELETE /projects/:projectId
projectsRouter.delete("/:projectId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId } = req.params;
  const db = createServerSupabase();
  // Deleting a project is the destructive end of the ladder, so it declares
  // `container.delete` like every other gate on this branch instead of
  // leaning on the cascade helper's `.eq("user_id", …)` filter to imply the
  // rule. Same verdict, stated where a reader looks for it — and the two
  // failure modes stop being one indistinguishable 404: a stranger still
  // gets "not found", while a member or viewer who CAN see the project is
  // told they were refused.
  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  if (!access.ok)
    return void res.status(404).json({ detail: "Project not found" });
  if (!can(access.projectRole, "container.delete"))
    return void res
      .status(403)
      .json({ detail: "Only a project owner can delete this project." });
  try {
    // Delete by id, not by owner: the capability check above is what
    // authorises this, and an organization project may have no creator left
    // to scope by (user_id goes NULL when that account is deleted).
    const deletedCount = await deleteProjectsByIds(db, [projectId]);
    if (deletedCount === 0)
      return void res.status(404).json({ detail: "Project not found" });
    res.status(204).send();
  } catch (err) {
    sendInternalError(res, err);
  }
});

// GET /projects/:projectId/documents
projectsRouter.get("/:projectId/documents", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId } = req.params;
  const db = createServerSupabase();

  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  if (!access.ok)
    return void res.status(404).json({ detail: "Project not found" });

  const { data: docs } = await db
    .from("documents")
    .select("*")
    .eq("project_id", projectId)
    .order("created_at", { ascending: true });
  const docsTyped = (docs ?? []) as unknown as {
    id: string;
    current_version_id?: string | null;
  }[];
  await attachActiveVersionPaths(db, docsTyped);
  res.json(docsTyped);
});

// GET /projects/:projectId/export — tamper-evident manifest of the project's
// documents: every version with its content_sha256 plus the accept/reject
// trail, under a SHA-256 digest that is Ed25519-signed when the deployment has
// MANIFEST_SIGNING_KEY set. To check an export, recompute a downloaded file's
// SHA-256 and compare, then check the manifest's signature against the key
// served at GET /manifest-signing-key. See the README.
projectsRouter.get(
  "/:projectId/export",
  requireAuth,
  requireMfaIfEnrolled,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { projectId } = req.params;
    const db = createServerSupabase();

    const access = await checkProjectAccess(projectId, userId, userEmail, db);
    if (!access.ok)
      return void res.status(404).json({ detail: "Project not found" });

    try {
      const data = await buildProjectExportManifest(db, projectId);
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${projectManifestFilename(projectId)}"`,
      );
      res.json(data);
    } catch (err) {
      console.error("[projects/export] failed", {
        projectId,
        error: err,
      });
      res
        .status(500)
        .json({ detail: "Failed to build project export manifest" });
    }
  },
);

// POST /projects/:projectId/documents/:documentId — assign or copy existing doc into project
projectsRouter.post(
  "/:projectId/documents/:documentId",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { projectId, documentId } = req.params;
    const db = createServerSupabase();

    const access = await checkProjectAccess(projectId, userId, userEmail, db);
    if (!access.ok)
      return void res.status(404).json({ detail: "Project not found" });
    if (!can(access.projectRole, "docs.organize"))
      return void res.status(403).json({ detail: DOCS_ORGANIZE_FORBIDDEN });

    // Adding-by-id pulls a doc into the project — only the doc's owner
    // is allowed to do that, so other people's standalone docs can't be
    // siphoned into a project the requester happens to share.
    const { data: doc } = await db
      .from("documents")
      .select("*")
      .eq("id", documentId)
      .eq("user_id", userId)
      .single();
    if (!doc)
      return void res.status(404).json({ detail: "Document not found" });
    await attachActiveVersionPaths(db, [
      doc as { id: string; current_version_id?: string | null },
    ]);

    // Already in this project — idempotent
    if (doc.project_id === projectId) return void res.json(doc);

    if (doc.project_id === null) {
      // Standalone → assign project_id (and inherit the project's org).
      const targetOrg = await resolveContentOrgId(db, { projectId });
      if (!targetOrg.ok) return void sendInternalError(res, targetOrg.detail);
      const { data: updated, error } = await db
        .from("documents")
        .update({
          project_id: projectId,
          org_id: targetOrg.orgId,
          library_folder_id: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", documentId)
        .select("*")
        .single();
      if (error || !updated)
        return void res
          .status(500)
          .json({ detail: "Failed to update document" });
      await attachActiveVersionPaths(db, [
        updated as { id: string; current_version_id?: string | null },
      ]);
      return void res.json(updated);
    } else {
      // Belongs to another project → duplicate record AND copy the
      // underlying storage objects so each project's copy is fully
      // independent (edits/version bumps on one don't leak into the
      // other).
      if (!doc.current_version_id) {
        return void res
          .status(404)
          .json({ detail: "Source document has no active version" });
      }

      const { data: srcV } = await db
        .from("document_versions")
        .select(
          "storage_path, pdf_storage_path, version_number, filename, source, file_type, size_bytes, page_count",
        )
        .eq("id", doc.current_version_id)
        .single();
      if (!srcV?.storage_path) {
        return void res
          .status(404)
          .json({ detail: "Source document has no active version" });
      }

      const activeVersionFilename =
        (srcV.filename as string | null)?.trim() || "Untitled document";
      const srcBytes = await downloadFile(srcV.storage_path);
      if (!srcBytes) {
        return void res
          .status(500)
          .json({ detail: "Failed to read source document bytes" });
      }

      const copyOrg = await resolveContentOrgId(db, { projectId });
      if (!copyOrg.ok) return void sendInternalError(res, copyOrg.detail);
      const { data: copy, error } = await db
        .from("documents")
        .insert({
          project_id: projectId,
          user_id: userId,
          status: doc.status,
          org_id: copyOrg.orgId,
        })
        .select("*")
        .single();
      if (error || !copy)
        return void res.status(500).json({ detail: "Failed to copy document" });

      const newKey = storageKey(
        userId,
        copy.id as string,
        activeVersionFilename,
      );
      let newPdfPath: string | null = null;
      try {
        const contentType = contentTypeForDocumentType(
          (srcV.file_type as string | null) ?? doc.file_type,
        );
        await uploadFile(newKey, srcBytes, contentType);

        // PDFs share one object for source + display rendition. DOCX
        // store the converted PDF at a separate `converted-pdfs/` key —
        // copy that too if it exists so the copy renders without going
        // back through libreoffice.
        if (srcV.pdf_storage_path) {
          if (srcV.pdf_storage_path === srcV.storage_path) {
            newPdfPath = newKey;
          } else {
            const pdfBytes = await downloadFile(srcV.pdf_storage_path);
            if (pdfBytes) {
              const newPdfKey = convertedPdfKey(userId, copy.id as string);
              await uploadFile(newPdfKey, pdfBytes, "application/pdf");
              newPdfPath = newPdfKey;
            }
          }
        }

        const { data: newV, error: newVError } = await db
          .from("document_versions")
          .insert({
            document_id: copy.id,
            storage_path: newKey,
            pdf_storage_path: newPdfPath,
            source: (srcV.source as string | null) ?? "upload",
            version_number: srcV.version_number ?? 1,
            filename: activeVersionFilename,
            file_type: (srcV.file_type as string | null) ?? doc.file_type,
            size_bytes:
              (srcV.size_bytes as number | null) ?? doc.size_bytes ?? null,
            page_count:
              (srcV.page_count as number | null) ?? doc.page_count ?? null,
            content_sha256: contentSha256(srcBytes),
          })
          .select("id")
          .single();
        const copyVersionRowId = (newV?.id as string | null) ?? null;
        if (newVError || !copyVersionRowId) {
          throw new Error(
            `Failed to create copied document version: ${newVError?.message ?? "unknown"}`,
          );
        }

        const { data: updatedCopy, error: updateCopyError } = await db
          .from("documents")
          .update({
            current_version_id: copyVersionRowId,
          })
          .eq("id", copy.id)
          .select("*")
          .single();
        if (updateCopyError || !updatedCopy) {
          throw new Error(
            `Failed to activate copied document version: ${updateCopyError?.message ?? "unknown"}`,
          );
        }

        await attachActiveVersionPaths(db, [
          updatedCopy as { id: string; current_version_id?: string | null },
        ]);
        return void res.status(201).json(updatedCopy);
      } catch (err) {
        console.error("[projects/documents/copy] failed", err);
        await Promise.all([
          deleteFile(newKey).catch(() => {}),
          newPdfPath && newPdfPath !== newKey
            ? deleteFile(newPdfPath).catch(() => {})
            : Promise.resolve(),
          db.from("documents").delete().eq("id", copy.id),
        ]);
        return void res.status(500).json({ detail: "Failed to copy document" });
      }
    }
  },
);

// PATCH /projects/:projectId/documents/:documentId — rename a project document
projectsRouter.patch(
  "/:projectId/documents/:documentId",
  requireAuth,
  async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId, documentId } = req.params;
  const db = createServerSupabase();

  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  if (!access.ok)
    return void res.status(404).json({ detail: "Project not found" });
  if (!can(access.projectRole, "docs.organize"))
    return void res.status(403).json({ detail: DOCS_ORGANIZE_FORBIDDEN });

  const { data: doc } = await db
    .from("documents")
    .select("id, current_version_id")
    .eq("id", documentId)
    .eq("project_id", projectId)
    .single();
  if (!doc)
    return void res.status(404).json({ detail: "Document not found" });

  const active = doc.current_version_id
    ? await db
        .from("document_versions")
        .select("filename")
        .eq("id", doc.current_version_id)
        .eq("document_id", documentId)
        .single()
    : null;
  const currentName =
      typeof active?.data?.filename === "string" && active.data.filename.trim()
      ? active.data.filename.trim()
      : "Untitled document";
  const filename = normalizeDocumentFilename(req.body?.filename, currentName);
  if (!filename)
    return void res.status(400).json({ detail: "filename is required" });

  const { data: updated, error } = await db
    .from("documents")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", documentId)
    .eq("project_id", projectId)
    .select("*")
    .single();
  if (error || !updated)
    return void res.status(404).json({ detail: "Document not found" });

  if (doc.current_version_id) {
    await db
      .from("document_versions")
      .update({ filename })
      .eq("id", doc.current_version_id)
      .eq("document_id", documentId);
  }

  res.json({
    ...updated,
    filename,
  });
  },
);

// GET /projects/:projectId/chats — every assistant chat under this project
// (any author with project access). Used by the project page's chat tab so
// it doesn't have to filter the global GET /chat list. Since 20260902_05 the
// global list shows these too (its predicate matches ensureChatAccess), so
// this endpoint is a convenience scoping, not the only way to find them.
projectsRouter.get("/:projectId/chats", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId } = req.params;
  const db = createServerSupabase();

  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  if (!access.ok)
    return void res.status(404).json({ detail: "Project not found" });

  const { data, error } = await db
    .from("chats")
    .select("*")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false });
  if (error) return void sendInternalError(res, error);
  const chats = data ?? [];
  await attachChatCreatorLabels(db, chats);
  // Label each row with the caller's role for THAT chat, the way the detail
  // route and the overview RPC already do. Without it the client has nothing
  // to gate on but `user_id === me`, which this PR's model makes wrong in
  // both directions: a project Owner may delete a colleague's chat, and an
  // Editor may not delete one they merely reach through the project.
  //
  // Project-owned chats inherit the project verdict exactly. Their creator
  // and any stale chat-level grant cannot raise or lower that role.
  for (const chat of chats as {
    id: string;
    user_id?: string | null;
    is_owner?: boolean;
    access_role?: ProjectRole | null;
  }[]) {
    chat.is_owner = !!chat.user_id && chat.user_id === userId;
    chat.access_role = access.projectRole;
  }
  res.json(chats);
});

// ── Folder routes ─────────────────────────────────────────────────────────────

// POST /projects/:projectId/folder-paths/resolve
projectsRouter.post(
  "/:projectId/folder-paths/resolve",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { projectId } = req.params;
    const body = req.body as {
      base_folder_id?: string | null;
      segments?: unknown;
      conflict_resolution?: unknown;
    };
    const rawSegments = Array.isArray(body.segments) ? body.segments : [];
    const segments = Array.isArray(body.segments)
      ? body.segments
          .filter((segment): segment is string => typeof segment === "string")
          .map((segment) => segment.trim())
      : [];
    if (
      rawSegments.length !== segments.length ||
      segments.length === 0 ||
      segments.length > 100 ||
      segments.some((segment) => !segment || segment.length > 255)
    ) {
      return void res.status(400).json({ detail: "Invalid folder path" });
    }
    const conflictResolution =
      body.conflict_resolution === "reuse" ||
      body.conflict_resolution === "rename"
        ? body.conflict_resolution
        : "error";
    const baseFolderId =
      typeof body.base_folder_id === "string" && body.base_folder_id.trim()
        ? body.base_folder_id.trim()
        : null;

    const db = createServerSupabase();
    const access = await checkProjectAccess(projectId, userId, userEmail, db);
    // This route reads like a lookup, but resolve_project_folder_path INSERTs
    // a project_subfolders row for every path segment that does not exist
    // yet. It therefore needs the same docs.organize gate its sibling folder
    // routes declare; without it a viewer — whose whole tier is read-only —
    // could POST an arbitrary nested folder tree into someone else's project.
    if (!access.ok)
      return void res.status(404).json({ detail: "Project not found" });
    if (!can(access.projectRole, "docs.organize"))
      return void res.status(403).json({ detail: DOCS_ORGANIZE_FORBIDDEN });
    if (baseFolderId) {
      const parent = await loadProjectFolder(db, projectId, baseFolderId);
      if (!parent)
        return void res.status(404).json({ detail: "Parent folder not found" });
    }

    const { data, error } = await db.rpc("resolve_project_folder_path", {
      target_project_id: projectId,
      target_user_id: userId,
      base_folder_id: baseFolderId,
      path_segments: segments,
      conflict_resolution: conflictResolution,
    });
    if (error) {
      console.error("[projects/folder-paths/resolve] failed", {
        projectId,
        userId,
        error: error,
      });
      return void res.status(500).json({
        detail: "Could not prepare this folder upload. Please try again.",
      });
    }
    res.json(data);
  },
);

// POST /projects/:projectId/folders
projectsRouter.post("/:projectId/folders", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId } = req.params;
  const { name, parent_folder_id } = req.body as {
    name: string;
    parent_folder_id?: string | null;
  };
  if (!name?.trim())
    return void res.status(400).json({ detail: "name is required" });

  const db = createServerSupabase();
  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  if (!access.ok)
    return void res.status(404).json({ detail: "Project not found" });
  if (!can(access.projectRole, "docs.organize"))
    return void res.status(403).json({ detail: DOCS_ORGANIZE_FORBIDDEN });

  // Verify parent folder belongs to this project
  if (parent_folder_id) {
    const { data: parent } = await db
      .from("project_subfolders")
      .select("id")
      .eq("id", parent_folder_id)
      .eq("project_id", projectId)
      .single();
    if (!parent)
      return void res.status(404).json({ detail: "Parent folder not found" });
  }

  const { data, error } = await db
    .from("project_subfolders")
    .insert({
    project_id: projectId,
    user_id: userId,
    name: name.trim(),
    parent_folder_id: parent_folder_id ?? null,
    })
    .select("*")
    .single();
  if (error) return void sendInternalError(res, error);
  res.status(201).json(data);
});

// PATCH /projects/:projectId/folders/:folderId
projectsRouter.patch(
  "/:projectId/folders/:folderId",
  requireAuth,
  async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId, folderId } = req.params;
    const body = req.body as {
      name?: string;
      parent_folder_id?: string | null;
    };

  const db = createServerSupabase();
  // Re-shaping the folder tree is member work, alongside the documents it
  // holds — Will's review put "organize documents and folders" on one line.
  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  if (!access.ok)
    return void res.status(404).json({ detail: "Project not found" });
  if (!can(access.projectRole, "docs.organize"))
    return void res.status(403).json({ detail: DOCS_ORGANIZE_FORBIDDEN });

    const updates: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };
  if (body.name != null) updates.name = body.name.trim();
  if ("parent_folder_id" in body) {
    // Cycle check: walk up the tree from the proposed parent to ensure folderId is not an ancestor
    if (body.parent_folder_id) {
        const parent = await loadProjectFolder(
          db,
          projectId,
          body.parent_folder_id,
        );
        if (!parent)
          return void res
            .status(404)
            .json({ detail: "Parent folder not found" });

      let cur: string | null = body.parent_folder_id;
      while (cur) {
          if (cur === folderId)
            return void res.status(400).json({
              detail: "Cannot move a folder into itself or a descendant",
            });
        const p = await loadProjectFolder(db, projectId, cur);
          if (!p)
            return void res
              .status(404)
              .json({ detail: "Parent folder not found" });
        cur = p?.parent_folder_id ?? null;
      }
    }
    updates.parent_folder_id = body.parent_folder_id ?? null;
  }

    const { data, error } = await db
      .from("project_subfolders")
    .update(updates)
      .eq("id", folderId)
      .eq("project_id", projectId)
      .select("*")
      .single();
    if (error || !data)
      return void res.status(404).json({ detail: "Folder not found" });
  res.json(data);
  },
);

// DELETE /projects/:projectId/folders/:folderId
projectsRouter.delete(
  "/:projectId/folders/:folderId",
  requireAuth,
  async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId, folderId } = req.params;
  const db = createServerSupabase();

  // Folder deletion cascades into every nested document and its storage
  // objects — but so does deleting those documents one at a time, which a
  // member may already do. Gating the folder higher bought no safety, only a
  // confusing extra tier.
  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  if (!access.ok)
    return void res.status(404).json({ detail: "Project not found" });
  if (!can(access.projectRole, "docs.organize"))
    return void res.status(403).json({ detail: DOCS_ORGANIZE_FORBIDDEN });

  const { data: allFolders, error: foldersError } = await db
    .from("project_subfolders")
    .select("id, parent_folder_id")
    .eq("project_id", projectId);
  if (foldersError)
    return void sendInternalError(res, foldersError);
  if (!(allFolders ?? []).some((f) => f.id === folderId))
    return void res.status(404).json({ detail: "Folder not found" });

  const childrenByParent = new Map<string, string[]>();
  for (const f of allFolders ?? []) {
    const parentId = f.parent_folder_id as string | null;
    if (!parentId) continue;
    const children = childrenByParent.get(parentId) ?? [];
    children.push(f.id as string);
    childrenByParent.set(parentId, children);
  }

  const folderIds = new Set<string>();
  const stack = [folderId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (folderIds.has(id)) continue;
    folderIds.add(id);
    stack.push(...(childrenByParent.get(id) ?? []));
  }

  const { data: docs, error: docsError } = await db
    .from("documents")
    .select("id")
    .eq("project_id", projectId)
    .in("folder_id", [...folderIds]);
    if (docsError)
      return void sendInternalError(res, docsError);

  const docIds = (docs ?? []).map((d) => d.id as string);
  const deleteDocsError = await deleteProjectDocumentsAndVersionFiles(
    db,
    projectId,
    docIds,
  );
  if (deleteDocsError)
    return void sendInternalError(res, deleteDocsError);

    const { error } = await db
      .from("project_subfolders")
      .delete()
      .eq("id", folderId)
      .eq("project_id", projectId);
  if (error) return void sendInternalError(res, error);
  res.status(204).send();
  },
);

// PATCH /projects/:projectId/documents/:documentId/folder — move doc to a folder
projectsRouter.patch(
  "/:projectId/documents/:documentId/folder",
  requireAuth,
  async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId, documentId } = req.params;
  const { folder_id } = req.body as { folder_id: string | null };

  const db = createServerSupabase();
  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  if (!access.ok)
    return void res.status(404).json({ detail: "Project not found" });
  if (!can(access.projectRole, "docs.organize"))
    return void res.status(403).json({ detail: DOCS_ORGANIZE_FORBIDDEN });

  if (folder_id) {
    const folder = await loadProjectFolder(db, projectId, folder_id);
      if (!folder)
        return void res.status(404).json({ detail: "Folder not found" });
  }

    const { data, error } = await db
      .from("documents")
      .update({
        folder_id: folder_id ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", documentId)
      .eq("project_id", projectId)
      .select("*")
      .single();
    if (error || !data)
      return void res.status(404).json({ detail: "Document not found" });
  res.json(data);
  },
);

async function loadProjectFolder(
  db: ReturnType<typeof createServerSupabase>,
  projectId: string,
  folderId: string,
): Promise<{ id: string; parent_folder_id: string | null } | null> {
  const { data } = await db
    .from("project_subfolders")
    .select("id, parent_folder_id")
    .eq("id", folderId)
    .eq("project_id", projectId)
    .maybeSingle();
  return (
    (data as { id: string; parent_folder_id: string | null } | null) ?? null
  );
}
