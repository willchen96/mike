"use client";

import { useEffect, useState } from "react";
import {
    listOrgMembers,
    type AccessAssignmentRole,
    type OrgMember,
    type UserLookupResult,
} from "@/app/lib/mikeApi";
import type { ProjectRole } from "@/app/lib/permissions";
import {
    OrganizationAccessEditor,
    AccessEditor,
    type OrganizationAccessAssignment,
    type AccessRow,
} from "./AccessEditor";

export interface PendingDirectGrant {
    email: string;
    display_name: string | null;
    role: ProjectRole;
}

export interface PendingOrgOverride {
    user_id: string;
    email: string;
    role: AccessAssignmentRole;
}

export function CreateAccessStep({
    orgId,
    organizationName,
    currentUserEmail,
    currentUserId,
    directGrants,
    onDirectGrantsChange,
    orgOverrides = [],
    onOrgOverridesChange,
    inheritedFromProject = false,
    ownerLabel = "Project owners",
}: {
    orgId: string | null;
    organizationName?: string | null;
    currentUserEmail?: string | null;
    currentUserId?: string | null;
    directGrants: PendingDirectGrant[];
    onDirectGrantsChange: (grants: PendingDirectGrant[]) => void;
    orgOverrides?: PendingOrgOverride[];
    onOrgOverridesChange?: (overrides: PendingOrgOverride[]) => void;
    inheritedFromProject?: boolean;
    ownerLabel?: string;
}) {
    const [memberState, setMemberState] = useState<{
        orgId: string;
        members: OrgMember[];
        error: string | null;
    } | null>(null);
    const [newRole, setNewRole] = useState<ProjectRole>("editor");
    const currentEmail = currentUserEmail?.trim().toLowerCase() ?? null;

    useEffect(() => {
        if (!orgId || inheritedFromProject) return;
        let cancelled = false;
        listOrgMembers(orgId)
            .then((rows) => {
                if (!cancelled) {
                    setMemberState({ orgId, members: rows, error: null });
                }
            })
            .catch(() => {
                if (!cancelled) {
                    setMemberState({
                        orgId,
                        members: [],
                        error: "Could not load organization members.",
                    });
                }
            });
        return () => {
            cancelled = true;
        };
    }, [inheritedFromProject, orgId]);

    const hasLoadedCurrentOrg = !!orgId && memberState?.orgId === orgId;
    const members = hasLoadedCurrentOrg ? memberState.members : [];
    const loading = !!orgId && !inheritedFromProject && !hasLoadedCurrentOrg;
    const loadError = hasLoadedCurrentOrg ? memberState.error : null;

    const rows: AccessRow[] = inheritedFromProject
        ? []
        : [
                ...(currentEmail
                    ? [
                          {
                              key: "creator",
                              email: currentEmail,
                              display_name: null,
                              role: "owner" as const,
                              isCreator: true,
                          },
                      ]
                    : []),
                ...directGrants.map((grant) => ({
                    key: grant.email,
                    email: grant.email,
                    display_name: grant.display_name,
                    role: grant.role,
                })),
            ];

    const organizationMembers: AccessRow[] = members.map((member) => {
        const isCreator =
            (!!currentUserId && member.user_id === currentUserId) ||
            (!!currentEmail &&
                member.email?.trim().toLowerCase() === currentEmail);
        return {
            key: member.user_id,
            user_id: member.user_id,
            email: member.email,
            display_name: member.display_name,
            role: member.role === "admin" ? "owner" : "editor",
            isCreator,
        };
    });
    const overrideAssignments: OrganizationAccessAssignment[] = orgOverrides.map((override) => {
        const member = members.find(
            (entry) => entry.user_id === override.user_id,
        );
        return {
            key: override.user_id,
            user_id: override.user_id,
            email: override.email,
            display_name: member?.display_name ?? null,
            role: override.role,
        };
    });
    const creator = organizationMembers.find((member) => member.isCreator);
    const organizationAssignments: OrganizationAccessAssignment[] = [
        ...(creator
            ? [
                  {
                      ...creator,
                      role: "owner" as const,
                      isCreator: true,
                  },
              ]
            : []),
        ...overrideAssignments.filter(
            (assignment) => assignment.user_id !== creator?.user_id,
        ),
    ];

    function validateDirectEmail(email: string) {
        if (currentEmail && email === currentEmail)
            return "You are already the owner.";
        if (directGrants.some((grant) => grant.email === email))
            return `${email} already has access.`;
        return null;
    }

    function addDirect(user: UserLookupResult) {
        const email = user.email.trim().toLowerCase();
        onDirectGrantsChange([
            ...directGrants,
            { email, display_name: user.display_name, role: newRole },
        ]);
    }

    function changeRole(row: AccessRow, role: AccessAssignmentRole) {
        if (!row.email || role === "deny") return;
        onDirectGrantsChange(
            directGrants.map((grant) =>
                grant.email === row.email ? { ...grant, role } : grant,
            ),
        );
    }

    function assignOrganizationMember(
        member: AccessRow,
        role: "owner" | "deny",
    ) {
        if (!member.user_id || !member.email) return;
        onOrgOverridesChange?.([
            ...orgOverrides.filter(
                (override) => override.user_id !== member.user_id,
            ),
            {
                user_id: member.user_id,
                email: member.email,
                role,
            },
        ]);
    }

    if (orgId && !inheritedFromProject) {
        return (
            <OrganizationAccessEditor
                members={organizationMembers}
                assignments={organizationAssignments}
                organizationName={organizationName}
                ownerLabel={ownerLabel}
                loading={loading}
                error={loadError}
                onAssign={assignOrganizationMember}
                onRemove={(assignment) =>
                    onOrgOverridesChange?.(
                        orgOverrides.filter(
                            (override) =>
                                override.user_id !== assignment.user_id,
                        ),
                    )
                }
            />
        );
    }

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <AccessEditor
                scope={inheritedFromProject ? "project" : "direct"}
                rows={rows}
                loading={loading}
                canManage={!inheritedFromProject}
                currentUserEmail={currentUserEmail}
                currentUserId={currentUserId}
                newRole={newRole}
                onNewRoleChange={setNewRole}
                onAdd={!inheritedFromProject ? addDirect : undefined}
                validateEmail={validateDirectEmail}
                onRoleChange={!inheritedFromProject ? changeRole : undefined}
                onRemove={(row) =>
                    onDirectGrantsChange(
                        directGrants.filter((grant) => grant.email !== row.email),
                    )
                }
                error={loadError}
            />
        </div>
    );
}
