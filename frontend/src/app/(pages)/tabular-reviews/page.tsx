"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Loader2, ChevronDown, Check, Table2 } from "lucide-react";
import { HeaderSearchBtn } from "@/app/components/shared/HeaderSearchBtn";
import { RowActions } from "@/app/components/shared/RowActions";
import {
    deleteTabularReview,
    listTabularReviews,
    createTabularReview,
    listProjects,
    updateTabularReview,
} from "@/app/lib/mikeApi";
import type { TabularReview, MikeProject } from "@/app/components/shared/types";
import { ToolbarTabs } from "@/app/components/shared/ToolbarTabs";
import { AddNewTRModal } from "@/app/components/tabular/AddNewTRModal";
import { OwnerOnlyModal } from "@/app/components/shared/OwnerOnlyModal";
import { useAuth } from "@/app/contexts/AuthContext";

type Tab = "all" | "in-project" | "standalone";

const CHECK_W = "w-8 shrink-0";
const NAME_COL_W = "w-[300px] shrink-0";

const TABS: { id: Tab; label: string }[] = [
    { id: "all", label: "All Reviews" },
    { id: "in-project", label: "In Project" },
    { id: "standalone", label: "Standalone" },
];

function formatDate(iso: string) {
    return new Date(iso).toLocaleDateString(undefined, {
        day: "numeric",
        month: "short",
        year: "numeric",
    });
}

