/**
 * Project / document access helpers.
 *
 * Sharing makes the previous "scope by user_id" pattern incorrect — a doc
 * can belong to user A's project that A has shared with B's email, and B
 * must still be able to read/edit it. These helpers centralize the
 * exclusive organization-or-direct scope check so every route uses the same
 * logic instead of re-implementing the join.
 *
 * The creator is Owner. For personal content, access otherwise comes from one
 * role-aware direct grant. Projects and workflows may instead be organization
 * scoped: Admins inherit Owner, Members inherit Editor, and a per-resource
 * override can assign Owner, Editor, Viewer, or Deny. Chats and reviews only
 * inherit organization access through a parent project.
 *
 * Personal content is simply `org_id IS NULL` — there is no hidden personal
 * organization. Content without an org is reachable through branches 1 and 2
 * only.
 */

import type { createServerSupabase } from "./supabase";
import {
    getContentGrantRole,
    type ContentGrantKind,
} from "./contentAccess";
import {
    can,
    isProjectRole,
    type ProjectRole,
} from "./permissions";
import {
    getOrgAccessOverrideRole,
    type OrgResourceKind,
} from "./orgAccessOverrides";

export {
    can,
    isProjectRole,
    strongerRole,
    type Capability,
    type ProjectRole,
} from "./permissions";

type Db = ReturnType<typeof createServerSupabase>;

/**
 * Organizations have exactly two roles. Admins administer the organization
 * (members, invitations, settings) and inherit Owner on organization content;
 * members collaborate and inherit Editor.
 */
export type OrgRole = "admin" | "member";

export const ORG_ROLES: OrgRole[] = ["admin", "member"];

export function isOrgRole(value: unknown): value is OrgRole {
    return typeof value === "string" && (ORG_ROLES as string[]).includes(value);
}

/** Only org admins may administer an org (members, invitations, settings). */
export function isOrgAdmin(role: OrgRole | null | undefined): boolean {
    return role === "admin";
}

/**
 * Map each organization role to its default content role.
 */
export function orgRoleToProjectRole(role: OrgRole): ProjectRole {
    return role === "admin" ? "owner" : "editor";
}

/** Normalize an email the way every grant/invitation row stores it. */
export function normalizeEmail(
    email: string | null | undefined,
): string | null {
    const normalized = (email ?? "").trim().toLowerCase();
    return normalized || null;
}

/**
 * The caller's role in a single org, or null if they are not a member.
 */
export async function getOrgRole(
    userId: string,
    orgId: string | null | undefined,
    db: Db,
): Promise<OrgRole | null> {
    if (!orgId) return null;
    const { data } = await db
        .from("org_members")
        .select("role")
        .eq("org_id", orgId)
        .eq("user_id", userId)
        .maybeSingle();
    const role = (data as { role?: string } | null)?.role;
    return isOrgRole(role) ? role : null;
}

/**
 * Every org id the caller belongs to. Used to scope collection reads and to
 * validate an org_id chosen at create time.
 */
export async function listUserOrgIds(userId: string, db: Db): Promise<string[]> {
    const { data } = await db
        .from("org_members")
        .select("org_id")
        .eq("user_id", userId);
    const ids = new Set<string>();
    for (const row of (data ?? []) as { org_id?: string | null }[]) {
        if (row.org_id) ids.add(row.org_id);
    }
    return [...ids];
}

/**
 * The role a direct access grant gives the caller on a project, or null when
 * they hold no grant. Grants are keyed by normalized email so an invitation
 * to share can be honoured before the recipient has an account.
 */
export async function getProjectGrantRole(
    projectId: string,
    userEmail: string | null | undefined,
    db: Db,
): Promise<ProjectRole | null> {
    const email = normalizeEmail(userEmail);
    if (!email) return null;
    const { data } = await db
        .from("project_access_grants")
        .select("role")
        .eq("project_id", projectId)
        .eq("email", email)
        .maybeSingle();
    const role = (data as { role?: string } | null)?.role;
    return isProjectRole(role) ? role : null;
}

/**
 * Choose the org_id a newly created resource should carry. Content created
 * inside a project inherits that project's org; everything else is personal
 * (org_id null). There is no personal organization to fall back to — an
 * absent org IS the personal case.
 *
 * Result-shaped because "the lookup failed" and "this is personal" must
 * never share a value. `null` is not a safe default here: it is the very
 * encoding of personal content, and personal content is what account
 * deletion destroys. A swallowed error at this seam filed a firm's upload
 * as its uploader's private property — invisible to org inheritance today,
 * destroyed with the uploader's account later. Callers refuse the request
 * instead of guessing the tenant.
 */
