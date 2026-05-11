"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
    Plus,
    Library,
    Table2,
    MessageSquare,
    User,
    ChevronDown,
    Check,
    Download,
} from "lucide-react";
import { HeaderSearchBtn } from "../shared/HeaderSearchBtn";
import {
    listWorkflows,
    deleteWorkflow,
    listHiddenWorkflows,
    hideWorkflow,
    unhideWorkflow,
} from "@/app/lib/mikeApi";
import type { MikeWorkflow } from "../shared/types";
import { BUILT_IN_WORKFLOWS, BUILT_IN_IDS } from "./builtinWorkflows";
import { DisplayWorkflowModal } from "./DisplayWorkflowModal";
import { NewWorkflowModal } from "./NewWorkflowModal";
import { UploadWorkflowButton } from "./UploadWorkflowButton";
import { downloadWorkflow } from "@/app/lib/workflowFile";
import { ToolbarTabs } from "../shared/ToolbarTabs";
import { RowActions } from "../shared/RowActions";
import { MikeIcon } from "@/components/chat/mike-icon";
import { useAuth } from "@/contexts/AuthContext";

type Tab = "all" | "builtin" | "custom" | "hidden";

const CHECK_W = "w-8 shrink-0";
const NAME_COL_W = "w-[300px] shrink-0";

const TABS: { id: Tab; label: string }[] = [
    { id: "all", label: "All Workflows" },
    { id: "builtin", label: "Built-in" },
    { id: "custom", label: "Custom" },
    { id: "hidden", label: "Hidden" },
];

