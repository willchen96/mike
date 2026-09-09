// Business logic + data-access for the organizations / RBAC module.
//
// These functions are the service layer behind routes/orgs.ts. They take an
// explicit Supabase client (`db`) plus request-derived primitives, enforce the
// admin/member role model, and RETURN typed discriminated results the thin
// route handlers map onto HTTP status codes. They never touch req/res.
//
// Role model (see also backend/src/lib/access.ts):
//   admin  — administers the organization: settings, invitations, member
//            roles and removal.
//   member — reads the organization and its roster. No org mutations.
// Both roles receive Editor on organization content unless an item-specific
// override assigns Owner, Viewer or Deny.
//
// There is no owner tier. An owner role that only one person could hold made
// every org a single point of failure and forced two nearly identical "can
// manage" checks; instead the database guarantees an org always retains at
// least one admin (org_members_protect_last_admin), and admins are peers.
//
// Membership is never granted directly. An admin creates an INVITATION; the
// org_members row appears only when the invited account accepts it. Adding
// someone to a firm workspace exposes confidential content, so it takes the
// recipient's consent, not just the inviter's intent.

import { createServerSupabase } from "./supabase";
import { recordAudit } from "./audit";
import {
    getOrgRole,
    isOrgAdmin,
    isOrgRole,
    normalizeEmail,
    type OrgRole,
} from "./access";

type Db = ReturnType<typeof createServerSupabase>;

type DbError = { code?: string; message: string } | null;

/** How long a pending invitation stays acceptable. */
export const INVITATION_TTL_DAYS = 14;

/**
 * Every table that carries its own `org_id` — the complete inventory of what
 * an organization can directly own.
 *
 * ONE list, because two different call sites ask the same question and used
 * to disagree about the answer: `deleteOrg` below (may this org be deleted?)
 * and account deletion (`listOrgsBlockingAccountDeletion` in
 * lib/userDataCleanup.ts). The account-deletion probe omitted `chats`, so an
 * org whose only remaining content was a chat looked empty and was deleted —
 * while `deleteOrg` refused the very same delete over the API.
 *
 * Every one of these foreign keys is ON DELETE RESTRICT, so an incomplete
 * probe does not silently detach content: the database refuses the delete and
 * the caller gets a raw constraint error instead of an intentional 409. The
 * probe exists to answer first.
 */
export const ORG_CONTENT_TABLES = [
    "projects",
    "documents",
    "chats",
    "tabular_reviews",
    "workflows",
] as const;

export type InvitationStatus =
    | "pending"
    | "accepted"
    | "declined"
    | "cancelled"
    | "expired";

/**
 * The existence pre-checks in createInvitation race with concurrent inserts;
 * the unique indexes backstop correctness, but a raw 23505 would surface as a
 * 500. Map it onto the same 409 the sequential path returns.
 */
function isUniqueViolation(error: DbError): boolean {
    return error?.code === "23505";
}

/**
 * The org_members_protect_last_admin trigger closes the read-then-act race on
 * last-admin protection at the DB level; when it fires, translate its 23514
 * into the same `last_admin` result the sequential in-process check produces.
 */
function isLastAdminViolation(error: DbError): boolean {
    return (
        error?.code === "23514" &&
        (error?.message ?? "").includes("at least one admin")
    );
}

function isResourceOwnerViolation(error: DbError): boolean {
    return (
        error?.code === "23514" &&
        (error?.message ?? "").includes("Transfer ownership")
    );
}

export type OrgResult<T> =
    | ({ ok: true } & T)
    | { ok: false; kind: "validation"; detail: string }
    | { ok: false; kind: "forbidden" }
    | { ok: false; kind: "not_found" }
    | { ok: false; kind: "conflict"; detail: string }
    | { ok: false; kind: "last_admin" }
    | { ok: false; kind: "expired" }
    | { ok: false; kind: "db_error"; detail: string };

// ---------------------------------------------------------------------------
// Org CRUD
// ---------------------------------------------------------------------------

