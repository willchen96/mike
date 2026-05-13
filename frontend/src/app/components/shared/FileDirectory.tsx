"use client";

import { useState } from "react";
import {
    Check,
    ChevronDown,
    ChevronRight,
    File,
    FileText,
    Folder,
    Trash2,
} from "lucide-react";
import type { MikeDocument, MikeProject } from "./types";
import { VersionChip } from "./VersionChip";
import { useTranslations } from "next-intl";

function formatDate(iso: string | null) {
    if (!iso) return null;
    return new Date(iso).toLocaleDateString(undefined, {
        day: "numeric",
        month: "short",
        year: "numeric",
    });
}

export function DocFileIcon({ fileType }: { fileType: string | null }) {
    if (fileType === "pdf")
        return <FileText className="h-3.5 w-3.5 text-red-500 shrink-0" />;
    return <File className="h-3.5 w-3.5 text-blue-500 shrink-0" />;
}

interface FileDirectoryProps {
    standaloneDocs: MikeDocument[];
    directoryProjects: MikeProject[];
    loading: boolean;
    selectedIds: Set<string>;
    onChange: (ids: Set<string>) => void;
    allowMultiple?: boolean;
    forceExpanded?: boolean;
    emptyMessage?: string;
    heading?: string;
    onDelete?: (ids: string[]) => void | Promise<void>;
}

