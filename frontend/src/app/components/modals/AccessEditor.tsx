"use client";

import { useState, type ReactNode } from "react";
import { Check, ChevronDown, Info, Loader2 } from "lucide-react";
import type { UserLookupResult } from "@/app/lib/mikeApi";
import type { AccessAssignmentRole } from "@/app/lib/mikeApi";
import {
    PROJECT_ROLE_DESCRIPTIONS,
    PROJECT_ROLE_LABELS,
    PROJECT_ROLES,
    type ProjectRole,
} from "@/app/lib/permissions";
import { AddUserInput } from "../shared/AddUserInput";
import { SearchBar } from "../ui/search-bar";
import {
    DropdownMenu,
    DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import {
    LiquidDropdownContent,
    LiquidDropdownItem,
} from "../ui/liquid-dropdown";
import {
    LIQUID_GLASS_FLOAT_CLASS,
    LIQUID_GLASS_HOVER_CLASS,
    LIQUID_GLASS_MODAL_ROW_HOVER_CLASS,
} from "@/shared/ui/LiquidGlassUI";

export type AccessScope = "direct" | "project";

export interface AccessRow {
    key?: string;
    email: string | null;
    user_id?: string | null;
    display_name: string | null;
    role: AccessAssignmentRole;
    isCreator?: boolean;
}

export type OrganizationAccessAssignment = AccessRow;

const INPUT_GROUP_ROLE_TRIGGER_CLASS =
    "flex h-10 shrink-0 items-center gap-1.5 px-3 text-xs shadow-none transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500/40 data-[state=open]:opacity-80 [&[data-state=open]>svg]:rotate-180 disabled:cursor-not-allowed disabled:opacity-50";

export function accessRoleLabel(role: AccessAssignmentRole): string {
    return role === "deny" ? "Deny" : PROJECT_ROLE_LABELS[role];
}

function accessRoleTone(role: AccessAssignmentRole): string {
    return role === "owner"
        ? "bg-blue-100 text-blue-700"
        : role === "editor"
          ? "bg-violet-100 text-violet-700"
          : role === "deny"
            ? "bg-red-100 text-red-700"
            : "bg-gray-100 text-gray-600";
}

function accessRoleTextTone(role: AccessAssignmentRole): string {
    return role === "owner"
        ? "text-blue-700"
        : role === "editor"
          ? "text-violet-700"
          : role === "deny"
            ? "text-red-700"
            : "text-gray-600";
}

function accessRoleMenuTone(role: AccessAssignmentRole): string {
    return role === "owner"
        ? "text-blue-700 hover:!bg-blue-100 focus:!bg-blue-100 data-[highlighted]:!bg-blue-100 data-[selected=true]:!bg-blue-100"
        : role === "editor"
          ? "text-violet-700 hover:!bg-violet-100 focus:!bg-violet-100 data-[highlighted]:!bg-violet-100 data-[selected=true]:!bg-violet-100"
          : role === "deny"
            ? "text-red-700 hover:!bg-red-100 focus:!bg-red-100 data-[highlighted]:!bg-red-100 data-[selected=true]:!bg-red-100"
            : "text-gray-600 hover:!bg-gray-100 focus:!bg-gray-100 data-[highlighted]:!bg-gray-100 data-[selected=true]:!bg-gray-100";
}

function AccessRolePill({
    role,
    label,
    editable,
    disabled,
    loading,
    onChange,
    options,
}: {
    role: AccessAssignmentRole;
    label: string;
    editable: boolean;
    disabled: boolean;
    loading: boolean;
    onChange: (role: AccessAssignmentRole) => void;
    options: AccessAssignmentRole[];
}) {
    const tone = accessRoleTone(role);
    const className = `inline-flex h-6 items-center justify-self-start justify-center gap-1 rounded-full px-2 text-left text-[11px] font-medium ${tone}`;

    if (!editable) return <span className={className}>{accessRoleLabel(role)}</span>;

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <button
                    type="button"
                    aria-label={`Role for ${label}`}
                    disabled={disabled}
                    className={`${className} transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 disabled:cursor-wait disabled:opacity-50`}
                >
                    <span>{accessRoleLabel(role)}</span>
                    {loading ? (
                        <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
                    ) : (
                        <ChevronDown className="h-3 w-3 shrink-0 text-gray-400" />
                    )}
                </button>
            </DropdownMenuTrigger>
            <LiquidDropdownContent
                align="end"
                className="z-[250] w-32 space-y-1"
            >
                {options.map((option) => (
                    <LiquidDropdownItem
                        key={option}
                        selected={role === option}
                        onSelect={() => onChange(option)}
                        className={`flex items-center justify-between ${accessRoleMenuTone(option)}`}
                    >
                        <span>{accessRoleLabel(option)}</span>
                        {role === option ? (
                            <Check className="h-3.5 w-3.5 text-gray-300" />
                        ) : null}
                    </LiquidDropdownItem>
                ))}
            </LiquidDropdownContent>
        </DropdownMenu>
    );
}