export async function resolveContentOrgId(
    db: Db,
    params: { projectId?: string | null },
): Promise<{ ok: true; orgId: string | null } | { ok: false; detail: string }> {
    if (!params.projectId) return { ok: true, orgId: null };
    const { data, error } = await db
        .from("projects")
        .select("org_id")
        .eq("id", params.projectId)
        .maybeSingle();
    if (error)
        return {
            ok: false,
            detail:
                error.message ?? "Failed to resolve the project's organization",
        };
    if (!data)
        return {
            ok: false,
            detail: "Project not found",
        };
    return {
        ok: true,
        orgId: (data as { org_id?: string | null }).org_id ?? null,
    };
}

type ProjectRow = {
    id: string;
    user_id: string | null;
    org_id?: string | null;
};

export type ProjectAccess =
    | {
          ok: true;
          /** True when the caller created this row ("created by me"), which is
           *  provenance only — it grants no rights beyond the admin role the
           *  creator branch already derives. */
          isCreator: boolean;
          orgRole: OrgRole | null;
          projectRole: ProjectRole;
          project: ProjectRow;
      }
    | { ok: false };

export async function checkProjectAccess(
    projectId: string,
    userId: string,
    userEmail: string | null | undefined,
    db: Db,
): Promise<ProjectAccess> {
    const { data: project } = await db
        .from("projects")
        .select("id, user_id, org_id")
        .eq("id", projectId)
        .maybeSingle();
    if (!project) return { ok: false };
    const proj = project as ProjectRow;

    const isCreator = !!proj.user_id && proj.user_id === userId;

    // Organization scope is exclusive. Admins always inherit Owner and cannot
    // be downgraded or denied by a resource override. Members inherit Editor;
    // the creator remains Owner and an explicit override may promote, reduce,
    // or deny another Member's inherited access.
    if (proj.org_id) {
        const orgRole = await getOrgRole(userId, proj.org_id, db);
        if (!orgRole) return { ok: false };
        if (isCreator || orgRole === "admin")
            return {
                ok: true,
                isCreator,
                orgRole,
                projectRole: "owner",
                project: proj,
            };
        const override = await getOrgAccessOverrideRole(
            db,
            "project",
            proj.id,
            proj.org_id,
            userId,
        );
        if (!override.ok || override.role === "deny") return { ok: false };
        return {
            ok: true,
            isCreator: false,
            orgRole,
            projectRole: override.role ?? orgRoleToProjectRole(orgRole),
            project: proj,
        };
    }

    const grantRole = await getProjectGrantRole(proj.id, userEmail, db);
    const projectRole = isCreator ? "owner" : grantRole;
    if (!projectRole) return { ok: false };
    return { ok: true, isCreator, orgRole: null, projectRole, project: proj };
}

type ResourceAccess =
    | {
          ok: true;
          isCreator: boolean;
          orgRole: OrgRole | null;
          projectRole: ProjectRole;
      }
    | { ok: false };

/**
 * Some operations stay scoped to the person who made the row — replacing or
 * deleting one version of a document, moving a review between projects.
 * Those rules are about authorship, not tier, and they predate this module.
 *
 * They acquired a hole the moment account deletion started blanking
 * `user_id` instead of destroying an organization's content: a row can now
 * have no creator at all, and "only the creator may act" then means NOBODY
 * may act. The document is stranded inside a project the organization is
 * supposed to control — exactly the outcome detaching the row was meant to
 * prevent. So when the creator is gone, the container's Owners inherit the
 * operation. While a creator still exists, nothing changes: an Owner does
 * not get to reach into a colleague's versions.
 */
export function creatorScopedAllowed(
    access: { isCreator: boolean; projectRole: ProjectRole },
    creatorId: string | null | undefined,
): boolean {
    if (access.isCreator) return true;
    return !creatorId && can(access.projectRole, "container.delete");
}

/** Build the ResourceAccess for a derived project role. */
function resourceAccessFor(
    projectRole: ProjectRole,
    orgRole: OrgRole | null,
    isCreator: boolean,
): ResourceAccess {
    return { ok: true, isCreator, orgRole, projectRole };
}

