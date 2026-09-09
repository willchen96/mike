"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/app/components/shared/PageHeader";
import { TableToolbar } from "@/app/components/shared/TableToolbar";
import {
  SkeletonLine,
  TableBody,
  TableCell,
  TableEmptyState,
  TableFilters,
  TableHeaderCell,
  TableHeaderRow,
  TableRow,
  TableScrollArea,
  TableStickyCell,
  type TableFilterOption,
  type TableSortDirection,
} from "@/app/components/shared/TablePrimitive";
import { EmptyState } from "@/app/components/ui/empty-state";
import { PillButton } from "@/app/components/ui/pill-button";
import { WarningPopup } from "@/app/components/popups/WarningPopup";
import { OrganizationSkeuoIcon } from "@/app/components/shared/AppSidebarSkeuoIcons";
import {
  acceptOrgInvitation,
  declineOrgInvitation,
  listMyOrgInvitations,
  listOrgs,
  type Org,
  type OrgInvitation,
} from "@/app/lib/mikeApi";
import { ORG_ROLE_LABELS } from "@/app/lib/permissions";
import { userFacingApiError } from "@/app/lib/userFacingError";
import { LIQUID_SUBTLE_PANEL_SURFACE_CLASS } from "@/app/components/ui/liquid-surface";
import { CreateOrganizationModal } from "./OrganizationModals";

type OrganizationFilter = "managed" | "joined" | "invites";
type OrganizationSortKey = "name" | "members" | "created";

const SORT_OPTIONS: TableFilterOption<TableSortDirection>[] = [
  { value: "asc", label: "Ascending" },
  { value: "desc", label: "Descending" },
];