export async function listMyOrgs(
    db: Db,
    userId: string,
): Promise<OrgResult<{ orgs: unknown[] }>> {
    const { data: memberships, error } = await db
        .from("org_members")
        .select("org_id, role")
        .eq("user_id", userId);
    if (error) return { ok: false, kind: "db_error", detail: error.message };

    const rows = (memberships ?? []) as { org_id: string; role: OrgRole }[];
    const roleByOrg = new Map<string, OrgRole>();
    for (const r of rows) roleByOrg.set(r.org_id, r.role);
    const orgIds = [...roleByOrg.keys()];
    if (orgIds.length === 0) return { ok: true, orgs: [] };

    const { data: orgs, error: orgsError } = await db
        .from("organizations")
        .select("*")
        .in("id", orgIds);
    if (orgsError)
        return { ok: false, kind: "db_error", detail: orgsError.message };

    // Roster sizes let the UI render "N members" without a second round-trip
    // per org.
    const { data: allMembers } = await db
        .from("org_members")
        .select("org_id")
        .in("org_id", orgIds);
    const memberCounts = new Map<string, number>();
    for (const row of (allMembers ?? []) as { org_id?: string | null }[]) {
        if (!row.org_id) continue;
        memberCounts.set(row.org_id, (memberCounts.get(row.org_id) ?? 0) + 1);
    }

    const enriched = ((orgs ?? []) as { id: string }[]).map((o) => ({
        ...o,
        role: roleByOrg.get(o.id) ?? null,
        member_count: memberCounts.get(o.id) ?? 0,
    }));
    return { ok: true, orgs: enriched };
}

export async function createOrg(
    db: Db,
    params: { userId: string; name: unknown },
): Promise<OrgResult<{ org: Record<string, unknown> }>> {
    const name = typeof params.name === "string" ? params.name.trim() : "";
    if (!name)
        return { ok: false, kind: "validation", detail: "name is required" };

    const { data: org, error } = await db
        .from("organizations")
        .insert({ name, created_by: params.userId })
        .select("*")
        .single();
    if (error || !org)
        return {
            ok: false,
            kind: "db_error",
            detail: error?.message ?? "Failed to create organization",
        };

    // The creator is the org's first admin. This is the ONLY path that writes
    // org_members without an accepted invitation.
    const { error: memberError } = await db
        .from("org_members")
        .insert({ org_id: org.id, user_id: params.userId, role: "admin" });
    if (memberError) {
        // Roll back the org so we never leave an org without an admin.
        await db.from("organizations").delete().eq("id", org.id);
        return { ok: false, kind: "db_error", detail: memberError.message };
    }

    return { ok: true, org: { ...org, role: "admin", member_count: 1 } };
}

export async function getOrg(
    db: Db,
    params: { userId: string; orgId: string },
): Promise<OrgResult<{ org: Record<string, unknown> }>> {
    const role = await getOrgRole(params.userId, params.orgId, db);
    if (!role) return { ok: false, kind: "not_found" };

    const { data: org, error } = await db
        .from("organizations")
        .select("*")
        .eq("id", params.orgId)
        .maybeSingle();
    if (error || !org) return { ok: false, kind: "not_found" };
    return { ok: true, org: { ...org, role } };
}

export async function updateOrg(
    db: Db,
    params: { userId: string; orgId: string; name: unknown },
): Promise<OrgResult<{ org: Record<string, unknown> }>> {
    const role = await getOrgRole(params.userId, params.orgId, db);
    if (!role) return { ok: false, kind: "not_found" };
    if (!isOrgAdmin(role)) return { ok: false, kind: "forbidden" };

    const name = typeof params.name === "string" ? params.name.trim() : "";
    if (!name)
        return { ok: false, kind: "validation", detail: "name is required" };

    const { data: org, error } = await db
        .from("organizations")
        .update({ name, updated_at: new Date().toISOString() })
        .eq("id", params.orgId)
        .select("*")
        .single();
    if (error || !org)
        return {
            ok: false,
            kind: "db_error",
            detail: error?.message ?? "Failed to update organization",
        };
    return { ok: true, org: { ...org, role } };
}

export async function deleteOrg(
    db: Db,
    params: { userId: string; userEmail?: string | null; orgId: string },
): Promise<OrgResult<Record<never, never>>> {
    const role = await getOrgRole(params.userId, params.orgId, db);
    if (!role) return { ok: false, kind: "not_found" };
    if (!isOrgAdmin(role)) return { ok: false, kind: "forbidden" };

    const { data: org } = await db
        .from("organizations")
        .select("id, name")
        .eq("id", params.orgId)
        .maybeSingle();
    if (!org) return { ok: false, kind: "not_found" };

    const inventories = await Promise.all(
        ORG_CONTENT_TABLES.map(async (table) => ({
            table,
            result: await db.from(table).select("id").eq("org_id", params.orgId),
        })),
    );
    const failedInventory = inventories.find((entry) => entry.result.error);
    if (failedInventory?.result.error)
        return {
            ok: false,
            kind: "db_error",
            detail: failedInventory.result.error.message,
        };
    const resourceCount = inventories.reduce(
        (count, entry) => count + (entry.result.data?.length ?? 0),
        0,
    );
    if (resourceCount > 0)
        return {
            ok: false,
            kind: "conflict",
            detail: `This organization still contains ${resourceCount} resource${resourceCount === 1 ? "" : "s"}. Move or delete them before deleting the organization.`,
        };

    const { error } = await db
        .from("organizations")
        .delete()
        .eq("id", params.orgId);
    if (error)
        return { ok: false, kind: "db_error", detail: error.message };

    await recordAudit(db, {
        userId: params.userId,
        userEmail: params.userEmail ?? null,
        action: "org.deleted",
        title: typeof org.name === "string" ? org.name : null,
        detail: { org_id: params.orgId },
    });
    return { ok: true };
}

