import type { createServerSupabase } from "./supabase";
import type { ProjectRole } from "./permissions";

type Db = ReturnType<typeof createServerSupabase>;

export type OrgResourceKind =
    | "project"
    | "workflow";

export type OrgAccessOverrideRole = ProjectRole | "deny";
export type OrgAssignableRole = ProjectRole | "deny";

const CONFIG = {
    project: {
        table: "project_org_access_overrides",
        resourceColumn: "project_id",
    },
    workflow: {
        table: "workflow_org_access_overrides",
        resourceColumn: "workflow_id",
    },
} as const;

export function isOrgAssignableRole(value: unknown): value is OrgAssignableRole {
    return (
        value === "owner" ||
        value === "editor" ||
        value === "viewer" ||
        value === "deny"
    );
}

export function isOrgAccessOverrideRole(
    value: unknown,
): value is OrgAccessOverrideRole {
    return (
        value === "owner" ||
        value === "editor" ||
        value === "viewer" ||
        value === "deny"
    );
}

export type OrgAccessOverride = {
    id: string;
    user_id: string;
    role: OrgAccessOverrideRole;
    assigned_by: string | null;
    created_at: string;
    updated_at: string;
};

export type OrgAccessPerson = {
    user_id: string;
    email: string;
    display_name: string | null;
    role: OrgAssignableRole;
    has_override: boolean;
};

export async function findOrgMemberByEmail(
    db: Db,
    orgId: string,
    emailValue: string,
): Promise<
    | {
          ok: true;
          member: { userId: string; email: string; orgRole: "admin" | "member" };
      }
    | { ok: false; kind: "not_found" | "db_error"; detail: string }
> {
    const email = emailValue.trim().toLowerCase();
    const { data: profile, error: profileError } = await db
        .from("user_profiles")
        .select("user_id, email")
        .eq("email", email)
        .maybeSingle();
    if (profileError)
        return { ok: false, kind: "db_error", detail: profileError.message };
    const userId = (profile as { user_id?: string } | null)?.user_id;
    if (!userId)
        return {
            ok: false,
            kind: "not_found",
            detail: "Only current organization members can be assigned a role",
        };
    const { data: membership, error: membershipError } = await db
        .from("org_members")
        .select("user_id, role")
        .eq("org_id", orgId)
        .eq("user_id", userId)
        .maybeSingle();
    if (membershipError)
        return {
            ok: false,
            kind: "db_error",
            detail: membershipError.message,
        };
    if (!membership)
        return {
            ok: false,
            kind: "not_found",
            detail: "Only current organization members can be assigned a role",
        };
    const orgRole = (membership as { role?: unknown }).role;
    if (orgRole !== "admin" && orgRole !== "member")
        return {
            ok: false,
            kind: "db_error",
            detail: "Organization membership has an invalid role",
        };
    return { ok: true, member: { userId, email, orgRole } };
}

export async function listOrgAccessPeople(
    db: Db,
    params: {
        kind: OrgResourceKind;
        resourceId: string;
        orgId: string;
        creatorId: string | null;
    },
): Promise<
    | { ok: true; people: OrgAccessPerson[] }
    | { ok: false; detail: string }
> {
    const [{ data: memberships, error: membersError }, listed] =
        await Promise.all([
            db
                .from("org_members")
                .select("user_id, role")
                .eq("org_id", params.orgId),
            listOrgAccessOverrides(db, params.kind, params.resourceId),
        ]);
    if (membersError)
        return { ok: false, detail: membersError.message };
    if (!listed.ok) return listed;

    const memberRows = (memberships ?? []) as {
        user_id: string;
        role: "admin" | "member";
    }[];
    const userIds = memberRows.map(
        (membership) => membership.user_id,
    );
    const { data: profiles, error: profilesError } = userIds.length
        ? await db
              .from("user_profiles")
              .select("user_id, email, display_name")
              .in("user_id", userIds)
        : { data: [], error: null };
    if (profilesError)
        return { ok: false, detail: profilesError.message };

    const overrideByUserId = new Map(
        listed.overrides.map((override) => [override.user_id, override.role]),
    );
    const profileByUserId = new Map(
        ((profiles ?? []) as {
            user_id: string;
            email: string | null;
            display_name: string | null;
        }[]).map((profile) => [profile.user_id, profile]),
    );
    const people: OrgAccessPerson[] = [];
    for (const membership of memberRows) {
        const userId = membership.user_id;
        const profile = profileByUserId.get(userId);
        if (!profile?.email) continue;
        people.push({
            user_id: userId,
            email: profile.email,
            display_name: profile.display_name ?? null,
            role:
                userId === params.creatorId || membership.role === "admin"
                    ? "owner"
                    : overrideByUserId.get(userId) ??
                      "editor",
            has_override:
                membership.role !== "admin" && overrideByUserId.has(userId),
        });
    }
    return { ok: true, people };
}