function formatDate(value?: string) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function OrganizationsOverview() {
  const router = useRouter();
  const [orgs, setOrgs] = useState<Org[] | null>(null);
  const [invitations, setInvitations] = useState<OrgInvitation[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [invitationsError, setInvitationsError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [activeFilter, setActiveFilter] =
    useState<OrganizationFilter>("managed");
  const [sort, setSort] = useState<{
    key: OrganizationSortKey;
    direction: TableSortDirection;
  } | null>(null);
  const [answeringId, setAnsweringId] = useState<string | null>(null);
  const [invitationError, setInvitationError] = useState<string | null>(null);

  // The two lists fail independently: a broken invitations fetch must not
  // blank the organizations table, and — the reason this is not a swallowed
  // `.catch(() => [])` — it must not masquerade as "you have no invitations"
  // either. Each side keeps its own error so each can offer its own retry.
  const load = useCallback(async () => {
    const [orgsResult, invitationsResult] = await Promise.allSettled([
      listOrgs(),
      listMyOrgInvitations(),
    ]);
    if (orgsResult.status === "fulfilled") {
      setOrgs(orgsResult.value);
      setLoadError(null);
    } else {
      console.error("Failed to load organizations", orgsResult.reason);
      // The invitations half of this same function already routes its
      // failure through userFacingApiError, which shows the server's own
      // wording for a 4xx. A hardcoded sentence here threw that away, so the
      // two halves of one screen answered the same kind of failure
      // differently — and the more useful answer was the one discarded.
      setLoadError(
        userFacingApiError(orgsResult.reason, "Could not load organizations."),
      );
      setOrgs([]);
    }
    if (invitationsResult.status === "fulfilled") {
      setInvitations(invitationsResult.value);
      setInvitationsError(null);
    } else {
      console.error("Failed to load invitations", invitationsResult.reason);
      setInvitations([]);
      setInvitationsError(
        userFacingApiError(
          invitationsResult.reason,
          "Could not load your invitations.",
        ),
      );
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function answer(invitation: OrgInvitation, accept: boolean) {
    setAnsweringId(invitation.id);
    setInvitationError(null);
    try {
      if (accept) await acceptOrgInvitation(invitation.id);
      else await declineOrgInvitation(invitation.id);
    } catch (error) {
      setInvitationError(
        userFacingApiError(error, "Could not answer that invitation."),
      );
    } finally {
      setAnsweringId(null);
    }
    // Outside the try, and on both paths. Inside it, a re-read that failed
    // would have been reported as "Could not answer that invitation" about an
    // invitation the server had just accepted — the reload is bookkeeping,
    // not the user's action. Both paths need it: an accepted invitation moves
    // to the organizations list, and a refusal is often a refusal because
    // somebody answered it somewhere else already.
    await load();
  }

  const loading = orgs === null;
  const organizationFilters = useMemo<
    { id: OrganizationFilter; label: string }[]
  >(
    () => [
      { id: "managed", label: "Managing" },
      { id: "joined", label: "Joined" },
      {
        id: "invites",
        // A failed fetch and an empty inbox both left this reading plain
        // "Invites", so the one state worth opening the tab for looked
        // exactly like the one that is not. Plain text in the label, not a
        // badge: this is a status, not a control.
        label: invitationsError
          ? "Invites (unavailable)"
          : invitations.length > 0
            ? `Invites (${invitations.length})`
            : "Invites",
      },
    ],
    [invitations.length, invitationsError],
  );
  const visibleOrgs = useMemo(() => {
    if (activeFilter === "invites") return [];
    const filtered = (orgs ?? []).filter((org) =>
      activeFilter === "managed" ? org.role === "admin" : org.role !== "admin",
    );
    if (!sort) return filtered;
    const multiplier = sort.direction === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      if (sort.key === "name") return a.name.localeCompare(b.name) * multiplier;
      if (sort.key === "members")
        return ((a.member_count ?? 0) - (b.member_count ?? 0)) * multiplier;
      return (
        (new Date(a.created_at ?? 0).getTime() -
          new Date(b.created_at ?? 0).getTime()) *
        multiplier
      );
    });
  }, [activeFilter, orgs, sort]);
  function setSortFor(
    key: OrganizationSortKey,
    direction: TableSortDirection | null,
  ) {
    setSort(direction ? { key, direction } : null);
  }
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <PageHeader
        loading={loading}
        actions={[
          {
            type: "new",
            title: "New organization",
            onClick: () => setCreateOpen(true),
          },
        ]}
      >
        <h1 className="font-serif text-2xl font-medium text-gray-900">
          Organizations
        </h1>
      </PageHeader>

      <TableToolbar
        items={organizationFilters}
        active={activeFilter}
        onChange={setActiveFilter}
      />

      {activeFilter === "invites" ? (
        loading ? (
          <div
            className={`mx-4 mb-3 space-y-4 rounded-2xl px-4 py-4 md:mx-8 ${LIQUID_SUBTLE_PANEL_SURFACE_CLASS}`}
          >
            {[1, 2, 3].map((row) => (
              <SkeletonLine key={row} className="h-7 w-full" />
            ))}
          </div>
        ) : invitationsError ? (
          <div className="mx-4 mb-3 flex min-h-0 flex-1 items-center justify-center md:mx-8">
            <EmptyState
              icon={<OrganizationSkeuoIcon />}
              title="Invitations"
              description={invitationsError}
              tone="error"
              action={
                <PillButton tone="black" size="sm" onClick={() => void load()}>
                  Try again
                </PillButton>
              }
            />
          </div>
        ) : invitations.length === 0 ? (
          <div className="mx-4 mb-3 flex min-h-0 flex-1 items-center justify-center md:mx-8">
            <EmptyState
              title="Invitations"
              description="You have no active organization invitations."
            />
          </div>
        ) : (
          <div
            className={`mx-4 mb-3 rounded-2xl px-4 py-3 md:mx-8 ${LIQUID_SUBTLE_PANEL_SURFACE_CLASS}`}
          >
            <div className="min-w-0 space-y-3">
              {invitations.map((invitation) => (
                <div
                  key={invitation.id}
                  className="flex flex-col gap-2 sm:flex-row sm:items-center"
                >
                  <p className="min-w-0 flex-1 text-xs text-gray-600">
                    <span className="font-medium text-gray-800">
                      {invitation.org_name ?? "An organization"}
                    </span>{" "}
                    invited you as {ORG_ROLE_LABELS[invitation.role]}.
                  </p>
                  <div className="flex gap-2">
                    <PillButton
                      tone="black"
                      size="sm"
                      disabled={answeringId === invitation.id}
                      onClick={() => void answer(invitation, true)}
                    >
                      {answeringId === invitation.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Check className="h-3.5 w-3.5" />
                      )}
                      Accept
                    </PillButton>
                    <PillButton
                      tone="white"
                      size="sm"
                      disabled={answeringId === invitation.id}
                      onClick={() => void answer(invitation, false)}
                    >
                      Decline
                    </PillButton>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )
      ) : (
        <TableScrollArea
          header={
            <TableHeaderRow>
              <TableStickyCell header>
                <span className="mr-1">Name</span>
                {!loading ? (
                  <TableFilters
                    label="Sort by organization name"
                    value={sort?.key === "name" ? sort.direction : null}
                    allLabel="Default order"
                    options={SORT_OPTIONS}
                    align="right"
                    widthClassName="w-40"
                    onChange={(direction) => setSortFor("name", direction)}
                  />
                ) : null}
              </TableStickyCell>
              <TableHeaderCell className="ml-auto w-32">
                <span className="mr-1">Members</span>
                {!loading ? (
                  <TableFilters
                    label="Sort by member count"
                    value={sort?.key === "members" ? sort.direction : null}
                    allLabel="Default order"
                    options={SORT_OPTIONS}
                    widthClassName="w-40"
                    onChange={(direction) => setSortFor("members", direction)}
                  />
                ) : null}
              </TableHeaderCell>
              <TableHeaderCell className="w-36">
                <span className="mr-1">Created</span>
                {!loading ? (
                  <TableFilters
                    label="Sort by creation date"
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
            <TableBody>
              {[1, 2, 3].map((row) => (
                <TableRow key={row} interactive={false}>
                  <TableStickyCell
                    hover={false}
                    bgClassName="bg-transparent"
                    className="items-center"
                  >
                    <SkeletonLine className="w-44" />
                  </TableStickyCell>
                  <TableCell className="ml-auto w-32">
                    <SkeletonLine className="w-12" />
                  </TableCell>
                  <TableCell className="w-36">
                    <SkeletonLine className="w-20" />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          ) : loadError ? (
            <TableEmptyState>
              <EmptyState
                icon={<OrganizationSkeuoIcon />}
                title="Organizations"
                description={loadError}
                tone="error"
                action={
                  <PillButton
                    tone="black"
                    size="sm"
                    onClick={() => void load()}
                  >
                    Try again
                  </PillButton>
                }
              />
            </TableEmptyState>
          ) : orgs.length === 0 ? (
            <TableEmptyState>
              <EmptyState
                icon={<OrganizationSkeuoIcon />}
                title="Organizations"
                description="Create an organization to share projects, chats and reviews with your team."
                action={
                  <PillButton
                    tone="black"
                    size="sm"
                    onClick={() => setCreateOpen(true)}
                  >
                    Create
                  </PillButton>
                }
              />
            </TableEmptyState>
          ) : visibleOrgs.length === 0 ? (
            <TableEmptyState>
              <p className="text-sm text-gray-400">
                {activeFilter === "managed"
                  ? "No managed organizations"
                  : "No joined organizations"}
              </p>
            </TableEmptyState>
          ) : (
            <TableBody>
              {visibleOrgs.map((org) => (
                <TableRow
                  key={org.id}
                  role="link"
                  tabIndex={0}
                  aria-label={`Open ${org.name}`}
                  onClick={() => router.push(`/organizations/${org.id}`)}
                  onKeyDown={(event) => {
                    if (event.target !== event.currentTarget) return;
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      router.push(`/organizations/${org.id}`);
                    }
                  }}
                  className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500/40"
                >
                  <TableStickyCell className="items-center">
                    <span className="min-w-0 flex-1 truncate text-xs text-gray-800">
                      {org.name}
                    </span>
                  </TableStickyCell>
                  <TableCell className="ml-auto w-32">
                    {org.member_count ?? 0}{" "}
                    {org.member_count === 1 ? "member" : "members"}
                  </TableCell>
                  <TableCell className="w-36">
                    {formatDate(org.created_at)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          )}
        </TableScrollArea>
      )}

      <CreateOrganizationModal
        open={createOpen}
        // A partly failed creation ("created, but some invitations could not
        // be sent") leaves the modal open on a real organization that never
        // reached onCreated. Refetching on dismissal is what makes that
        // organization appear here instead of only after a reload.
        onClose={() => {
          setCreateOpen(false);
          void load();
        }}
        onCreated={(org) => {
          setCreateOpen(false);
          router.push(`/organizations/${org.id}`);
        }}
      />
      <WarningPopup
        open={invitationError !== null}
        title="Invitation not updated"
        message={invitationError}
        onClose={() => setInvitationError(null)}
      />
    </div>
  );
}
