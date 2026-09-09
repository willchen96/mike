"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { Check, ChevronDown, Loader2, Pencil, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/app/contexts/AuthContext";
import { PageHeader } from "@/app/components/shared/PageHeader";
import { HeaderActionsMenu } from "@/app/components/shared/HeaderActionsMenu";
import { TableToolbar } from "@/app/components/shared/TableToolbar";
import {
  SkeletonCheckbox,
  SkeletonLine,
  TABLE_CHECKBOX_CLASS,
  TableBody,
  TableCell,
  TableEmptyState,
  TableFilters,
  TableHeaderCell,
  TableHeaderRow,
  TablePrimaryCell,
  TableRow,
  TableScrollArea,
  TableStickyCell,
  type TableFilterOption,
  type TableSortDirection,
} from "@/app/components/shared/TablePrimitive";
import {
  OrganizationSkeuoIcon,
  WorkflowSkeuoIcon,
} from "@/app/components/shared/AppSidebarSkeuoIcons";
import { ClosedProjectSvgIcon } from "@/app/components/shared/FolderSvgIcon";
import { ConfirmPopup } from "@/app/components/popups/ConfirmPopup";
import { WarningPopup } from "@/app/components/popups/WarningPopup";
import { EmptyState } from "@/app/components/ui/empty-state";
import { TabPillButton } from "@/app/components/ui/tab-pill-button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
} from "@/app/components/ui/dropdown-menu";
import {
  LiquidDropdownContent,
  LiquidDropdownItem,
} from "@/app/components/ui/liquid-dropdown";
import { LIQUID_GLASS_HOVER_CLASS } from "@/app/components/ui/liquid-surface";
import {
  getOrg,
  listOrgInvitations,
  listOrgMembers,
  listOrgResources,
  removeOrgMember,
  updateOrgMember,
  type Org,
  type OrgInvitation,
  type OrgMember,
  type OrgResources,
} from "@/app/lib/mikeApi";
import { ORG_ROLE_LABELS, type OrgRole } from "@/app/lib/permissions";
import { userFacingApiError } from "@/app/lib/userFacingError";
import {
  InviteOrganizationMemberModal,
  OrganizationSettingsModal,
} from "./OrganizationModals";

type OrganizationTab = "people" | "projects" | "workflows";

const TABS: { id: OrganizationTab; label: string }[] = [
  { id: "people", label: "People" },
  { id: "projects", label: "Projects" },
  { id: "workflows", label: "Workflows" },
];

const EMPTY_RESOURCES: OrgResources = { projects: [], workflows: [] };

const SORT_OPTIONS: TableFilterOption<TableSortDirection>[] = [
  { value: "asc", label: "Ascending" },
  { value: "desc", label: "Descending" },
];

const ROLE_FILTER_OPTIONS: TableFilterOption<OrgRole>[] = [
  { value: "admin", label: ORG_ROLE_LABELS.admin, className: "text-blue-700" },
  {
    value: "member",
    label: ORG_ROLE_LABELS.member,
    className: "text-violet-700",
  },
];

