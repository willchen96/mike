"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, Search, X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { MikeWorkflow } from "../shared/types";
import { listWorkflows } from "@/app/lib/mikeApi";
import { BUILT_IN_WORKFLOWS } from "../workflows/builtinWorkflows";
import { useTranslations } from "next-intl";

interface Props {
    open: boolean;
    onClose: () => void;
    onSelect: (workflow: MikeWorkflow) => void;
    projectName?: string;
    projectCmNumber?: string | null;
    initialWorkflowId?: string;
}

export function AssistantWorkflowModal({
    open,
    onClose,
    onSelect,
    projectName,
    projectCmNumber,
    initialWorkflowId,
}: Props) {
    const t = useTranslations("assistant.workflowModal");
    const [workflows, setWorkflows] = useState<MikeWorkflow[]>([]);
    const [loading, setLoading] = useState(false);
    const [selected, setSelected] = useState<MikeWorkflow | null>(null);
    const [search, setSearch] = useState("");
    const [rightVisible, setRightVisible] = useState(false);

    useEffect(() => {
        if (!selected) {
            setRightVisible(false);
            return;
        }
        const frame = requestAnimationFrame(() => setRightVisible(true));
        return () => cancelAnimationFrame(frame);
    }, [selected]);

    useEffect(() => {
        if (!open) {
            setSelected(null);
            setSearch("");
            return;
        }
        const builtins = BUILT_IN_WORKFLOWS.filter(
            (w) => w.type === "assistant",
        );
        setWorkflows(builtins);
        setLoading(true);
        listWorkflows("assistant")
            .then((custom) => {
                const all = [...builtins, ...custom];
                setWorkflows(all);
                if (initialWorkflowId) {
                    const match = all.find((w) => w.id === initialWorkflowId);
                    if (match) setSelected(match);
                }
            })
            .catch(() => {
                if (initialWorkflowId) {
                    const match = builtins.find((w) => w.id === initialWorkflowId);
                    if (match) setSelected(match);
                }
            })
            .finally(() => setLoading(false));
        // Pre-select from builtins immediately if possible
        if (initialWorkflowId) {
            const match = builtins.find((w) => w.id === initialWorkflowId);
            if (match) setSelected(match);
        }
    }, [open, initialWorkflowId]);

    if (!open) return null;

    const filteredWorkflows = search
        ? workflows.filter((w) => w.title.toLowerCase().includes(search.toLowerCase()))
        : workflows;

    function handleUse() {
        if (!selected) return;
        onSelect(selected);
        onClose();
    }

    return createPortal(
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/10 backdrop-blur-xs">
            <div
                className={`w-full rounded-2xl bg-white shadow-2xl flex flex-col h-[600px] ${selected ? "max-w-4xl" : "max-w-2xl"}`}
            >
                {/* Header */}
                <div className="flex items-center justify-between px-4 py-4 shrink-0 border-b border-gray-100">
                    <div className="flex items-center gap-1.5 text-xs text-gray-400">
                        {projectName ? (
                            <>
                                <span>{t("projetos")}</span>
                                <span>›</span>
                                <span>
                                    {projectName}
                                    {projectCmNumber
                                        ? ` (#${projectCmNumber})`
                                        : ""}
                                </span>
                                <span>›</span>
                                <span>{t("assistente")}</span>
                                <span>›</span>
                                <span>{t("adicionarWorkflow")}</span>
                            </>
                        ) : (
                            <>
                                <span>{t("assistente")}</span>
                                <span>›</span>
                                <span>{t("adicionarWorkflow")}</span>
                            </>
                        )}
                    </div>
                    <button
                        onClick={onClose}
                        className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>

                {/* Content */}
                <div className="flex flex-row flex-1 min-h-0 overflow-hidden">
                    {/* Left panel — workflow list */}
                    <div
                        className={`overflow-y-auto ${selected ? "w-80 shrink-0" : "flex-1"}`}
                    >
                        {/* Search */}
                        <div className="px-4 pt-3 pb-2 shrink-0">
                            <div className="flex items-center gap-1.5 rounded-md border border-gray-200 bg-gray-50 px-2.5 py-1">
                                <Search className="h-3 w-3 text-gray-400 shrink-0" />
                                <input
                                    type="text"
                                    placeholder={t("buscar")}
                                    value={search}
                                    onChange={(e) => setSearch(e.target.value)}
                                    className="flex-1 bg-transparent text-xs text-gray-700 placeholder:text-gray-400 outline-none"
                                />
                                {search && (
                                    <button onClick={() => setSearch("")} className="text-gray-400 hover:text-gray-600">
                                        <X className="h-3 w-3" />
                                    </button>
                                )}
                            </div>
                        </div>

                        {loading ? (
                            <div className="space-y-px px-4 pt-1">
                                {[60, 45, 75, 50, 65, 40, 55].map((w, i) => (
                                    <div
                                        key={i}
                                        className="flex items-center justify-between gap-3 py-3 border-b border-gray-50"
                                    >
                                        <div
                                            className="h-3 rounded bg-gray-100 animate-pulse"
                                            style={{ width: `${w}%` }}
                                        />
                                        <div className="h-3 w-10 rounded bg-gray-100 animate-pulse shrink-0" />
                                    </div>
                                ))}
                            </div>
                        ) : filteredWorkflows.length === 0 ? (
                            <p className="px-4 py-8 text-sm text-center text-gray-400">
                                {search ? t("nenhumResultado") : t("nenhumWorkflow")}
                            </p>
                        ) : (
                            filteredWorkflows.map((wf) => (
                                <button
                                    key={wf.id}
                                    type="button"
                                    onClick={() =>
                                        setSelected((prev) =>
                                            prev?.id === wf.id ? null : wf,
                                        )
                                    }
                                    className={`w-full flex items-center gap-3 px-4 py-3 text-xs text-left transition-colors border-b border-gray-50 ${
                                        selected?.id === wf.id
                                            ? "bg-gray-50"
                                            : "hover:bg-gray-50"
                                    }`}
                                >
                                    <span className="flex-1 truncate text-gray-800">
                                        {wf.title}
                                    </span>
                                    <span className="shrink-0 text-xs text-gray-400">
                                        {wf.is_system ? t("padrao") : t("personalizado")}
                                    </span>
                                </button>
                            ))
                        )}
                    </div>

                    {/* Right panel — prompt preview */}
                    {selected && (
                        <div className={`flex-1 border-l border-gray-100 flex flex-col overflow-hidden px-3 pb-3 transition-opacity duration-200 ${rightVisible ? "opacity-100" : "opacity-0"}`}>
                            <div className="flex items-center justify-between py-3 shrink-0">
                                <p className="text-xs font-medium text-gray-700">
                                    {t("promptWorkflow")}
                                </p>
                                <button
                                    onClick={() => setSelected(null)}
                                    className="rounded-lg p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
                                >
                                    <ChevronLeft className="h-3.5 w-3.5" />
                                </button>
                            </div>
                            <div className="flex-1 overflow-y-auto px-4 py-3 text-sm border border-gray-200 rounded-md text-gray-600 leading-relaxed font-serif bg-gray-50">
                                <ReactMarkdown
                                    remarkPlugins={[remarkGfm]}
                                    components={{
                                        h1: ({ children }) => (
                                            <h1 className="text-base font-semibold text-gray-900 mt-4 mb-1 first:mt-0">
                                                {children}
                                            </h1>
                                        ),
                                        h2: ({ children }) => (
                                            <h2 className="text-sm font-semibold text-gray-900 mt-3 mb-1 first:mt-0">
                                                {children}
                                            </h2>
                                        ),
                                        h3: ({ children }) => (
                                            <h3 className="text-xs font-semibold text-gray-900 mt-2 mb-0.5 first:mt-0">
                                                {children}
                                            </h3>
                                        ),
                                        p: ({ children }) => (
                                            <p className="mb-2 last:mb-0">
                                                {children}
                                            </p>
                                        ),
                                        ul: ({ children }) => (
                                            <ul className="list-disc pl-4 mb-2 space-y-0.5">
                                                {children}
                                            </ul>
                                        ),
                                        ol: ({ children }) => (
                                            <ol className="list-decimal pl-4 mb-2 space-y-0.5">
                                                {children}
                                            </ol>
                                        ),
                                        li: ({ children }) => (
                                            <li>{children}</li>
                                        ),
                                        strong: ({ children }) => (
                                            <strong className="font-semibold text-gray-800">
                                                {children}
                                            </strong>
                                        ),
                                        em: ({ children }) => (
                                            <em className="italic">
                                                {children}
                                            </em>
                                        ),
                                    }}
                                >
                                    {selected.prompt_md ??
                                        t("semPrompt")}
                                </ReactMarkdown>
                            </div>
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div className="border-t border-gray-100 px-4 py-3 flex items-center justify-end gap-2 shrink-0">
                    <button
                        type="button"
                        onClick={onClose}
                        className="rounded-lg px-3 py-1.5 text-sm text-gray-500 hover:bg-gray-100 transition-colors"
                    >
                        {t("cancelar")}
                    </button>
                    <button
                        type="button"
                        onClick={handleUse}
                        disabled={!selected}
                        className="rounded-lg bg-gray-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-40 transition-colors"
                    >
                        {t("usar")}
                    </button>
                </div>
            </div>
        </div>,
        document.body,
    );
}