export function FileDirectory({
    standaloneDocs,
    directoryProjects,
    loading,
    selectedIds,
    onChange,
    allowMultiple = true,
    forceExpanded = false,
    emptyMessage,
    heading,
    onDelete,
}: FileDirectoryProps) {
    const t = useTranslations("documents");
    const resolvedEmptyMessage = emptyMessage ?? t("nenhumDocumentoPadrao");
    const resolvedHeading = heading ?? t("headingPadrao");
    const [expandedProjects, setExpandedProjects] = useState<Set<string>>(
        new Set(),
    );
    const [deleting, setDeleting] = useState(false);

    const selectedCount = selectedIds.size;

    async function handleDelete() {
        if (!onDelete || selectedCount === 0 || deleting) return;
        const ids = Array.from(selectedIds);
        setDeleting(true);
        try {
            await onDelete(ids);
            const next = new Set(selectedIds);
            ids.forEach((id) => next.delete(id));
            onChange(next);
        } finally {
            setDeleting(false);
        }
    }

    const allDocs = [
        ...standaloneDocs,
        ...directoryProjects.flatMap((p) => p.documents ?? []),
    ];

    const allStandaloneSelected =
        standaloneDocs.length > 0 &&
        standaloneDocs.every((d) => selectedIds.has(d.id));

    function toggle(docId: string) {
        if (!allowMultiple) {
            onChange(new Set([docId]));
            return;
        }
        const next = new Set(selectedIds);
        next.has(docId) ? next.delete(docId) : next.add(docId);
        onChange(next);
    }

    function toggleAll() {
        if (allStandaloneSelected) {
            const next = new Set(selectedIds);
            standaloneDocs.forEach((d) => next.delete(d.id));
            onChange(next);
        } else {
            const next = new Set(selectedIds);
            standaloneDocs.forEach((d) => next.add(d.id));
            onChange(next);
        }
    }

    function toggleFolder(projectId: string) {
        if (forceExpanded) return;
        setExpandedProjects((prev) => {
            const next = new Set(prev);
            next.has(projectId) ? next.delete(projectId) : next.add(projectId);
            return next;
        });
    }

    if (loading) {
        return (
            <div className="rounded-sm border border-gray-100 overflow-hidden">
                {/* Documents header skeleton */}
                <div className="flex items-center justify-between px-2 py-2">
                    <div className="h-3 w-20 rounded bg-gray-200 animate-pulse" />
                    <div className="h-3 w-12 rounded bg-gray-200 animate-pulse" />
                </div>
                {/* File rows skeleton */}
                <div>
                    {[60, 45, 75, 55, 40].map((w, i) => (
                        <div
                            key={i}
                            className="flex items-center gap-2 px-2 py-2"
                        >
                            <div className="h-3.5 w-3.5 rounded border border-gray-200 shrink-0" />
                            <div className="h-3.5 w-3.5 rounded bg-gray-200 animate-pulse shrink-0" />
                            <div
                                className="h-3 rounded bg-gray-200 animate-pulse"
                                style={{ width: `${w}%` }}
                            />
                        </div>
                    ))}
                </div>
            </div>
        );
    }

    if (allDocs.length === 0 && directoryProjects.length === 0) {
        return (
            <p className="text-center text-sm text-gray-400 py-8">
                {resolvedEmptyMessage}
            </p>
        );
    }

    return (
        <div className="rounded-sm border border-gray-100 overflow-hidden">
            <div>
                {(standaloneDocs.length > 0 ||
                    (onDelete && selectedCount > 0)) && (
                    <div className="flex items-center justify-between px-2 py-2">
                        <p className="text-xs font-medium text-gray-400">
                            {resolvedHeading}
                        </p>
                        <div className="flex items-center gap-3">
                            {onDelete && selectedCount > 0 && (
                                <button
                                    type="button"
                                    onClick={handleDelete}
                                    disabled={deleting}
                                    className="inline-flex items-center gap-1 text-xs text-red-500 hover:text-red-700 transition-colors disabled:opacity-50"
                                >
                                    <Trash2 className="h-3 w-3" />
                                    {t("excluir")}
                                </button>
                            )}
                            {standaloneDocs.length > 0 && (
                                <button
                                    type="button"
                                    onClick={toggleAll}
                                    className="text-xs text-gray-400 hover:text-gray-600 transition-colors"
                                >
                                    {allStandaloneSelected
                                        ? t("desmarcarTodos")
                                        : t("selecionarTodos")}
                                </button>
                            )}
                        </div>
                    </div>
                )}
                {standaloneDocs.map((doc) => {
                    const selected = selectedIds.has(doc.id);
                    return (
                        <button
                            type="button"
                            key={doc.id}
                            onClick={() => toggle(doc.id)}
                            className={`w-full flex items-center gap-2 px-2 py-2 text-xs transition-colors text-left  ${
                                selected ? "bg-gray-100" : "hover:bg-gray-50"
                            }`}
                        >
                            <span
                                className={`shrink-0 h-3.5 w-3.5 rounded border flex items-center justify-center ${
                                    selected
                                        ? "bg-gray-900 border-gray-900"
                                        : "border-gray-300"
                                }`}
                            >
                                {selected && (
                                    <Check className="h-2.5 w-2.5 text-white" />
                                )}
                            </span>
                            <DocFileIcon fileType={doc.file_type} />
                            <span
                                className={`flex-1 truncate ${
                                    selected ? "text-gray-900" : "text-gray-700"
                                }`}
                            >
                                {doc.filename}
                            </span>
                            <VersionChip n={doc.latest_version_number} />
                            {doc.created_at && (
                                <span className="shrink-0 text-gray-300">
                                    {formatDate(doc.created_at)}
                                </span>
                            )}
                        </button>
                    );
                })}

                {standaloneDocs.length > 0 && directoryProjects.length > 0 && (
                    <div className="border-t border-gray-100 py-2 px-2">
                        <p className="text-xs font-medium text-gray-400">
                            {t("projetos")}
                        </p>
                    </div>
                )}

                {directoryProjects.map((project) => {
                    const isExpanded =
                        forceExpanded || expandedProjects.has(project.id);
                    const docs = project.documents ?? [];
                    return (
                        <div key={project.id}>
                            <button
                                type="button"
                                onClick={() => toggleFolder(project.id)}
                                className="w-full flex items-center gap-2 px-2 py-2 text-xs hover:bg-gray-50 transition-colors text-left"
                            >
                                {isExpanded ? (
                                    <ChevronDown className="h-3 w-3 text-gray-400 shrink-0" />
                                ) : (
                                    <ChevronRight className="h-3 w-3 text-gray-400 shrink-0" />
                                )}
                                <Folder className="h-3.5 w-3.5 shrink-0 text-gray-400" />
                                <span className="flex-1 truncate font-medium text-gray-700">
                                    {project.name}
                                    {project.cm_number && (
                                        <span className="ml-1 font-normal text-gray-400">
                                            (#{project.cm_number})
                                        </span>
                                    )}
                                </span>
                                <span className="text-xs text-gray-400 shrink-0">
                                    {docs.length}
                                </span>
                            </button>
                            {isExpanded && (
                                <div>
                                    {docs.length === 0 ? (
                                        <p className="pl-7 py-1 text-xs text-gray-400">
                                            {t("pastaVazia")}
                                        </p>
                                    ) : (
                                        docs.map((doc) => {
                                            const selected = selectedIds.has(
                                                doc.id,
                                            );
                                            return (
                                                <button
                                                    type="button"
                                                    key={doc.id}
                                                    onClick={() =>
                                                        toggle(doc.id)
                                                    }
                                                    className={`w-full flex items-center gap-2 pl-7 pr-2 py-2 text-xs transition-colors text-left  ${
                                                        selected
                                                            ? "bg-gray-100"
                                                            : "hover:bg-gray-50"
                                                    }`}
                                                >
                                                    <span
                                                        className={`shrink-0 h-3.5 w-3.5 rounded border flex items-center justify-center ${
                                                            selected
                                                                ? "bg-gray-900 border-gray-900"
                                                                : "border-gray-300"
                                                        }`}
                                                    >
                                                        {selected && (
                                                            <Check className="h-2.5 w-2.5 text-white" />
                                                        )}
                                                    </span>
                                                    <DocFileIcon
                                                        fileType={doc.file_type}
                                                    />
                                                    <span
                                                        className={`flex-1 truncate min-w-0 ${
                                                            selected
                                                                ? "text-gray-900 font-medium"
                                                                : "text-gray-700"
                                                        }`}
                                                    >
                                                        {doc.filename}
                                                    </span>
                                                    <VersionChip
                                                        n={doc.latest_version_number}
                                                    />
                                                    {doc.created_at && (
                                                        <span className="shrink-0 text-gray-300">
                                                            {formatDate(
                                                                doc.created_at,
                                                            )}
                                                        </span>
                                                    )}
                                                </button>
                                            );
                                        })
                                    )}
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
