"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useDebouncedValue } from "@/app/hooks/useDebouncedValue";
import { restoreOptimisticallyDeletedRows } from "@/app/lib/optimisticRows";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronDown, Loader2 } from "lucide-react";
import {
    RowActionMenuItems,
    RowActions,
} from "@/app/components/shared/RowActions";
import { TableLoadMoreRow } from "@/app/components/shared/TableLoadMoreRow";
import {
    deleteTabularReview,
    createTabularReview,
    getTabularReviewPeople,
    grantTabularReviewAccess,
    listProjects,
    updateTabularReview,
} from "@/app/lib/mikeApi";
import type { TabularReview, Project } from "@/app/components/shared/types";
import { TableToolbar } from "@/app/components/shared/TableToolbar";
import { NewTRModal } from "@/app/components/tabular/NewTRModal";
import { TabularReviewDetailsModal } from "@/app/components/tabular/TabularReviewDetailsModal";
import {
    PermissionDeniedPopup,
    type AccessContact,
} from "@/app/components/popups/PermissionDeniedPopup";
import { can, roleFrom } from "@/app/lib/permissions";
import { userFacingApiError } from "@/app/lib/userFacingError";
import { WarningPopup } from "@/app/components/popups/WarningPopup";
import { ConfirmPopup } from "@/app/components/popups/ConfirmPopup";
import { useAuth } from "@/app/contexts/AuthContext";
import { PageHeader } from "@/app/components/shared/PageHeader";
import {
    TABLE_CHECKBOX_CLASS,
    SkeletonCheckbox,
    SkeletonLine,
    TableBody,
    TableCell,
    TableEmptyState,
    TableFilters,
    type TableFilterOption,
    TableHeaderCell,
    TableHeaderRow,
    TablePrimaryCell,
    TableRow,
    TableScrollArea,
    rowActionSelectionIds,
    type TableSortDirection,
    TableStickyCell,
} from "@/app/components/shared/TablePrimitive";
import { PillButton } from "@/app/components/ui/pill-button";
import { TabPillButton } from "@/app/components/ui/tab-pill-button";
import { TabularReviewSkeuoIcon } from "@/app/components/shared/AppSidebarSkeuoIcons";
import { LiquidDropdownSurface } from "@/app/components/ui/liquid-dropdown";
import {
    type TabularReviewScope,
    usePaginatedTabularReviews,
} from "@/app/hooks/usePaginatedTabularReviews";
import { deleteTabularReviewsWithConcurrency } from "@/app/lib/deleteTabularReviewsWithConcurrency";
import { useQueryParamTab } from "@/app/hooks/useQueryParamTab";

type ReviewScope = TabularReviewScope;
type ReviewSortKey = "name" | "columns" | "documents" | "created";

const REVIEW_SCOPES: { id: ReviewScope; label: string }[] = [
    { id: "all", label: "All" },
    { id: "in-project", label: "In Project" },
    { id: "standalone", label: "Standalone" },
];
const REVIEW_SCOPE_IDS = REVIEW_SCOPES.map((scope) => scope.id);
const SORT_OPTIONS: TableFilterOption<TableSortDirection>[] = [
    { value: "asc", label: "Ascending" },
    { value: "desc", label: "Descending" },
];
function formatDate(iso: string) {
    return new Date(iso).toLocaleDateString(undefined, {
        day: "numeric",
        month: "short",
        year: "numeric",
    });
}