export default function TabularReviewsPage() {
    const [reviews, setReviews] = useState<TabularReview[]>([]);
    const [projects, setProjects] = useState<MikeProject[]>([]);
    const [loading, setLoading] = useState(true);
    const [creating, setCreating] = useState(false);
    const [newTROpen, setNewTROpen] = useState(false);
    const [activeTab, setActiveTab] = useState<Tab>("all");
    const [renamingId, setRenamingId] = useState<string | null>(null);
    const [renameValue, setRenameValue] = useState("");
    const [projectFilter, setProjectFilter] = useState<string | null>(null);
    const [filterOpen, setFilterOpen] = useState(false);
    const [search, setSearch] = useState("");
    const [selectedIds, setSelectedIds] = useState<string[]>([]);
    const [actionsOpen, setActionsOpen] = useState(false);
    const [ownerOnlyAction, setOwnerOnlyAction] = useState<string | null>(null);
    const filterRef = useRef<HTMLDivElement>(null);
    const actionsRef = useRef<HTMLDivElement>(null);
    const router = useRouter();
    const { user } = useAuth();

    useEffect(() => {
        Promise.all([
            listTabularReviews().catch(() => []),
            listProjects().catch(() => []),
        ])
            .then(([r, p]) => {
                setReviews(r);
                setProjects(p);
            })
            .finally(() => setLoading(false));
    }, []);

    useEffect(() => {
        setSelectedIds([]);
    }, [activeTab, projectFilter]);

    useEffect(() => {
        function handleClick(e: MouseEvent) {
            if (filterRef.current && !filterRef.current.contains(e.target as Node)) setFilterOpen(false);
        }
        document.addEventListener("mousedown", handleClick);
        return () => document.removeEventListener("mousedown", handleClick);
    }, []);

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

    const q = search.toLowerCase();
    const filtered = reviews
        .filter((r) => {
            if (activeTab === "in-project") return !!r.project_id;
            if (activeTab === "standalone") return !r.project_id;
            return true;
        })
        .filter((r) => !projectFilter || r.project_id === projectFilter)
        .filter((r) => !q || (r.title ?? "").toLowerCase().includes(q));

    const allSelected =
        filtered.length > 0 &&
        filtered.every((r) => selectedIds.includes(r.id));
    const someSelected =
        !allSelected && filtered.some((r) => selectedIds.includes(r.id));

    function toggleAll() {
        if (allSelected) setSelectedIds([]);
        else setSelectedIds(filtered.map((r) => r.id));
    }

    function toggleOne(id: string) {
        setSelectedIds((prev) =>
            prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
        );
    }

    const selectedProject = projects.find((p) => p.id === projectFilter);

    const handleNewReview = async (
        title: string,
        projectId?: string,
        documentIds?: string[],
        columnsConfig?:
            | import("@/app/components/shared/types").ColumnConfig[]
            | null,
    ) => {
        setCreating(true);
        try {
            const review = await createTabularReview({
                title,
                document_ids: documentIds ?? [],
                columns_config: columnsConfig ?? [],
                ...(projectId && { project_id: projectId }),
            });
            router.push(
                projectId
                    ? `/projects/${projectId}/tabular-reviews/${review.id}`
                    : `/tabular-reviews/${review.id}`,
            );
        } finally {
            setCreating(false);
        }
    };

    async function handleRenameSubmit(reviewId: string) {
        const trimmed = renameValue.trim();
        if (!trimmed) {
            setRenamingId(null);
            return;
        }
        const review = reviews.find((r) => r.id === reviewId);
        if (review && user?.id && review.user_id !== user.id) {
            setRenamingId(null);
            setOwnerOnlyAction("rename this tabular review");
            return;
        }
        setReviews((prev) =>
            prev.map((r) => (r.id === reviewId ? { ...r, title: trimmed } : r)),
        );
        setRenamingId(null);
        await updateTabularReview(reviewId, { title: trimmed });
    }

    async function handleDeleteSelected() {
        const ids = [...selectedIds];
        setActionsOpen(false);
        const owned = ids.filter((id) => {
            const r = reviews.find((rr) => rr.id === id);
            return !r || !user?.id || r.user_id === user.id;
        });
        const blocked = ids.length - owned.length;
        setSelectedIds([]);
        await Promise.all(
            owned.map((id) => deleteTabularReview(id).catch(() => {})),
        );
        setReviews((prev) => prev.filter((r) => !owned.includes(r.id)));
        if (blocked > 0) {
            setOwnerOnlyAction(
                `delete ${blocked} of the selected reviews — only the review creator can delete a review`,
            );
        }
    }

    const projectFilterButton = (
        <div className="relative" ref={filterRef}>
            <button
                onClick={() => setFilterOpen((o) => !o)}
                className={`flex items-center gap-1 text-xs font-medium transition-colors ${
                    projectFilter
                        ? "text-gray-700 hover:text-gray-900"
                        : "text-gray-500 hover:text-gray-700"
                }`}
            >
                {selectedProject ? selectedProject.name : "Filter by project"}
                <ChevronDown className="h-3 w-3" />
            </button>
            {filterOpen && (
                <div className="absolute right-0 top-full mt-1.5 z-20 w-52 rounded-xl border border-gray-100 bg-white shadow-lg overflow-hidden">
                    <button
                        onClick={() => {
                            setProjectFilter(null);
                            setFilterOpen(false);
                        }}
                        className="flex items-center justify-between w-full px-3 py-2 text-xs text-gray-600 hover:bg-gray-50 transition-colors"
                    >
                        All Projects
                        {!projectFilter && (
                            <Check className="h-3.5 w-3.5 text-gray-400" />
                        )}
                    </button>
                    {projects.length > 0 && (
                        <div className="border-t border-gray-100" />
                    )}
                    {projects.map((p) => (
                        <button
                            key={p.id}
                            onClick={() => {
                                setProjectFilter(p.id);
                                setFilterOpen(false);
                            }}
                            className="flex items-center justify-between w-full px-3 py-2 text-xs text-gray-600 hover:bg-gray-50 transition-colors"
                        >
                            <span className="truncate pr-2">{p.name}</span>
                            {projectFilter === p.id && (
                                <Check className="h-3.5 w-3.5 shrink-0 text-gray-400" />
                            )}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );

    const toolbarActions = (
        <div className="flex items-center gap-2">
            {selectedIds.length > 0 && (
                <div ref={actionsRef} className="relative">
                    <button
                        onClick={() => setActionsOpen((v) => !v)}
                        className="flex items-center gap-1 text-xs font-medium text-gray-700 hover:text-gray-900 transition-colors"
                    >
                        Actions
                        <ChevronDown className="h-3.5 w-3.5" />
                    </button>
                    {actionsOpen && (
                        <div className="absolute top-full right-0 mt-1 w-36 rounded-lg border border-gray-100 bg-white shadow-lg z-50 overflow-hidden">
                            <button
                                onClick={handleDeleteSelected}
                                className="w-full px-3 py-1.5 text-left text-xs text-red-600 hover:bg-red-50 transition-colors"
                            >
                                Delete
                            </button>
                        </div>
                    )}
                </div>
            )}
            {projectFilterButton}
        </div>
    );

    return (
        <div className="flex-1 overflow-y-auto bg-white">
            {/* Page header */}
            <div className="flex items-center justify-between px-8 py-4">
                <h1 className="text-2xl font-medium font-serif text-gray-900">
                    Tabular Reviews
                </h1>
                <div className="flex items-center gap-2">
                    <HeaderSearchBtn value={search} onChange={setSearch} placeholder="Search reviews…" />
                    <button
                        onClick={() => setNewTROpen(true)}
                        disabled={creating}
                        className="flex items-center justify-center p-1.5 text-gray-500 hover:text-gray-900 transition-colors disabled:opacity-40"
                    >
                        {creating ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                            <Plus className="h-4 w-4" />
                        )}
                    </button>
                </div>
            </div>

            <ToolbarTabs
                tabs={TABS}
                active={activeTab}
                onChange={setActiveTab}
                actions={toolbarActions}
            />

            {/* Table */}
            <div className="w-full overflow-x-auto">
                <div className="min-w-max">
                <div className="flex items-center h-8 pr-8 border-b border-gray-200 text-xs text-gray-500 font-medium select-none">
                    <div className={`sticky left-0 z-[60] ${CHECK_W} relative bg-white flex items-center justify-center self-stretch before:absolute before:inset-x-0 before:bottom-0 before:h-px before:bg-white`}>
                        {!loading && (
                            <input
                                type="checkbox"
                                checked={allSelected}
                                ref={(el) => {
                                    if (el) el.indeterminate = someSelected;
                                }}
                                onChange={toggleAll}
                                className="h-2.5 w-2.5 rounded border-gray-200 cursor-pointer accent-black"
                            />
                        )}
                    </div>
                    <div className={`sticky left-8 z-[60] ${NAME_COL_W} bg-white pl-2 text-left`}>
                        Name
                    </div>
                    <div className="ml-auto w-24 shrink-0">Columns</div>
                    <div className="w-24 shrink-0">Documents</div>
                    <div className="w-40 shrink-0">Project</div>
                    <div className="w-32 shrink-0">Created</div>
                    <div className="w-8 shrink-0" />
                </div>

                {loading ? (
                    <div>
                        {[1, 2, 3].map((i) => (
                            <div
                                key={i}
                                className="flex items-center h-10 pr-8 border-b border-gray-50"
                            >
                                <div className="w-8 shrink-0" />
                                <div className="flex-1 min-w-0 pl-3 pr-4">
                                    <div className="h-3.5 w-48 rounded bg-gray-100 animate-pulse" />
                                </div>
                                <div className="w-24 shrink-0">
                                    <div className="h-3 w-8 rounded bg-gray-100 animate-pulse" />
                                </div>
                                <div className="w-24 shrink-0">
                                    <div className="h-3 w-8 rounded bg-gray-100 animate-pulse" />
                                </div>
                                <div className="w-40 shrink-0">
                                    <div className="h-3 w-24 rounded bg-gray-100 animate-pulse" />
                                </div>
                                <div className="w-32 shrink-0">
                                    <div className="h-3 w-20 rounded bg-gray-100 animate-pulse" />
                                </div>
                                <div className="w-8 shrink-0" />
                            </div>
                        ))}
                    </div>
                ) : filtered.length === 0 ? (
                    <div className="flex flex-col items-start py-24 w-full max-w-xs mx-auto">
                        {activeTab === "all" && !projectFilter ? (
                            <>
                                <Table2 className="h-8 w-8 text-gray-300 mb-4" />
                                <p className="text-2xl font-medium font-serif text-gray-900">
                                    Tabular Reviews
                                </p>
                                <p className="mt-1 text-xs text-gray-400 max-w-xs text-left">
                                    Extract data from documents into tables
                                    using AI.
                                </p>
                                <button
                                    onClick={() => setNewTROpen(true)}
                                    disabled={creating}
                                    className="mt-4 inline-flex items-center gap-1 rounded-full bg-gray-900 px-3 py-1 text-xs font-medium text-white hover:bg-gray-700 transition-colors shadow-md disabled:opacity-40"
                                >
                                    + Create New
                                </button>
                            </>
                        ) : (
                            <p className="text-sm text-gray-400">
                                No reviews found
                            </p>
                        )}
                    </div>
                ) : (
                    <div>
                        {filtered.map((review) => {
                            const project = projects.find(
                                (p) => p.id === review.project_id,
                            );
                            const rowBg = selectedIds.includes(review.id)
                                ? "bg-gray-50"
                                : "bg-white";
                            return (
                                <div
                                    key={review.id}
                                    onClick={() => {
                                        if (renamingId === review.id) return;
                                        router.push(
                                            review.project_id
                                                ? `/projects/${review.project_id}/tabular-reviews/${review.id}`
                                                : `/tabular-reviews/${review.id}`,
                                        );
                                    }}
                                    className="group flex items-center h-10 pr-8 border-b border-gray-50 hover:bg-gray-50 cursor-pointer transition-colors"
                                >
                                    <div
                                        className={`sticky left-0 z-[60] ${CHECK_W} p-2 flex items-center justify-center ${rowBg} group-hover:bg-gray-50`}
                                        onClick={(e) => e.stopPropagation()}
                                    >
                                        <input
                                            type="checkbox"
                                            checked={selectedIds.includes(
                                                review.id,
                                            )}
                                            onChange={() =>
                                                toggleOne(review.id)
                                            }
                                            className="h-2.5 w-2.5 rounded border-gray-200 cursor-pointer accent-black"
                                        />
                                    </div>
                                    <div className={`sticky left-8 z-[60] ${NAME_COL_W} p-2 ${rowBg} group-hover:bg-gray-50`}>
                                        {renamingId === review.id ? (
                                            <input
                                                autoFocus
                                                value={renameValue}
                                                onChange={(e) =>
                                                    setRenameValue(
                                                        e.target.value,
                                                    )
                                                }
                                                onKeyDown={(e) => {
                                                    if (e.key === "Enter")
                                                        handleRenameSubmit(
                                                            review.id,
                                                        );
                                                    if (e.key === "Escape")
                                                        setRenamingId(null);
                                                }}
                                                onBlur={() =>
                                                    handleRenameSubmit(
                                                        review.id,
                                                    )
                                                }
                                                onClick={(e) =>
                                                    e.stopPropagation()
                                                }
                                                className="w-full text-sm text-gray-800 bg-transparent outline-none"
                                            />
                                        ) : (
                                            <span className="text-sm text-gray-800 truncate block">
                                                {review.title ??
                                                    "Untitled Review"}
                                            </span>
                                        )}
                                    </div>
                                    <div className="ml-auto w-24 shrink-0 text-sm text-gray-500 truncate">
                                        {review.columns_config?.length ?? 0}
                                    </div>
                                    <div className="w-24 shrink-0 text-sm text-gray-500 truncate">
                                        {review.document_count ?? 0}
                                    </div>
                                    <div className="w-40 shrink-0 text-sm text-gray-500 truncate pr-2">
                                        {project ? (
                                            project.name
                                        ) : (
                                            <span className="text-gray-300">
                                                —
                                            </span>
                                        )}
                                    </div>
                                    <div className="w-32 shrink-0 text-sm text-gray-500 truncate">
                                        {review.created_at ? (
                                            formatDate(review.created_at)
                                        ) : (
                                            <span className="text-gray-300">
                                                —
                                            </span>
                                        )}
                                    </div>
                                    <div
                                        className="w-8 shrink-0 flex justify-end"
                                        onClick={(e) => e.stopPropagation()}
                                    >
                                        <RowActions
                                            onRename={() => {
                                                if (
                                                    user?.id &&
                                                    review.user_id !== user.id
                                                ) {
                                                    setOwnerOnlyAction(
                                                        "rename this tabular review",
                                                    );
                                                    return;
                                                }
                                                setRenameValue(
                                                    review.title ??
                                                        "Untitled Review",
                                                );
                                                setRenamingId(review.id);
                                            }}
                                            onDelete={async () => {
                                                if (
                                                    user?.id &&
                                                    review.user_id !== user.id
                                                ) {
                                                    setOwnerOnlyAction(
                                                        "delete this tabular review",
                                                    );
                                                    return;
                                                }
                                                await deleteTabularReview(
                                                    review.id,
                                                );
                                                setReviews((prev) =>
                                                    prev.filter(
                                                        (r) =>
                                                            r.id !== review.id,
                                                    ),
                                                );
                                            }}
                                            />
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
            </div>

            <AddNewTRModal
                open={newTROpen}
                onClose={() => setNewTROpen(false)}
                onAdd={handleNewReview}
                projects={projects}
            />

            <OwnerOnlyModal
                open={!!ownerOnlyAction}
                action={ownerOnlyAction ?? undefined}
                onClose={() => setOwnerOnlyAction(null)}
            />
        </div>
    );
}