function RemoveActionDropdown({
    label,
    disabled = false,
    onRemove,
}: {
    label: string;
    disabled?: boolean;
    onRemove: () => void;
}) {
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <button
                    type="button"
                    aria-label={`Actions for ${label}`}
                    disabled={disabled}
                    className="flex h-6 w-6 items-center justify-center rounded-full text-xs text-gray-500 hover:bg-gray-200/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 disabled:opacity-50"
                >
                    ···
                </button>
            </DropdownMenuTrigger>
            <LiquidDropdownContent
                align="end"
                className="z-[250] min-w-28"
            >
                <LiquidDropdownItem
                    onSelect={onRemove}
                    className="text-red-500 hover:!bg-red-500/10 focus:!bg-red-500/10 data-[highlighted]:!bg-red-500/10"
                >
                    Remove
                </LiquidDropdownItem>
            </LiquidDropdownContent>
        </DropdownMenu>
    );
}

function InfoLabelTooltip({
    label,
    tooltipId,
    infoLabel,
    children,
}: {
    label: ReactNode;
    tooltipId: string;
    infoLabel: string;
    children: ReactNode;
}) {
    return (
        <div className="relative flex w-fit items-center gap-1.5">
            {label}
            <button
                type="button"
                aria-label={infoLabel}
                aria-describedby={tooltipId}
                className="peer flex h-5 w-5 items-center justify-center rounded-full text-gray-400 transition-colors hover:text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
            >
                <Info className="h-3.5 w-3.5" />
            </button>
            <div
                id={tooltipId}
                role="tooltip"
                className={`pointer-events-none invisible absolute left-0 top-full z-[260] mt-1.5 w-[min(18rem,calc(100vw-3rem))] rounded-xl p-3 text-xs leading-4 text-gray-600 opacity-0 transition-opacity peer-hover:visible peer-hover:opacity-100 peer-focus-visible:visible peer-focus-visible:opacity-100 ${LIQUID_GLASS_FLOAT_CLASS}`}
            >
                {children}
            </div>
        </div>
    );
}