/**
 * The organization's projects and workflows, as the CALLER may see them.
 *
 * Membership is what makes this list reachable, but it is not what decides
 * its contents. A `deny` override is the ethical-wall tier: the member must
 * not learn that the matter exists, and the columns here — a project's name
 * and its cm_number, a workflow's title — are exactly the detail a wall is
 * put up to withhold. Listing a row whose link then 404s leaks the thing the
 * override was bought to hide.
 *
 * Denials cannot touch an admin or a resource's creator (the
 * `validate_org_access_override` trigger refuses to write one), so the two
 * short-circuits below are the same ones `project_access_role` takes in SQL —
 * kept here so this filter reads as that predicate rather than as a rule of
 * its own.
 */
export async function listOrgResources(
    db: Db,
    params: { userId: string; orgId: string },
): Promise<
    OrgResult<{
        projects: unknown[];
        workflows: unknown[];
    }>
> {
    const role = await getOrgRole(params.userId, params.orgId, db);
    if (!role) return { ok: false, kind: "not_found" };

    // One batched read per override table, not one per resource: this is a
    // filter over a page of rows, and it must not become an N+1.
    const [projectsResult, workflowsResult, projectDenials, workflowDenials] =
        await Promise.all([
            db
                .from("projects")
                .select("id, user_id, org_id, name, cm_number, practice, created_at, updated_at")
                .eq("org_id", params.orgId)
                .order("created_at", { ascending: false }),
            db
                .from("workflows")
                .select(
                    "id, user_id, org_id, title, type, practice, created_at",
                )
                .eq("org_id", params.orgId)
                .order("created_at", { ascending: false }),
            db
                .from("project_org_access_overrides")
                .select("project_id")
                .eq("org_id", params.orgId)
                .eq("user_id", params.userId)
                .eq("role", "deny"),
            db
                .from("workflow_org_access_overrides")
                .select("workflow_id")
                .eq("org_id", params.orgId)
                .eq("user_id", params.userId)
                .eq("role", "deny"),
        ]);
    const failed = [
        projectsResult,
        workflowsResult,
        projectDenials,
        workflowDenials,
    ].find((result) => result.error)?.error;
    if (failed)
        return { ok: false, kind: "db_error", detail: failed.message };

    // Fail closed: an unreadable override table must hide rows, never reveal
    // them. `error` is handled above, so an empty set here means "no denials".
    const deniedIds = (rows: unknown, key: string) =>
        new Set(
            ((rows ?? []) as Record<string, unknown>[])
                .map((row) => row[key])
                .filter((id): id is string => typeof id === "string"),
        );
    const deniedProjectIds = deniedIds(projectDenials.data, "project_id");
    const deniedWorkflowIds = deniedIds(workflowDenials.data, "workflow_id");

    const visible = <T extends { id?: unknown; user_id?: unknown }>(
        rows: T[],
        denied: Set<string>,
    ) =>
        rows.filter((row) => {
            if (isOrgAdmin(role)) return true;
            if (row.user_id && row.user_id === params.userId) return true;
            return typeof row.id !== "string" || !denied.has(row.id);
        });

    return {
        ok: true,
        projects: visible(
            (projectsResult.data ?? []) as { id?: unknown; user_id?: unknown }[],
            deniedProjectIds,
        ),
        workflows: visible(
            (workflowsResult.data ?? []) as {
                id?: unknown;
                user_id?: unknown;
            }[],
            deniedWorkflowIds,
        ),
    };
}

// ---------------------------------------------------------------------------
// Membership
// ---------------------------------------------------------------------------