export default function TabularReviewsPage() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const [projects, setProjects] = useState<Project[]>([]);
    const [creating, setCreating] = useState(false);
    const [newTROpen, setNewTROpen] = useState(false);
    // Holds the review created by the open New review dialog so a retry after
    // a failed access grant does not create a second one. Cleared when the
    // dialog closes, whether it finished or was cancelled.
    const createdReviewRef = useRef<TabularReview | null>(null);
    const [detailsReview, setDetailsReview] = useState<TabularReview | null>(
        null,
    );
    const [activeScope, setActiveScope] = useQueryParamTab(
        REVIEW_SCOPE_IDS,
        "all",
    );
    const [projectFilter, setProjectFilter] = useState<string | null>(null);
    const [sort, setSort] = useState<{
        key: ReviewSortKey;
        direction: TableSortDirection;
    } | null>(null);
    const [search, setSearch] = useState("");
    const debouncedSearch = useDebouncedValue(search, 250);
    const {
        reviews,
        setReviews,
        loading,
        loadingMore,
        hasMore,
        error: loadError,
        loadMoreError,
        loadMore,
        retry,
        selectedReviewIds: selectedIds,
        setSelectedReviewIds: setSelectedIds,
        selectAllMatching,
        selectingAll,
        getReviewOwnerId,
    } = usePaginatedTabularReviews({
        projectId: projectFilter ?? undefined,
        search: debouncedSearch,
        selectionKey: search,
        scope: activeScope,
        sort,
    });
    const [actionsOpen, setActionsOpen] = useState(false);
    /**
     * A refusal plus the person who can lift it. Unlike the projects overview,
     * the reviews overview RPC returns no contact columns at all — only
     * `access_role` — so the address is fetched from
     * `/tabular-review/:id/people` the first time a refusal actually fires,
     * exactly as TabularReviewView does for a standalone review. The popup
     * opens immediately and the "ask …" line fills in when the roster
     * answers; a refusal that names nobody is a dead end.
     */
    const [ownerOnlyAction, setOwnerOnlyAction] = useState<{
        reviewId: string;
        action: string;
        requiredRole: "owner" | "editor";
    } | null>(null);
    const [contactsByReviewId, setContactsByReviewId] = useState<
        Record<string, AccessContact[]>
    >({});
    const [selectionCameFromSelectAll, setSelectionCameFromSelectAll] =
        useState(false);
    const [confirmDeleteAllOpen, setConfirmDeleteAllOpen] = useState(false);
    const [bulkDeleteNotice, setBulkDeleteNotice] = useState<string | null>(
        null,
    );
    const [deletingReviewIds, setDeletingReviewIds] = useState<Set<string>>(
        () => new Set(),
    );
    const actionsRef = useRef<HTMLDivElement>(null);
    const { user } = useAuth();
    const previewEmptyStates = searchParams.get("emptyStates") === "1";
    const effectiveLoading = loading && !previewEmptyStates;
    const visibleReviews = useMemo(
        () => (previewEmptyStates ? [] : reviews),
        [previewEmptyStates, reviews],
    );

    useEffect(() => {
        let cancelled = false;
        void listProjects()
            .then((loadedProjects) => {
                if (!cancelled) setProjects(loadedProjects);
            })
            .catch(() => {
                if (!cancelled) setProjects([]);
            });
        return () => {
            cancelled = true;
        };
    }, []);

    function handleLoadMore() {
        void loadMore();
    }

    function handleScroll(event: React.UIEvent<HTMLDivElement>) {
        if (loading || loadingMore || !hasMore) return;
        const el = event.currentTarget;
        const distanceToBottom =
            el.scrollHeight - el.scrollTop - el.clientHeight;
        if (distanceToBottom < 200) void loadMore();
    }

    useEffect(() => {
        function handleClick(e: MouseEvent) {
            if (
                actionsRef.current &&
                !actionsRef.current.contains(e.target as Node)
            ) {
                setActionsOpen(false);
            }
        }
        if (actionsOpen) document.addEventListener("mousedown", handleClick);
        return () => document.removeEventListener("mousedown", handleClick);
    }, [actionsOpen]);

    const projectNameById = useMemo(
        () => new Map(projects.map((project) => [project.id, project.name])),
        [projects],
    );
    const filtered = visibleReviews;

    const allSelected =
        filtered.length > 0 &&
        filtered.every((r) => selectedIds.includes(r.id));
    const someSelected =
        !allSelected && filtered.some((r) => selectedIds.includes(r.id));

    function toggleAll() {
        if (allSelected) {
            setSelectedIds([]);
            setSelectionCameFromSelectAll(false);
        } else {
            setSelectionCameFromSelectAll(true);
            void selectAllMatching();
        }
    }

    function toggleOne(id: string) {
        setSelectedIds((prev) =>
            prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
        );
    }

    function clearSelection() {
        setSelectedIds([]);
        setSelectionCameFromSelectAll(false);
        setConfirmDeleteAllOpen(false);
        setActionsOpen(false);
    }

    function handleProjectFilterChange(value: string | null) {
        setProjectFilter(value);
        clearSelection();
    }

    function handleSortChange(
        key: ReviewSortKey,
        direction: TableSortDirection | null,
    ) {
        setSort(direction ? { key, direction } : null);
        clearSelection();
    }

    const handleNewReview = async (
        title: string,
        projectId: string | undefined,
        documentIds: string[] | undefined,
        columnsConfig:
            | import("@/app/components/shared/types").ColumnConfig[]
            | null
            | undefined,
        documentGrouping: "document" | "folder" | undefined,
        model: string,
        accessAssignments: {
            email: string;
            role: import("@/app/lib/mikeApi").AccessAssignmentRole;
        }[],
    ): Promise<string | void> => {
        setCreating(true);
        try {
            // A grant that fails after the review exists used to throw out of
            // here, so the modal said "Could not create the review." and a
            // second Create made a SECOND review. The created row is held
            // until the modal closes, so a retry re-runs only the grants.
            const review =
                createdReviewRef.current ??
                (await createTabularReview({
                    title,
                    document_ids: documentIds ?? [],
                    columns_config: columnsConfig ?? [],
                    document_grouping: documentGrouping,
                    model,
                    ...(projectId && { project_id: projectId }),
                }));
            createdReviewRef.current = review;

            // Sequential, one try per recipient: these are a handful of
            // addresses, and one refusal should be reported with its own
            // message rather than losing the others. The endpoint upserts,
            // so retrying after a partial failure is safe.
            const grantFailures: { email: string; detail: string }[] = [];
            for (const assignment of accessAssignments) {
                try {
                    await grantTabularReviewAccess(
                        review.id,
                        assignment.email,
                        assignment.role,
                    );
                } catch (error: unknown) {
                    grantFailures.push({
                        email: assignment.email,
                        detail: userFacingApiError(error, "the request failed"),
                    });
                }
            }
            if (grantFailures.length > 0) {
                // The review exists, so say so — and stay on the dialog rather
                // than navigating away from the only place that knows the
                // sharing did not happen. Same wording as NewProjectModal.
                return `Review created, but access was not granted to ${grantFailures
                    .map((failure) => failure.email)
                    .join(", ")}: ${grantFailures[0].detail}`;
            }

            // Handed over: the navigation below shows the review, so the
            // dialog's close must not ask the list to refetch for it.
            createdReviewRef.current = null;
            router.push(
                projectId
                    ? `/projects/${projectId}/tabular-reviews/${review.id}`
                    : `/tabular-reviews/${review.id}`,
            );
        } finally {
            setCreating(false);
        }
    };

    /**
     * Refuse an action on one review, and make sure the popup can say who to
     * ask. The roster is fetched once per review and cached, so repeated
     * refusals on the same row cost nothing.
     */
    function refuse(
        reviewId: string,
        action: string,
        requiredRole: "owner" | "editor" = "owner",
    ) {
        setOwnerOnlyAction({ reviewId, action, requiredRole });
        if (contactsByReviewId[reviewId]) return;
        void getTabularReviewPeople(reviewId)
            .then((people) => {
                setContactsByReviewId((prev) => ({
                    ...prev,
                    [reviewId]: people.owner ? [people.owner] : [],
                }));
            })
            .catch(() => {
                // A roster we cannot read just means no name to offer; the
                // refusal itself still stands.
                setContactsByReviewId((prev) => ({ ...prev, [reviewId]: [] }));
            });
    }

    function requestReviewDetails(review: TabularReview) {
        // The overview RPC now returns each row's merged access_role. Details
        // editing is member-tier — the server's PATCH asks for content.edit —
        // so the refusal must say "member", not "admin" (the review page and
        // this list previously disagreed about the same action).
        if (!can(roleFrom(review), "content.edit")) {
            refuse(review.id, "edit tabular review details", "editor");
            return;
        }
        setDetailsReview(review);
    }

    async function handleDetailsSave(values: {
        title: string;
        projectId?: string | null;
    }) {
        if (!detailsReview) return;
        if (!can(roleFrom(detailsReview), "content.edit")) {
            refuse(detailsReview.id, "edit tabular review details", "editor");
            return;
        }
        const updated = await updateTabularReview(detailsReview.id, {
            title: values.title,
            project_id: values.projectId ?? null,
        });
        setReviews((prev) =>
            prev.map((review) =>
                review.id === updated.id ? { ...review, ...updated } : review,
            ),
        );
        setDetailsReview((current) =>
            current?.id === updated.id ? { ...current, ...updated } : current,
        );
    }

    function requestDeleteSelected() {
        setActionsOpen(false);
        if (selectionCameFromSelectAll) {
            setConfirmDeleteAllOpen(true);
            return;
        }
        void handleDeleteSelected();
    }

    async function handleDeleteSelected() {
        const ids = [...selectedIds];
        setActionsOpen(false);
        setConfirmDeleteAllOpen(false);
        setSelectionCameFromSelectAll(false);
        setBulkDeleteNotice(null);
        // Prefer the loaded row's role; select-all-matching can hand back
        // ids that were never paged in, and for those the creator id is the
        // only signal available.
        const roleById = new Map(
            reviews.map((review) => [review.id, roleFrom(review)] as const),
        );
        const owned = ids.filter((id) => {
            const role = roleById.get(id);
            if (role) return can(role, "container.delete");
            // Fail closed on rows we could not load. `!user?.id ||` made an
            // unknown viewer identity pass every creator check, so a signed-in
            // state that had not settled yet turned select-all-matching into
            // "delete everything selected". Both halves must be known and
            // must match; anything else is counted as blocked and reported.
            const ownerId = getReviewOwnerId(id);
            return !!ownerId && !!user?.id && ownerId === user.id;
        });
        const blocked = ids.length - owned.length;
        setSelectedIds([]);
        const snapshot = reviews;
        setReviews((current) =>
            current.filter((review) => !owned.includes(review.id)),
        );
        const { failedIds } =
            await deleteTabularReviewsWithConcurrency(
                owned,
                deleteTabularReview,
            );
        setSelectedIds(failedIds);
        if (failedIds.length > 0) {
            setReviews((current) =>
                restoreOptimisticallyDeletedRows(current, snapshot, failedIds),
            );
        }
        const notices = [
            blocked > 0
                ? `${blocked} selected review${blocked === 1 ? " was" : "s were"} skipped because only a review owner can delete them.`
                : null,
            failedIds.length > 0
                ? `${failedIds.length} review${failedIds.length === 1 ? " was" : "s were"} not deleted because the request failed. ${failedIds.length === 1 ? "It remains" : "They remain"} selected so you can try again.`
                : null,
        ].filter((notice): notice is string => notice !== null);
        if (notices.length > 0) setBulkDeleteNotice(notices.join(" "));
    }

    async function handleDeleteReviewRow(review: TabularReview) {
        if (!can(roleFrom(review), "container.delete")) {
            refuse(review.id, "delete this tabular review");
            return;
        }
        const snapshot = reviews;
        setDeletingReviewIds((current) => new Set(current).add(review.id));
        setReviews((current) =>
            current.filter((candidate) => candidate.id !== review.id),
        );
        try {
            await deleteTabularReview(review.id);
        } catch (error) {
            setReviews((current) =>
                restoreOptimisticallyDeletedRows(current, snapshot, [review.id]),
            );
            throw error;
        } finally {
            setDeletingReviewIds((current) => {
                const next = new Set(current);
                next.delete(review.id);
                return next;
            });
        }
    }

    const projectFilterButton = (
        <TableFilters
            label="Filter by project"
            value={projectFilter}
            allLabel="All Projects"
            options={projects.map((project) => ({
                value: project.id,
                label: project.name,
            }))}
            onChange={handleProjectFilterChange}
        />
    );
    const nameSortDirection = sort?.key === "name" ? sort.direction : null;
    const columnsSortDirection =
        sort?.key === "columns" ? sort.direction : null;
    const documentsSortDirection =
        sort?.key === "documents" ? sort.direction : null;
    const createdSortDirection =
        sort?.key === "created" ? sort.direction : null;
    const nameFilterButton = (
        <TableFilters
            label="Sort by review name"
            value={nameSortDirection}
            allLabel="Default Order"
            widthClassName="w-40"
            align="right"
            options={SORT_OPTIONS}
            onChange={(direction) => handleSortChange("name", direction)}
        />
    );
    const columnsFilterButton = (
        <TableFilters
            label="Sort by columns"
            value={columnsSortDirection}
            allLabel="Default Order"
            widthClassName="w-40"
            options={SORT_OPTIONS}
            onChange={(direction) => handleSortChange("columns", direction)}
        />
    );
    const documentsFilterButton = (
        <TableFilters
            label="Sort by documents"
            value={documentsSortDirection}
            allLabel="Default Order"
            widthClassName="w-40"
            options={SORT_OPTIONS}
            onChange={(direction) => handleSortChange("documents", direction)}
        />
    );
    const createdFilterButton = (
        <TableFilters
            label="Sort by created date"
            value={createdSortDirection}
            allLabel="Default Order"
            widthClassName="w-40"
            options={SORT_OPTIONS}
            onChange={(direction) => handleSortChange("created", direction)}
        />
    );

    const toolbarActions =
        selectedIds.length > 0 ? (
            <div ref={actionsRef} className="relative">
                <TabPillButton onClick={() => setActionsOpen((v) => !v)}>
                    Actions
                    <ChevronDown className="h-3.5 w-3.5" />
                </TabPillButton>
                {actionsOpen && (
                    <LiquidDropdownSurface className="absolute top-full right-0 mt-1 z-[100] w-36 overflow-hidden">
                        <button
                            onClick={requestDeleteSelected}
                            className="w-full px-3 py-1.5 text-left text-xs text-red-600 transition-colors hover:bg-red-500/10"
                        >
                            Delete
                        </button>
                    </LiquidDropdownSurface>
                )}
            </div>
        ) : undefined;

    return (
        <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
            {/* Page header */}
            <PageHeader
                loading={loading}
                actions={[
                    {
                        type: "search",
                        value: search,
                        onChange: setSearch,
                        placeholder: "Search reviews…",
                    },
                    {
                        type: "new",
                        onClick: () => setNewTROpen(true),
                        loading: creating,
                        title: "New tabular review",
                    },
                ]}
            >
                <h1 className="text-2xl font-medium font-serif text-gray-900">
                    Tabular Reviews
                </h1>
            </PageHeader>

            <TableToolbar
                items={REVIEW_SCOPES}
                active={activeScope}
                onChange={(scope) => {
                    setActiveScope(scope);
                    clearSelection();
                }}
                actions={toolbarActions}
            />

            {/* Table */}
            <TableScrollArea
                onScroll={handleScroll}
                header={
                    <TableHeaderRow>
                        <TableStickyCell header>
                            {effectiveLoading ? (
                                <SkeletonCheckbox />
                            ) : (
                                <input
                                    type="checkbox"
                                    checked={allSelected}
                                    disabled={
                                        selectingAll ||
                                        deletingReviewIds.size > 0
                                    }
                                    ref={(el) => {
                                        if (el) el.indeterminate = someSelected;
                                    }}
                                    onChange={toggleAll}
                                    className={TABLE_CHECKBOX_CLASS}
                                    aria-label="Select all reviews"
                                />
                            )}
                            <span className="mr-1">Name</span>
                            {!loading && nameFilterButton}
                        </TableStickyCell>
                        <TableHeaderCell className="ml-auto w-24">
                            <div className="flex items-center gap-1">
                                <span>Columns</span>
                                {!loading && columnsFilterButton}
                            </div>
                        </TableHeaderCell>
                        <TableHeaderCell className="w-24">
                            <div className="flex items-center gap-1">
                                <span>Documents</span>
                                {!loading && documentsFilterButton}
                            </div>
                        </TableHeaderCell>
                        <TableHeaderCell className="w-52">
                            <div className="flex items-center gap-1">
                                <span>Project</span>
                                {!loading && projectFilterButton}
                            </div>
                        </TableHeaderCell>
                        <TableHeaderCell className="w-32">
                            <div className="flex items-center gap-1">
                                <span>Created</span>
                                {!loading && createdFilterButton}
                            </div>
                        </TableHeaderCell>
                        <TableHeaderCell className="w-8" />
                    </TableHeaderRow>
                }
            >
                {effectiveLoading ? (
                    <TableBody>
                        {[1, 2, 3].map((i) => (
                            <TableRow key={i} interactive={false}>
                                <TableStickyCell
                                    hover={false}
                                    bgClassName="bg-transparent"
                                >
                                    <SkeletonCheckbox />
                                    <SkeletonLine className="h-3.5 w-48" />
                                </TableStickyCell>
                                <TableCell className="ml-auto w-24">
                                    <SkeletonLine className="w-8" />
                                </TableCell>
                                <TableCell className="w-24">
                                    <SkeletonLine className="w-8" />
                                </TableCell>
                                <TableCell className="w-52">
                                    <SkeletonLine className="w-24" />
                                </TableCell>
                                <TableCell className="w-32">
                                    <SkeletonLine className="w-20" />
                                </TableCell>
                                <TableCell className="w-8" />
                            </TableRow>
                        ))}
                    </TableBody>
                ) : loadError ? (
                    <TableEmptyState>
                        <p className="text-lg font-medium font-serif text-gray-900">
                            Unable to load reviews
                        </p>
                        <p className="mt-1 text-xs text-gray-400">
                            Check your connection and try again.
                        </p>
                        <PillButton
                            tone="black"
                            size="sm"
                            onClick={retry}
                            className="mt-4"
                        >
                            Try again
                        </PillButton>
                    </TableEmptyState>
                ) : filtered.length === 0 ? (
                    <TableEmptyState>
                        {activeScope === "all" &&
                        !projectFilter &&
                        !debouncedSearch ? (
                            <>
                                <TabularReviewSkeuoIcon className="mb-4 h-8 w-8" />
                                <p className="text-2xl font-medium font-serif text-gray-900">
                                    Tabular Reviews
                                </p>
                                <p className="mt-1 text-xs text-gray-400 max-w-xs text-left">
                                    Extract data from documents into tables
                                    using AI.
                                </p>
                                <PillButton
                                    tone="black"
                                    size="sm"
                                    onClick={() => setNewTROpen(true)}
                                    disabled={creating}
                                    className="mt-4"
                                >
                                    Create
                                </PillButton>
                            </>
                        ) : (
                            <p className="text-sm text-gray-400">
                                No reviews found
                            </p>
                        )}
                    </TableEmptyState>
                ) : (
                    <TableBody>
                        {filtered.map((review) => {
                            const projectName = review.project_id
                                ? projectNameById.get(review.project_id)
                                : null;
                            const deleting = deletingReviewIds.has(review.id);
                            const actionIds = rowActionSelectionIds(
                                review.id,
                                selectedIds,
                            );
                            const appliesToSelection = actionIds.length > 1;
                            return (
                                <TableRow
                                    key={review.id}
                                    interactive={!deleting}
                                    selected={
                                        !deleting &&
                                        selectedIds.includes(review.id)
                                    }
                                    rightClickDropdown={
                                        deleting
                                            ? undefined
                                            : (close, menuProps) => (
                                                  <RowActionMenuItems
                                                      onClose={close}
                                                      surfaceProps={menuProps}
                                                      onView={
                                                          appliesToSelection
                                                              ? undefined
                                                              : () =>
                                                                    router.push(
                                                                        review.project_id
                                                                            ? `/projects/${review.project_id}/tabular-reviews/${review.id}`
                                                                            : `/tabular-reviews/${review.id}`,
                                                                    )
                                                      }
                                                      viewLabel="Open"
                                                      onEditDetails={
                                                          appliesToSelection
                                                              ? undefined
                                                              : () => {
                                                                    requestReviewDetails(
                                                                        review,
                                                                    );
                                                                }
                                                      }
                                                      onDelete={() =>
                                                          appliesToSelection
                                                              ? requestDeleteSelected()
                                                              : handleDeleteReviewRow(
                                                                    review,
                                                                )
                                                      }
                                                      deleteLabel={
                                                          appliesToSelection
                                                              ? `Delete ${actionIds.length} reviews`
                                                              : undefined
                                                      }
                                                  />
                                              )
                                    }
                                    onClick={
                                        deleting
                                            ? undefined
                                            : () => {
                                                  router.push(
                                                      review.project_id
                                                          ? `/projects/${review.project_id}/tabular-reviews/${review.id}`
                                                          : `/tabular-reviews/${review.id}`,
                                                  );
                                              }
                                    }
                                    className={
                                        deleting
                                            ? "pointer-events-none opacity-50"
                                            : undefined
                                    }
                                >
                                    <TablePrimaryCell
                                                selected={
                                                    !deleting &&
                                                    selectedIds.includes(
                                                        review.id,
                                                    )
                                                }
                                        selectionIndicator={
                                            deleting ? (
                                                <Loader2 className="mr-4 h-3 w-3 shrink-0 animate-spin text-gray-400" />
                                            ) : undefined
                                        }
                                        onSelectionChange={() =>
                                            toggleOne(review.id)
                                        }
                                        label={
                                            review.title ?? "Untitled Review"
                                        }
                                    />
                                    <TableCell className="ml-auto w-24">
                                        {review.columns_config?.length ?? 0}
                                    </TableCell>
                                    <TableCell className="w-24">
                                        {review.document_count ?? 0}
                                    </TableCell>
                                    <TableCell className="w-52 pr-2">
                                        {projectName ? (
                                            projectName
                                        ) : (
                                            <span className="text-gray-300">
                                                —
                                            </span>
                                        )}
                                    </TableCell>
                                    <TableCell className="w-32">
                                        {review.created_at ? (
                                            formatDate(review.created_at)
                                        ) : (
                                            <span className="text-gray-300">
                                                —
                                            </span>
                                        )}
                                    </TableCell>
                                    <div
                                        className="w-8 shrink-0 flex justify-end"
                                        onClick={(e) => e.stopPropagation()}
                                    >
                                        <RowActions
                                            onView={() =>
                                                router.push(
                                                    review.project_id
                                                        ? `/projects/${review.project_id}/tabular-reviews/${review.id}`
                                                        : `/tabular-reviews/${review.id}`,
                                                )
                                            }
                                            viewLabel="Open"
                                            onEditDetails={() => {
                                                requestReviewDetails(review);
                                            }}
                                            onDelete={() =>
                                                handleDeleteReviewRow(review)
                                            }
                                        />
                                    </div>
                                </TableRow>
                            );
                        })}
                    </TableBody>
                )}
                <TableLoadMoreRow
                    loading={effectiveLoading}
                    hasMore={hasMore}
                    itemCount={filtered.length}
                    loadingMore={loadingMore}
                    hasError={!!loadMoreError}
                    onLoadMore={handleLoadMore}
                />
            </TableScrollArea>

            <NewTRModal
                open={newTROpen}
                onClose={() => {
                    // The dialog's own reset runs through here, so this is the
                    // one place that has to forget the held review.
                    //
                    // A review created behind a refused grant never reached
                    // the list — the page only adds it on the navigation that
                    // a successful create performs — so refetch on the way out
                    // instead of leaving it invisible until a reload.
                    const createdWithoutHandover =
                        createdReviewRef.current !== null;
                    createdReviewRef.current = null;
                    setNewTROpen(false);
                    if (createdWithoutHandover) retry();
                }}
                onAdd={handleNewReview}
                projects={projects}
            />

            <TabularReviewDetailsModal
                open={!!detailsReview}
                review={detailsReview}
                projects={projects}
                canEdit={
                    !!detailsReview &&
                    can(roleFrom(detailsReview), "content.edit")
                }
                onClose={() => setDetailsReview(null)}
                onSave={handleDetailsSave}
            />

            <PermissionDeniedPopup
                open={!!ownerOnlyAction}
                action={ownerOnlyAction?.action}
                requiredRole={ownerOnlyAction?.requiredRole}
                contacts={
                    ownerOnlyAction
                        ? contactsByReviewId[ownerOnlyAction.reviewId]
                        : null
                }
                onClose={() => setOwnerOnlyAction(null)}
            />
            <WarningPopup
                open={!!bulkDeleteNotice}
                title="Some reviews were not deleted"
                message={bulkDeleteNotice}
                onClose={() => setBulkDeleteNotice(null)}
            />
            <ConfirmPopup
                open={confirmDeleteAllOpen && selectedIds.length > 0}
                title="Delete all selected reviews?"
                message={`This will permanently delete every selected review you administer, including selected reviews not currently shown. Their review results and associated data will also be deleted. Reviews you cannot delete will be skipped. ${selectedIds.length} reviews are selected.`}
                confirmLabel="Delete"
                confirmVariant="danger"
                onCancel={() => setConfirmDeleteAllOpen(false)}
                onConfirm={() => void handleDeleteSelected()}
            />
        </div>
    );
}
