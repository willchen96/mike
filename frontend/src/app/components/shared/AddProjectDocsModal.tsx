"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Loader2, Search, Upload, X } from "lucide-react";
import { getProject, uploadProjectDocument } from "@/app/lib/mikeApi";
import type { MikeDocument } from "./types";
import { DocFileIcon } from "./FileDirectory";
import { VersionChip } from "./VersionChip";

interface Props {
    open: boolean;
    onClose: () => void;
    onSelect: (documents: MikeDocument[]) => void;
    breadcrumb: string[];
    projectId: string;
    /** Docs already in the target list — rendered checked + disabled. */
    excludeDocIds?: Set<string>;
    allowMultiple?: boolean;
}

function formatDate(iso: string | null) {
    if (!iso) return null;
    return new Date(iso).toLocaleDateString(undefined, {
        day: "numeric",
        month: "short",
        year: "numeric",
    });
}

export function AddProjectDocsModal({
    open,
    onClose,
    onSelect,
    breadcrumb,
    projectId,
    excludeDocIds,
    allowMultiple = true,
}: Props) {
    const [docs, setDocs] = useState<MikeDocument[]>([]);
    const [loading, setLoading] = useState(false);
    const [search, setSearch] = useState("");
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [uploading, setUploading] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (!open) return;
        setSearch("");
        setSelectedIds(new Set());
        let cancelled = false;
        setLoading(true);
        getProject(projectId)
            .then((p) => {
                if (!cancelled) setDocs(p.documents ?? []);
            })
            .catch(() => {
                if (!cancelled) setDocs([]);
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [open, projectId]);

    if (!open) return null;

    const q = search.toLowerCase().trim();
    const filtered = q
        ? docs.filter((d) => d.filename.toLowerCase().includes(q))
        : docs;

    const isExcluded = (id: string) => !!excludeDocIds?.has(id);

    function toggle(id: string) {
        if (isExcluded(id)) return;
        if (!allowMultiple) {
            setSelectedIds(new Set([id]));
            return;
        }
        setSelectedIds((prev) => {
            const next = new Set(prev);
            next.has(id) ? next.delete(id) : next.add(id);
            return next;
        });
    }

    function handleConfirm() {
        const selected = docs.filter((d) => selectedIds.has(d.id));
        onSelect(selected);
        onClose();
    }

    async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
        const files = Array.from(e.target.files || []);
        if (!files.length) return;
        setUploading(true);
        try {
            const uploaded = await Promise.all(
                files.map((f) => uploadProjectDocument(projectId, f)),
            );
            setDocs((prev) => [...uploaded, ...prev]);
            setSelectedIds((prev) => {
                const next = new Set(prev);
                uploaded.forEach((d) => next.add(d.id));
                return next;
            });
        } catch (err) {
            console.error("Upload failed:", err);
        } finally {
            setUploading(false);
            if (fileInputRef.current) fileInputRef.current.value = "";
        }
    }

    return createPortal(
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-[#292629]/10 backdrop-blur-xs">
            <div className="w-full max-w-2xl rounded-2xl bg-white shadow-2xl flex flex-col h-[600px]">
                {/* Header */}
                <div className="flex items-center justify-between px-5 py-4">
                    <div className="flex items-center gap-1.5 text-xs text-[#292629]/40">
                        {breadcrumb.map((segment, i) => (
                            <span
                                key={i}
                                className="flex items-center gap-1.5"
                            >
                                {i > 0 && <span>›</span>}
                                {segment}
                            </span>
                        ))}
                    </div>
                    <button
                        onClick={onClose}
                        className="rounded-lg p-1.5 text-[#292629]/40 hover:bg-[#F5F5F5] hover:text-[#292629]/60"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>

                {/* Search */}
                <div className="px-4 pt-1 pb-2">
                    <div className="flex items-center gap-2 rounded-lg border border-[#C7C7B2] bg-[#F5F5F5] px-3 py-2">
                        <Search className="h-3.5 w-3.5 text-[#292629]/40 shrink-0" />
                        <input
                            type="text"
                            placeholder="Search…"
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            className="flex-1 bg-transparent text-sm text-[#292629]/80 placeholder:text-[#292629]/40 outline-none"
                            autoFocus
                        />
                        {search && (
                            <button
                                onClick={() => setSearch("")}
                                className="text-[#292629]/40 hover:text-[#292629]/60"
                            >
                                <X className="h-3.5 w-3.5" />
                            </button>
                        )}
                    </div>
                </div>

                {/* File list */}
                <div className="flex-1 overflow-y-auto px-4 pb-2">
                    {loading ? (
                        <div className="rounded-sm border border-[#C7C7B2]/50 overflow-hidden">
                            {[60, 45, 75, 55, 40].map((w, i) => (
                                <div
                                    key={i}
                                    className="flex items-center gap-2 px-2 py-2"
                                >
                                    <div className="h-3.5 w-3.5 rounded border border-[#C7C7B2] shrink-0" />
                                    <div className="h-3.5 w-3.5 rounded bg-[#C7C7B2]/40 animate-pulse shrink-0" />
                                    <div
                                        className="h-3 rounded bg-[#C7C7B2]/40 animate-pulse"
                                        style={{ width: `${w}%` }}
                                    />
                                </div>
                            ))}
                        </div>
                    ) : filtered.length === 0 ? (
                        <p className="text-center text-sm text-[#292629]/40 py-8">
                            {q ? "No matches found" : "No documents in this project"}
                        </p>
                    ) : (
                        <div className="rounded-sm border border-[#C7C7B2]/50 overflow-hidden">
                            {filtered.map((doc) => {
                                const excluded = isExcluded(doc.id);
                                const checked =
                                    excluded || selectedIds.has(doc.id);
                                return (
                                    <button
                                        type="button"
                                        key={doc.id}
                                        disabled={excluded}
                                        onClick={() => toggle(doc.id)}
                                        className={`w-full flex items-center gap-2 px-2 py-2 text-xs text-left transition-colors ${
                                            excluded
                                                ? "opacity-50 cursor-not-allowed"
                                                : checked
                                                  ? "bg-[#F5F5F5]"
                                                  : "hover:bg-[#F5F5F5]"
                                        }`}
                                    >
                                        <span
                                            className={`shrink-0 h-3.5 w-3.5 rounded border flex items-center justify-center ${
                                                checked
                                                    ? "bg-[#292629] border-[#292629]"
                                                    : "border-[#C7C7B2]"
                                            }`}
                                        >
                                            {checked && (
                                                <Check className="h-2.5 w-2.5 text-white" />
                                            )}
                                        </span>
                                        <DocFileIcon
                                            fileType={doc.file_type}
                                        />
                                        <span
                                            className={`flex-1 truncate ${
                                                checked
                                                    ? "text-[#292629]"
                                                    : "text-[#292629]/80"
                                            }`}
                                        >
                                            {doc.filename}
                                        </span>
                                        {excluded && (
                                            <span className="text-[10px] text-[#292629]/40 shrink-0">
                                                Already added
                                            </span>
                                        )}
                                        <VersionChip
                                            n={doc.latest_version_number}
                                        />
                                        {doc.created_at && (
                                            <span className="shrink-0 text-[#292629]/30">
                                                {formatDate(doc.created_at)}
                                            </span>
                                        )}
                                    </button>
                                );
                            })}
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div className="border-t border-[#C7C7B2]/50 px-4 py-3 flex items-center justify-between gap-3">
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
                            className="flex items-center gap-1.5 rounded-lg border border-[#C7C7B2] px-3 py-1.5 text-sm text-[#292629]/60 hover:bg-[#F5F5F5] disabled:opacity-50"
                        >
                            {uploading ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                                <Upload className="h-3.5 w-3.5" />
                            )}
                            {uploading ? "Uploading…" : "Upload"}
                        </button>
                    </div>
                    <div className="flex items-center gap-2">
                        {selectedIds.size > 0 && (
                            <span className="text-xs text-[#292629]/40">
                                {selectedIds.size} selected
                            </span>
                        )}
                        <button
                            onClick={onClose}
                            className="rounded-lg px-3 py-1.5 text-sm text-[#292629]/50 hover:bg-[#F5F5F5]"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={handleConfirm}
                            disabled={selectedIds.size === 0 || uploading}
                            className="rounded-lg bg-[#292629] px-4 py-1.5 text-sm font-medium text-white hover:bg-[#292629]/90 disabled:opacity-40"
                        >
                            Confirm
                        </button>
                    </div>
                </div>
            </div>
        </div>,
        document.body,
    );
}