/**
 * Decorate membership rows with the profile identity the roster UI needs.
 * user_profiles mirrors auth.users' email precisely so sharing/roster reads
 * never scan the auth schema.
 */
async function attachProfiles(
    db: Db,
    rows: { user_id: string }[],
): Promise<Map<string, { email: string | null; display_name: string | null }>> {
    const byUser = new Map<
        string,
        { email: string | null; display_name: string | null }
    >();
    const userIds = [...new Set(rows.map((r) => r.user_id).filter(Boolean))];
    if (userIds.length === 0) return byUser;
    const { data } = await db
        .from("user_profiles")
        .select("user_id, email, display_name")
        .in("user_id", userIds);
    for (const p of (data ?? []) as {
        user_id: string;
        email: string | null;
        display_name: string | null;
    }[]) {
        byUser.set(p.user_id, {
            email: p.email ?? null,
            display_name: p.display_name ?? null,
        });
    }
    return byUser;
}

export async function listMembers(
    db: Db,
    params: { userId: string; orgId: string },
): Promise<OrgResult<{ members: unknown[] }>> {
    const role = await getOrgRole(params.userId, params.orgId, db);
    if (!role) return { ok: false, kind: "not_found" };

    const { data, error } = await db
        .from("org_members")
        .select("id, user_id, role, created_at")
        .eq("org_id", params.orgId);
    if (error) return { ok: false, kind: "db_error", detail: error.message };

    const rows = (data ?? []) as {
        id: string;
        user_id: string;
        role: OrgRole;
        created_at: string;
    }[];
    const profiles = await attachProfiles(db, rows);
    return {
        ok: true,
        members: rows.map((m) => ({
            ...m,
            email: profiles.get(m.user_id)?.email ?? null,
            display_name: profiles.get(m.user_id)?.display_name ?? null,
        })),
    };
}

async function countAdmins(db: Db, orgId: string): Promise<number> {
    const { data } = await db
        .from("org_members")
        .select("user_id")
        .eq("org_id", orgId)
        .eq("role", "admin");
    return ((data ?? []) as unknown[]).length;
}

export async function updateMember(
    db: Db,
    params: {
        actorId: string;
        actorEmail?: string | null;
        orgId: string;
        targetUserId: string;
        role: unknown;
    },
): Promise<OrgResult<{ member: Record<string, unknown> }>> {
    const actorRole = await getOrgRole(params.actorId, params.orgId, db);
    if (!actorRole) return { ok: false, kind: "not_found" };
    if (!isOrgAdmin(actorRole)) return { ok: false, kind: "forbidden" };

    if (!isOrgRole(params.role))
        return { ok: false, kind: "validation", detail: "invalid role" };
    const nextRole = params.role;

    const targetRole = await getOrgRole(params.targetUserId, params.orgId, db);
    if (!targetRole) return { ok: false, kind: "not_found" };

    // Last-admin protection: demoting the sole admin would strand the org
    // with nobody able to invite, remove or re-role anyone.
    if (targetRole === "admin" && nextRole !== "admin") {
        const admins = await countAdmins(db, params.orgId);
        if (admins <= 1) return { ok: false, kind: "last_admin" };
    }

    const { data: member, error } = await db
        .from("org_members")
        .update({ role: nextRole, updated_at: new Date().toISOString() })
        .eq("org_id", params.orgId)
        .eq("user_id", params.targetUserId)
        .select("*")
        .single();
    if (error || !member) {
        if (isLastAdminViolation(error))
            return { ok: false, kind: "last_admin" };
        return {
            ok: false,
            kind: "db_error",
            detail: error?.message ?? "Failed to update member",
        };
    }
    // Role changes move real standing (an org role inherits onto every
    // project the org owns), so they belong in the same audit trail the
    // invitation lifecycle already writes to.
    const profiles = await attachProfiles(db, [
        { user_id: params.targetUserId },
    ]);
    await recordAudit(db, {
        userId: params.actorId,
        userEmail: params.actorEmail ?? null,
        action: "org.member.role_changed",
        title: profiles.get(params.targetUserId)?.email ?? params.targetUserId,
        detail: {
            org_id: params.orgId,
            target_user_id: params.targetUserId,
            previous_role: targetRole,
            role: nextRole,
        },
    });
    return { ok: true, member };
}

