"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X, Upload, Search, Loader2 } from "lucide-react";
import {
    uploadStandaloneDocument,
    uploadProjectDocument,
    addDocumentToProject,
    deleteDocument,
} from "@/app/lib/mikeApi";
import type { MikeDocument } from "./types";
import { FileDirectory } from "./FileDirectory";
import { useDirectoryData, invalidateDirectoryCache } from "./useDirectoryData";
import { OwnerOnlyModal } from "./OwnerOnlyModal";
import { useAuth } from "@/contexts/AuthContext";
import { getSupportedUploadFiles } from "./documentUpload";

export { invalidateDirectoryCache };

interface Props {
    open: boolean;
    onClose: () => void;
    onSelect: (documents: MikeDocument[], projectId?: string) => void;
    breadcrumb: string[];
    allowMultiple?: boolean;
    projectId?: string;
}

export function AddDocumentsModal({
    open,
    onClose,
    onSelect,
    breadcrumb,
    allowMultiple = true,
    projectId,
}: Props) {
    const { loading, standaloneDocuments, projects } = useDirectoryData(open);
    const { user } = useAuth();
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [uploading, setUploading] = useState(false);
    const [uploadError, setUploadError] = useState<string | null>(null);
    const [isDraggingFiles, setIsDraggingFiles] = useState(false);
    const [search, setSearch] = useState("");
    const [extraUploadedDocs, setExtraUploadedDocs] = useState<MikeDocument[]>([]);
    // IDs deleted in this session — hidden locally since `useDirectoryData`'s
    // cached state won't re-fetch until the modal reopens.
    const [deletedIds, setDeletedIds] = useState<Set<string>>(new Set());
    const [ownerOnlyAction, setOwnerOnlyAction] = useState<string | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (!open) return;
        setSearch("");
        setSelectedIds(new Set());
        setExtraUploadedDocs([]);
        setDeletedIds(new Set());
        setUploadError(null);
        setIsDraggingFiles(false);
    }, [open]);

    if (!open) return null;

    const q = search.toLowerCase().trim();

    const allStandalone = [
        ...extraUploadedDocs.filter(
            (u) => !standaloneDocuments.some((d) => d.id === u.id),
        ),
        ...standaloneDocuments,
    ].filter((d) => !deletedIds.has(d.id));

    const filteredStandalone = q
        ? allStandalone.filter((d) => d.filename.toLowerCase().includes(q))
        : allStandalone;

    const filteredProjects = projects
        .filter((p) => p.id !== projectId)
        .map((p) => ({
            ...p,
            documents: (p.documents || []).filter(
                (d) =>
                    !deletedIds.has(d.id) &&
                    (!q || d.filename.toLowerCase().includes(q)),
            ),
        }))
        .filter(
            (p) =>
                !q ||
                p.name.toLowerCase().includes(q) ||
                p.documents.length > 0,
        );

    const allDocs = [
        ...allStandalone,
        ...projects.flatMap((p) => p.documents || []),
    ];

    async function handleConfirm() {
        const selected = allDocs.filter((d) => selectedIds.has(d.id));

        if (projectId) {
            const toAssign = selected.filter((d) => d.project_id !== projectId);
            const alreadyHere = selected.filter(
                (d) => d.project_id === projectId,
            );
            if (toAssign.length > 0) {
                setUploading(true);
                try {
                    const assigned = await Promise.all(
                        toAssign.map((d) =>
                            addDocumentToProject(projectId, d.id),
                        ),
                    );
                    onSelect([...alreadyHere, ...assigned], projectId);
                } catch (err) {
                    console.error("Failed to assign documents:", err);
                } finally {
                    setUploading(false);
                }
            } else {
                onSelect(alreadyHere, projectId);
            }
            onClose();
            return;
        }

        const projectIds = new Set(
            selected.map((d) => d.project_id).filter(Boolean),
        );
        const singleProjectId =
            projectIds.size === 1 ? [...projectIds][0]! : undefined;
        onSelect(selected, singleProjectId);
        onClose();
    }

    async function handleDelete(ids: string[]) {
        // Server only allows the doc creator to delete. Filter to owned
        // and warn for the rest.
        const docsById = new Map<string, MikeDocument>();
        for (const d of [
            ...standaloneDocuments,
            ...extraUploadedDocs,
            ...projects.flatMap((p) => p.documents ?? []),
        ]) {
            docsById.set(d.id, d);
        }
        const owned = ids.filter((id) => {
            const d = docsById.get(id);
            return !d || !d.user_id || !user?.id || d.user_id === user.id;
        });
        const blocked = ids.length - owned.length;
        if (owned.length === 0 && blocked > 0) {
            setOwnerOnlyAction(
                "delete these documents — only the document creator can delete a document",
            );
            return;
        }
        const idSet = new Set(owned);
        try {
            await Promise.all(owned.map((id) => deleteDocument(id)));
        } catch (err) {
            console.error("Delete failed:", err);
            return;
        }
        invalidateDirectoryCache();
        setExtraUploadedDocs((prev) => prev.filter((d) => !idSet.has(d.id)));
        setDeletedIds((prev) => {
            const next = new Set(prev);
            owned.forEach((id) => next.add(id));
            return next;
        });
        if (blocked > 0) {
            setOwnerOnlyAction(
                `delete ${blocked} of the selected documents — only the document creator can delete a document`,
            );
        }
    }

    async function uploadFiles(files: File[]) {
        if (!files.length) return;
        const supportedFiles = getSupportedUploadFiles(files);
        if (!supportedFiles.length) {
            setUploadError("Only PDF, DOC, and DOCX files are supported.");
            return;
        }
        setUploadError(null);
        setUploading(true);
        try {
            const uploaded = await Promise.all(
                supportedFiles.map((f) =>
                    projectId
                        ? uploadProjectDocument(projectId, f)
                        : uploadStandaloneDocument(f),
                ),
            );
            invalidateDirectoryCache();
            setExtraUploadedDocs((prev) => [...uploaded, ...prev]);
            uploaded.forEach((d) =>
                setSelectedIds((prev) => new Set([...prev, d.id])),
            );
            if (supportedFiles.length < files.length) {
                setUploadError(
                    "Some files were skipped because only PDF, DOC, and DOCX files are supported.",
                );
            }
        } catch (err) {
            console.error("Upload failed:", err);
            setUploadError("Upload failed. Please try again.");
        } finally {
            setUploading(false);
            if (fileInputRef.current) fileInputRef.current.value = "";
        }
    }

    async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
        await uploadFiles(Array.from(e.target.files || []));
    }

    function handleDragEnter(e: React.DragEvent<HTMLDivElement>) {
        if (!Array.from(e.dataTransfer.types).includes("Files")) return;
        e.preventDefault();
        setIsDraggingFiles(true);
    }

    function handleDragOver(e: React.DragEvent<HTMLDivElement>) {
        if (!Array.from(e.dataTransfer.types).includes("Files")) return;
        e.preventDefault();
    }

    function handleDragLeave(e: React.DragEvent<HTMLDivElement>) {
        const nextTarget = e.relatedTarget;
        if (nextTarget instanceof Node && e.currentTarget.contains(nextTarget)) {
            return;
        }
        setIsDraggingFiles(false);
    }

    async function handleDrop(e: React.DragEvent<HTMLDivElement>) {
        e.preventDefault();
        setIsDraggingFiles(false);
        await uploadFiles(Array.from(e.dataTransfer.files || []));
    }

    return createPortal(
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/10 backdrop-blur-xs">
            <div
                className={`relative w-full max-w-2xl rounded-2xl bg-white shadow-2xl flex flex-col h-[600px] transition-colors ${
                    isDraggingFiles ? "ring-2 ring-gray-900 ring-offset-2" : ""
                }`}
                onDragEnter={handleDragEnter}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
            >
                {isDraggingFiles && (
                    <div className="pointer-events-none absolute inset-3 z-10 flex items-center justify-center rounded-xl border-2 border-dashed border-gray-900 bg-white/85 text-sm font-medium text-gray-900">
                        Drop PDF or Word files to upload
                    </div>
                )}
                {/* Header */}
                <div className="flex items-center justify-between px-5 py-4">
                    <div className="flex items-center gap-1.5 text-xs text-gray-400">
                        {breadcrumb.map((segment, i) => (
                            <span key={i} className="flex items-center gap-1.5">
                                {i > 0 && <span>›</span>}
                                {segment}
                            </span>
                        ))}
                    </div>
                    <button
                        onClick={onClose}
                        className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>

                {/* Search bar */}
                <div className="px-4 pt-1 pb-2">
                    <div className="flex items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
                        <Search className="h-3.5 w-3.5 text-gray-400 shrink-0" />
                        <input
                            type="text"
                            placeholder="Search…"
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            className="flex-1 bg-transparent text-sm text-gray-700 placeholder:text-gray-400 outline-none"
                            autoFocus
                        />
                        {search && (
                            <button
                                onClick={() => setSearch("")}
                                className="text-gray-400 hover:text-gray-600"
                            >
                                <X className="h-3.5 w-3.5" />
                            </button>
                        )}
                    </div>
                </div>

                {/* File browser */}
                <div className="flex-1 overflow-y-auto px-4 pb-2">
                    <FileDirectory
                        standaloneDocs={filteredStandalone}
                        directoryProjects={filteredProjects}
                        loading={loading}
                        selectedIds={selectedIds}
                        onChange={setSelectedIds}
                        allowMultiple={allowMultiple}
                        forceExpanded={!!q}
                        emptyMessage={
                            q ? "No matches found" : "No documents yet"
                        }
                        onDelete={handleDelete}
                    />
                </div>

                {/* Footer */}
                <div className="border-t border-gray-100 px-4 py-3 flex items-center justify-between gap-3">
                    <div>
                        <input
                            ref={fileInputRef}
                            type="file"
                            accept=".pdf,.docx,.doc"
                            multiple
                            className="hidden"
                            onChange={handleUpload}
                        />
                        <button
                            onClick={() => fileInputRef.current?.click()}
                            disabled={uploading}
                            className="flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-50"
                        >
                            {uploading ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                                <Upload className="h-3.5 w-3.5" />
                            )}
                            {uploading ? "Uploading…" : "Upload"}
                        </button>
                    </div>
                    {uploadError && (
                        <p className="max-w-[260px] text-xs text-red-600">
                            {uploadError}
                        </p>
                    )}
                    <div className="flex items-center gap-2">
                        {selectedIds.size > 0 && (
                            <span className="text-xs text-gray-400">
                                {selectedIds.size} selected
                            </span>
                        )}
                        <button
                            onClick={onClose}
                            className="rounded-lg px-3 py-1.5 text-sm text-gray-500 hover:bg-gray-100"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={handleConfirm}
                            disabled={selectedIds.size === 0 || uploading}
                            className="rounded-lg bg-gray-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-40"
                        >
                            {uploading ? "Saving…" : "Confirm"}
                        </button>
                    </div>
                </div>
            </div>
            <OwnerOnlyModal
                open={!!ownerOnlyAction}
                action={ownerOnlyAction ?? undefined}
                onClose={() => setOwnerOnlyAction(null)}
            />
        </div>,
        document.body,
    );
}
