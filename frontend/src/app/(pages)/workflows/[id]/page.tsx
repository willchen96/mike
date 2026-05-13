"use client";

import { use, useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { ChevronDown, Plus, Users, X } from "lucide-react";
import { getWorkflow, updateWorkflow } from "@/app/lib/mikeApi";
import { ShareWorkflowModal } from "@/app/components/workflows/ShareWorkflowModal";
import { WFEditColumnModal } from "@/app/components/workflows/WFEditColumnModal";
import { WFColumnViewModal } from "@/app/components/workflows/WFColumnViewModal";
import { AddColumnModal } from "@/app/components/tabular/AddColumnModal";
import type { ColumnConfig, MikeWorkflow } from "@/app/components/shared/types";
import {
    BUILT_IN_IDS,
    BUILT_IN_WORKFLOWS,
} from "@/app/components/workflows/builtinWorkflows";
import { formatIcon, formatLabel } from "@/app/components/tabular/columnFormat";
import { RenameableTitle } from "@/app/components/shared/RenameableTitle";
import { useTranslations } from "next-intl";
// dynamic import keeps Tiptap (browser-only) out of the SSR bundle
const WorkflowPromptEditor = dynamic(
    () =>
        import("@/app/components/workflows/WorkflowPromptEditor").then(
            (m) => ({ default: m.WorkflowPromptEditor }),
        ),
    { ssr: false },
);

interface Props {
    params: Promise<{ id: string }>;
}

type SaveStatus = "idle" | "saving" | "saved";

const CHECK_W = "w-8 shrink-0";
const NAME_COL_W = "w-[300px] shrink-0";

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
export default function WorkflowDetailPage({ params }: Props) {
    const t = useTranslations("pages.workflowDetalhe");
    const { id } = use(params);
    const router = useRouter();

    const [workflow, setWorkflow] = useState<MikeWorkflow | null>(null);
    const [loading, setLoading] = useState(true);
    const [notFound, setNotFound] = useState(false);

    const isBuiltin = BUILT_IN_IDS.has(id);
    const readOnly =
        isBuiltin ||
        (workflow?.is_system ?? false) ||
        workflow?.allow_edit === false;
    const canShare = !readOnly && (workflow?.is_owner ?? true);

    // Editor state
    const [promptMd, setPromptMd] = useState("");
    const [columns, setColumns] = useState<ColumnConfig[]>([]);

    // Save status
    const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Column selection
    const [selectedColIndices, setSelectedColIndices] = useState<number[]>([]);

    // Column modal
    const [addColumnOpen, setAddColumnOpen] = useState(false);
    const [editingColumn, setEditingColumn] = useState<ColumnConfig | null>(null);
    const [viewingColumn, setViewingColumn] = useState<ColumnConfig | null>(null);

    // Share popover
    const [shareOpen, setShareOpen] = useState(false);

    // Column actions dropdown
    const [colActionsOpen, setColActionsOpen] = useState(false);
    const colActionsRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        function handleClick(e: MouseEvent) {
            if (colActionsRef.current && !colActionsRef.current.contains(e.target as Node)) {
                setColActionsOpen(false);
            }
        }
        if (colActionsOpen) document.addEventListener("mousedown", handleClick);
        return () => document.removeEventListener("mousedown", handleClick);
    }, [colActionsOpen]);

    // ---------------------------------------------------------------------------
    // Load workflow
    // ---------------------------------------------------------------------------
    useEffect(() => {
        if (isBuiltin) {
            const wf = BUILT_IN_WORKFLOWS.find((w) => w.id === id) ?? null;
            if (!wf) {
                setNotFound(true);
            } else {
                setWorkflow(wf);
                setPromptMd(wf.prompt_md ?? "");
                setColumns(wf.columns_config ?? []);
            }
            setLoading(false);
            return;
        }

        getWorkflow(id)
            .then((wf) => {
                setWorkflow(wf);
                setPromptMd(wf.prompt_md ?? "");
                setColumns(
                    (wf.columns_config ?? [])
                        .slice()
                        .sort((a, b) => a.index - b.index),
                );
            })
            .catch(() => setNotFound(true))
            .finally(() => setLoading(false));
    }, [id, isBuiltin]);

    // ---------------------------------------------------------------------------
    // Debounced auto-save for prompt
    // ---------------------------------------------------------------------------
    const save = useCallback(
        (newPromptMd: string) => {
            if (readOnly) return;
            if (debounceRef.current) clearTimeout(debounceRef.current);
            setSaveStatus("saving");
            debounceRef.current = setTimeout(async () => {
                try {
                    await updateWorkflow(id, { prompt_md: newPromptMd });
                    setSaveStatus("saved");
                    setTimeout(() => setSaveStatus("idle"), 2000);
                } catch {
                    setSaveStatus("idle");
                }
            }, 800);
        },
        [id, readOnly],
    );

    async function handleTitleCommit(newTitle: string) {
        if (!newTitle || newTitle === workflow?.title) return;
        const updated = await updateWorkflow(id, { title: newTitle });
        setWorkflow(updated);
    }

    function handlePromptChange(val: string | undefined) {
        const next = val ?? "";
        setPromptMd(next);
        save(next);
    }

    // ---------------------------------------------------------------------------
    // Column save
    // ---------------------------------------------------------------------------
    async function saveColumns(next: ColumnConfig[]) {
        if (readOnly) return;
        setSaveStatus("saving");
        try {
            const updated = await updateWorkflow(id, { columns_config: next });
            setWorkflow(updated);
            setSaveStatus("saved");
            setTimeout(() => setSaveStatus("idle"), 2000);
        } catch {
            setSaveStatus("idle");
        }
    }

    function handleColumnsAdded(added: ColumnConfig[]) {
        const next = [
            ...columns,
            ...added.map((c, i) => ({ ...c, index: columns.length + i })),
        ];
        setColumns(next);
        saveColumns(next);
        setAddColumnOpen(false);
    }

    function handleColumnSaved(updated: ColumnConfig) {
        const next = columns.map((c) =>
            c.index === updated.index ? updated : c,
        );
        setColumns(next);
        saveColumns(next);
        setEditingColumn(null);
    }

    // ---------------------------------------------------------------------------
    // Render
    // ---------------------------------------------------------------------------
    if (loading) {
        return (
            <div className="flex flex-col h-full">
                {/* Header skeleton */}
                <div className="flex items-center justify-between px-8 py-4 shrink-0">
                    <div className="flex items-center gap-1.5">
                        <div className="h-6 w-24 rounded bg-gray-100 animate-pulse" />
                        <span className="text-gray-300">›</span>
                        <div className="h-6 w-40 rounded bg-gray-100 animate-pulse" />
                    </div>
                </div>

                {/* Toolbar skeleton */}
                <div className="flex items-center px-8 h-10 border-b border-gray-200 shrink-0">
                    <div className="h-3 w-20 rounded bg-gray-100 animate-pulse" />
                </div>

                {/* Table header skeleton */}
                <div className="flex items-center h-8 pr-8 border-b border-gray-200 shrink-0">
                    <div className="w-8 shrink-0 border-r border-gray-100 self-stretch" />
                    <div className="flex-1 pl-3">
                        <div className="h-2.5 w-20 rounded bg-gray-100 animate-pulse" />
                    </div>
                    <div className="w-36 shrink-0">
                        <div className="h-2.5 w-14 rounded bg-gray-100 animate-pulse" />
                    </div>
                    <div className="flex-1">
                        <div className="h-2.5 w-12 rounded bg-gray-100 animate-pulse" />
                    </div>
                    <div className="w-8 shrink-0" />
                </div>

                {/* Row skeletons */}
                <div className="flex-1 overflow-hidden">
                    {[1, 2, 3, 4, 5].map((i) => (
                        <div key={i} className="flex items-center h-10 pr-8 border-b border-gray-50">
                            <div className="w-8 shrink-0 border-r border-gray-100 self-stretch" />
                            <div className="flex-1 pl-3 pr-4">
                                <div className="h-3 rounded bg-gray-100 animate-pulse" style={{ width: `${40 + (i * 13) % 35}%` }} />
                            </div>
                            <div className="w-36 shrink-0">
                                <div className="h-3 w-16 rounded bg-gray-100 animate-pulse" />
                            </div>
                            <div className="flex-1 pr-4">
                                <div className="h-3 rounded bg-gray-100 animate-pulse" style={{ width: `${50 + (i * 17) % 35}%` }} />
                            </div>
                            <div className="w-8 shrink-0" />
                        </div>
                    ))}
                </div>
            </div>
        );
    }

    if (notFound || !workflow) {
        return (
            <div className="flex-1 flex items-center justify-center">
                <p className="text-gray-400 font-serif">{t("naoEncontrado")}</p>
            </div>
        );
    }

    return (
        <div className="flex flex-col h-full">
            {/* Page header */}
            <div className="flex items-center justify-between px-8 py-4 shrink-0">
                <div className="flex items-center gap-1.5 text-2xl font-medium font-serif">
                    <button
                        onClick={() => router.push("/workflows")}
                        className="text-gray-500 hover:text-gray-700 transition-colors"
                    >
                        Workflows
                    </button>
                    <span className="text-gray-300">›</span>
                    {readOnly ? (
                        <span className="text-gray-900 truncate max-w-xs">{workflow.title}</span>
                    ) : (
                        <RenameableTitle value={workflow.title} onCommit={handleTitleCommit} />
                    )}
                </div>

                <div className="flex items-center gap-3">
                    {/* Save status */}
                    <span className="text-xs text-gray-400">
                        {saveStatus === "saving"
                            ? t("salvando")
                            : saveStatus === "saved"
                              ? t("salvo")
                              : ""}
                    </span>

                    {/* Share button (custom workflows only) */}
                    {canShare && (
                        <button
                            onClick={() => setShareOpen(true)}
                            aria-label={t("ariaLabelPessoas")}
                            title={t("tituloPessoas")}
                            className="flex items-center text-gray-500 hover:text-gray-900 transition-colors"
                        >
                            <Users className="h-4 w-4" />
                        </button>
                    )}
                    {shareOpen && (
                        <ShareWorkflowModal
                            workflowId={id}
                            workflowName={workflow.title}
                            onClose={() => setShareOpen(false)}
                        />
                    )}
                </div>
            </div>

            {/* Read-only badge for built-in workflows */}
            {readOnly && (
                <div className="flex items-center h-10 px-8 border-b border-gray-200">
                    <span className="text-xs text-gray-400">{t("somenteLetura")}</span>
                </div>
            )}

            {/* Body */}
            <div className="flex-1 min-h-0 flex flex-col">
                {workflow.type === "assistant" ? (
                    /* ── Assistant: WYSIWYG editor ── */
                    <div className="flex-1 min-h-0 p-6">
                        <WorkflowPromptEditor
                            value={promptMd}
                            onChange={readOnly ? undefined : handlePromptChange}
                            readOnly={readOnly}
                        />
                    </div>
                ) : (
                    /* ── Tabular: Column table ── */
                    <div className="flex flex-col flex-1 min-h-0">
                        {/* Toolbar */}
                        {!readOnly && (
                            <div className="flex items-center justify-between px-8 h-10 border-b border-gray-200 shrink-0">
                                <button
                                    onClick={() => setAddColumnOpen(true)}
                                    className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-700 transition-colors"
                                >
                                    <Plus className="h-3.5 w-3.5" />
                                    {t("adicionarColuna")}
                                </button>
                                {selectedColIndices.length > 0 && (
                                    <div ref={colActionsRef} className="relative">
                                        <button
                                            onClick={() => setColActionsOpen((v) => !v)}
                                            className="flex items-center gap-1 text-xs font-medium text-gray-700 hover:text-gray-900 transition-colors"
                                        >
                                            {t("acoes")}
                                            <ChevronDown className="h-3.5 w-3.5" />
                                        </button>
                                        {colActionsOpen && (
                                            <div className="absolute top-full right-0 mt-1 w-36 rounded-lg border border-gray-100 bg-white shadow-lg z-50 overflow-hidden">
                                                <button
                                                    onClick={() => {
                                                        const next = columns
                                                            .filter((c) => !selectedColIndices.includes(c.index))
                                                            .map((c, i) => ({ ...c, index: i }));
                                                        setColumns(next);
                                                        saveColumns(next);
                                                        setSelectedColIndices([]);
                                                        setColActionsOpen(false);
                                                    }}
                                                    className="w-full px-3 py-1.5 text-left text-xs text-red-600 hover:bg-red-50 transition-colors"
                                                >
                                                    {t("excluir")}
                                                </button>
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        )}

                        <div className="flex-1 min-h-0 overflow-auto">
                        <div className="min-w-max flex min-h-full flex-col">
                        {/* Table header */}
                        <div className="flex items-center h-8 pr-8 border-b border-gray-200 text-xs text-gray-500 font-medium shrink-0 select-none">
                            <div className={`sticky left-0 z-[60] ${CHECK_W} relative bg-white flex items-center justify-center self-stretch before:absolute before:inset-x-0 before:bottom-0 before:h-px before:bg-white`}>
                                {columns.length > 0 && (
                                    <input
                                        type="checkbox"
                                        checked={columns.length > 0 && selectedColIndices.length === columns.length}
                                        ref={(el) => { if (el) el.indeterminate = selectedColIndices.length > 0 && selectedColIndices.length < columns.length; }}
                                        onChange={() => setSelectedColIndices(selectedColIndices.length === columns.length ? [] : columns.map((c) => c.index))}
                                        className="h-2.5 w-2.5 rounded border-gray-200 cursor-pointer accent-black"
                                    />
                                )}
                            </div>
                            <div className={`sticky left-8 z-[60] ${NAME_COL_W} bg-white pl-2 text-left`}>
                                {t("colNome")}
                            </div>
                            <div className="ml-auto w-36 shrink-0">{t("colFormato")}</div>
                            <div className="flex-1 min-w-0">{t("colPrompt")}</div>
                            {!readOnly && <div className="w-8 shrink-0" />}
                        </div>

                        {/* Rows */}
                        <div className="flex-1">
                            {columns.length === 0 ? (
                                <div className="flex flex-col items-start py-24 w-full max-w-xs mx-auto">
                                    <Plus className="h-8 w-8 text-gray-300 mb-4" />
                                    <p className="text-2xl font-medium font-serif text-gray-900">
                                        {t("tituloColunas")}
                                    </p>
                                    <p className="mt-1 text-xs text-gray-400 text-left">
                                        {t("descricaoColunas")}
                                    </p>
                                    {!readOnly && (
                                        <button
                                            onClick={() => setAddColumnOpen(true)}
                                            className="mt-4 inline-flex items-center gap-1 rounded-full bg-gray-900 px-3 py-1 text-xs font-medium text-white hover:bg-gray-700 transition-colors shadow-md"
                                        >
                                            {t("adicionarColunaBtn")}
                                        </button>
                                    )}
                                </div>
                            ) : (
                                columns.map((col) => {
                                    const FormatIcon = formatIcon(col.format ?? "text");
                                    const isChecked = selectedColIndices.includes(col.index);
                                    return (
                                        <div
                                            key={col.index}
                                            onClick={() => readOnly ? setViewingColumn(col) : setEditingColumn(col)}
                                            className="group flex items-center h-10 pr-8 border-b border-gray-50 hover:bg-gray-50 cursor-pointer transition-colors"
                                        >
                                            <div
                                                className={`sticky left-0 z-[60] ${CHECK_W} p-2 flex items-center justify-center ${isChecked ? "bg-gray-50" : "bg-white"} group-hover:bg-gray-50`}
                                                onClick={(e) => e.stopPropagation()}
                                            >
                                                <input
                                                    type="checkbox"
                                                    checked={isChecked}
                                                    onChange={() => setSelectedColIndices((prev) => prev.includes(col.index) ? prev.filter((i) => i !== col.index) : [...prev, col.index])}
                                                    className="h-2.5 w-2.5 rounded border-gray-200 cursor-pointer accent-black"
                                                />
                                            </div>
                                            <div className={`sticky left-8 z-[60] ${NAME_COL_W} p-2 ${isChecked ? "bg-gray-50" : "bg-white"} group-hover:bg-gray-50`}>
                                                <span className="text-sm text-gray-800 truncate block">
                                                    {col.name}
                                                </span>
                                            </div>
                                            <div className="ml-auto w-36 shrink-0">
                                                <span className="inline-flex items-center gap-1.5 text-xs text-gray-600">
                                                    <FormatIcon className="h-3.5 w-3.5 text-gray-400" />
                                                    {formatLabel(col.format ?? "text")}
                                                </span>
                                            </div>
                                            <div className="flex-1 min-w-0 pr-4">
                                                <span className="text-xs text-gray-500 truncate block">
                                                    {col.prompt}
                                                </span>
                                            </div>
                                            {!readOnly && (
                                                <div className="w-8 shrink-0 flex justify-end">
                                                    <button
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            const next = columns
                                                                .filter((c) => c.index !== col.index)
                                                                .map((c, i) => ({ ...c, index: i }));
                                                            setColumns(next);
                                                            saveColumns(next);
                                                        }}
                                                        className="p-1 text-gray-300 hover:text-red-500 transition-colors"
                                                    >
                                                        <X className="h-3.5 w-3.5" />
                                                    </button>
                                                </div>
                                            )}
                                        </div>
                                    );
                                })
                            )}
                        </div>
                        </div>
                        </div>
                    </div>
                )}
            </div>

            {/* Read-only column view modal */}
            {viewingColumn && (
                <WFColumnViewModal col={viewingColumn} onClose={() => setViewingColumn(null)} />
            )}

            {/* Add column modal */}
            <AddColumnModal
                open={addColumnOpen}
                existingCount={columns.length}
                onClose={() => setAddColumnOpen(false)}
                onAdd={handleColumnsAdded}
            />

            {/* Edit column modal */}
            {editingColumn && (
                <WFEditColumnModal
                    column={editingColumn}
                    onClose={() => setEditingColumn(null)}
                    onSave={handleColumnSaved}
                    onDelete={() => {
                        const next = columns
                            .filter((c) => c.index !== editingColumn.index)
                            .map((c, i) => ({ ...c, index: i }));
                        setColumns(next);
                        saveColumns(next);
                        setEditingColumn(null);
                    }}
                />
            )}
        </div>
    );
}
