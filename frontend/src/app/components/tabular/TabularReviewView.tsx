"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Plus, Loader2, Play, ChevronDown, MessageSquare, Download, Users } from "lucide-react";
import { HeaderSearchBtn } from "../shared/HeaderSearchBtn";

import {
    clearTabularCells,
    getTabularReview,
    getProject,
    getTabularReviewPeople,
    regenerateTabularCell,
    streamTabularGeneration,
    updateTabularReview,
} from "@/app/lib/mikeApi";
import type {
    ColumnConfig,
    MikeDocument,
    MikeProject,
    TabularCell,
    TabularReview,
} from "../shared/types";
import { AddColumnModal } from "./AddColumnModal";
import { AddDocumentsModal } from "../shared/AddDocumentsModal";
import { AddProjectDocsModal } from "../shared/AddProjectDocsModal";
import { PeopleModal } from "../shared/PeopleModal";
import { OwnerOnlyModal } from "../shared/OwnerOnlyModal";
import { ApiKeyMissingModal } from "../shared/ApiKeyMissingModal";
import { RenameableTitle } from "../shared/RenameableTitle";
import { useAuth } from "@/contexts/AuthContext";
import { useUserProfile } from "@/contexts/UserProfileContext";
import {
    getModelProvider,
    isModelAvailable,
    type ModelProvider,
} from "@/app/lib/modelAvailability";
import { TRSidePanel } from "./TRSidePanel";
import { TRTable } from "./TRTable";
import type { TRTableHandle } from "./TRTable";
import { TRChatPanel } from "./TRChatPanel";
import { exportTabularReviewToExcel } from "./exportToExcel";
import { useSidebar } from "@/app/contexts/SidebarContext";

interface Props {
    reviewId: string;
    projectId?: string;
}

