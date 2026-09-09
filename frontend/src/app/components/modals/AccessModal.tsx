"use client";

import { useEffect, useMemo, useState } from "react";
import type {
    AccessAssignmentRole,
    ProjectPeople,
    UserLookupResult,
} from "@/app/lib/mikeApi";
import { getOrg } from "@/app/lib/mikeApi";
import type { ProjectRole } from "@/app/lib/permissions";
import { userFacingApiError } from "@/app/lib/userFacingError";
import { Modal } from "./Modal";
import {
    OrganizationAccessEditor,
    AccessEditor,
    type OrganizationAccessAssignment,
    type AccessRow,
} from "./AccessEditor";

export interface SharedResource {
    id: string;
    owner_display_name?: string | null;
    owner_email?: string | null;
}

export interface AccessControls {
    grants: { email: string; role: AccessAssignmentRole }[];
    orgId?: string | null;
    inheritedFromProjectId?: string | null;
    canManage: boolean;
    ownerLabel?: string;
    /**
     * A failure the owner of this modal wants shown beside the roster rather
     * than in place of it — a refused grants fetch, say, which leaves the
     * people list perfectly loadable but management impossible. It shares the
     * editor's error line with the modal's own action failures; an in-flight
     * action's message wins, because it is the newer answer.
     */
    error?: string | null;
    onGrant: (email: string, role: AccessAssignmentRole) => Promise<void>;
    onRevoke: (email: string) => Promise<void>;
}

interface Props {
    open: boolean;
    onClose: () => void;
    resource: SharedResource | null;
    fetchAccess: (id: string) => Promise<ProjectPeople>;
    currentUserEmail?: string | null;
    currentUserId?: string | null;
    breadcrumb: string[];
    access: AccessControls;
}