async function organizationResourceAccess(
    kind: OrgResourceKind,
    row: { id: string; user_id: string | null; org_id?: string | null },
    userId: string,
    db: Db,
): Promise<ResourceAccess> {
    if (!row.org_id) return { ok: false };
    const orgRole = await getOrgRole(userId, row.org_id, db);
    if (!orgRole) return { ok: false };
    const isCreator = !!row.user_id && row.user_id === userId;
    if (isCreator || orgRole === "admin")
        return resourceAccessFor("owner", orgRole, isCreator);
    const override = await getOrgAccessOverrideRole(
        db,
        kind,
        row.id,
        row.org_id,
        userId,
    );
    if (!override.ok || override.role === "deny") return { ok: false };
    return resourceAccessFor(
        override.role ?? orgRoleToProjectRole(orgRole),
        orgRole,
        false,
    );
}

type WorkflowRow = {
    id: string;
    user_id: string | null;
    org_id?: string | null;
};

export type WorkflowAccess =
    | {
          ok: true;
          isCreator: boolean;
          orgRole: OrgRole | null;
          projectRole: ProjectRole;
          workflow: WorkflowRow;
      }
    | { ok: false };

/** Resolve a workflow through exactly one scope: organization or direct. */
export async function checkWorkflowAccess(
    workflowId: string,
    userId: string,
    userEmail: string | null | undefined,
    db: Db,
): Promise<WorkflowAccess> {
    const { data } = await db
        .from("workflows")
        .select("id, user_id, org_id")
        .eq("id", workflowId)
        .maybeSingle();
    if (!data) return { ok: false };
    const workflow = data as WorkflowRow;
    const isCreator = !!workflow.user_id && workflow.user_id === userId;

    if (workflow.org_id) {
        const access = await organizationResourceAccess(
            "workflow",
            workflow,
            userId,
            db,
        );
        return access.ok
            ? { ...access, workflow }
            : { ok: false };
    }

    if (isCreator)
        return {
            ok: true,
            isCreator: true,
            orgRole: null,
            projectRole: "owner",
            workflow,
        };
    const email = normalizeEmail(userEmail);
    if (!email) return { ok: false };
    // An exact match is correct because BOTH sides are canonical:
    // normalizeEmail trims and lowercases the caller's address, and
    // workflow_shares.shared_with_email carries a lowercase CHECK (added by
    // migration 20260904_02, which also folded the legacy mixed-case rows).
    // Before that constraint a mixed-case row listed for its recipient via
    // get_workflows_overview — which lowers both sides — and then missed
    // here, so the workflow 404'd the moment they opened it.
    const { data: share, error } = await db
        .from("workflow_shares")
        .select("role")
        .eq("workflow_id", workflowId)
        .eq("shared_with_email", email)
        .maybeSingle();
    if (error) return { ok: false };
    const role = (share as { role?: unknown } | null)?.role;
    if (!isProjectRole(role)) return { ok: false };
    return {
        ok: true,
        isCreator: false,
        orgRole: null,
        projectRole: role,
        workflow,
    };
}

/**
 * Check whether the current user can access a document the caller has
 * already loaded (saves a round-trip vs. having the helper re-fetch).
 * Project and workflow documents inherit their container role exactly.
 * `isCreator` remains row provenance: a project Owner is not the creator of a
 * colleague's document, while that colleague does not gain extra permissions
 * beyond the inherited container role.
 */
export async function ensureDocAccess(
    doc: {
        user_id: string | null;
        project_id: string | null;
        org_id?: string | null;
        workflow_id?: string | null;
    },
    userId: string,
    userEmail: string | null | undefined,
    db: Db,
): Promise<ResourceAccess> {
    if (doc.project_id) {
        const access = await checkProjectAccess(
            doc.project_id,
            userId,
            userEmail,
            db,
        );
        return access.ok
            ? resourceAccessFor(
                  access.projectRole,
                  access.orgRole,
                  !!doc.user_id && doc.user_id === userId,
              )
            : { ok: false };
    }
    if (doc.workflow_id) {
        const access = await checkWorkflowAccess(
            doc.workflow_id,
            userId,
            userEmail,
            db,
        );
        return access.ok
            ? resourceAccessFor(
                  access.projectRole,
                  access.orgRole,
                  !!doc.user_id && doc.user_id === userId,
              )
            : { ok: false };
    }
    if (doc.org_id) {
        const orgRole = await getOrgRole(userId, doc.org_id, db);
        if (!orgRole) return { ok: false };
        const isCreator = !!doc.user_id && doc.user_id === userId;
        return resourceAccessFor(
            isCreator ? "owner" : orgRoleToProjectRole(orgRole),
            orgRole,
            isCreator,
        );
    }
    const isCreator = !!doc.user_id && doc.user_id === userId;
    return isCreator
        ? resourceAccessFor("owner", null, true)
        : { ok: false };
}