export async function removeMember(
    db: Db,
    params: {
        actorId: string;
        actorEmail?: string | null;
        orgId: string;
        targetUserId: string;
    },
): Promise<OrgResult<Record<never, never>>> {
    const actorRole = await getOrgRole(params.actorId, params.orgId, db);
    if (!actorRole) return { ok: false, kind: "not_found" };
    // A member may remove themselves (leave); removing others needs admin.
    const isSelf = params.actorId === params.targetUserId;
    if (!isSelf && !isOrgAdmin(actorRole))
        return { ok: false, kind: "forbidden" };

    const targetRole = await getOrgRole(params.targetUserId, params.orgId, db);
    if (!targetRole) return { ok: false, kind: "not_found" };

    // Last-admin protection: never remove the sole admin, not even by their
    // own hand — they must appoint a successor first.
    if (targetRole === "admin") {
        const admins = await countAdmins(db, params.orgId);
        if (admins <= 1) return { ok: false, kind: "last_admin" };
    }

    const { error } = await db
        .from("org_members")
        .delete()
        .eq("org_id", params.orgId)
        .eq("user_id", params.targetUserId);
    if (error) {
        if (isLastAdminViolation(error))
            return { ok: false, kind: "last_admin" };
        if (isResourceOwnerViolation(error))
            return {
                ok: false,
                kind: "conflict",
                detail:
                    "Transfer ownership of this member's organization resources before removing them.",
            };
        return { ok: false, kind: "db_error", detail: error.message };
    }
    const profiles = await attachProfiles(db, [
        { user_id: params.targetUserId },
    ]);
    await recordAudit(db, {
        userId: params.actorId,
        userEmail: params.actorEmail ?? null,
        action: isSelf ? "org.member.left" : "org.member.removed",
        title: profiles.get(params.targetUserId)?.email ?? params.targetUserId,
        detail: {
            org_id: params.orgId,
            target_user_id: params.targetUserId,
            role: targetRole,
        },
    });
    return { ok: true };
}

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------

type InvitationRow = {
    id: string;
    org_id: string;
    email: string;
    role: OrgRole;
    invited_by: string | null;
    status: InvitationStatus;
    expires_at: string;
    created_at: string;
    accepted_at: string | null;
    declined_at: string | null;
    cancelled_at: string | null;
};

function isExpired(row: { status: string; expires_at: string }): boolean {
    return (
        row.status === "pending" && new Date(row.expires_at).getTime() <= Date.now()
    );
}

/**
 * Expiry is evaluated lazily on read rather than by a sweeper job: a pending
 * invitation past its expires_at reports as `expired` and cannot be accepted.
 * The stored status stays 'pending' until someone acts on it, so there is no
 * background writer racing the accept path.
 */
function presentInvitation(row: InvitationRow) {
    return { ...row, status: isExpired(row) ? "expired" : row.status };
}