export function AccessModal({
    open,
    onClose,
    resource,
    fetchAccess,
    currentUserEmail,
    currentUserId,
    breadcrumb,
    access,
}: Props) {
    const [busy, setBusy] = useState(false);
    const [pendingEmail, setPendingEmail] = useState<string | null>(null);
    const [newRole, setNewRole] = useState<ProjectRole>("editor");
    const [error, setError] = useState<string | null>(null);
    const [accessRoster, setAccessRoster] = useState<ProjectPeople | null>(null);
    const [accessLoading, setAccessLoading] = useState(false);
    const [loadedRosterKey, setLoadedRosterKey] = useState<string | null>(null);
    const [lookupNames, setLookupNames] = useState<Map<string, string | null>>(
        new Map(),
    );
    const [organizationLookup, setOrganizationLookup] = useState<{
        orgId: string;
        name: string | null;
    } | null>(null);

    const scope = access.inheritedFromProjectId
        ? "project"
        : access.orgId
          ? "organization"
          : "direct";
    const canManage = access.canManage;
    const orgId = access.orgId ?? null;
    const resourceId = resource?.id ?? null;
    const grants = useMemo(() => access.grants, [access.grants]);
    const rosterKey = `${resourceId ?? ""}:${grants
        .map((grant) => `${grant.email}:${grant.role}`)
        .map((entry) => entry.toLowerCase())
        .sort()
        .join(",")}`;

    useEffect(() => {
        if (!open) return;
        setBusy(false);
        setPendingEmail(null);
        setNewRole("editor");
        setError(null);
    }, [open]);

    useEffect(() => {
        if (!open || !resourceId) return;
        let cancelled = false;
        setAccessLoading(true);
        setAccessRoster(null);
        setLoadedRosterKey(null);
        fetchAccess(resourceId)
            .then((data) => {
                if (!cancelled) {
                    setAccessRoster(data);
                    setLoadedRosterKey(rosterKey);
                }
            })
            .catch((cause) => {
                if (!cancelled) {
                    setError(
                        userFacingApiError(
                            cause,
                            "Could not load access details.",
                        ),
                    );
                    setLoadedRosterKey(rosterKey);
                }
            })
            .finally(() => {
                if (!cancelled) setAccessLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [fetchAccess, open, resourceId, rosterKey]);

    useEffect(() => {
        if (!open || !orgId) return;
        let cancelled = false;
        getOrg(orgId)
            .then((organization) => {
                if (!cancelled) {
                    setOrganizationLookup({
                        orgId,
                        name: organization.name,
                    });
                }
            })
            .catch(() => {
                if (!cancelled) {
                    setOrganizationLookup({ orgId, name: null });
                }
            });
        return () => {
            cancelled = true;
        };
    }, [open, orgId]);

    if (!open || !resource) return null;

    const ownerEmail =
        accessRoster?.owner?.email?.trim().toLowerCase() ??
        resource.owner_email?.trim().toLowerCase() ??
        null;
    const memberByEmail = new Map(
        (accessRoster?.members ?? []).map((member) => [
            member.email.toLowerCase(),
            member,
        ]),
    );
    const recipients = accessRoster
        ? accessRoster.members.map((member) => ({
              email: member.email,
              role: member.role ?? ("editor" as const),
          }))
        : grants;
    const rows: AccessRow[] = [];
    if (accessRoster?.owner || ownerEmail || resource.owner_display_name) {
        rows.push({
            key: "creator",
            user_id: accessRoster?.owner?.user_id ?? null,
            email: ownerEmail,
            display_name:
                accessRoster?.owner?.display_name ??
                resource.owner_display_name ??
                null,
            role: "owner",
            isCreator: true,
        });
    }
    for (const recipient of recipients) {
        const email = recipient.email.trim().toLowerCase();
        if (ownerEmail && email === ownerEmail) continue;
        const member = memberByEmail.get(email);
        rows.push({
            key: member?.user_id ?? email,
            user_id: member?.user_id ?? null,
            email,
            display_name:
                member?.display_name ?? lookupNames.get(email) ?? null,
            role: recipient.role,
        });
    }

    const recipientEmails = recipients.map((entry) =>
        entry.email.trim().toLowerCase(),
    );
    const currentEmail = currentUserEmail?.trim().toLowerCase() ?? null;

    function validateEmail(email: string) {
        if (recipientEmails.includes(email)) return `${email} already has access.`;
        if (ownerEmail && email === ownerEmail)
            return `${email} created this and is already an owner.`;
        if (currentEmail && email === currentEmail)
            return "You cannot share this with yourself.";
        return null;
    }

    async function add(user: UserLookupResult) {
        const email = user.email.trim().toLowerCase();
        setLookupNames((current) =>
            new Map(current).set(email, user.display_name),
        );
        setBusy(true);
        setError(null);
        try {
            await access.onGrant(email, newRole);
        } catch (cause) {
            // A refused grant used to escape as an unhandled rejection with no
            // message; the sibling changeRole/remove paths already report.
            setError(
                userFacingApiError(cause, "Could not add this user. Try again."),
            );
        } finally {
            setBusy(false);
        }
    }

    async function changeRole(
        row: AccessRow,
        role: AccessAssignmentRole,
    ) {
        if (!row.email) return;
        setBusy(true);
        setPendingEmail(row.email);
        setError(null);
        try {
            await access.onGrant(row.email, role);
        } catch (cause) {
            setError(userFacingApiError(cause, "Could not change that role."));
        } finally {
            setBusy(false);
            setPendingEmail(null);
        }
    }

    async function remove(row: AccessRow) {
        if (!row.email) return;
        setBusy(true);
        setPendingEmail(row.email);
        setError(null);
        try {
            await access.onRevoke(row.email);
        } catch (cause) {
            setError(userFacingApiError(cause, "Could not remove access."));
        } finally {
            setBusy(false);
            setPendingEmail(null);
        }
    }

    if (scope === "organization") {
        const organizationMembers: AccessRow[] = (
            accessRoster?.members ?? []
        ).map((member) => ({
            key: member.user_id ?? member.email,
            user_id: member.user_id ?? null,
            email: member.email,
            display_name: member.display_name,
            role: member.role ?? "editor",
        }));
        const overrideAssignments: OrganizationAccessAssignment[] = grants
            .filter(
                (grant) => grant.role === "owner" || grant.role === "deny",
            )
            .map((grant) => {
                const member = memberByEmail.get(grant.email.toLowerCase());
                return {
                    key: member?.user_id ?? grant.email,
                    user_id: member?.user_id ?? null,
                    email: grant.email,
                    display_name:
                        member?.display_name ??
                        lookupNames.get(grant.email.toLowerCase()) ??
                        null,
                    role: grant.role,
                };
            });
        const creatorAssignment: OrganizationAccessAssignment | null =
            accessRoster?.owner
                ? {
                      key: "creator",
                      user_id: accessRoster.owner.user_id,
                      email: accessRoster.owner.email,
                      display_name: accessRoster.owner.display_name,
                      role: "owner",
                      isCreator: true,
                  }
                : ownerEmail || resource.owner_display_name
                  ? {
                        key: "creator",
                        email: ownerEmail,
                        display_name: resource.owner_display_name ?? null,
                        role: "owner",
                        isCreator: true,
                    }
                  : null;
        const organizationAssignments: OrganizationAccessAssignment[] = [
            ...(creatorAssignment ? [creatorAssignment] : []),
            ...overrideAssignments.filter(
                (assignment) =>
                    assignment.user_id !== creatorAssignment?.user_id &&
                    (!assignment.email ||
                        assignment.email.toLowerCase() !==
                            creatorAssignment?.email?.toLowerCase()),
            ),
        ];

        return (
            <Modal
                open={open}
                onClose={onClose}
                breadcrumbs={[
                    ...breadcrumb.slice(0, -1),
                    "Organisational Access",
                ]}
            >
                <div className="flex min-h-0 flex-1 flex-col pb-5">
                    <OrganizationAccessEditor
                        members={organizationMembers}
                        assignments={organizationAssignments}
                        organizationName={
                            organizationLookup?.orgId === orgId
                                ? organizationLookup.name
                                : null
                        }
                        ownerLabel={access.ownerLabel}
                        currentUserId={currentUserId}
                        currentUserEmail={currentUserEmail}
                        loading={
                            accessLoading || loadedRosterKey !== rosterKey
                        }
                        disabled={!canManage || busy}
                        error={error ?? access.error ?? null}
                        onAssign={(member, role) =>
                            changeRole(member, role)
                        }
                        onRemove={remove}
                    />
                </div>
            </Modal>
        );
    }

    return (
        <Modal
            open={open}
            onClose={onClose}
            breadcrumbs={[...breadcrumb.slice(0, -1), "Access"]}
        >
            <div className="flex min-h-0 flex-1 flex-col pb-5">
                <AccessEditor
                    scope={scope}
                    rows={rows}
                    loading={accessLoading || loadedRosterKey !== rosterKey}
                    canManage={canManage}
                    currentUserEmail={currentUserEmail}
                    currentUserId={currentUserId}
                    busy={busy}
                    pendingEmail={pendingEmail}
                    newRole={newRole}
                    onNewRoleChange={setNewRole}
                    onAdd={scope === "direct" ? add : undefined}
                    validateEmail={validateEmail}
                    onRoleChange={changeRole}
                    onRemove={scope === "direct" ? remove : undefined}
                    error={error ?? access.error ?? null}
                />
            </div>
        </Modal>
    );
}