/**
 * Shared derivation for tabular reviews and assistant chats. Project children
 * inherit the project role exactly. Standalone rows use creator/direct grants;
 * they never establish an organization scope of their own.
 */
async function ensureSharedRowAccess(
    kind: ContentGrantKind,
    row: {
        id: string;
        user_id: string | null;
        project_id: string | null;
        org_id?: string | null;
    },
    userId: string,
    userEmail: string | null | undefined,
    db: Db,
): Promise<ResourceAccess> {
    if (row.project_id) {
        const access = await checkProjectAccess(
            row.project_id,
            userId,
            userEmail,
            db,
        );
        return access.ok
            ? resourceAccessFor(
                  access.projectRole,
                  access.orgRole,
                  !!row.user_id && row.user_id === userId,
              )
            : { ok: false };
    }
    const isCreator = !!row.user_id && row.user_id === userId;
    if (isCreator) return resourceAccessFor("owner", null, true);
    const role = await getContentGrantRole(
        db,
        kind,
        row.id,
        userEmail,
    );
    return role ? resourceAccessFor(role, null, false) : { ok: false };
}

/**
 * Same shape as `ensureDocAccess`, for tabular_reviews: creator, direct
 * grant, or inherited project access, using one exclusive scope.
 */
export async function ensureReviewAccess(
    review: {
        id: string;
        user_id: string | null;
        project_id: string | null;
        org_id?: string | null;
    },
    userId: string,
    userEmail: string | null | undefined,
    db: Db,
): Promise<ResourceAccess> {
    return ensureSharedRowAccess("tabular_review", review, userId, userEmail, db);
}

/**
 * Same shape as `ensureReviewAccess`, for assistant chats. A project chat
 * inherits the project verdict; a standalone chat can be shared through a
 * direct grant, and is personal (org_id null) until it is.
 *
 * `get_chats_overview` mirrors this predicate branch for branch — keep the
 * two in lockstep, or a chat becomes openable by URL while staying invisible
 * in the list.
 */
export async function ensureChatAccess(
    chat: {
        id: string;
        user_id: string | null;
        project_id: string | null;
        org_id?: string | null;
    },
    userId: string,
    userEmail: string | null | undefined,
    db: Db,
): Promise<ResourceAccess> {
    return ensureSharedRowAccess("chat", chat, userId, userEmail, db);
}

/**
 * Filter user-supplied document IDs down to documents the caller can read.
 *
 * Tabular review routes accept document IDs from request bodies. Without this
 * check, a caller with access to any review could attach arbitrary document
 * UUIDs and later cause /generate or /regenerate-cell to extract those bytes.
 */
export async function filterAccessibleDocumentIds(
    documentIds: string[],
    userId: string,
    userEmail: string | null | undefined,
    db: Db,
): Promise<string[]> {
    if (documentIds.length === 0) return [];
    const { data: docs } = await db
        .from("documents")
        .select("id, user_id, project_id, workflow_id, org_id")
        .in("id", documentIds);
    const rows = (docs ?? []) as {
        id: string;
        user_id: string | null;
        project_id: string | null;
        workflow_id?: string | null;
        org_id?: string | null;
    }[];
    if (rows.length === 0) return [];

    const verdicts = await Promise.all(
        rows.map(async (doc) => ({
            id: doc.id,
            access: await ensureDocAccess(doc, userId, userEmail, db),
        })),
    );
    return verdicts.filter((entry) => entry.access.ok).map((entry) => entry.id);
}

const ACCESSIBLE_PROJECTS_PAGE_SIZE = 1000;
/** Guards a runaway loop, not a product limit. */
const ACCESSIBLE_PROJECTS_MAX_PAGES = 200;

async function pageProjectRows<T>(
    fetchPage: (from: number, to: number) => PromiseLike<{ data: T[] | null }>,
): Promise<T[]> {
    const rows: T[] = [];
    for (let page = 0; page < ACCESSIBLE_PROJECTS_MAX_PAGES; page += 1) {
        const from = page * ACCESSIBLE_PROJECTS_PAGE_SIZE;
        const { data } = await fetchPage(
            from,
            from + ACCESSIBLE_PROJECTS_PAGE_SIZE - 1,
        );
        const batch = (data ?? []) as T[];
        rows.push(...batch);
        if (batch.length < ACCESSIBLE_PROJECTS_PAGE_SIZE) break;
    }
    return rows;
}