function formatDate(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function resourceName(value: string | null | undefined, fallback: string) {
  return value?.trim() || fallback;
}

export function OrganizationWorkspace({ orgId }: { orgId: string }) {
  const router = useRouter();
  const { user } = useAuth();
  const [org, setOrg] = useState<Org | null>(null);
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [invitations, setInvitations] = useState<OrgInvitation[]>([]);
  const [resources, setResources] = useState<OrgResources>(EMPTY_RESOURCES);
  const [activeTab, setActiveTab] = useState<OrganizationTab>("people");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [busyMemberId, setBusyMemberId] = useState<string | null>(null);
  const [selectedMemberIds, setSelectedMemberIds] = useState<string[]>([]);
  const [removeSelectedOpen, setRemoveSelectedOpen] = useState(false);
  const [removingSelected, setRemovingSelected] = useState(false);
  const [removeMember, setRemoveMember] = useState<OrgMember | null>(null);
  const [pendingSelfRoleChange, setPendingSelfRoleChange] = useState<{
    member: OrgMember;
    role: OrgRole;
  } | null>(null);

  /**
   * Which read of each list is the current one.
   *
   * Two independent readers write these lists — the full `load` and the
   * `refreshPeople` that runs whenever the Add-member modal opens or closes —
   * and nothing ordered them. Opening the modal on a still-loading page fires
   * both, and whichever response arrives LAST wins regardless of which was
   * asked first: a three-person roster was seen collapsing to one, because
   * the older answer landed second. Every read takes a ticket and applies its
   * result only while that ticket is still the newest, so a slow answer to an
   * old question is discarded instead of overwriting a newer one.
   */
  const membersRequestRef = useRef(0);
  const invitationsRequestRef = useRef(0);

  /**
   * `member_count` is derived from the roster, so it moves with it or not at
   * all — writing the count from a read whose rows were discarded would put
   * the header and the table into two different truths.
   */
  const applyMembers = useCallback((ticket: number, next: OrgMember[]) => {
    if (ticket !== membersRequestRef.current) return;
    setMembers(next);
    setOrg((current) =>
      current ? { ...current, member_count: next.length } : current,
    );
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    const membersTicket = ++membersRequestRef.current;
    const invitationsTicket = ++invitationsRequestRef.current;
    try {
      const nextOrg = await getOrg(orgId);
      const [nextMembers, nextResources, nextInvitations] = await Promise.all([
        listOrgMembers(orgId),
        listOrgResources(orgId),
        nextOrg.role === "admin"
          ? listOrgInvitations(orgId)
          : Promise.resolve([] as OrgInvitation[]),
      ]);
      setOrg(nextOrg);
      applyMembers(membersTicket, nextMembers);
      setResources(nextResources);
      if (invitationsTicket === invitationsRequestRef.current)
        setInvitations(nextInvitations);
    } catch (error) {
      console.error("Failed to load organization", error);
      setLoadError(
        userFacingApiError(error, "Could not load this organization."),
      );
    } finally {
      setLoading(false);
    }
  }, [applyMembers, orgId]);

  const refreshInvitations = useCallback(async () => {
    if (org?.role !== "admin") return;
    const ticket = ++invitationsRequestRef.current;
    const nextInvitations = await listOrgInvitations(orgId);
    if (ticket !== invitationsRequestRef.current) return;
    setInvitations(nextInvitations);
  }, [org?.role, orgId]);

  const refreshMembers = useCallback(async () => {
    const ticket = ++membersRequestRef.current;
    applyMembers(ticket, await listOrgMembers(orgId));
  }, [applyMembers, orgId]);

  /**
   * An invitation is accepted somewhere else entirely — in the recipient's
   * browser — so nothing on this page hears about it. Both lists it lands in
   * therefore have to be re-read together whenever the admin looks: the
   * invitation leaves "Pending invitations" and the same person appears on the
   * People roster. Reading only the invitations, which is what the Add member
   * modal used to do, left the roster a reload behind.
   *
   * One failing does not cancel the other — but neither is it swallowed. A
   * console line is not a user interface: the admin was left reading a roster
   * that had silently stopped tracking the server, with the page looking
   * exactly as it does when the refresh worked. It says so now, in the same
   * place every other failed action on this page speaks.
   */
  const refreshPeople = useCallback(async () => {
    const results = await Promise.allSettled([
      refreshInvitations(),
      refreshMembers(),
    ]);
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (!failure) return;
    console.error("Failed to refresh organization people", failure.reason);
    setActionError(
      userFacingApiError(
        failure.reason,
        "This organization's people could not be refreshed. Reload to see the current list.",
      ),
    );
  }, [refreshInvitations, refreshMembers]);

  useEffect(() => {
    void load();
  }, [load]);

  const isAdmin = org?.role === "admin";

  /**
   * Demoting yourself is the one role change that rewrites what this page is
   * allowed to do, so it is confirmed before it runs rather than silently
   * pulling the admin controls out from under the click.
   */
  function requestRoleChange(member: OrgMember, role: OrgRole) {
    if (!isAdmin || member.role === role || busyMemberId) return;
    if (member.user_id === user?.id && role !== "admin") {
      setPendingSelfRoleChange({ member, role });
      return;
    }
    void changeRole(member, role);
  }

  async function changeRole(member: OrgMember, role: OrgRole) {
    if (!isAdmin || member.role === role || busyMemberId) return;
    setBusyMemberId(member.user_id);
    setActionError(null);
    try {
      await updateOrgMember(orgId, member.user_id, role);
      setMembers((current) =>
        current.map((row) =>
          row.user_id === member.user_id ? { ...row, role } : row,
        ),
      );
      // The membership row is not the only place this role lives: `org.role`
      // gates every admin-only control and request on the page. Without this
      // the demoted admin keeps a UI they no longer have rights for, and each
      // action 403s until a reload.
      if (member.user_id === user?.id) {
        setOrg((current) => (current ? { ...current, role } : current));
        if (role !== "admin") setInvitations([]);
      }
    } catch (error) {
      setActionError(userFacingApiError(error, "Could not change that role."));
    } finally {
      setBusyMemberId(null);
    }
  }

  async function confirmRemoveMember() {
    if (!removeMember || busyMemberId) return;
    const member = removeMember;
    setBusyMemberId(member.user_id);
    setActionError(null);
    try {
      await removeOrgMember(orgId, member.user_id);
      if (member.user_id === user?.id) {
        router.push("/organizations");
        return;
      }
      setMembers((current) =>
        current.filter((row) => row.user_id !== member.user_id),
      );
      setSelectedMemberIds((current) =>
        current.filter((id) => id !== member.id),
      );
      setRemoveMember(null);
    } catch (error) {
      setActionError(
        userFacingApiError(error, "Could not remove that member."),
      );
      setRemoveMember(null);
    } finally {
      setBusyMemberId(null);
    }
  }

  function requestRemoveSelected() {
    if (!isAdmin || selectedMemberIds.length === 0) return;
    const selectedMembers = members.filter((member) =>
      selectedMemberIds.includes(member.id),
    );
    if (selectedMembers.some((member) => member.user_id === user?.id)) {
      setActionError("Use Leave organization to remove yourself.");
      return;
    }
    setRemoveSelectedOpen(true);
  }

  async function confirmRemoveSelected() {
    if (!isAdmin || removingSelected || selectedMemberIds.length === 0) return;
    const selectedMembers = members.filter((member) =>
      selectedMemberIds.includes(member.id),
    );
    setRemovingSelected(true);
    setActionError(null);
    const results = await Promise.allSettled(
      selectedMembers.map((member) => removeOrgMember(orgId, member.user_id)),
    );
    const removedIds = selectedMembers
      .filter((_, index) => results[index]?.status === "fulfilled")
      .map((member) => member.id);
    const firstFailure = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    setMembers((current) =>
      current.filter((member) => !removedIds.includes(member.id)),
    );
    setSelectedMemberIds((current) =>
      current.filter((id) => !removedIds.includes(id)),
    );
    if (firstFailure) {
      setActionError(
        userFacingApiError(
          firstFailure.reason,
          "Could not remove all selected members.",
        ),
      );
    }
    setRemoveSelectedOpen(false);
    setRemovingSelected(false);
  }

  const peopleToolbarActions =
    activeTab === "people" && isAdmin && selectedMemberIds.length > 0 ? (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <TabPillButton>
            Actions
            <ChevronDown className="h-3.5 w-3.5" />
          </TabPillButton>
        </DropdownMenuTrigger>
        <LiquidDropdownContent align="end" className="z-[130] w-44">
          <LiquidDropdownItem
            onSelect={requestRemoveSelected}
            className="text-red-600 focus:text-red-700"
          >
            <Trash2 className="h-3.5 w-3.5 text-red-600" />
            Remove all selected
          </LiquidDropdownItem>
        </LiquidDropdownContent>
      </DropdownMenu>
    ) : undefined;

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <PageHeader
        loading={loading}
        breadcrumbs={[
          {
            label: "Organizations",
            onClick: () => router.push("/organizations"),
            title: "Back to Organizations",
          },
          org
            ? { label: org.name, cursor: "text" }
            : { loading: true, skeletonClassName: "w-40" },
        ]}
        actionGroups={[
          [
            {
              type: "new",
              title: isAdmin
                ? "Add member"
                : "Only organization admins can add members",
              disabled: !isAdmin,
              onClick: () => {
                setInviteOpen(true);
                // The modal shows the invitation list this page loaded, which
                // by now may name people who have already accepted.
                void refreshPeople();
              },
            },
            isAdmin
              ? {
                  type: "custom",
                  render: (
                    <HeaderActionsMenu
                      title="Organization settings"
                      items={[
                        {
                          label: "Organization settings",
                          icon: Pencil,
                          onSelect: () => setSettingsOpen(true),
                        },
                      ]}
                    />
                  ),
                }
              : null,
          ],
        ]}
      />

      <TableToolbar
        items={TABS}
        active={activeTab}
        onChange={(tab) => {
          setActiveTab(tab);
          setSelectedMemberIds([]);
        }}
        actions={peopleToolbarActions}
      />

      {activeTab === "people" ? (
        <PeopleTable
          loading={loading}
          error={loadError}
          members={members}
          selectedMemberIds={selectedMemberIds}
          onSelectedMemberIdsChange={setSelectedMemberIds}
          currentUserId={user?.id ?? null}
          isAdmin={isAdmin}
          busyMemberId={busyMemberId}
          onRetry={load}
          onRoleChange={requestRoleChange}
          onRemove={setRemoveMember}
        />
      ) : activeTab === "projects" ? (
        <ResourceTable
          key="projects"
          loading={loading}
          error={loadError}
          kind="projects"
          rows={resources.projects.map((project) => ({
            id: project.id,
            name: resourceName(project.name, "Untitled project"),
            context: project.practice || "—",
            createdAt: project.created_at,
            href: `/projects/${project.id}`,
          }))}
          onRetry={load}
        />
      ) : (
        <ResourceTable
          key="workflows"
          loading={loading}
          error={loadError}
          kind="workflows"
          rows={resources.workflows.map((workflow) => ({
            id: workflow.id,
            name: resourceName(workflow.title, "Untitled workflow"),
            context:
              workflow.type === "tabular" ? "Tabular review" : "Assistant",
            createdAt: workflow.created_at,
            href: `/workflows/${workflow.id}`,
          }))}
          onRetry={load}
        />
      )}

      {org ? (
        <>
          <InviteOrganizationMemberModal
            open={inviteOpen}
            org={org}
            invitations={invitations}
            onClose={() => {
              setInviteOpen(false);
              // An invitation sent or accepted while the modal was open
              // changes BOTH lists behind it — a new invitation is pending, an
              // accepted one is gone and its sender is now on the roster — so
              // the admin returns to a re-read of both, not of the roster
              // alone with a stale "Pending invitations" beside it.
              void refreshPeople();
            }}
            onChanged={refreshPeople}
          />
          <OrganizationSettingsModal
            open={settingsOpen}
            org={org}
            onClose={() => setSettingsOpen(false)}
            onUpdated={(updated) => {
              setOrg((current) => ({
                ...updated,
                member_count: current?.member_count,
              }));
              setSettingsOpen(false);
            }}
            onDeleted={() => router.push("/organizations")}
          />
        </>
      ) : null}

      <ConfirmPopup
        open={removeMember !== null}
        title={
          removeMember?.user_id === user?.id
            ? "Leave organization?"
            : "Remove member?"
        }
        message={
          removeMember?.user_id === user?.id
            ? "You will lose access to this organization's shared resources."
            : `${removeMember?.display_name || removeMember?.email || "This member"} will lose organization access.`
        }
        confirmLabel={removeMember?.user_id === user?.id ? "Leave" : "Remove"}
        confirmVariant="danger"
        confirmStatus={busyMemberId ? "loading" : "idle"}
        onCancel={() => setRemoveMember(null)}
        onConfirm={() => void confirmRemoveMember()}
      />
      <ConfirmPopup
        open={pendingSelfRoleChange !== null}
        title="Give up admin access?"
        message="You will lose admin access to this organization and can no longer manage its people, settings or invitations."
        confirmLabel="Continue"
        confirmStatus={busyMemberId ? "loading" : "idle"}
        onCancel={() => setPendingSelfRoleChange(null)}
        onConfirm={() => {
          const pending = pendingSelfRoleChange;
          setPendingSelfRoleChange(null);
          if (pending) void changeRole(pending.member, pending.role);
        }}
      />
      <ConfirmPopup
        open={removeSelectedOpen}
        title="Remove selected people?"
        message={`${selectedMemberIds.length} selected ${selectedMemberIds.length === 1 ? "member" : "members"} will lose access to this organization.`}
        confirmLabel="Remove"
        confirmVariant="danger"
        confirmStatus={removingSelected ? "loading" : "idle"}
        onCancel={() => setRemoveSelectedOpen(false)}
        onConfirm={() => void confirmRemoveSelected()}
      />
      <WarningPopup
        open={actionError !== null}
        title="Organization action failed"
        message={actionError}
        onClose={() => setActionError(null)}
      />
    </div>
  );
}