export function WorkflowList() {
    const router = useRouter();
    const { user } = useAuth();
    const [custom, setCustom] = useState<MikeWorkflow[]>([]);
    const [loading, setLoading] = useState(true);
    const [selected, setSelected] = useState<MikeWorkflow | null>(null);
    const [activeTab, setActiveTab] = useState<Tab>("all");
    const [newModalOpen, setNewModalOpen] = useState(false);
    const [hiddenBuiltinIds, setHiddenBuiltinIds] = useState<string[]>([]);
    const [selectedIds, setSelectedIds] = useState<string[]>([]);
    const [actionsOpen, setActionsOpen] = useState(false);
    const [practiceFilter, setPracticeFilter] = useState<string | null>(null);
    const [practiceFilterOpen, setPracticeFilterOpen] = useState(false);
    const [typeFilter, setTypeFilter] = useState<MikeWorkflow["type"] | null>(
        null,
    );
    const [typeFilterOpen, setTypeFilterOpen] = useState(false);
    const [search, setSearch] = useState("");
    const actionsRef = useRef<HTMLDivElement>(null);
    const practiceFilterRef = useRef<HTMLDivElement>(null);
    const typeFilterRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        Promise.all([
            listWorkflows("assistant"),
            listWorkflows("tabular"),
            listHiddenWorkflows(),
        ])
            .then(([assistant, tabular, hidden]) => {
                setCustom([...assistant, ...tabular]);
                setHiddenBuiltinIds(hidden);
            })
            .catch(() => setCustom([]))
            .finally(() => setLoading(false));
    }, []);

    useEffect(() => {
        setSelectedIds([]);
        setActionsOpen(false);
    }, [activeTab, practiceFilter, typeFilter]);

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

    useEffect(() => {
        function handleClick(e: MouseEvent) {
            if (
                practiceFilterRef.current &&
                !practiceFilterRef.current.contains(e.target as Node)
            ) {
                setPracticeFilterOpen(false);
            }
            if (
                typeFilterRef.current &&
                !typeFilterRef.current.contains(e.target as Node)
            ) {
                setTypeFilterOpen(false);
            }
        }
        document.addEventListener("mousedown", handleClick);
        return () => document.removeEventListener("mousedown", handleClick);
    }, []);

    const hiddenBuiltins = BUILT_IN_WORKFLOWS.filter((wf) =>
        hiddenBuiltinIds.includes(wf.id),
    );
    const visibleBuiltins = BUILT_IN_WORKFLOWS.filter(
        (wf) => !hiddenBuiltinIds.includes(wf.id),
    );
    const all = [...visibleBuiltins, ...custom];
    const byTab =
        activeTab === "builtin"
            ? visibleBuiltins
            : activeTab === "custom"
              ? custom
              : activeTab === "hidden"
                ? hiddenBuiltins
                : all;
    const practices = Array.from(
        new Set(byTab.map((wf) => wf.practice).filter((p): p is string => !!p)),
    ).sort();
    const q = search.toLowerCase();
    const filtered = byTab
        .filter((wf) => !practiceFilter || wf.practice === practiceFilter)
        .filter((wf) => !typeFilter || wf.type === typeFilter)
        .filter((wf) => !q || wf.title.toLowerCase().includes(q));

    const allSelected =
        filtered.length > 0 &&
        filtered.every((wf) => selectedIds.includes(wf.id));
    const someSelected =
        !allSelected && filtered.some((wf) => selectedIds.includes(wf.id));

    function toggleAll() {
        if (allSelected) setSelectedIds([]);
        else setSelectedIds(filtered.map((wf) => wf.id));
    }

    function toggleOne(id: string) {
        setSelectedIds((prev) =>
            prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
        );
    }

    async function handleHideWorkflow(id: string) {
        setHiddenBuiltinIds((prev) => [...prev, id]);
        await hideWorkflow(id).catch(() => {
            setHiddenBuiltinIds((prev) => prev.filter((x) => x !== id));
        });
    }

    async function handleUnhideWorkflow(id: string) {
        setHiddenBuiltinIds((prev) => prev.filter((x) => x !== id));
        await unhideWorkflow(id).catch(() => {
            setHiddenBuiltinIds((prev) => [...prev, id]);
        });
    }

    async function handleBulkRemove() {
        const ids = [...selectedIds];
        setActionsOpen(false);
        setSelectedIds([]);
        const builtinIds = ids.filter((id) => BUILT_IN_IDS.has(id));
        const customIds = ids.filter((id) => !BUILT_IN_IDS.has(id));
        if (builtinIds.length > 0) {
            setHiddenBuiltinIds((prev) => [
                ...prev,
                ...builtinIds.filter((id) => !prev.includes(id)),
            ]);
            await Promise.all(
                builtinIds.map((id) => hideWorkflow(id).catch(() => {})),
            );
        }
        if (customIds.length > 0) {
            await Promise.all(
                customIds.map((id) => deleteWorkflow(id).catch(() => {})),
            );
            setCustom((prev) => prev.filter((w) => !customIds.includes(w.id)));
        }
    }

    async function handleBulkUnhide() {
        const ids = [...selectedIds];
        setActionsOpen(false);
        setSelectedIds([]);
        setHiddenBuiltinIds((prev) => prev.filter((id) => !ids.includes(id)));
        await Promise.all(ids.map((id) => unhideWorkflow(id).catch(() => {})));
    }

    const getTypeMeta = (type: MikeWorkflow["type"]) =>
        type === "tabular"
            ? { label: "Tabular", Icon: Table2, className: "text-violet-700" }
            : {
                  label: "Assistant",
                  Icon: MessageSquare,
                  className: "text-blue-700",
              };

    const typeFilterButton = (
        <div className="relative" ref={typeFilterRef}>
            <button
                onClick={() => setTypeFilterOpen((o) => !o)}
                className={`flex items-center gap-1 text-xs font-medium transition-colors ${
                    typeFilter
                        ? "text-gray-700 hover:text-gray-900"
                        : "text-gray-500 hover:text-gray-700"
                }`}
            >
                {typeFilter
                    ? typeFilter === "tabular"
                        ? "Tabular"
                        : "Assistant"
                    : "Filter by type"}
                <ChevronDown className="h-3 w-3" />
            </button>
            {typeFilterOpen && (
                <div className="absolute right-0 top-full mt-1.5 z-20 w-40 rounded-xl border border-gray-100 bg-white shadow-lg overflow-hidden">
                    <button
                        onClick={() => {
                            setTypeFilter(null);
                            setTypeFilterOpen(false);
                        }}
                        className="flex items-center justify-between w-full px-3 py-2 text-xs text-gray-600 hover:bg-gray-50 transition-colors"
                    >
                        All Types
                        {!typeFilter && (
                            <Check className="h-3.5 w-3.5 text-gray-400" />
                        )}
                    </button>
                    <div className="border-t border-gray-100" />
                    {(["assistant", "tabular"] as const).map((t) => {
                        const { label, Icon, className } = getTypeMeta(t);
                        return (
                            <button
                                key={t}
                                onClick={() => {
                                    setTypeFilter(t);
                                    setTypeFilterOpen(false);
                                }}
                                className="flex items-center justify-between w-full px-3 py-2 text-xs hover:bg-gray-50 transition-colors"
                            >
                                <span
                                    className={`inline-flex items-center gap-1.5 font-medium ${className}`}
                                >
                                    <Icon className="h-3.5 w-3.5" />
                                    {label}
                                </span>
                                {typeFilter === t && (
                                    <Check className="h-3.5 w-3.5 shrink-0 text-gray-400" />
                                )}
                            </button>
                        );
                    })}
                </div>
            )}
        </div>
    );

    const practiceFilterButton = (
        <div className="relative" ref={practiceFilterRef}>
            <button
                onClick={() => setPracticeFilterOpen((o) => !o)}
                className={`flex items-center gap-1 text-xs font-medium transition-colors ${
                    practiceFilter
                        ? "text-gray-700 hover:text-gray-900"
                        : "text-gray-500 hover:text-gray-700"
                }`}
            >
                {practiceFilter ?? "Filter by practice"}
                <ChevronDown className="h-3 w-3" />
            </button>
            {practiceFilterOpen && (
                <div className="absolute right-0 top-full mt-1.5 z-20 w-52 rounded-xl border border-gray-100 bg-white shadow-lg overflow-hidden">
                    <button
                        onClick={() => {
                            setPracticeFilter(null);
                            setPracticeFilterOpen(false);
                        }}
                        className="flex items-center justify-between w-full px-3 py-2 text-xs text-gray-600 hover:bg-gray-50 transition-colors"
                    >
                        All Practices
                        {!practiceFilter && (
                            <Check className="h-3.5 w-3.5 text-gray-400" />
                        )}
                    </button>
                    {practices.length > 0 && (
                        <div className="border-t border-gray-100" />
                    )}
                    {practices.map((p) => (
                        <button
                            key={p}
                            onClick={() => {
                                setPracticeFilter(p);
                                setPracticeFilterOpen(false);
                            }}
                            className="flex items-center justify-between w-full px-3 py-2 text-xs text-gray-600 hover:bg-gray-50 transition-colors"
                        >
                            <span className="truncate pr-2">{p}</span>
                            {practiceFilter === p && (
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
                            {activeTab === "hidden" ? (
                                <button
                                    onClick={handleBulkUnhide}
                                    className="w-full px-3 py-1.5 text-left text-xs text-gray-700 hover:bg-gray-50 transition-colors"
                                >
                                    Unhide
                                </button>
                            ) : (
                                <button
                                    onClick={handleBulkRemove}
                                    className="w-full px-3 py-1.5 text-left text-xs text-red-600 hover:bg-red-50 transition-colors"
                                >
                                    Delete
                                </button>
                            )}
                        </div>
                    )}
                </div>
            )}
            {typeFilterButton}
            {practiceFilterButton}
        </div>
    );

    return (
        <div className="flex flex-col flex-1 overflow-hidden bg-white">
            {/* Page header */}
            <div className="flex items-center justify-between px-8 py-4 shrink-0">
                <h1 className="text-2xl font-medium font-serif text-gray-900">
                    Workflows
                </h1>
                <div className="flex items-center gap-2">
                    <HeaderSearchBtn
                        value={search}
                        onChange={setSearch}
                        placeholder="Search workflows…"
                    />
                    <UploadWorkflowButton
                        onUploaded={(wf) => {
                            setCustom((prev) => [wf, ...prev]);
                        }}
                    />
                    <button
                        onClick={() => setNewModalOpen(true)}
                        className="flex items-center justify-center p-1.5 text-gray-500 hover:text-gray-900 transition-colors"
                    >
                        <Plus className="h-4 w-4" />
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
            <div className="flex-1 overflow-auto">
                <div className="min-w-max">
                    {/* Column headers */}
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
                        <div className="ml-auto w-28 shrink-0">Type</div>
                        <div className="w-40 shrink-0">Practice</div>
                        <div className="w-28 shrink-0">Source</div>
                        <div className="w-16 shrink-0" />
                    </div>

                    {loading && activeTab !== "builtin" ? (
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
                                    <div className="w-28 shrink-0">
                                        <div className="h-3 w-16 rounded bg-gray-100 animate-pulse" />
                                    </div>
                                    <div className="w-40 shrink-0">
                                        <div className="h-3 w-24 rounded bg-gray-100 animate-pulse" />
                                    </div>
                                    <div className="w-28 shrink-0">
                                        <div className="h-3 w-14 rounded bg-gray-100 animate-pulse" />
                                    </div>
                                    <div className="w-16 shrink-0" />
                                </div>
                            ))}
                        </div>
                    ) : filtered.length === 0 ? (
                        <div className="flex flex-col items-start py-24 w-full max-w-xs mx-auto">
                            {activeTab === "custom" ? (
                                <>
                                    <Library className="h-8 w-8 text-gray-300 mb-4" />
                                    <p className="text-2xl font-medium font-serif text-gray-900">
                                        Custom Workflows
                                    </p>
                                    <p className="mt-1 text-xs text-gray-400 text-left">
                                        Build reusable prompts and tabular
                                        review templates tailored to your
                                        practice.
                                    </p>
                                    <button
                                        onClick={() => setNewModalOpen(true)}
                                        className="mt-4 inline-flex items-center gap-1 rounded-full bg-gray-900 px-3 py-1 text-xs font-medium text-white hover:bg-gray-700 transition-colors shadow-md"
                                    >
                                        + Create New
                                    </button>
                                </>
                            ) : activeTab === "hidden" ? (
                                <>
                                    <Library className="h-8 w-8 text-gray-300 mb-4" />
                                    <p className="text-2xl font-medium font-serif text-gray-900">
                                        Hidden Workflows
                                    </p>
                                    <p className="mt-1 text-xs text-gray-400 text-left">
                                        Built-in workflows you've hidden will
                                        appear here. You can unhide them at any
                                        time.
                                    </p>
                                </>
                            ) : (
                                <>
                                    <Library className="h-8 w-8 text-gray-300 mb-4" />
                                    <p className="text-2xl font-medium font-serif text-gray-900">
                                        Workflows
                                    </p>
                                    <p className="mt-1 text-xs text-gray-400 text-left">
                                        Automate document analysis with reusable
                                        prompts and tabular review templates.
                                    </p>
                                </>
                            )}
                        </div>
                    ) : (
                        filtered.map((wf) => {
                            const rowBg = selectedIds.includes(wf.id)
                                ? "bg-gray-50"
                                : "bg-white";
                            return (
                            <div
                                key={wf.id}
                                onClick={() => setSelected(wf)}
                                className="group flex items-center h-10 pr-8 border-b border-gray-50 hover:bg-gray-50 cursor-pointer transition-colors"
                            >
                                <div
                                    className={`sticky left-0 z-[60] ${CHECK_W} p-2 flex items-center justify-center ${rowBg} group-hover:bg-gray-50`}
                                    onClick={(e) => e.stopPropagation()}
                                >
                                    <input
                                        type="checkbox"
                                        checked={selectedIds.includes(wf.id)}
                                        onChange={() => toggleOne(wf.id)}
                                        className="h-2.5 w-2.5 rounded border-gray-200 cursor-pointer accent-black"
                                    />
                                </div>
                                <div className={`sticky left-8 z-[60] ${NAME_COL_W} p-2 ${rowBg} group-hover:bg-gray-50`}>
                                    <span className="text-sm text-gray-800 truncate block">
                                        {wf.title}
                                    </span>
                                </div>
                                <div className="ml-auto w-28 shrink-0">
                                    {(() => {
                                        const { label, Icon, className } =
                                            getTypeMeta(wf.type);
                                        return (
                                            <span
                                                className={`inline-flex items-center gap-1.5 text-xs font-medium ${className}`}
                                            >
                                                <Icon className="h-3.5 w-3.5" />
                                                {label}
                                            </span>
                                        );
                                    })()}
                                </div>
                                <div className="w-40 shrink-0">
                                    {wf.practice ? (
                                        <span className="text-xs font-medium text-gray-600">
                                            {wf.practice}
                                        </span>
                                    ) : (
                                        <span className="text-xs text-gray-300">
                                            —
                                        </span>
                                    )}
                                </div>
                                <div className="w-28 shrink-0">
                                    {wf.is_system ? (
                                        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-600">
                                            <MikeIcon size={14} />
                                            Mike
                                        </span>
                                    ) : wf.user_id === user?.id ? (
                                        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-600">
                                            <User className="h-3.5 w-3.5 text-gray-500" />
                                            Myself
                                        </span>
                                    ) : (
                                        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-600 truncate max-w-full">
                                            <User className="h-3.5 w-3.5 text-gray-400 shrink-0" />
                                            <span className="truncate">
                                                {wf.shared_by_name ?? "Shared"}
                                            </span>
                                        </span>
                                    )}
                                </div>
                                <div
                                    className="w-16 shrink-0 flex items-center justify-end gap-1"
                                    onClick={(e) => e.stopPropagation()}
                                >
                                    {activeTab !== "hidden" && (
                                        <button
                                            onClick={() => downloadWorkflow(wf)}
                                            aria-label="Download workflow"
                                            title="Download workflow"
                                            className="flex items-center justify-center p-1 text-gray-400 hover:text-gray-900 transition-colors"
                                        >
                                            <Download className="h-3.5 w-3.5" />
                                        </button>
                                    )}
                                    {wf.is_system ? (
                                        activeTab === "hidden" ? (
                                            <RowActions
                                                onUnhide={() =>
                                                    handleUnhideWorkflow(wf.id)
                                                }
                                            />
                                        ) : (
                                            <RowActions
                                                onHide={() =>
                                                    handleHideWorkflow(wf.id)
                                                }
                                            />
                                        )
                                    ) : wf.is_owner === false ? null : (
                                        <RowActions
                                            onDelete={async () => {
                                                await deleteWorkflow(wf.id);
                                                setCustom((prev) =>
                                                    prev.filter(
                                                        (w) => w.id !== wf.id,
                                                    ),
                                                );
                                            }}
                                        />
                                    )}
                                </div>
                            </div>
                            );
                        })
                    )}
                </div>
            </div>

            <DisplayWorkflowModal
                workflows={all}
                workflow={selected}
                onClose={() => setSelected(null)}
            />

            <NewWorkflowModal
                open={newModalOpen}
                onClose={() => setNewModalOpen(false)}
                onCreated={(wf) => {
                    setCustom((prev) => [wf, ...prev]);
                    setNewModalOpen(false);
                    router.push(`/workflows/${wf.id}`);
                }}
            />
        </div>
    );
}