/**
 * Returns the set of project IDs the user can access — projects they created,
 * any project they hold an access grant on, and any project in an org they
 * belong to. Used to scope chat lists and similar collection queries.
 *
 * Written as THREE bounded, paged reads plus ONE batched override read, and
 * deliberately not as `checkProjectAccess` per row. The previous shape issued
 * an unordered, unpaged `.in("org_id", …)` — silently truncated by PostgREST's
 * db-max-rows, so a large firm's audit trail simply lost the projects past the
 * cap — and then fanned out one verdict per org project, each of which is
 * itself two or three round trips. A firm with a few hundred matters paid
 * ~1000 sequential queries for one chat-list request. Paging by `id` (the
 * primary key, so the order is total and stable across pages) makes the reads
 * complete; re-deriving the org verdict inline from the same rules
 * checkProjectAccess applies makes them cheap.
 */
export async function listAccessibleProjectIds(
    userId: string,
    userEmail: string | null | undefined,
    db: Db,
): Promise<string[]> {
    const normalizedEmail = normalizeEmail(userEmail);

    // Roles, not just ids: an org ADMIN cannot be denied a project, which is
    // one of the two exemptions the override filter below has to honour.
    const { data: membershipRows } = await db
        .from("org_members")
        .select("org_id, role")
        .eq("user_id", userId);
    const orgRoleByOrgId = new Map<string, string>();
    for (const row of (membershipRows ?? []) as {
        org_id?: string | null;
        role?: string | null;
    }[]) {
        if (row.org_id) orgRoleByOrgId.set(row.org_id, row.role ?? "");
    }
    const orgIds = [...orgRoleByOrgId.keys()];

    const { data: grants } = normalizedEmail
        ? await db
              .from("project_access_grants")
              .select("project_id")
              .eq("email", normalizedEmail)
        : { data: [] as { project_id?: string | null }[] };
    const grantIds = [
        ...new Set(
            ((grants ?? []) as { project_id?: string | null }[])
                .map((grant) => grant.project_id)
                .filter((id): id is string => !!id),
        ),
    ];

    const [personalOwned, personalGranted, orgProjects, denials] =
        await Promise.all([
            // Personal projects the caller created. Their ORG projects are
            // resolved by the org branch instead, because a creator who has
            // left the org no longer has access to them — exactly what
            // checkProjectAccess answers.
            pageProjectRows<{ id: string }>((from, to) =>
                db
                    .from("projects")
                    .select("id")
                    .eq("user_id", userId)
                    .is("org_id", null)
                    .order("id", { ascending: true })
                    .range(from, to),
            ),
            grantIds.length
                ? pageProjectRows<{ id: string }>((from, to) =>
                      db
                          .from("projects")
                          .select("id")
                          .in("id", grantIds)
                          .is("org_id", null)
                          .order("id", { ascending: true })
                          .range(from, to),
                  )
                : Promise.resolve([] as { id: string }[]),
            orgIds.length
                ? pageProjectRows<{
                      id: string;
                      user_id: string | null;
                      org_id: string;
                  }>((from, to) =>
                      db
                          .from("projects")
                          .select("id, user_id, org_id")
                          .in("org_id", orgIds)
                          .order("id", { ascending: true })
                          .range(from, to),
                  )
                : Promise.resolve(
                      [] as {
                          id: string;
                          user_id: string | null;
                          org_id: string;
                      }[],
                  ),
            // One read for every deny this caller holds anywhere in their
            // orgs, instead of one verdict per project. Scoped by org_id so
            // the filter is bounded by membership rather than by a list of
            // every candidate project id.
            orgIds.length
                ? db
                      .from("project_org_access_overrides")
                      .select("project_id")
                      .in("org_id", orgIds)
                      .eq("user_id", userId)
                      .eq("role", "deny")
                : Promise.resolve({
                      data: [] as { project_id?: string | null }[],
                      error: null,
                  }),
        ]);

    const deniedProjectIds = new Set(
        ((denials.data ?? []) as { project_id?: string | null }[])
            .map((row) => row.project_id)
            .filter((id): id is string => !!id),
    );

    const ids = new Set<string>();
    for (const project of personalOwned) ids.add(project.id);
    for (const project of personalGranted) ids.add(project.id);
    for (const project of orgProjects) {
        // The two exemptions checkProjectAccess applies: the creator and an
        // org admin always keep Owner and cannot be denied.
        const isCreator = !!project.user_id && project.user_id === userId;
        const isOrgAdmin = orgRoleByOrgId.get(project.org_id) === "admin";
        if (!isCreator && !isOrgAdmin && deniedProjectIds.has(project.id))
            continue;
        ids.add(project.id);
    }
    return [...ids];
}