function PeopleTable({
  loading,
  error,
  members,
  selectedMemberIds,
  onSelectedMemberIdsChange,
  currentUserId,
  isAdmin,
  busyMemberId,
  onRetry,
  onRoleChange,
  onRemove,
}: {
  loading: boolean;
  error: string | null;
  members: OrgMember[];
  selectedMemberIds: string[];
  onSelectedMemberIdsChange: Dispatch<SetStateAction<string[]>>;
  currentUserId: string | null;
  isAdmin: boolean;
  busyMemberId: string | null;
  onRetry: () => Promise<void>;
  onRoleChange: (member: OrgMember, role: OrgRole) => void;
  onRemove: (member: OrgMember) => void;
}) {
  const [roleFilter, setRoleFilter] = useState<OrgRole | null>(null);
  const [sort, setSort] = useState<{
    key: "name" | "email" | "added";
    direction: TableSortDirection;
  } | null>(null);
  const visibleMembers = useMemo(() => {
    const filtered = roleFilter
      ? members.filter((member) => member.role === roleFilter)
      : members;
    if (!sort) return filtered;
    const multiplier = sort.direction === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      if (sort.key === "added") {
        return (
          (new Date(a.created_at ?? 0).getTime() -
            new Date(b.created_at ?? 0).getTime()) *
          multiplier
        );
      }
      const aValue =
        sort.key === "email"
          ? (a.email ?? "")
          : a.display_name || a.email || a.user_id;
      const bValue =
        sort.key === "email"
          ? (b.email ?? "")
          : b.display_name || b.email || b.user_id;
      return aValue.localeCompare(bValue) * multiplier;
    });
  }, [members, roleFilter, sort]);
  const allSelected =
    visibleMembers.length > 0 &&
    visibleMembers.every((member) => selectedMemberIds.includes(member.id));
  const someSelected =
    !allSelected &&
    visibleMembers.some((member) => selectedMemberIds.includes(member.id));

  function setSortFor(
    key: "name" | "email" | "added",
    direction: TableSortDirection | null,
  ) {
    setSort(direction ? { key, direction } : null);
    onSelectedMemberIdsChange([]);
  }

  function toggleAllVisible() {
    const visibleIds = visibleMembers.map((member) => member.id);
    onSelectedMemberIdsChange((current) =>
      allSelected
        ? current.filter((id) => !visibleIds.includes(id))
        : [...new Set([...current, ...visibleIds])],
    );
  }

  function toggleMember(memberId: string) {
    onSelectedMemberIdsChange((current) =>
      current.includes(memberId)
        ? current.filter((id) => id !== memberId)
        : [...current, memberId],
    );
  }

  return (
    <TableScrollArea
      header={
        <TableHeaderRow>
          <TableStickyCell header>
            {loading ? (
              <SkeletonCheckbox />
            ) : (
              <input
                type="checkbox"
                checked={allSelected}
                ref={(element) => {
                  if (element) element.indeterminate = someSelected;
                }}
                onChange={toggleAllVisible}
                className={TABLE_CHECKBOX_CLASS}
                aria-label="Select all people"
              />
            )}
            <span className="mr-1">Username</span>
            {!loading ? (
              <TableFilters
                label="Sort by username"
                value={sort?.key === "name" ? sort.direction : null}
                allLabel="Default order"
                options={SORT_OPTIONS}
                align="right"
                widthClassName="w-40"
                onChange={(direction) => setSortFor("name", direction)}
              />
            ) : null}
          </TableStickyCell>
          <TableHeaderCell className="ml-auto w-64">
            <span className="mr-1">Email</span>
            {!loading ? (
              <TableFilters
                label="Sort by email"
                value={sort?.key === "email" ? sort.direction : null}
                allLabel="Default order"
                options={SORT_OPTIONS}
                widthClassName="w-40"
                onChange={(direction) => setSortFor("email", direction)}
              />
            ) : null}
          </TableHeaderCell>
          <TableHeaderCell className="w-32">
            <span className="mr-1">Role</span>
            {!loading ? (
              <TableFilters
                label="Filter by role"
                value={roleFilter}
                allLabel="All roles"
                options={ROLE_FILTER_OPTIONS}
                widthClassName="w-36"
                onChange={(role) => {
                  setRoleFilter(role);
                  onSelectedMemberIdsChange([]);
                }}
              />
            ) : null}
          </TableHeaderCell>
          <TableHeaderCell className="w-36">
            <span className="mr-1">Added</span>
            {!loading ? (
              <TableFilters
                label="Sort by date added"
                value={sort?.key === "added" ? sort.direction : null}
                allLabel="Default order"
                options={SORT_OPTIONS}
                widthClassName="w-40"
                onChange={(direction) => setSortFor("added", direction)}
              />
            ) : null}
          </TableHeaderCell>
          <TableHeaderCell className="w-10" />
        </TableHeaderRow>
      }
    >
      {loading ? (
        <LoadingRows columns={["w-64", "w-32", "w-36", "w-10"]} />
      ) : error ? (
        <ErrorState error={error} onRetry={onRetry} />
      ) : members.length === 0 ? (
        <TableEmptyState>
          <EmptyState
            icon={<OrganizationSkeuoIcon />}
            title="People"
            description="This organization has no members."
          />
        </TableEmptyState>
      ) : visibleMembers.length === 0 ? (
        <TableEmptyState>
          <p className="text-sm text-gray-400">No people match this filter.</p>
        </TableEmptyState>
      ) : (
        <TableBody>
          {visibleMembers.map((member) => {
            const label = member.display_name || member.email || member.user_id;
            const canRemove = isAdmin || member.user_id === currentUserId;
            const isSelected = selectedMemberIds.includes(member.id);
            return (
              <TableRow
                key={member.id}
                interactive={false}
                selected={isSelected}
                className={!isSelected ? LIQUID_GLASS_HOVER_CLASS : undefined}
              >
                <TablePrimaryCell
                  selected={isSelected}
                  onSelectionChange={() => toggleMember(member.id)}
                  checkboxTitle={`Select ${label}`}
                >
                  <span className="min-w-0 flex-1 truncate text-xs text-gray-800">
                    {label}
                  </span>
                  {member.user_id === currentUserId ? (
                    <span className="ml-1 text-[10px] text-gray-400">
                      (You)
                    </span>
                  ) : null}
                </TablePrimaryCell>
                <TableCell className="ml-auto w-64">
                  {member.email || "—"}
                </TableCell>
                <TableCell className="w-32 overflow-visible">
                  <OrganizationRoleTab
                    role={member.role}
                    label={label}
                    editable={isAdmin}
                    disabled={busyMemberId === member.user_id}
                    onChange={(role) => onRoleChange(member, role)}
                  />
                </TableCell>
                <TableCell className="w-36">
                  {formatDate(member.created_at)}
                </TableCell>
                <TableCell className="flex w-10 justify-end overflow-visible">
                  {canRemove ? (
                    <HeaderActionsMenu
                      title={`Actions for ${label}`}
                      items={[
                        {
                          label:
                            member.user_id === currentUserId
                              ? "Leave organization"
                              : "Remove member",
                          icon: Trash2,
                          variant: "danger",
                          onSelect: () => onRemove(member),
                        },
                      ]}
                    />
                  ) : null}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      )}
    </TableScrollArea>
  );
}

function OrganizationRoleTab({
  role,
  label,
  editable,
  disabled,
  onChange,
}: {
  role: OrgRole;
  label: string;
  editable: boolean;
  disabled: boolean;
  onChange: (role: OrgRole) => void;
}) {
  const tone =
    role === "admin"
      ? "bg-blue-100 text-blue-700"
      : "bg-violet-100 text-violet-700";
  const className = `inline-flex h-6 min-w-20 items-center justify-center gap-1 rounded-full px-2 text-[11px] font-medium ${tone}`;

  if (!editable) {
    return <span className={className}>{ORG_ROLE_LABELS[role]}</span>;
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Change role for ${label}`}
          disabled={disabled}
          className={`${className} transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 disabled:cursor-wait disabled:opacity-50`}
        >
          <span className="flex-1 text-center">{ORG_ROLE_LABELS[role]}</span>
          {disabled ? (
            <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
          ) : (
            <ChevronDown className="h-3 w-3 shrink-0" />
          )}
        </button>
      </DropdownMenuTrigger>
      <LiquidDropdownContent align="start" className="z-[120] w-36">
        {ROLE_FILTER_OPTIONS.map((option) => (
          <LiquidDropdownItem
            key={option.value}
            selected={role === option.value}
            onSelect={() => onChange(option.value)}
            className="flex items-center justify-between"
          >
            <span className={option.className}>{option.label}</span>
            {role === option.value ? (
              <Check className="h-3.5 w-3.5 text-gray-400" />
            ) : null}
          </LiquidDropdownItem>
        ))}
      </LiquidDropdownContent>
    </DropdownMenu>
  );
}

type ResourceKind = "projects" | "workflows";
type ResourceRow = {
  id: string;
  name: string;
  context: string;
  createdAt: string | null;
  href: string;
};

function ResourceTable({
  loading,
  error,
  kind,
  rows,
  onRetry,
}: {
  loading: boolean;
  error: string | null;
  kind: ResourceKind;
  rows: ResourceRow[];
  onRetry: () => Promise<void>;
}) {
  const router = useRouter();
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [contextFilter, setContextFilter] = useState<string | null>(null);
  const [sort, setSort] = useState<{
    key: "name" | "created";
    direction: TableSortDirection;
  } | null>(null);
  const copy = {
    projects: {
      title: "Projects",
      context: "Practice",
      empty: "No projects belong to this organization.",
      icon: <ClosedProjectSvgIcon />,
    },
    workflows: {
      title: "Workflows",
      context: "Type",
      empty: "No workflows belong to this organization.",
      icon: <WorkflowSkeuoIcon />,
    },
  }[kind];
  const contextOptions = useMemo<TableFilterOption<string>[]>(
    () =>
      [...new Set(rows.map((row) => row.context))]
        .sort((a, b) => a.localeCompare(b))
        .map((context) => ({ value: context, label: context })),
    [rows],
  );
  const visibleRows = useMemo(() => {
    const filtered = contextFilter
      ? rows.filter((row) => row.context === contextFilter)
      : rows;
    if (!sort) return filtered;
    const multiplier = sort.direction === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      if (sort.key === "name") return a.name.localeCompare(b.name) * multiplier;
      return (
        (new Date(a.createdAt ?? 0).getTime() -
          new Date(b.createdAt ?? 0).getTime()) *
        multiplier
      );
    });
  }, [contextFilter, rows, sort]);
  const allSelected =
    visibleRows.length > 0 &&
    visibleRows.every((row) => selectedIds.includes(row.id));
  const someSelected =
    !allSelected && visibleRows.some((row) => selectedIds.includes(row.id));

  function setSortFor(
    key: "name" | "created",
    direction: TableSortDirection | null,
  ) {
    setSort(direction ? { key, direction } : null);
    setSelectedIds([]);
  }

  function toggleAllVisible() {
    const visibleIds = visibleRows.map((row) => row.id);
    setSelectedIds((current) =>
      allSelected
        ? current.filter((id) => !visibleIds.includes(id))
        : [...new Set([...current, ...visibleIds])],
    );
  }

  function toggleRow(rowId: string) {
    setSelectedIds((current) =>
      current.includes(rowId)
        ? current.filter((id) => id !== rowId)
        : [...current, rowId],
    );
  }

  return (
    <TableScrollArea
      header={
        <TableHeaderRow>
          <TableStickyCell header>
            {loading ? (
              <SkeletonCheckbox />
            ) : (
              <input
                type="checkbox"
                checked={allSelected}
                ref={(element) => {
                  if (element) element.indeterminate = someSelected;
                }}
                onChange={toggleAllVisible}
                className={TABLE_CHECKBOX_CLASS}
                aria-label={`Select all ${kind}`}
              />
            )}
            <span className="mr-1">Name</span>
            {!loading ? (
              <TableFilters
                label={`Sort ${kind} by name`}
                value={sort?.key === "name" ? sort.direction : null}
                allLabel="Default order"
                options={SORT_OPTIONS}
                align="right"
                widthClassName="w-40"
                onChange={(direction) => setSortFor("name", direction)}
              />
            ) : null}
          </TableStickyCell>
          <TableHeaderCell className="ml-auto w-48">
            <span className="mr-1">{copy.context}</span>
            {!loading ? (
              <TableFilters
                label={`Filter ${kind} by ${copy.context.toLowerCase()}`}
                value={contextFilter}
                allLabel={`All ${copy.context.toLowerCase()}s`}
                options={contextOptions}
                widthClassName="w-44"
                onChange={(context) => {
                  setContextFilter(context);
                  setSelectedIds([]);
                }}
              />
            ) : null}
          </TableHeaderCell>
          <TableHeaderCell className="w-36">
            <span className="mr-1">Created</span>
            {!loading ? (
              <TableFilters
                label={`Sort ${kind} by creation date`}
                value={sort?.key === "created" ? sort.direction : null}
                allLabel="Default order"
                options={SORT_OPTIONS}
                widthClassName="w-40"
                onChange={(direction) => setSortFor("created", direction)}
              />
            ) : null}
          </TableHeaderCell>
        </TableHeaderRow>
      }
    >
      {loading ? (
        <LoadingRows columns={["w-48", "w-36"]} />
      ) : error ? (
        <ErrorState error={error} onRetry={onRetry} />
      ) : rows.length === 0 ? (
        <TableEmptyState>
          <EmptyState
            icon={copy.icon}
            title={copy.title}
            description={copy.empty}
          />
        </TableEmptyState>
      ) : visibleRows.length === 0 ? (
        <TableEmptyState>
          <p className="text-sm text-gray-400">No {kind} match this filter.</p>
        </TableEmptyState>
      ) : (
        <TableBody>
          {visibleRows.map((row) => (
            <TableRow
              key={row.id}
              selected={selectedIds.includes(row.id)}
              role="link"
              tabIndex={0}
              aria-label={`Open ${row.name}`}
              onClick={() => router.push(row.href)}
              onKeyDown={(event) => {
                if (event.target !== event.currentTarget) return;
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  router.push(row.href);
                }
              }}
              className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500/40"
            >
              <TablePrimaryCell
                selected={selectedIds.includes(row.id)}
                onSelectionChange={() => toggleRow(row.id)}
                checkboxTitle={`Select ${row.name}`}
              >
                <span className="min-w-0 flex-1 truncate text-xs text-gray-800">
                  {row.name}
                </span>
              </TablePrimaryCell>
              <TableCell className="ml-auto w-48">{row.context}</TableCell>
              <TableCell className="w-36">
                {formatDate(row.createdAt)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      )}
    </TableScrollArea>
  );
}

function LoadingRows({ columns }: { columns: string[] }) {
  return (
    <TableBody>
      {[1, 2, 3].map((row) => (
        <TableRow key={row} interactive={false}>
          <TableStickyCell hover={false} bgClassName="bg-transparent">
            <SkeletonCheckbox />
            <SkeletonLine className="w-40" />
          </TableStickyCell>
          {columns.map((width, index) => (
            <TableCell
              key={`${width}-${index}`}
              className={`${index === 0 ? "ml-auto " : ""}${width}`}
            >
              <SkeletonLine className="w-20" />
            </TableCell>
          ))}
        </TableRow>
      ))}
    </TableBody>
  );
}

function ErrorState({
  error,
  onRetry,
}: {
  error: string;
  onRetry: () => Promise<void>;
}) {
  return (
    <TableEmptyState>
      <EmptyState
        icon={<OrganizationSkeuoIcon />}
        title="Organization"
        description={error}
        tone="error"
        action={
          <button
            type="button"
            onClick={() => void onRetry()}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-700 hover:text-gray-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
          >
            <Loader2 className="h-3.5 w-3.5" />
            Try again
          </button>
        }
      />
    </TableEmptyState>
  );
}