function OrganizationMemberPicker({
    id,
    label,
    placeholder,
    description,
    showLabel = true,
    members,
    disabled,
    onSelect,
}: {
    id: string;
    label: string;
    placeholder: string;
    description?: string;
    showLabel?: boolean;
    members: AccessRow[];
    disabled: boolean;
    onSelect: (member: AccessRow) => void;
}) {
    const [query, setQuery] = useState("");
    const [focused, setFocused] = useState(false);
    const normalizedQuery = query.trim().toLowerCase();
    const matches = normalizedQuery
        ? members
              .filter((member) =>
                  [member.display_name, member.email]
                      .filter(Boolean)
                      .some((value) =>
                          value!.toLowerCase().includes(normalizedQuery),
                      ),
              )
              .slice(0, 8)
        : [];
    const showResults = focused && normalizedQuery.length > 0;

    return (
        <div className="relative">
            {showLabel ? (
                <InfoLabelTooltip
                    label={
                        <label
                            htmlFor={id}
                            className="block text-sm font-medium text-gray-700"
                        >
                            {label}
                        </label>
                    }
                    tooltipId={`${id}-description`}
                    infoLabel={`About ${label}`}
                >
                    {description}
                </InfoLabelTooltip>
            ) : null}
            <SearchBar
                id={id}
                value={query}
                onValueChange={setQuery}
                placeholder={placeholder}
                label={label}
                disabled={disabled}
                autoComplete="off"
                wrapperClassName={showLabel ? "mt-2" : undefined}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                onKeyDown={(event) => {
                    if (event.key === "Escape") {
                        setQuery("");
                        setFocused(false);
                    }
                }}
            />
            {showResults ? (
                <div
                    role="listbox"
                    aria-label={`${label} matches`}
                    className={`absolute left-0 right-0 top-full z-[260] mt-1 max-h-48 overflow-y-auto rounded-xl p-1 ${LIQUID_GLASS_FLOAT_CLASS}`}
                >
                    {matches.length > 0 ? (
                        matches.map((member) => {
                            const key =
                                member.key ??
                                member.user_id ??
                                member.email ??
                                "unknown";
                            return (
                                <button
                                    key={key}
                                    type="button"
                                    role="option"
                                    aria-selected="false"
                                    onMouseDown={(event) =>
                                        event.preventDefault()
                                    }
                                    onClick={() => {
                                        onSelect(member);
                                        setQuery("");
                                        setFocused(false);
                                    }}
                                    className={`flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 ${LIQUID_GLASS_HOVER_CLASS}`}
                                >
                                    <span className="min-w-0 truncate text-xs text-gray-800">
                                        {member.display_name?.trim() ||
                                            member.email}
                                    </span>
                                    {member.display_name ? (
                                        <span className="min-w-0 truncate text-xs text-gray-400">
                                            {member.email}
                                        </span>
                                    ) : null}
                                </button>
                            );
                        })
                    ) : (
                        <p className="px-3 py-2 text-xs text-gray-400">
                            No matching organization members.
                        </p>
                    )}
                </div>
            ) : null}
        </div>
    );
}

function OrganizationAssignmentList({
    label,
    assignments,
    emptyMessage,
    loading,
    disabled,
    onRemove,
}: {
    label: string;
    assignments: OrganizationAccessAssignment[];
    emptyMessage: string;
    loading: boolean;
    disabled: boolean;
    onRemove: (
        assignment: OrganizationAccessAssignment,
    ) => Promise<unknown> | unknown;
}) {
    return (
        <div className="h-28 overflow-y-auto rounded-xl bg-white/20 p-1">
            {loading ? (
                <div className="flex h-full items-center justify-center gap-2 text-xs text-gray-400">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Loading organization members…
                </div>
            ) : assignments.length === 0 ? (
                <div className="flex h-full items-center justify-center text-xs text-gray-400">
                    {emptyMessage}
                </div>
            ) : (
                <ul
                    aria-label={label}
                    className="space-y-1"
                >
                    {assignments.map((assignment) => {
                        const key =
                            assignment.key ??
                            assignment.user_id ??
                            assignment.email;
                        return (
                            <li
                                key={key}
                                className={`${LIQUID_GLASS_MODAL_ROW_HOVER_CLASS} grid grid-cols-[minmax(0,1fr)_minmax(10rem,16rem)_1.5rem] items-center gap-3 rounded-lg px-2 py-2 transition-colors`}
                            >
                                <span className="truncate text-xs text-gray-800">
                                    {assignment.display_name?.trim() || "—"}
                                </span>
                                <span className="max-w-full justify-self-end truncate text-xs text-gray-500">
                                    {assignment.email || "—"}
                                </span>
                                {!disabled && !assignment.isCreator ? (
                                    <RemoveActionDropdown
                                        label={
                                            assignment.email ??
                                            assignment.display_name ??
                                            "member"
                                        }
                                        onRemove={() =>
                                            void onRemove(assignment)
                                        }
                                    />
                                ) : (
                                    <span className="h-6 w-6" />
                                )}
                            </li>
                        );
                    })}
                </ul>
            )}
        </div>
    );
}