function invitationExpiry(): string {
    return new Date(
        Date.now() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
}

export async function createInvitation(
    db: Db,
    params: {
        actorId: string;
        actorEmail?: string | null;
        orgId: string;
        email: unknown;
        role: unknown;
    },
): Promise<OrgResult<{ invitation: Record<string, unknown> }>> {
    const actorRole = await getOrgRole(params.actorId, params.orgId, db);
    if (!actorRole) return { ok: false, kind: "not_found" };
    if (!isOrgAdmin(actorRole)) return { ok: false, kind: "forbidden" };

    const email =
        typeof params.email === "string" ? normalizeEmail(params.email) : null;
    if (!email || !email.includes("@"))
        return {
            ok: false,
            kind: "validation",
            detail: "A valid email address is required",
        };
    const actorEmail = normalizeEmail(params.actorEmail);
    if (actorEmail && actorEmail === email)
        return {
            ok: false,
            kind: "validation",
            detail: "You are already a member of this organization",
        };

    // Omitting the role still means "member" — that is the documented
    // default. Naming one that does not exist is a different thing, and it
    // gets the same 400 that updateMember and project sharing already give.
    // Coercing 'owner' to 'member' behind a 201 would answer a request for a
    // tier this product deleted by inventing a quieter one, and the caller
    // would have no way to tell.
    if (params.role !== undefined && params.role !== null && !isOrgRole(params.role))
        return {
            ok: false,
            kind: "validation",
            detail: "Role must be admin or member",
        };
    const role: OrgRole = isOrgRole(params.role) ? params.role : "member";

    // Someone who already belongs here needs no invitation. Resolved through
    // the mirrored profile email so the check never scans auth.users.
    const { data: profile } = await db
        .from("user_profiles")
        .select("user_id")
        .eq("email", email)
        .maybeSingle();
    const existingUserId = (profile as { user_id?: string } | null)?.user_id;
    if (existingUserId) {
        const existingRole = await getOrgRole(
            existingUserId,
            params.orgId,
            db,
        );
        if (existingRole)
            return {
                ok: false,
                kind: "conflict",
                detail: "That person is already a member of this organization",
            };
    }

    // One live invitation per (org, email). A previously expired one is
    // re-openable: refresh it in place rather than accumulating dead rows.
    const { data: existingInvite } = await db
        .from("org_invitations")
        .select("*")
        .eq("org_id", params.orgId)
        .eq("email", email)
        .eq("status", "pending")
        .maybeSingle();
    const live = existingInvite as InvitationRow | null;
    if (live && !isExpired(live))
        return {
            ok: false,
            kind: "conflict",
            detail: "That email already has a pending invitation",
        };
    if (live) {
        const { data: refreshed, error: refreshError } = await db
            .from("org_invitations")
            .update({
                role,
                invited_by: params.actorId,
                expires_at: invitationExpiry(),
            })
            .eq("id", live.id)
            .select("*")
            .single();
        if (refreshError || !refreshed)
            return {
                ok: false,
                kind: "db_error",
                detail: refreshError?.message ?? "Failed to create invitation",
            };
        await recordAudit(db, {
            userId: params.actorId,
            userEmail: params.actorEmail ?? null,
            action: "org.invite.created",
            title: email,
            detail: { org_id: params.orgId, role, invitation_id: live.id },
        });
        return {
            ok: true,
            invitation: presentInvitation(refreshed as InvitationRow),
        };
    }

    const { data: invitation, error } = await db
        .from("org_invitations")
        .insert({
            org_id: params.orgId,
            email,
            role,
            invited_by: params.actorId,
            status: "pending",
            expires_at: invitationExpiry(),
        })
        .select("*")
        .single();
    if (error || !invitation) {
        if (isUniqueViolation(error))
            return {
                ok: false,
                kind: "conflict",
                detail: "That email already has a pending invitation",
            };
        return {
            ok: false,
            kind: "db_error",
            detail: error?.message ?? "Failed to create invitation",
        };
    }
    await recordAudit(db, {
        userId: params.actorId,
        userEmail: params.actorEmail ?? null,
        action: "org.invite.created",
        title: email,
        detail: {
            org_id: params.orgId,
            role,
            invitation_id: (invitation as { id: string }).id,
        },
    });
    return {
        ok: true,
        invitation: presentInvitation(invitation as InvitationRow),
    };
}

export async function listInvitations(
    db: Db,
    params: { userId: string; orgId: string },
): Promise<OrgResult<{ invitations: unknown[] }>> {
    const role = await getOrgRole(params.userId, params.orgId, db);
    if (!role) return { ok: false, kind: "not_found" };
    // The roster of who has been asked to join is administrative detail.
    if (!isOrgAdmin(role)) return { ok: false, kind: "forbidden" };

    const { data, error } = await db
        .from("org_invitations")
        .select("*")
        .eq("org_id", params.orgId)
        .order("created_at", { ascending: false });
    if (error) return { ok: false, kind: "db_error", detail: error.message };
    const rows = (data ?? []) as InvitationRow[];
    const profiles = await attachProfiles(
        db,
        rows
            .filter((r) => r.invited_by)
            .map((r) => ({ user_id: r.invited_by as string })),
    );
    return {
        ok: true,
        invitations: rows.map((r) => ({
            ...presentInvitation(r),
            invited_by_email: r.invited_by
                ? (profiles.get(r.invited_by)?.email ?? null)
                : null,
        })),
    };
}

export async function cancelInvitation(
    db: Db,
    params: {
        actorId: string;
        actorEmail?: string | null;
        orgId: string;
        invitationId: string;
    },
): Promise<OrgResult<Record<never, never>>> {
    const actorRole = await getOrgRole(params.actorId, params.orgId, db);
    if (!actorRole) return { ok: false, kind: "not_found" };
    if (!isOrgAdmin(actorRole)) return { ok: false, kind: "forbidden" };

    const { data: invite } = await db
        .from("org_invitations")
        .select("*")
        .eq("id", params.invitationId)
        .eq("org_id", params.orgId)
        .maybeSingle();
    const row = invite as InvitationRow | null;
    if (!row) return { ok: false, kind: "not_found" };
    // A cancelled invitation was withdrawn by an admin, not answered by the
    // recipient — reporting it as "already answered" tells them something
    // untrue about their own actions. It reads as missing instead, which is
    // the branch the client's "may have been cancelled" copy is written for.
    if (row.status === "cancelled") return { ok: false, kind: "not_found" };
    if (row.status !== "pending")
        return {
            ok: false,
            kind: "conflict",
            detail: "That invitation has already been answered",
        };

    const { error } = await db
        .from("org_invitations")
        .update({
            status: "cancelled",
            cancelled_at: new Date().toISOString(),
        })
        .eq("id", row.id);
    if (error) return { ok: false, kind: "db_error", detail: error.message };
    await recordAudit(db, {
        userId: params.actorId,
        userEmail: params.actorEmail ?? null,
        action: "org.invite.cancelled",
        title: row.email,
        detail: { org_id: params.orgId, invitation_id: row.id },
    });
    return { ok: true };
}

export async function resendInvitation(
    db: Db,
    params: {
        actorId: string;
        actorEmail?: string | null;
        orgId: string;
        invitationId: string;
    },
): Promise<OrgResult<{ invitation: Record<string, unknown> }>> {
    const actorRole = await getOrgRole(params.actorId, params.orgId, db);
    if (!actorRole) return { ok: false, kind: "not_found" };
    if (!isOrgAdmin(actorRole)) return { ok: false, kind: "forbidden" };

    const { data: invite } = await db
        .from("org_invitations")
        .select("*")
        .eq("id", params.invitationId)
        .eq("org_id", params.orgId)
        .maybeSingle();
    const row = invite as InvitationRow | null;
    if (!row) return { ok: false, kind: "not_found" };
    // Resending an answered invitation would silently re-open a decision the
    // recipient already made. Only pending ones (expired included) refresh.
    // A cancelled invitation was withdrawn by an admin, not answered by the
    // recipient — reporting it as "already answered" tells them something
    // untrue about their own actions. It reads as missing instead, which is
    // the branch the client's "may have been cancelled" copy is written for.
    if (row.status === "cancelled") return { ok: false, kind: "not_found" };
    if (row.status !== "pending")
        return {
            ok: false,
            kind: "conflict",
            detail: "That invitation has already been answered",
        };

    const { data: refreshed, error } = await db
        .from("org_invitations")
        .update({ expires_at: invitationExpiry() })
        .eq("id", row.id)
        .select("*")
        .single();
    if (error || !refreshed)
        return {
            ok: false,
            kind: "db_error",
            detail: error?.message ?? "Failed to resend invitation",
        };
    await recordAudit(db, {
        userId: params.actorId,
        userEmail: params.actorEmail ?? null,
        action: "org.invite.resent",
        title: row.email,
        detail: { org_id: params.orgId, invitation_id: row.id },
    });
    return {
        ok: true,
        invitation: presentInvitation(refreshed as InvitationRow),
    };
}

/**
 * Invitations addressed to the caller. Matching is by normalized email, which
 * is what makes claim-after-signup work: an invitation created before the
 * recipient had an account is waiting for them the moment their profile
 * carries that address.
 */
export async function listMyInvitations(
    db: Db,
    params: { userEmail?: string | null },
): Promise<OrgResult<{ invitations: unknown[] }>> {
    const email = normalizeEmail(params.userEmail);
    if (!email) return { ok: true, invitations: [] };

    const { data, error } = await db
        .from("org_invitations")
        .select("*")
        .eq("email", email)
        .eq("status", "pending")
        .order("created_at", { ascending: false });
    if (error) return { ok: false, kind: "db_error", detail: error.message };

    const rows = ((data ?? []) as InvitationRow[]).filter((r) => !isExpired(r));
    if (rows.length === 0) return { ok: true, invitations: [] };

    const orgIds = [...new Set(rows.map((r) => r.org_id))];
    const { data: orgs } = await db
        .from("organizations")
        .select("id, name")
        .in("id", orgIds);
    const nameById = new Map(
        ((orgs ?? []) as { id: string; name: string }[]).map((o) => [
            o.id,
            o.name,
        ]),
    );
    const profiles = await attachProfiles(
        db,
        rows
            .filter((r) => r.invited_by)
            .map((r) => ({ user_id: r.invited_by as string })),
    );
    return {
        ok: true,
        invitations: rows.map((r) => ({
            ...presentInvitation(r),
            org_name: nameById.get(r.org_id) ?? null,
            invited_by_email: r.invited_by
                ? (profiles.get(r.invited_by)?.email ?? null)
                : null,
        })),
    };
}

/** Load an invitation and verify it is this caller's to answer. */
async function loadAnswerableInvitation(
    db: Db,
    params: { userEmail?: string | null; invitationId: string },
): Promise<
    | { ok: true; invitation: InvitationRow }
    | Extract<OrgResult<unknown>, { ok: false }>
> {
    const email = normalizeEmail(params.userEmail);
    const { data } = await db
        .from("org_invitations")
        .select("*")
        .eq("id", params.invitationId)
        .maybeSingle();
    const row = data as InvitationRow | null;
    // An invitation addressed to somebody else is reported as missing rather
    // than forbidden: otherwise the 403/404 split would confirm that a given
    // invitation id exists for some other address.
    if (!row || !email || row.email !== email)
        return { ok: false, kind: "not_found" };
    // A cancelled invitation was withdrawn by an admin, not answered by the
    // recipient — reporting it as "already answered" tells them something
    // untrue about their own actions. It reads as missing instead, which is
    // the branch the client's "may have been cancelled" copy is written for.
    if (row.status === "cancelled") return { ok: false, kind: "not_found" };
    if (row.status !== "pending")
        return {
            ok: false,
            kind: "conflict",
            detail: "That invitation has already been answered",
        };
    if (isExpired(row)) return { ok: false, kind: "expired" };
    return { ok: true, invitation: row };
}

export async function acceptInvitation(
    db: Db,
    params: {
        userId: string;
        userEmail?: string | null;
        invitationId: string;
    },
): Promise<OrgResult<{ org_id: string; role: OrgRole }>> {
    const loaded = await loadAnswerableInvitation(db, params);
    if (!loaded.ok) return loaded;
    const invite = loaded.invitation;

    // Acceptance is the only door through which org_members rows appear
    // (apart from an org's creator). Idempotent for the already-a-member
    // case: mark the invitation answered rather than 500ing on the unique.
    const existing = await getOrgRole(params.userId, invite.org_id, db);
    // Grants are FLOORS, not ceilings — the same rule `strongerRole` applies
    // to project access. Accepting an admin invitation while already a member
    // raises you to admin; accepting a member invitation while already an
    // admin leaves you an admin, because an invitation is an offer of
    // access, not an instruction to reduce it. Demotion is what
    // PATCH /orgs/:orgId/members exists for, where an admin does it on
    // purpose and the last-admin guard gets a say.
    const effectiveRole: OrgRole =
        existing === "admin" ? "admin" : (invite.role as OrgRole);

    if (!existing) {
        const { error } = await db.from("org_members").insert({
            org_id: invite.org_id,
            user_id: params.userId,
            role: effectiveRole,
        });
        if (error && !isUniqueViolation(error))
            return { ok: false, kind: "db_error", detail: error.message };
    } else if (effectiveRole !== existing) {
        const { error } = await db
            .from("org_members")
            .update({ role: effectiveRole, updated_at: new Date().toISOString() })
            .eq("org_id", invite.org_id)
            .eq("user_id", params.userId);
        if (error) return { ok: false, kind: "db_error", detail: error.message };
    }

    const { error: updateError } = await db
        .from("org_invitations")
        .update({ status: "accepted", accepted_at: new Date().toISOString() })
        .eq("id", invite.id);
    if (updateError)
        return { ok: false, kind: "db_error", detail: updateError.message };

    await recordAudit(db, {
        userId: params.userId,
        userEmail: params.userEmail ?? null,
        action: "org.invite.accepted",
        title: invite.email,
        detail: {
            org_id: invite.org_id,
            // The role now in force, not the one that was offered: an audit
            // trail that records the offer cannot answer "what changed?".
            role: effectiveRole,
            invited_role: invite.role,
            invitation_id: invite.id,
        },
    });
    return { ok: true, org_id: invite.org_id, role: effectiveRole };
}

export async function declineInvitation(
    db: Db,
    params: {
        userId: string;
        userEmail?: string | null;
        invitationId: string;
    },
): Promise<OrgResult<Record<never, never>>> {
    const loaded = await loadAnswerableInvitation(db, params);
    if (!loaded.ok) return loaded;
    const invite = loaded.invitation;

    const { error } = await db
        .from("org_invitations")
        .update({ status: "declined", declined_at: new Date().toISOString() })
        .eq("id", invite.id);
    if (error) return { ok: false, kind: "db_error", detail: error.message };

    await recordAudit(db, {
        userId: params.userId,
        userEmail: params.userEmail ?? null,
        action: "org.invite.declined",
        title: invite.email,
        detail: { org_id: invite.org_id, invitation_id: invite.id },
    });
    return { ok: true };
}