export function TRView({ reviewId, projectId }: Props) {
    const { setSidebarOpen } = useSidebar();
    const [review, setReview] = useState<TabularReview | null>(null);
    const [project, setProject] = useState<MikeProject | null>(null);
    const [cells, setCells] = useState<TabularCell[]>([]);
    const [documents, setDocuments] = useState<MikeDocument[]>([]);
    const [columns, setColumns] = useState<ColumnConfig[]>([]);
    const [loading, setLoading] = useState(true);
    const [generating, setGenerating] = useState(false);
    const [savingColumn, setSavingColumn] = useState(false);
    const [savingColumnsConfig, setSavingColumnsConfig] = useState(false);
    const [addColOpen, setAddColOpen] = useState(false);
    const [addDocsOpen, setAddDocsOpen] = useState(false);
    const [peopleModalOpen, setPeopleModalOpen] = useState(false);
    const [ownerOnlyAction, setOwnerOnlyAction] = useState<string | null>(null);
    const { user } = useAuth();
    const [expandedCell, setExpandedCell] = useState<TabularCell | null>(null);
    const [expandedCellCitation, setExpandedCellCitation] = useState<
        { quote: string; page: number } | undefined
    >(undefined);
    const [selectedDocIds, setSelectedDocIds] = useState<string[]>([]);
    const [actionsOpen, setActionsOpen] = useState(false);
    const [search, setSearch] = useState("");
    const searchParams = useSearchParams();
    const initialChatParamRef = useRef<string | null>(
        searchParams.get("chat"),
    );
    const [chatOpen, setChatOpen] = useState(!!initialChatParamRef.current);
    const [selectedChatId, setSelectedChatId] = useState<string | null>(
        initialChatParamRef.current && initialChatParamRef.current !== "new"
            ? initialChatParamRef.current
            : null,
    );
    const [highlightedCell, setHighlightedCell] = useState<{ colIdx: number; rowIdx: number } | null>(null);
    const [apiKeyModalProvider, setApiKeyModalProvider] =
        useState<ModelProvider | null>(null);
    const actionsRef = useRef<HTMLDivElement>(null);
    const tableRef = useRef<TRTableHandle>(null);
    const router = useRouter();
    const { profile } = useUserProfile();
    const apiKeys = {
        claudeApiKey: profile?.claudeApiKey ?? null,
        geminiApiKey: profile?.geminiApiKey ?? null,
        openaiApiKey: profile?.openaiApiKey ?? null,
    };
    const tabularModel = profile?.tabularModel ?? "gemini-3-flash-preview";

    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        if (chatOpen) {
            params.set("chat", selectedChatId ?? "new");
        } else {
            params.delete("chat");
        }
        const query = params.toString();
        const newUrl = `${window.location.pathname}${query ? `?${query}` : ""}`;
        window.history.replaceState(null, "", newUrl);
    }, [chatOpen, selectedChatId]);

    useEffect(() => {
        if (!actionsOpen) return;
        function handleClickOutside(e: MouseEvent) {
            if (
                actionsRef.current &&
                !actionsRef.current.contains(e.target as Node)
            )
                setActionsOpen(false);
        }
        document.addEventListener("mousedown", handleClickOutside);
        return () =>
            document.removeEventListener("mousedown", handleClickOutside);
    }, [actionsOpen]);

    useEffect(() => {
        const fetches: Promise<unknown>[] = [
            getTabularReview(reviewId).then(({ review, cells, documents }) => {
                setReview(review);
                setCells(cells);
                setDocuments(documents);
                setColumns(review.columns_config || []);
            }),
        ];
        if (projectId) {
            fetches.push(
                getProject(projectId)
                    .then(setProject)
                    .catch(() => {}),
            );
        }
        Promise.all(fetches).finally(() => setLoading(false));
    }, [reviewId, projectId]);

    function getNextColumnIndex() {
        return (
            columns.reduce((max, column) => Math.max(max, column.index), -1) + 1
        );
    }

    async function saveColumnsConfig(nextColumns: ColumnConfig[]) {
        setSavingColumnsConfig(true);
        try {
            const updated = await updateTabularReview(reviewId, {
                columns_config: nextColumns,
                document_ids: documents.map((document) => document.id),
            });
            setReview(updated);
            setColumns(updated.columns_config || nextColumns);
        } finally {
            setSavingColumnsConfig(false);
        }
    }

    async function handleAddDocuments(newDocs: MikeDocument[]) {
        const toAdd = newDocs.filter(
            (d) => !documents.some((existing) => existing.id === d.id),
        );
        if (!toAdd.length) return;
        const allIds = [
            ...documents.map((d) => d.id),
            ...toAdd.map((d) => d.id),
        ];

        await updateTabularReview(reviewId, {
            document_ids: allIds,
            columns_config: columns,
        });
        setDocuments((prev) => [...prev, ...toAdd]);
        if (columns.length > 0) {
            setCells((prev) => [
                ...prev,
                ...toAdd.flatMap((doc) =>
                    columns.map((col) => ({
                        id: `new-${doc.id}-${col.index}`,
                        review_id: reviewId,
                        document_id: doc.id,
                        column_index: col.index,
                        content: null,
                        status: "pending" as const,
                        created_at: new Date().toISOString(),
                    })),
                ),
            ]);
        }
    }

    async function handleRegenerateCell(docId: string, colIndex: number) {
        setCells((prev) =>
            prev.map((c) =>
                c.document_id === docId && c.column_index === colIndex
                    ? { ...c, status: "generating" as const, content: null }
                    : c,
            ),
        );
        setExpandedCell((prev) =>
            prev
                ? { ...prev, status: "generating" as const, content: null }
                : null,
        );
        try {
            const result = await regenerateTabularCell(
                reviewId,
                docId,
                colIndex,
            );
            setCells((prev) =>
                prev.map((c) =>
                    c.document_id === docId && c.column_index === colIndex
                        ? { ...c, status: "done" as const, content: result }
                        : c,
                ),
            );
            setExpandedCell((prev) =>
                prev
                    ? { ...prev, status: "done" as const, content: result }
                    : null,
            );
        } catch (err) {
            console.error("Regeneration failed", err);
            setCells((prev) =>
                prev.map((c) =>
                    c.document_id === docId && c.column_index === colIndex
                        ? { ...c, status: "error" as const }
                        : c,
                ),
            );
            setExpandedCell((prev) =>
                prev ? { ...prev, status: "error" as const } : null,
            );
        }
    }

    async function handleGenerate() {
        if (!review || generating) return;

        // If columns changed since last save, update the review first
        if (columns.length === 0) return;

        if (!isModelAvailable(tabularModel, apiKeys)) {
            setApiKeyModalProvider(getModelProvider(tabularModel));
            return;
        }

        setGenerating(true);

        // Optimistically set empty/pending/error cells to generating (skip done cells)
        setCells((prev) =>
            documents.flatMap((doc) =>
                columns.map((col) => {
                    const existing = prev.find(
                        (c) =>
                            c.document_id === doc.id &&
                            c.column_index === col.index,
                    );
                    if (existing?.status === "done" && existing?.content) {
                        return existing;
                    }
                    return existing
                        ? {
                              ...existing,
                              status: "generating" as const,
                              content: null,
                          }
                        : {
                              id: `${doc.id}-${col.index}`,
                              review_id: reviewId,
                              document_id: doc.id,
                              column_index: col.index,
                              content: null,
                              status: "generating" as const,
                              created_at: new Date().toISOString(),
                          };
                }),
            ),
        );

        try {
            const response = await streamTabularGeneration(reviewId);
            if (!response.body) throw new Error("No body");

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split("\n");
                buffer = lines.pop() ?? "";

                for (const line of lines) {
                    if (!line.startsWith("data:")) continue;
                    const dataStr = line.slice(5).trim();
                    if (dataStr === "[DONE]") break;
                    try {
                        const data = JSON.parse(dataStr);
                        if (data.type === "cell_update") {
                            setCells((prev) =>
                                prev.map((c) =>
                                    c.document_id === data.document_id &&
                                    c.column_index === data.column_index
                                        ? {
                                              ...c,
                                              content: data.content,
                                              status: data.status,
                                          }
                                        : c,
                                ),
                            );
                        }
                    } catch {}
                }
            }
        } catch (err) {
            console.error("Generation failed", err);
        } finally {
            setGenerating(false);
        }
    }

    async function handleAddColumn(newColumns: ColumnConfig[]) {
        const startIndex = getNextColumnIndex();
        const normalizedColumns = newColumns.map((column, index) => ({
            ...column,
            index: startIndex + index,
        }));
        const newCols = [...columns, ...normalizedColumns];
        setSavingColumn(true);
        setColumns(newCols);
        setCells((prev) => [
            ...prev,
            ...documents
                .filter((doc) =>
                    normalizedColumns.some(
                        (column) =>
                            !prev.some(
                                (cell) =>
                                    cell.document_id === doc.id &&
                                    cell.column_index === column.index,
                            ),
                    ),
                )
                .flatMap((doc) =>
                    normalizedColumns
                        .filter(
                            (column) =>
                                !prev.some(
                                    (cell) =>
                                        cell.document_id === doc.id &&
                                        cell.column_index === column.index,
                                ),
                        )
                        .map((column) => ({
                            id: `new-${doc.id}-${column.index}`,
                            review_id: reviewId,
                            document_id: doc.id,
                            column_index: column.index,
                            content: null,
                            status: "pending" as const,
                            created_at: new Date().toISOString(),
                        })),
                ),
        ]);
        try {
            await saveColumnsConfig(newCols);
        } catch (err) {
            setColumns(columns);
            setCells((prev) =>
                prev.filter(
                    (cell) =>
                        !normalizedColumns.some(
                            (column) => column.index === cell.column_index,
                        ),
                ),
            );
            console.error("Failed to save column", err);
        } finally {
            setSavingColumn(false);
        }
    }

    async function handleUpdateColumn(nextColumn: ColumnConfig) {
        const nextColumns = columns.map((column) =>
            column.index === nextColumn.index ? nextColumn : column,
        );
        const previousColumns = columns;
        setColumns(nextColumns);
        try {
            await saveColumnsConfig(nextColumns);
        } catch (err) {
            setColumns(previousColumns);
            console.error("Failed to update column", err);
        }
    }

    async function handleDeleteColumn(columnIndex: number) {
        const previousColumns = columns;
        const nextColumns = columns.filter(
            (column) => column.index !== columnIndex,
        );
        setColumns(nextColumns);
        try {
            await saveColumnsConfig(nextColumns);
        } catch (err) {
            setColumns(previousColumns);
            console.error("Failed to delete column", err);
        }
    }

    function handleTabularCitationClick(colIdx: number, rowIdx: number) {
        setSearch("");
        setHighlightedCell({ colIdx, rowIdx });
        setTimeout(() => {
            tableRef.current?.scrollToCell(colIdx, rowIdx);
        }, 50);
        setTimeout(() => setHighlightedCell(null), 3000);
    }

    async function handleDeleteDocuments() {
        const remaining = documents.filter(
            (d) => !selectedDocIds.includes(d.id),
        );
        setDocuments(remaining);
        setCells((prev) =>
            prev.filter((c) => !selectedDocIds.includes(c.document_id)),
        );
        setSelectedDocIds([]);
        setActionsOpen(false);
        await updateTabularReview(reviewId, {
            document_ids: remaining.map((d) => d.id),
            columns_config: columns,
        });
    }

    async function handleClearResults() {
        const docIds = [...selectedDocIds];
        if (docIds.length === 0) return;
        setCells((prev) =>
            prev.map((c) =>
                docIds.includes(c.document_id)
                    ? { ...c, content: null, status: "pending" }
                    : c,
            ),
        );
        setSelectedDocIds([]);
        setActionsOpen(false);
        await clearTabularCells(reviewId, docIds);
    }

    async function handleTitleCommit(newTitle: string) {
        if (!newTitle || newTitle === review?.title) return;
        setReview((prev) => (prev ? { ...prev, title: newTitle } : prev));
        await updateTabularReview(reviewId, { title: newTitle });
    }

    const q = search.toLowerCase();
    const filteredDocuments = q
        ? documents.filter((d) => d.filename.toLowerCase().includes(q))
        : documents;

    return (
        <div className="flex h-full overflow-hidden bg-white">
            <div className="flex flex-1 flex-col overflow-hidden">
                {/* Header */}
                <div className="bg-white px-8 py-4 flex items-start justify-between shrink-0 gap-4">
                    <div className="flex items-center gap-1.5 text-2xl font-medium font-serif">
                        {projectId && (
                            <>
                                <button
                                    onClick={() => router.push("/projects")}
                                    className="text-gray-500 hover:text-gray-700 transition-colors"
                                >
                                    Projects
                                </button>
                                <span className="text-gray-300">›</span>
                                <button
                                    onClick={() =>
                                        router.push(`/projects/${projectId}`)
                                    }
                                    className="text-gray-500 hover:text-gray-700 transition-colors"
                                >
                                    {loading ? (
                                        <div className="h-6 w-32 rounded bg-gray-100 animate-pulse" />
                                    ) : (
                                        <>
                                            {project?.name ?? ""}
                                            {project?.cm_number && (
                                                <span className="ml-1 text-gray-400">
                                                    (#{project.cm_number})
                                                </span>
                                            )}
                                        </>
                                    )}
                                </button>
                                <span className="text-gray-300">›</span>
                                <button
                                    onClick={() =>
                                        router.push(
                                            `/projects/${projectId}?tab=reviews`,
                                        )
                                    }
                                    className="text-gray-500 hover:text-gray-700 transition-colors"
                                >
                                    Tabular Reviews
                                </button>
                            </>
                        )}
                        {!projectId && (
                            <button
                                onClick={() => router.push("/tabular-reviews")}
                                className="text-gray-500 hover:text-gray-700 transition-colors"
                            >
                                Tabular Reviews
                            </button>
                        )}
                        <span className="text-gray-300">›</span>
                        {loading ? (
                            <div className="h-6 w-40 rounded bg-gray-100 animate-pulse" />
                        ) : (
                            <RenameableTitle
                                value={review?.title || "Untitled Review"}
                                onCommit={handleTitleCommit}
                            />
                        )}
                    </div>
                    {!loading && (
                        <div className="flex items-center gap-2">
                            <HeaderSearchBtn value={search} onChange={setSearch} placeholder="Search documents…" />
                            {!projectId && (
                                <button
                                    onClick={() => setPeopleModalOpen(true)}
                                    disabled={loading}
                                    className={`flex h-8 w-8 items-center justify-center text-sm transition-colors ${
                                        loading
                                            ? "text-gray-300 cursor-default"
                                            : "text-gray-500 hover:text-gray-900 cursor-pointer"
                                    }`}
                                    title="People with access"
                                    aria-label="People with access"
                                >
                                    <Users className="h-4 w-4" />
                                </button>
                            )}
                            <button
                                onClick={() =>
                                    exportTabularReviewToExcel({
                                        reviewTitle: review?.title || "Tabular Review",
                                        columns,
                                        documents,
                                        cells,
                                    })
                                }
                                disabled={columns.length === 0 || documents.length === 0}
                                title="Export to Excel"
                                className={`flex h-8 items-center justify-center gap-1.5 px-3 text-sm transition-colors ${
                                    columns.length === 0 || documents.length === 0
                                        ? "text-gray-300 cursor-default"
                                        : "text-gray-700 hover:text-gray-900 cursor-pointer"
                                }`}
                            >
                                <Download className="h-4 w-4" />
                                Export
                            </button>
                            <button
                                onClick={handleGenerate}
                                disabled={
                                    generating ||
                                    columns.length === 0 ||
                                    documents.length === 0 ||
                                    savingColumnsConfig
                                }
                                className={`flex h-8 items-center justify-center gap-1.5 px-3 text-sm transition-colors ${
                                    generating ||
                                    columns.length === 0 ||
                                    documents.length === 0 ||
                                    savingColumnsConfig
                                        ? "text-gray-300 cursor-default"
                                        : "text-gray-700 hover:text-gray-900 cursor-pointer"
                                }`}
                            >
                                {generating ? (
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                    <Play className="h-4 w-4" />
                                )}
                                {generating ? "Running…" : "Run"}
                            </button>
                        </div>
                    )}
                </div>

                {/* Toolbar */}
                <div className="flex items-center h-10 px-8 border-b border-gray-200 gap-4">
                    <button
                        onClick={() => {
                            if (!chatOpen) setSidebarOpen(false);
                            if (chatOpen) setSelectedChatId(null);
                            setChatOpen((v) => !v);
                        }}
                        disabled={loading || columns.length === 0 || documents.length === 0}
                        className={`flex items-center gap-1 text-xs font-medium transition-colors ${
                            loading || columns.length === 0 || documents.length === 0
                                ? "text-gray-300 cursor-default"
                                : "text-gray-700 hover:text-gray-900"
                        }`}
                    >
                        <MessageSquare className="h-3.5 w-3.5" />
                        Assistant in Tabular Review
                    </button>
                    <div className="ml-auto flex items-center gap-4">
                        {selectedDocIds.length > 0 && (
                            <div ref={actionsRef} className="relative">
                                <button
                                    onClick={() => setActionsOpen((v) => !v)}
                                    className="flex items-center gap-1 text-xs font-medium text-gray-600 hover:text-gray-900 transition-colors"
                                >
                                    Actions
                                    <ChevronDown className="h-3.5 w-3.5" />
                                </button>
                                {actionsOpen && (
                                    <div className="absolute top-full right-0 mt-1 w-36 rounded-lg border border-gray-100 bg-white shadow-lg z-50 overflow-hidden">
                                        <button
                                            onClick={handleClearResults}
                                            className="w-full px-3 py-1.5 text-left text-xs text-gray-700 hover:bg-gray-50 transition-colors"
                                        >
                                            Clear results
                                        </button>
                                        <button
                                            onClick={handleDeleteDocuments}
                                            className="w-full px-3 py-1.5 text-left text-xs text-red-600 hover:bg-red-50 transition-colors"
                                        >
                                            Delete
                                        </button>
                                    </div>
                                )}
                            </div>
                        )}
                        <button
                            onClick={() => setAddDocsOpen(true)}
                            disabled={loading || savingColumnsConfig}
                            className={`flex items-center gap-1 text-xs font-medium transition-colors ${
                                loading || savingColumnsConfig
                                    ? "text-gray-300 cursor-default"
                                    : "text-gray-700 hover:text-gray-900"
                            }`}
                        >
                            <Plus className="h-3.5 w-3.5" />
                            Add Documents
                        </button>
                        <button
                            onClick={() => setAddColOpen(true)}
                            disabled={
                                loading || savingColumn || savingColumnsConfig
                            }
                            className={`flex items-center gap-1 text-xs font-medium transition-colors ${
                                loading || savingColumn || savingColumnsConfig
                                    ? "text-gray-300 cursor-default"
                                    : "text-gray-700 hover:text-gray-900"
                            }`}
                        >
                            <Plus className="h-3.5 w-3.5" />
                            Add Columns
                        </button>
                    </div>
                </div>

                {/* Table area */}
                <div className="flex flex-1 overflow-hidden">
                    {chatOpen && (
                        <TRChatPanel
                            reviewId={reviewId}
                            reviewTitle={review?.title ?? null}
                            projectName={project?.name ?? null}
                            columns={columns}
                            documents={documents}
                            onCitationClick={handleTabularCitationClick}
                            onClose={() => {
                                setSelectedChatId(null);
                                setChatOpen(false);
                            }}
                            initialChatId={selectedChatId}
                            onChatIdChange={setSelectedChatId}
                        />
                    )}
                    <TRTable
                        ref={tableRef}
                        loading={loading}
                        columns={columns}
                        documents={filteredDocuments}
                        cells={cells}
                        highlightedCell={highlightedCell}
                        savingColumn={savingColumn}
                        savingColumnsConfig={savingColumnsConfig}
                        selectedDocIds={selectedDocIds}
                        onSelectionChange={setSelectedDocIds}
                        onExpand={(cell) => {
                            setExpandedCell(cell);
                            setExpandedCellCitation(undefined);
                        }}
                        onCitationClick={(cell, page, quote) => {
                            setExpandedCell(cell);
                            setExpandedCellCitation({ quote, page });
                        }}
                        onUpdateColumn={handleUpdateColumn}
                        onDeleteColumn={handleDeleteColumn}
                        onAddColumn={() => setAddColOpen(true)}
                        onAddDocuments={() => setAddDocsOpen(true)}
                    />
                </div>
            </div>

            {/* Cell detail side panel */}
            {expandedCell &&
                (() => {
                    const expandedDoc = documents.find(
                        (d) => d.id === expandedCell.document_id,
                    );
                    const expandedCol = columns.find(
                        (c) => c.index === expandedCell.column_index,
                    );
                    if (!expandedDoc || !expandedCol) return null;
                    return (
                        <TRSidePanel
                            cell={expandedCell}
                            document={expandedDoc}
                            column={expandedCol}
                            columns={columns}
                            onClose={() => {
                                setExpandedCell(null);
                                setExpandedCellCitation(undefined);
                            }}
                            onNavigate={(columnIndex) => {
                                const nextCell = cells.find(
                                    (c) =>
                                        c.document_id ===
                                            expandedCell.document_id &&
                                        c.column_index === columnIndex,
                                );
                                if (nextCell) {
                                    setExpandedCell(nextCell);
                                    setExpandedCellCitation(undefined);
                                }
                            }}
                            onRegenerate={() =>
                                handleRegenerateCell(
                                    expandedCell.document_id,
                                    expandedCell.column_index,
                                )
                            }
                            displayDocument={expandedCellCitation !== undefined}
                            citationQuote={expandedCellCitation?.quote}
                            citationPage={expandedCellCitation?.page}
                        />
                    );
                })()}

            <AddColumnModal
                open={addColOpen}
                existingCount={columns.length}
                onClose={() => setAddColOpen(false)}
                onAdd={handleAddColumn}
            />

            {project ? (
                <AddProjectDocsModal
                    open={addDocsOpen}
                    onClose={() => setAddDocsOpen(false)}
                    onSelect={(docs: MikeDocument[]) =>
                        handleAddDocuments(docs)
                    }
                    breadcrumb={[
                        "Projects",
                        project.name +
                            (project.cm_number
                                ? ` (#${project.cm_number})`
                                : ""),
                        "Tabular Reviews",
                        ...(review ? [review.title || "Untitled Review"] : []),
                        "Add Documents",
                    ]}
                    projectId={project.id}
                    excludeDocIds={new Set(documents.map((d) => d.id))}
                />
            ) : (
                <AddDocumentsModal
                    open={addDocsOpen}
                    onClose={() => setAddDocsOpen(false)}
                    onSelect={(docs: MikeDocument[]) =>
                        handleAddDocuments(docs)
                    }
                    breadcrumb={[
                        "Tabular Reviews",
                        ...(review ? [review.title || "Untitled Review"] : []),
                        "Add Documents",
                    ]}
                />
            )}

            <PeopleModal
                open={peopleModalOpen}
                onClose={() => setPeopleModalOpen(false)}
                resource={review}
                fetchPeople={getTabularReviewPeople}
                currentUserEmail={user?.email ?? null}
                breadcrumb={[
                    "Tabular Reviews",
                    review?.title || "Untitled Review",
                    "People",
                ]}
                // Only the review owner may modify the member list. PeopleModal
                // hides the add/remove controls when this prop is undefined.
                onSharedWithChange={
                    review?.is_owner === false
                        ? undefined
                        : async (next) => {
                              const updated = await updateTabularReview(
                                  reviewId,
                                  { shared_with: next },
                              );
                              setReview((prev) =>
                                  prev
                                      ? {
                                            ...prev,
                                            shared_with: updated.shared_with,
                                        }
                                      : prev,
                              );
                          }
                }
            />

            <OwnerOnlyModal
                open={!!ownerOnlyAction}
                action={ownerOnlyAction ?? undefined}
                onClose={() => setOwnerOnlyAction(null)}
            />

            <ApiKeyMissingModal
                open={apiKeyModalProvider !== null}
                provider={apiKeyModalProvider}
                onClose={() => setApiKeyModalProvider(null)}
            />
        </div>
    );
}