export function OrganizationAccessEditor({
    members,
    assignments,
    organizationName,
    ownerLabel = "Project owners",
    loading = false,
    disabled = false,
    error,
    currentUserId,
    currentUserEmail,
    onAssign,
    onRemove,
}: {
    members: AccessRow[];
    assignments: OrganizationAccessAssignment[];
    organizationName?: string | null;
    ownerLabel?: string;
    loading?: boolean;
    disabled?: boolean;
    error?: string | null;
    /**
     * Who is looking. Both identifiers, because a roster row can arrive with
     * one and not the other — and the server refuses either override aimed at
     * the caller ("You cannot share a project with yourself"), so offering
     * their own name in these pickers only ever produced that error.
     */
    currentUserId?: string | null;
    currentUserEmail?: string | null;
    onAssign: (
        member: AccessRow,
        role: "owner" | "deny",
    ) => Promise<unknown> | unknown;
    onRemove: (
        assignment: OrganizationAccessAssignment,
    ) => Promise<unknown> | unknown;
}) {
    const assignedKeys = new Set(
        assignments.map(
            (assignment) =>
                assignment.user_id ??
                assignment.email?.toLowerCase() ??
                assignment.key ??
                "",
        ),
    );
    const selfEmail = currentUserEmail?.trim().toLowerCase() ?? null;
    const isSelf = (member: AccessRow) =>
        (!!currentUserId && member.user_id === currentUserId) ||
        (!!selfEmail && member.email?.trim().toLowerCase() === selfEmail);
    const availableMembers = members.filter((member) => {
        if (member.isCreator || !member.email) return false;
        // Neither override can be aimed at the caller: the server answers
        // "You cannot share a project with yourself", so their own row in
        // these pickers was an action that could only fail.
        if (isSelf(member)) return false;
        return !assignedKeys.has(
            member.user_id ?? member.email.toLowerCase(),
        );
    });
    const availableOwnerMembers = availableMembers.filter(
        (member) => member.role !== "owner",
    );
    const availableDenyMembers = availableMembers.filter(
        // Organization Admins resolve to Owner and are an immutable part of
        // the organization's security boundary.
        (member) => member.role !== "owner",
    );
    const ownerAssignments = assignments.filter(
        (assignment) => assignment.role === "owner",
    );
    const deniedAssignments = assignments.filter(
        (assignment) => assignment.role === "deny",
    );
    const denyCount = deniedAssignments.length;
    // An existing deny list is a security decision somebody needs to see, so
    // the section opens itself when there is anything in it. The assignments
    // arrive with the roster, after mount, so the mount-time initialiser is
    // not enough on its own — re-derive it when the load finishes.
    //
    // Once only, though. Every grant and revoke re-reads the roster, and each
    // of those re-runs this: a deny list the user had deliberately collapsed
    // sprang open again after their next change, and again after the one
    // after that. Opening it the first time is the point being made; after
    // that the section is theirs.
    const [denyState, setDenyState] = useState({
        loading,
        expanded: denyCount > 0,
        autoExpanded: denyCount > 0,
    });
    if (denyState.loading !== loading) {
        const settled = !loading;
        const shouldAutoExpand =
            settled && !denyState.autoExpanded && denyCount > 0;
        setDenyState({
            loading,
            expanded: shouldAutoExpand ? true : denyState.expanded,
            autoExpanded: denyState.autoExpanded || (settled && denyCount > 0),
        });
    }
    const denyExpanded = denyState.expanded;
    const toggleDenyExpanded = () =>
        setDenyState((current) => ({
            ...current,
            expanded: !current.expanded,
        }));
    const resourceNoun = ownerLabel.toLowerCase().startsWith("workflow")
        ? "workflow"
        : "project";
    const organizationMembersLabel = organizationName || "organisation";
    const ownerDescription = `Add ${organizationMembersLabel} members as owners with rights to manage access, settings and delete the ${resourceNoun}.`;
    const denyDescription = `Deny ${organizationMembersLabel} members from accessing this ${resourceNoun}.`;

    return (
        <div
            data-slot="organization-access-editor"
            className="flex min-h-0 flex-1 flex-col pb-1"
        >
            <section className="space-y-2">
                <OrganizationMemberPicker
                    id="organization-owner-picker"
                    label={ownerLabel}
                    placeholder="Search members…"
                    description={ownerDescription}
                    members={availableOwnerMembers}
                    disabled={disabled || loading}
                    onSelect={(member) => onAssign(member, "owner")}
                />
                <OrganizationAssignmentList
                    label={`${ownerLabel} list`}
                    assignments={ownerAssignments}
                    emptyMessage="No additional Owners added."
                    loading={loading}
                    disabled={disabled}
                    onRemove={onRemove}
                />
            </section>

            {error ? (
                <p role="alert" className="mt-3 text-xs text-red-500">
                    {error}
                </p>
            ) : null}

            <section className="mt-auto pt-4">
                <InfoLabelTooltip
                    label={
                        <button
                            type="button"
                            aria-expanded={denyExpanded}
                            aria-controls="organization-deny-list-content"
                            onClick={toggleDenyExpanded}
                            className="flex items-center gap-1.5 rounded-lg text-left text-sm font-medium text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                        >
                            <span>
                                {denyCount > 0
                                    ? `Deny list (${denyCount})`
                                    : "Deny list"}
                            </span>
                            <ChevronDown
                                aria-hidden="true"
                                className={`h-3.5 w-3.5 text-gray-400 transition-transform ${denyExpanded ? "rotate-180" : ""}`}
                            />
                        </button>
                    }
                    tooltipId="organization-deny-description"
                    infoLabel="About the Deny list"
                >
                    {denyDescription}
                </InfoLabelTooltip>
                {denyExpanded ? (
                    <div
                        id="organization-deny-list-content"
                        className="mt-2 space-y-2"
                    >
                        <OrganizationMemberPicker
                            id="organization-deny-picker"
                            label="Deny list"
                            showLabel={false}
                            placeholder="Search members…"
                            members={availableDenyMembers}
                            disabled={disabled || loading}
                            onSelect={(member) => onAssign(member, "deny")}
                        />
                        <OrganizationAssignmentList
                            label="Deny list entries"
                            assignments={deniedAssignments}
                            emptyMessage="No members denied."
                            loading={loading}
                            disabled={disabled}
                            onRemove={onRemove}
                        />
                    </div>
                ) : null}
            </section>
        </div>
    );
}