export async function getOrgAccessOverrideRole(
    db: Db,
    kind: OrgResourceKind,
    resourceId: string,
    orgId: string,
    userId: string,
): Promise<
    | { ok: true; role: OrgAccessOverrideRole | null }
    | { ok: false; detail: string }
> {
    const config = CONFIG[kind];
    const { data, error } = await db
        .from(config.table)
        .select("role")
        .eq(config.resourceColumn, resourceId)
        .eq("org_id", orgId)
        .eq("user_id", userId)
        .maybeSingle();
    if (error)
        return {
            ok: false,
            detail: error.message ?? "Failed to resolve organization access override",
        };
    const role = (data as { role?: unknown } | null)?.role;
    return {
        ok: true,
        role: isOrgAccessOverrideRole(role) ? role : null,
    };
}

export async function listOrgAccessOverrides(
    db: Db,
    kind: OrgResourceKind,
    resourceId: string,
): Promise<
    | { ok: true; overrides: OrgAccessOverride[] }
    | { ok: false; detail: string }
> {
    const config = CONFIG[kind];
    const { data, error } = await db
        .from(config.table)
        .select("id, user_id, role, assigned_by, created_at, updated_at")
        .eq(config.resourceColumn, resourceId)
        .order("created_at", { ascending: true });
    if (error) {
        return {
            ok: false,
            detail: error.message ?? "Failed to load organization access overrides",
        };
    }
    return { ok: true, overrides: (data ?? []) as OrgAccessOverride[] };
}

/** Persist an explicit exception to the member's organization-role default. */
export async function setOrgAccessOverride(
    db: Db,
    params: {
        kind: OrgResourceKind;
        resourceId: string;
        orgId: string;
        userId: string;
        role: OrgAssignableRole;
        assignedBy: string;
    },
): Promise<
    | { ok: true; override: OrgAccessOverride | null }
    | { ok: false; detail: string }
> {
    const config = CONFIG[params.kind];
    const { data, error } = await db
        .from(config.table)
        .upsert(
            {
                [config.resourceColumn]: params.resourceId,
                org_id: params.orgId,
                user_id: params.userId,
                role: params.role,
                assigned_by: params.assignedBy,
                updated_at: new Date().toISOString(),
            },
            { onConflict: `${config.resourceColumn},user_id` },
        )
        .select("id, user_id, role, assigned_by, created_at, updated_at")
        .single();
    if (error || !data) {
        return {
            ok: false,
            detail: error?.message ?? "Failed to save organization access override",
        };
    }
    return { ok: true, override: data as OrgAccessOverride };
}

/**
 * Persist a WHOLE BATCH of overrides in one statement.
 *
 * A loop of single upserts is not atomic: the org-membership triggers on
 * these tables can refuse the fourth row after the first three have already
 * committed, and the caller then answers 500 with access silently changed for
 * three people. One upsert is one statement, so a trigger refusal on any
 * target rolls the whole batch back and nothing is written.
 */
export async function setOrgAccessOverrides(
    db: Db,
    params: {
        kind: OrgResourceKind;
        resourceId: string;
        orgId: string;
        userIds: string[];
        role: OrgAssignableRole;
        assignedBy: string;
    },
): Promise<{ ok: true } | { ok: false; detail: string }> {
    if (params.userIds.length === 0) return { ok: true };
    const config = CONFIG[params.kind];
    const updatedAt = new Date().toISOString();
    const { error } = await db.from(config.table).upsert(
        params.userIds.map((userId) => ({
            [config.resourceColumn]: params.resourceId,
            org_id: params.orgId,
            user_id: userId,
            role: params.role,
            assigned_by: params.assignedBy,
            updated_at: updatedAt,
        })),
        { onConflict: `${config.resourceColumn},user_id` },
    );
    if (error)
        return {
            ok: false,
            detail:
                error.message ??
                "Failed to save organization access overrides",
        };
    return { ok: true };
}

export async function deleteOrgAccessOverride(
    db: Db,
    params: {
        kind: OrgResourceKind;
        resourceId: string;
        userId: string;
    },
): Promise<{ ok: true; removed: boolean } | { ok: false; detail: string }> {
    const config = CONFIG[params.kind];
    const { data, error } = await db
        .from(config.table)
        .delete()
        .eq(config.resourceColumn, params.resourceId)
        .eq("user_id", params.userId)
        .select("id");
    if (error) return { ok: false, detail: error.message };
    return { ok: true, removed: ((data ?? []) as unknown[]).length > 0 };
}