export function AccessEditor({
    scope,
    rows,
    loading = false,
    canManage,
    currentUserEmail,
    currentUserId,
    busy = false,
    pendingEmail = null,
    newRole,
    onNewRoleChange,
    onAdd,
    validateEmail,
    onRoleChange,
    onRemove,
    error,
}: {
    scope: AccessScope;
    rows: AccessRow[];
    loading?: boolean;
    canManage: boolean;
    currentUserEmail?: string | null;
    currentUserId?: string | null;
    busy?: boolean;
    pendingEmail?: string | null;
    newRole: ProjectRole;
    onNewRoleChange: (role: ProjectRole) => void;
    onAdd?: (
        user: UserLookupResult,
    ) => Promise<boolean | void> | boolean | void;
    validateEmail?: (email: string) => string | null;
    onRoleChange?: (
        row: AccessRow,
        role: AccessAssignmentRole,
    ) => Promise<unknown> | unknown;
    onRemove?: (row: AccessRow) => Promise<unknown> | unknown;
    error?: string | null;
}) {
    const roleOptions = PROJECT_ROLES;
    const normalizedCurrentEmail = currentUserEmail?.trim().toLowerCase();
    const normalizedCurrentUserId = currentUserId?.trim() || null;

    return (
        <div className="flex min-h-0 flex-1 flex-col gap-4">
            {scope === "direct" && canManage && onAdd ? (
                <section className="space-y-2">
                    <InfoLabelTooltip
                        label={
                            <h2 className="text-sm font-medium text-gray-700">
                                Share Access
                            </h2>
                        }
                        tooltipId="access-role-rights"
                        infoLabel="About access roles"
                    >
                        <div>
                            <p className="mb-2 text-xs font-medium text-gray-700">
                                Roles and rights
                            </p>
                            <dl className="space-y-2">
                                {PROJECT_ROLES.map((role) => (
                                    <div
                                        key={role}
                                        className="grid grid-cols-[3.5rem_minmax(0,1fr)] gap-2 text-xs"
                                    >
                                        <dt
                                            className={`font-medium ${accessRoleTextTone(role)}`}
                                        >
                                            {accessRoleLabel(role)}
                                        </dt>
                                        <dd className="leading-4 text-gray-500">
                                            {PROJECT_ROLE_DESCRIPTIONS[role]}
                                        </dd>
                                    </div>
                                ))}
                            </dl>
                        </div>
                    </InfoLabelTooltip>
                    <AddUserInput
                        onAdd={onAdd}
                        validateEmail={validateEmail}
                        busy={busy}
                        placeholder="Add by email..."
                        autoFocus
                        submitLabel="Add"
                        submitVariant="attached"
                        inputEndControl={
                            <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                    <button
                                        type="button"
                                        aria-label={`Role for the new recipient: ${accessRoleLabel(newRole)}`}
                                        disabled={busy}
                                        className={`${INPUT_GROUP_ROLE_TRIGGER_CLASS} bg-transparent ${accessRoleTextTone(newRole)}`}
                                    >
                                        <span>{accessRoleLabel(newRole)}</span>
                                        <ChevronDown className="h-3 w-3 shrink-0 text-gray-300" />
                                    </button>
                                </DropdownMenuTrigger>
                                <LiquidDropdownContent
                                    align="end"
                                    className="z-[250] w-32 space-y-1"
                                >
                                    {PROJECT_ROLES.map((role) => (
                                        <LiquidDropdownItem
                                            key={role}
                                            selected={newRole === role}
                                            onSelect={() => onNewRoleChange(role)}
                                            className={`flex items-center justify-between ${accessRoleMenuTone(role)}`}
                                        >
                                            <span>{accessRoleLabel(role)}</span>
                                            {newRole === role ? (
                                                <Check className="h-3.5 w-3.5 text-gray-300" />
                                            ) : null}
                                        </LiquidDropdownItem>
                                    ))}
                                </LiquidDropdownContent>
                            </DropdownMenu>
                        }
                        className="bg-white focus-within:bg-white"
                    />
                </section>
            ) : null}

            {/* One alert for every scope: the add form is only rendered to a
                manager in the direct scope, so an error nested inside it was
                invisible when a re-role or a revoke failed anywhere else. */}
            {error ? (
                <p role="alert" className="text-xs text-red-500">
                    {error}
                </p>
            ) : null}

            <section className="flex min-h-0 flex-1 flex-col">
                <div className="mb-1 grid grid-cols-[minmax(0,1fr)_minmax(8rem,12rem)_5rem_1.5rem] gap-3 px-2 text-xs font-medium text-gray-500">
                    <div className="flex items-center gap-2">
                        <span>Name</span>
                        {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                    </div>
                    <span className="justify-self-start text-left">Email</span>
                    <span className="justify-self-start text-left">Role</span>
                    <span aria-hidden="true" />
                </div>

                {scope === "project" ? (
                    <p className="mb-2 text-xs text-gray-500">
                        Access is inherited from the project and must be changed
                        from the project&apos;s Access panel.
                    </p>
                ) : null}

                {loading ? (
                    <div className="min-h-0 flex-1 space-y-1">
                        {[1, 2].map((item) => (
                            <div
                                key={item}
                                className="grid grid-cols-[minmax(0,1fr)_minmax(8rem,12rem)_5rem_1.5rem] items-center gap-3 rounded-lg px-2 py-2"
                            >
                                <div className="h-3 w-20 animate-pulse rounded bg-gray-100" />
                                <div className="h-3 w-28 animate-pulse rounded bg-gray-100" />
                                <div className="h-4 w-12 animate-pulse rounded-full bg-gray-100" />
                                <div className="h-6 w-6" />
                            </div>
                        ))}
                    </div>
                ) : rows.length === 0 ? (
                    // In the inherited scope the note above already explains
                    // where access comes from; "No one has access yet"
                    // underneath it reads as a contradiction.
                    scope === "project" ? null : (
                        <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-gray-400">
                            No one has access yet.
                        </div>
                    )
                ) : (
                    <div
                        role="list"
                        className="min-h-0 flex-1 space-y-1 overflow-y-auto"
                    >
                        {rows.map((entry) => {
                            const rowKey =
                                entry.key ?? entry.user_id ?? entry.email ?? "unknown";
                            const email = entry.email ?? "";
                            // Either identifier is enough; when neither is
                            // known the row stays interactive rather than
                            // guessing which grant belongs to the viewer.
                            const isYou =
                                (!!normalizedCurrentUserId &&
                                    entry.user_id === normalizedCurrentUserId) ||
                                (!!normalizedCurrentEmail &&
                                    email.toLowerCase() ===
                                        normalizedCurrentEmail);
                            const name = isYou
                                ? "You"
                                : entry.display_name?.trim() || "—";
                            const isPending = pendingEmail === email;
                            return (
                                <div
                                    key={rowKey}
                                    role="listitem"
                                    className={`${LIQUID_GLASS_MODAL_ROW_HOVER_CLASS} relative grid grid-cols-[minmax(0,1fr)_minmax(8rem,12rem)_5rem_1.5rem] items-start gap-3 rounded-lg px-2 py-2 transition-colors`}
                                >
                                    <p className="truncate pt-1 text-xs text-gray-800">{name}</p>
                                    <p className="justify-self-start truncate pt-1 text-left text-xs text-gray-500">{entry.email || "—"}</p>
                                    <AccessRolePill
                                        role={entry.role}
                                        label={email || name}
                                        editable={
                                            !entry.isCreator &&
                                            // Re-roling yourself is refused by
                                            // the server ("You cannot share a
                                            // project with yourself"), so the
                                            // picker only ever produced an
                                            // error.
                                            !isYou &&
                                            canManage &&
                                            scope !== "project" &&
                                            !!onRoleChange
                                        }
                                        disabled={busy}
                                        loading={busy && isPending}
                                        onChange={(role) => onRoleChange?.(entry, role)}
                                        options={roleOptions}
                                    />
                                    <div className="relative h-6 w-6">
                                        {/* No Remove on your own grant: one
                                            unconfirmed click would lock the
                                            viewer out of the resource. */}
                                        {!entry.isCreator &&
                                        !isYou &&
                                        canManage &&
                                        scope === "direct" &&
                                        onRemove ? (
                                            <RemoveActionDropdown
                                                label={email}
                                                disabled={busy}
                                                onRemove={() =>
                                                    void onRemove(entry)
                                                }
                                            />
                                        ) : null}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </section>
        </div>
    );
}
