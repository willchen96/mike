"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
    Upload,
    Plus,
    Loader2,
    FileText,
    File,
    AlertCircle,
    ChevronDown,
    ChevronRight,
    Download,
    Folder,
    FolderOpen,
    FolderPlus,
    MessageSquare,
    Pencil,
    Table2,
    Users,
} from "lucide-react";
import { HeaderSearchBtn } from "@/app/components/shared/HeaderSearchBtn";
import {
    getProject,
    deleteDocument,
    createTabularReview,
    updateProject,
    listProjectChats,
    deleteChat,
    renameChat,
    listTabularReviews,
    deleteTabularReview,
    updateTabularReview,
    getDocumentUrl,
    downloadDocumentsZip,
    createProjectFolder,
    renameProjectFolder,
    deleteProjectFolder,
    moveDocumentToFolder,
    moveSubfolderToFolder,
    listDocumentVersions,
    uploadDocumentVersion,
    renameDocumentVersion,
    getProjectPeople,
    type MikeDocumentVersion,
} from "@/app/lib/mikeApi";
import type {
    MikeDocument,
    MikeFolder,
    MikeProject,
    MikeChat,
    TabularReview,
} from "@/app/components/shared/types";
import { ToolbarTabs } from "@/app/components/shared/ToolbarTabs";
import { RenameableTitle } from "@/app/components/shared/RenameableTitle";
import { RowActions } from "@/app/components/shared/RowActions";
import { AddDocumentsModal } from "@/app/components/shared/AddDocumentsModal";
import { PeopleModal } from "@/app/components/shared/PeopleModal";
import { OwnerOnlyModal } from "@/app/components/shared/OwnerOnlyModal";
import { useAuth } from "@/contexts/AuthContext";
import { UploadNewVersionModal } from "@/app/components/shared/UploadNewVersionModal";
import { DocViewModal } from "@/app/components/shared/DocViewModal";
import { AddNewTRModal } from "@/app/components/tabular/AddNewTRModal";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";

interface Props {
    projectId: string;
}

type Tab = "documents" | "assistant" | "reviews";

type ContextMenu = {
    x: number;
    y: number;
    folderId: string | null;       // null = right-clicked on root/empty space
    showFolderActions: boolean;    // true when right-clicked on a specific folder row
};

const CHECK_W = "w-8 shrink-0";
const NAME_COL_W = "w-[300px] shrink-0";

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string) {
    return new Date(iso).toLocaleDateString(undefined, {
        day: "numeric",
        month: "short",
        year: "numeric",
    });
}

function DocIcon({ fileType }: { fileType: string | null }) {
    if (fileType === "pdf")
        return <FileText className="h-4 w-4 text-red-600 shrink-0" />;
    if (fileType === "docx" || fileType === "doc")
        return <File className="h-4 w-4 text-[#898344] shrink-0" />;
    return <File className="h-4 w-4 text-[#292629]/50 shrink-0" />;
}

/**
 * Stacked rows rendered beneath a doc row when its Version column is
 * expanded. Each row shows a past (or current) version with its number,
 * source, date, and a download button that fetches that specific version.
 */
function DocVersionHistory({
    docId,
    filename,
    loading,
    versions,
    onDownloadVersion,
    onOpenVersion,
    onRenameVersion,
}: {
    docId: string;
    filename: string;
    loading: boolean;
    versions: MikeDocumentVersion[];
    onDownloadVersion: (
        docId: string,
        versionId: string,
        filename: string,
    ) => void;
    onOpenVersion?: (
        versionId: string,
        versionLabel: string,
    ) => void;
    onRenameVersion?: (
        versionId: string,
        displayName: string | null,
    ) => Promise<void> | void;
}) {
    const [editingVersionId, setEditingVersionId] = useState<string | null>(
        null,
    );
    const [editingValue, setEditingValue] = useState("");

    const commit = async (versionId: string) => {
        const trimmed = editingValue.trim();
        setEditingVersionId(null);
        // Empty string → clear override (falls back to V{n})
        const next = trimmed.length > 0 ? trimmed : null;
        await onRenameVersion?.(versionId, next);
    };
    if (loading && versions.length === 0) {
        return (
            <div className="flex items-center h-9 border-b border-[#C7C7B2]/30 text-xs text-[#292629]/50 bg-[#F5F5F5]/60">
                <div className={`sticky left-0 z-[60] ${CHECK_W} bg-[#F5F5F5]/60 self-stretch`} />
                <div className={`sticky left-8 z-[60] ${NAME_COL_W} bg-[#F5F5F5]/60 p-2`}>
                    <div className="flex items-center gap-2">
                        <Loader2 className="h-3 w-3 animate-spin text-[#292629]/40" />
                        <span>Loading versions…</span>
                    </div>
                </div>
            </div>
        );
    }
    if (versions.length === 0) {
        return (
            <div className="flex items-center h-9 border-b border-[#C7C7B2]/30 text-xs text-[#292629]/40 bg-[#F5F5F5]/60">
                <div className={`sticky left-0 z-[60] ${CHECK_W} bg-[#F5F5F5]/60 self-stretch`} />
                <div className={`sticky left-8 z-[60] ${NAME_COL_W} bg-[#F5F5F5]/60 p-2`}>
                    <div>
                        No version history.
                    </div>
                </div>
            </div>
        );
    }
    // Most recent version first.
    const ordered = [...versions].reverse();
    return (
        <>
            {ordered.map((v) => {
                const numberLabel =
                    typeof v.version_number === "number" && v.version_number >= 1
                        ? `${v.version_number}`
                        : v.source === "upload"
                          ? "Original"
                          : "—";
                const displayLabel = v.display_name?.trim() || numberLabel;
                const dt = new Date(v.created_at);
                const dateLabel = Number.isNaN(dt.valueOf())
                    ? ""
                    : dt.toLocaleString(undefined, {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                          hour: "numeric",
                          minute: "2-digit",
                      });
                const isEditing = editingVersionId === v.id;
                return (
                    <div
                        key={`ver-${docId}-${v.id}`}
                        onClick={() => {
                            if (isEditing) return;
                            onOpenVersion?.(v.id, displayLabel);
                        }}
                        className="group flex items-center h-9 pr-8 border-b border-[#C7C7B2]/30 bg-[#F5F5F5]/60 text-xs text-[#292629]/60 cursor-pointer hover:bg-[#F5F5F5] transition-colors"
                    >
                        <div className={`sticky left-0 z-[60] ${CHECK_W} bg-[#F5F5F5]/60 group-hover:bg-[#F5F5F5] self-stretch`} />
                        <div className={`sticky left-8 z-[60] ${NAME_COL_W} bg-[#F5F5F5]/60 group-hover:bg-[#F5F5F5] p-2`}>
                        <div className="flex items-center gap-2">
                            <span className="shrink-0 text-[#292629]/40">↳</span>
                            {isEditing ? (
                                <input
                                    autoFocus
                                    value={editingValue}
                                    onClick={(e) => e.stopPropagation()}
                                    onChange={(e) =>
                                        setEditingValue(e.target.value)
                                    }
                                    onKeyDown={(e) => {
                                        if (e.key === "Enter") {
                                            e.preventDefault();
                                            void commit(v.id);
                                        } else if (e.key === "Escape") {
                                            setEditingVersionId(null);
                                        }
                                    }}
                                    onBlur={() => void commit(v.id)}
                                    className="min-w-0 flex-1 max-w-[240px] border-b border-[#C7C7B2] bg-transparent text-xs text-[#292629]/90 outline-none focus:border-[#898344]"
                                />
                            ) : (
                                <span className="font-medium text-[#292629]/80 truncate">
                                    {displayLabel}
                                </span>
                            )}
                            {!isEditing && onRenameVersion && (
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        setEditingVersionId(v.id);
                                        setEditingValue(v.display_name ?? "");
                                    }}
                                    title="Rename version"
                                    className="shrink-0 rounded p-0.5 text-[#292629]/40 opacity-0 group-hover:opacity-100 hover:text-[#292629]/80 hover:bg-[#C7C7B2]/40 transition"
                                >
                                    <Pencil className="h-3 w-3" />
                                </button>
                            )}
                            <span className="text-[#292629]/40 truncate">{dateLabel}</span>
                            <span className="text-[#292629]/30 shrink-0">·</span>
                            <span className="text-[#292629]/40 truncate">{v.source}</span>
                        </div>
                        </div>
                        <div className="ml-auto w-20 shrink-0" />
                        <div className="w-24 shrink-0" />
                        <div className="ml-auto w-20 shrink-0" />
                        <div className="w-8 shrink-0 flex justify-end">
                            <button
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onDownloadVersion(docId, v.id, filename);
                                }}
                                title="Download this version"
                                className="flex items-center justify-center w-6 h-6 rounded text-[#292629]/50 hover:text-[#292629]/90 hover:bg-[#F5F5F5] transition-colors"
                            >
                                <Download className="h-3.5 w-3.5" />
                            </button>
                        </div>
                    </div>
                );
            })}
        </>
    );
}

export function ProjectPage({ projectId }: Props) {
    const [project, setProject] = useState<MikeProject | null>(null);
    const [folders, setFolders] = useState<MikeFolder[]>([]);
    const [chats, setChats] = useState<MikeChat[]>([]);
    const [projectReviews, setProjectReviews] = useState<TabularReview[]>([]);
    const [loading, setLoading] = useState(true);
    const searchParams = useSearchParams();
    const tabParam = searchParams.get("tab");
    const tab: Tab =
        tabParam === "assistant" || tabParam === "reviews"
            ? tabParam
            : "documents";
    const [addDocsOpen, setAddDocsOpen] = useState(false);
    const [peopleModalOpen, setPeopleModalOpen] = useState(false);
    const [ownerOnlyAction, setOwnerOnlyAction] = useState<string | null>(null);
    const { user } = useAuth();
    const [uploadVersionDoc, setUploadVersionDoc] =
        useState<MikeDocument | null>(null);
    const [viewingDoc, setViewingDoc] = useState<MikeDocument | null>(null);
    const [viewingDocVersion, setViewingDocVersion] = useState<{
        id: string;
        label: string;
    } | null>(null);
    const [creatingChat, setCreatingChat] = useState(false);
    const [creatingReview, setCreatingReview] = useState(false);
    const [newTRModalOpen, setNewTRModalOpen] = useState(false);

    // Per-tab selection
    const [selectedDocIds, setSelectedDocIds] = useState<string[]>([]);
    const [selectedChatIds, setSelectedChatIds] = useState<string[]>([]);
    const [selectedReviewIds, setSelectedReviewIds] = useState<string[]>([]);

    // Version-history expansion (per-doc). versionsByDocId caches fetched
    // versions so toggling closed + open again doesn't refetch. loadingIds
    // drives the inline spinner in the version cell while a fetch is in
    // flight.
    const [expandedVersionDocIds, setExpandedVersionDocIds] = useState<
        Set<string>
    >(() => new Set());
    const [versionsByDocId, setVersionsByDocId] = useState<
        Map<string, MikeDocumentVersion[]>
    >(() => new Map());
    const [loadingVersionDocIds, setLoadingVersionDocIds] = useState<
        Set<string>
    >(() => new Set());

    const toggleVersions = async (docId: string) => {
        const already = expandedVersionDocIds.has(docId);
        if (already) {
            setExpandedVersionDocIds((prev) => {
                const next = new Set(prev);
                next.delete(docId);
                return next;
            });
            return;
        }
        // Opening — expand immediately so the user sees a loading state.
        setExpandedVersionDocIds((prev) => new Set([...prev, docId]));
        if (versionsByDocId.has(docId)) return;
        setLoadingVersionDocIds((prev) => new Set([...prev, docId]));
        try {
            const res = await listDocumentVersions(docId);
            setVersionsByDocId((prev) => {
                const next = new Map(prev);
                next.set(docId, res.versions);
                return next;
            });
        } catch (e) {
            console.error("listDocumentVersions failed", e);
        } finally {
            setLoadingVersionDocIds((prev) => {
                const next = new Set(prev);
                next.delete(docId);
                return next;
            });
        }
    };

    async function downloadDocVersion(
        docId: string,
        versionId: string,
        filename: string,
    ) {
        try {
            const resolved = await getDocumentUrl(docId, versionId);
            const a = document.createElement("a");
            a.href = resolved.url;
            // Prefer the backend's resolved filename (which honours the
            // version's display_name). Fall back to the passed filename
            // if for some reason it's missing.
            a.download = resolved.filename || filename;
            a.click();
        } catch (e) {
            console.error("downloadDocVersion failed", e);
        }
    }

    /**
     * Trigger a file picker and upload the chosen file as a new version of
     * the given document. On success, refresh the project (for the doc's
     * latest_version_number) and re-fetch the version list so the history
     * panel shows the new row.
     */
    function handleUploadNewVersion(doc: MikeDocument) {
        setUploadVersionDoc(doc);
    }

    async function submitNewVersion(
        doc: MikeDocument,
        file: File,
        displayName: string,
    ) {
        try {
            await uploadDocumentVersion(doc.id, file, displayName);
            // Refresh project so doc.latest_version_number and filename advance.
            const updated = await getProject(projectId);
            setProject(updated);
            // Re-fetch versions for this doc (invalidate cache first).
            setVersionsByDocId((prev) => {
                const next = new Map(prev);
                next.delete(doc.id);
                return next;
            });
            // Ensure the history panel is expanded so the user sees it.
            setExpandedVersionDocIds((prev) => new Set([...prev, doc.id]));
            const res = await listDocumentVersions(doc.id);
            setVersionsByDocId((prev) => {
                const next = new Map(prev);
                next.set(doc.id, res.versions);
                return next;
            });
        } catch (e) {
            console.error("uploadDocumentVersion failed", e);
        }
    }

    /**
     * Patch a version's display_name and update the local cache in place.
     */
    async function handleRenameVersion(
        docId: string,
        versionId: string,
        displayName: string | null,
    ) {
        try {
            const updated = await renameDocumentVersion(
                docId,
                versionId,
                displayName,
            );
            setVersionsByDocId((prev) => {
                const list = prev.get(docId);
                if (!list) return prev;
                const next = new Map(prev);
                next.set(
                    docId,
                    list.map((v) => (v.id === versionId ? updated : v)),
                );
                return next;
            });
        } catch (e) {
            console.error("renameDocumentVersion failed", e);
        }
    }

    // Inline rename for chats and reviews
    const [renamingChatId, setRenamingChatId] = useState<string | null>(null);
    const [renameChatValue, setRenameChatValue] = useState("");
    const [renamingReviewId, setRenamingReviewId] = useState<string | null>(null);
    const [renameReviewValue, setRenameReviewValue] = useState("");

    // Folder state
    const [expandedFolderIds, setExpandedFolderIds] = useState<Set<string>>(new Set());
    // undefined = not creating; null = creating at root; string = creating inside that folder id
    const [creatingFolderIn, setCreatingFolderIn] = useState<string | null | undefined>(undefined);
    const [newFolderName, setNewFolderName] = useState("");
    const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
    const [renameFolderValue, setRenameFolderValue] = useState("");
    const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);
    const contextMenuRef = useRef<HTMLDivElement>(null);
    const newFolderInputRef = useRef<HTMLDivElement | null>(null);
    const [dragOverFolderId, setDragOverFolderId] = useState<string | null>(null);
    const [dragOverRoot, setDragOverRoot] = useState(false);

    // Actions dropdown
    const [actionsOpen, setActionsOpen] = useState(false);
    const actionsRef = useRef<HTMLDivElement>(null);
    const [search, setSearch] = useState("");

    const router = useRouter();
    const { saveChat } = useChatHistoryContext();

    function handleTabChange(newTab: Tab) {
        const base = `/projects/${projectId}`;
        const url = newTab === "documents" ? base : `${base}?tab=${newTab}`;
        router.push(url);
    }

    useEffect(() => {
        Promise.all([
            getProject(projectId),
            listProjectChats(projectId).catch(() => [] as MikeChat[]),
            listTabularReviews(projectId).catch(() => []),
        ])
            .then(([proj, projectChats, projectReviews]) => {
                setProject(proj);
                const loadedFolders = proj.folders ?? [];
                setFolders(loadedFolders);
                setExpandedFolderIds(new Set(loadedFolders.map((f) => f.id)));
                setChats(projectChats);
                setProjectReviews(projectReviews);
            })
            .finally(() => setLoading(false));
    }, [projectId]);

    // Reset selection and close dropdowns when tab changes
    useEffect(() => {
        setSelectedDocIds([]);
        setSelectedChatIds([]);
        setSelectedReviewIds([]);
        setActionsOpen(false);
        setContextMenu(null);
    }, [tab]);

    useEffect(() => {
        function handleClick(e: MouseEvent) {
            if (actionsRef.current && !actionsRef.current.contains(e.target as Node))
                setActionsOpen(false);
        }
        if (actionsOpen) document.addEventListener("mousedown", handleClick);
        return () => document.removeEventListener("mousedown", handleClick);
    }, [actionsOpen]);

    // Close context menu on outside click
    useEffect(() => {
        if (!contextMenu) return;
        function handle(e: MouseEvent) {
            if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node))
                setContextMenu(null);
        }
        document.addEventListener("mousedown", handle);
        return () => document.removeEventListener("mousedown", handle);
    }, [contextMenu]);

    // Clear all drag state when any drag operation ends
    useEffect(() => {
        function handleDragEnd() {
            setDragOverFolderId(null);
            setDragOverRoot(false);
        }
        document.addEventListener("dragend", handleDragEnd);
        return () => document.removeEventListener("dragend", handleDragEnd);
    }, []);

    // Scroll new-folder input into view whenever it appears
    useEffect(() => {
        if (creatingFolderIn !== undefined) {
            newFolderInputRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
        }
    }, [creatingFolderIn]);

    // ── Folder handlers ───────────────────────────────────────────────────────

    function toggleFolder(id: string) {
        setExpandedFolderIds((prev) => {
            const next = new Set(prev);
            next.has(id) ? next.delete(id) : next.add(id);
            return next;
        });
    }

    async function handleCreateFolder(parentId: string | null) {
        const name = newFolderName.trim();
        setNewFolderName("");
        if (!name) { setCreatingFolderIn(undefined); return; }

        // Immediately hide the input and show an optimistic folder row
        setCreatingFolderIn(undefined);
        const tempId = `temp-${Date.now()}`;
        const optimistic: MikeFolder = {
            id: tempId,
            project_id: projectId,
            user_id: "",
            name,
            parent_folder_id: parentId,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
        };
        setFolders((prev) => [...prev, optimistic]);
        setExpandedFolderIds((prev) => new Set([...prev, tempId]));
        if (parentId) setExpandedFolderIds((prev) => new Set([...prev, parentId]));

        // Replace with real folder from API
        const folder = await createProjectFolder(projectId, name, parentId ?? undefined);
        setFolders((prev) => prev.map((f) => f.id === tempId ? folder : f));
        setExpandedFolderIds((prev) => {
            const next = new Set(prev);
            next.delete(tempId);
            next.add(folder.id);
            return next;
        });
    }

    async function handleRenameFolder(folderId: string) {
        const name = renameFolderValue.trim();
        setRenamingFolderId(null);
        if (!name) return;
        setFolders((prev) => prev.map((f) => f.id === folderId ? { ...f, name } : f));
        await renameProjectFolder(projectId, folderId, name);
    }

    async function handleDeleteFolder(folderId: string) {
        // Collect all subfolder IDs that will cascade-delete
        const toDelete = new Set<string>();
        function collectIds(id: string) {
            toDelete.add(id);
            folders.filter((f) => f.parent_folder_id === id).forEach((f) => collectIds(f.id));
        }
        collectIds(folderId);

        setFolders((prev) => prev.filter((f) => !toDelete.has(f.id)));
        setProject((prev) =>
            prev ? {
                ...prev,
                documents: (prev.documents ?? []).map((d) =>
                    d.folder_id && toDelete.has(d.folder_id) ? { ...d, folder_id: null } : d,
                ),
            } : prev,
        );
        await deleteProjectFolder(projectId, folderId);
    }

    // ── Doc/chat/review handlers ──────────────────────────────────────────────

    function handleDocsSelected(newDocs: MikeDocument[]) {
        setProject((prev) =>
            prev ? {
                ...prev,
                documents: [
                    ...(prev.documents || []),
                    ...newDocs.filter((d) => !prev.documents?.some((e) => e.id === d.id)),
                ],
            } : prev,
        );
    }

    async function handleRemoveDocFromFolder(docId: string) {
        setProject((prev) => prev ? {
            ...prev,
            documents: (prev.documents ?? []).map((d) =>
                d.id === docId ? { ...d, folder_id: null } : d,
            ),
        } : prev);
        await moveDocumentToFolder(projectId, docId, null);
    }

    async function handleRemoveDoc(docId: string) {
        const doc = project?.documents?.find((d) => d.id === docId);
        // Backend only lets the doc creator delete. Warn the requester
        // instead of letting the request 404 silently.
        if (doc && user?.id && doc.user_id && doc.user_id !== user.id) {
            setOwnerOnlyAction("delete this document");
            return;
        }
        await deleteDocument(docId);
        setProject((prev) =>
            prev ? { ...prev, documents: prev.documents?.filter((d) => d.id !== docId) || [] } : prev,
        );
    }

    async function handleNewChat() {
        setCreatingChat(true);
        try {
            const id = await saveChat(projectId);
            if (id) router.push(`/projects/${projectId}/assistant/chat/${id}`);
        } finally {
            setCreatingChat(false);
        }
    }

    function handleNewReview() {
        const docs = project?.documents?.filter((d) => d.status === "ready") || [];
        if (docs.length === 0) return;
        setNewTRModalOpen(true);
    }

    async function handleCreateReview(
        title: string,
        _projectId?: string,
        documentIds?: string[],
        columnsConfig?: any,
    ) {
        setCreatingReview(true);
        try {
            const docs = project?.documents?.filter((d) => d.status === "ready") || [];
            const review = await createTabularReview({
                title: title || undefined,
                document_ids: documentIds ?? docs.map((d) => d.id),
                columns_config: columnsConfig ?? [],
                project_id: projectId,
            });
            router.push(`/projects/${projectId}/tabular-reviews/${review.id}`);
        } finally {
            setCreatingReview(false);
        }
    }

    async function handleTitleCommit(newName: string) {
        if (!newName || newName === project?.name) return;
        // Server-side this would 404 silently for non-owners; surface a
        // clear permission warning instead.
        if (project && project.is_owner === false) {
            setOwnerOnlyAction("rename this project");
            return;
        }
        setProject((prev) => (prev ? { ...prev, name: newName } : prev));
        await updateProject(projectId, { name: newName });
    }

    async function submitChatRename(chatId: string) {
        const trimmed = renameChatValue.trim();
        setRenamingChatId(null);
        if (!trimmed) return;
        const chat = chats.find((c) => c.id === chatId);
        if (chat && user?.id && chat.user_id !== user.id) {
            setOwnerOnlyAction("rename this chat");
            return;
        }
        setChats((prev) => prev.map((c) => (c.id === chatId ? { ...c, title: trimmed } : c)));
        await renameChat(chatId, trimmed);
    }

    async function submitReviewRename(reviewId: string) {
        const trimmed = renameReviewValue.trim();
        setRenamingReviewId(null);
        if (!trimmed) return;
        const review = projectReviews.find((r) => r.id === reviewId);
        if (review && user?.id && review.user_id !== user.id) {
            setOwnerOnlyAction("rename this tabular review");
            return;
        }
        setProjectReviews((prev) => prev.map((r) => (r.id === reviewId ? { ...r, title: trimmed } : r)));
        await updateTabularReview(reviewId, { title: trimmed });
    }

    async function downloadDoc(docId: string) {
        const { url, filename } = await getDocumentUrl(docId);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.click();
    }

    async function handleDownloadSelectedDocs() {
        setActionsOpen(false);
        const ids = [...selectedDocIds];
        if (ids.length === 1) { await downloadDoc(ids[0]); return; }
        const blob = await downloadDocumentsZip(ids);
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "documents.zip";
        a.click();
        URL.revokeObjectURL(a.href);
    }

    async function handleRemoveSelectedFromFolder() {
        const ids = selectedDocIds.filter((id) => docs.find((d) => d.id === id)?.folder_id != null);
        setActionsOpen(false);
        if (ids.length === 0) return;
        setProject((prev) => prev ? {
            ...prev,
            documents: (prev.documents ?? []).map((d) =>
                ids.includes(d.id) ? { ...d, folder_id: null } : d,
            ),
        } : prev);
        await Promise.all(ids.map((id) => moveDocumentToFolder(projectId, id, null).catch(() => {})));
    }

    async function handleDeleteSelectedDocs() {
        const ids = [...selectedDocIds];
        setActionsOpen(false);
        // Filter to docs the requester owns (server-side gate).
        const owned = ids.filter((id) => {
            const d = project?.documents?.find((dd) => dd.id === id);
            return !d || !d.user_id || !user?.id || d.user_id === user.id;
        });
        const blocked = ids.length - owned.length;
        setSelectedDocIds([]);
        await Promise.all(owned.map((id) => deleteDocument(id).catch(() => {})));
        setProject((prev) =>
            prev ? { ...prev, documents: prev.documents?.filter((d) => !owned.includes(d.id)) || [] } : prev,
        );
        if (blocked > 0) {
            setOwnerOnlyAction(
                `delete ${blocked} of the selected documents — only the document creator can delete a document`,
            );
        }
    }

    async function handleDeleteSelectedChats() {
        const ids = [...selectedChatIds];
        setActionsOpen(false);
        const owned = ids.filter((id) => {
            const c = chats.find((cc) => cc.id === id);
            return !c || !user?.id || c.user_id === user.id;
        });
        const blocked = ids.length - owned.length;
        setSelectedChatIds([]);
        await Promise.all(owned.map((id) => deleteChat(id).catch(() => {})));
        setChats((prev) => prev.filter((c) => !owned.includes(c.id)));
        if (blocked > 0) {
            setOwnerOnlyAction(
                `delete ${blocked} of the selected chats — only the chat creator can delete a chat`,
            );
        }
    }

    async function handleDeleteSelectedReviews() {
        const ids = [...selectedReviewIds];
        setActionsOpen(false);
        const owned = ids.filter((id) => {
            const r = projectReviews.find((rr) => rr.id === id);
            return !r || !user?.id || r.user_id === user.id;
        });
        const blocked = ids.length - owned.length;
        setSelectedReviewIds([]);
        await Promise.all(owned.map((id) => deleteTabularReview(id).catch(() => {})));
        setProjectReviews((prev) => prev.filter((r) => !owned.includes(r.id)));
        if (blocked > 0) {
            setOwnerOnlyAction(
                `delete ${blocked} of the selected reviews — only the review creator can delete a review`,
            );
        }
    }

    // ── Drag & drop ───────────────────────────────────────────────────────────

    function wouldCreateCycle(movingId: string, targetId: string): boolean {
        // Returns true if targetId is movingId or a descendant of it
        let cur: MikeFolder | undefined = folders.find((f) => f.id === targetId);
        while (cur) {
            if (cur.id === movingId) return true;
            if (!cur.parent_folder_id) break;
            cur = folders.find((f) => f.id === cur!.parent_folder_id);
        }
        return false;
    }

    async function handleDropOnFolder(targetFolderId: string | null, dt: DataTransfer) {
        const docId = dt.getData("application/mike-doc");
        const subFolderId = dt.getData("application/mike-folder");
        if (docId) {
            const doc = (project?.documents ?? []).find((d) => d.id === docId);
            if (!doc || (doc.folder_id ?? null) === targetFolderId) return;
            setProject((prev) => prev ? {
                ...prev,
                documents: (prev.documents ?? []).map((d) =>
                    d.id === docId ? { ...d, folder_id: targetFolderId } : d,
                ),
            } : prev);
            await moveDocumentToFolder(projectId, docId, targetFolderId);
        } else if (subFolderId && subFolderId !== targetFolderId) {
            if (targetFolderId !== null && wouldCreateCycle(subFolderId, targetFolderId)) return;
            const folder = folders.find((f) => f.id === subFolderId);
            if (!folder || (folder.parent_folder_id ?? null) === targetFolderId) return;
            setFolders((prev) => prev.map((f) =>
                f.id === subFolderId ? { ...f, parent_folder_id: targetFolderId } : f,
            ));
            await moveSubfolderToFolder(projectId, subFolderId, targetFolderId);
        }
    }

    // ── Tree rendering ────────────────────────────────────────────────────────

    function renderFolderInput(parentId: string | null) {
        if (creatingFolderIn !== parentId) return null;
        return (
            <div
                ref={newFolderInputRef}
                className="group flex items-center h-10 pr-8 border-b border-[#C7C7B2]/30"
                key={`new-folder-${parentId ?? "root"}`}
            >
                <div className={`sticky left-0 z-[60] ${CHECK_W} bg-white self-stretch`} />
                <div className={`sticky left-8 z-[60] ${NAME_COL_W} bg-white p-2`}>
                    <div className="flex items-center gap-1.5">
                        <ChevronRight className="h-3.5 w-3.5 text-[#292629]/30 shrink-0" />
                        <FolderPlus className="h-4 w-4 text-amber-400 shrink-0" />
                        <input
                            autoFocus
                            className="flex-1 min-w-0 text-sm text-[#292629]/90 bg-transparent outline-none border-b border-[#C7C7B2]"
                            placeholder="Folder name"
                            value={newFolderName}
                            onChange={(e) => setNewFolderName(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === "Enter") void handleCreateFolder(parentId);
                                if (e.key === "Escape") { setCreatingFolderIn(undefined); setNewFolderName(""); }
                            }}
                            onBlur={() => void handleCreateFolder(parentId)}
                        />
                    </div>
                </div>
                <div className="ml-auto w-20 shrink-0" />
                <div className="w-24 shrink-0" />
                <div className="w-20 shrink-0" />
                <div className="w-32 shrink-0" />
                <div className="w-32 shrink-0" />
                <div className="w-8 shrink-0" />
            </div>
        );
    }

    function renderLevel(parentId: string | null, depth: number) {
        const childFolders = folders
            .filter((f) => f.parent_folder_id === parentId)
            .sort((a, b) => a.name.localeCompare(b.name));
        const childDocs = (project?.documents ?? []).filter((d) => (d.folder_id ?? null) === parentId);

        return (
            <>
                {/* Files first */}
                {childDocs.map((doc) => {
                    const isProcessing = doc.status === "pending" || doc.status === "processing";
                    const isError = doc.status === "error";
                    const isVersionsOpen = expandedVersionDocIds.has(doc.id);
                    const hasVersions =
                        typeof doc.latest_version_number === "number" &&
                        doc.latest_version_number >= 1;
                    return (
                        <div key={`doc-${doc.id}`}>
                            <div
                                draggable
                                onDragStart={(e) => {
                                    e.dataTransfer.setData("application/mike-doc", doc.id);
                                    e.dataTransfer.effectAllowed = "move";
                                }}
                                onClick={() => {
                                    setViewingDocVersion(null);
                                    setViewingDoc(doc);
                                }}
                                onContextMenu={(e) => e.stopPropagation()}
                            className="group flex items-center h-10 pr-8 border-b border-[#C7C7B2]/30 hover:bg-[#F5F5F5] cursor-pointer transition-colors"
                            >
                                {(() => {
                                    const rowBg = selectedDocIds.includes(doc.id)
                                        ? "bg-[#F5F5F5]"
                                        : "bg-white";
                                    return (
                                        <>
                                <div
                                    className={`sticky left-0 z-[60] ${CHECK_W} p-2 flex items-center justify-center ${rowBg} group-hover:bg-[#F5F5F5]`}
                                    onClick={(e) => e.stopPropagation()}
                                >
                                    <input
                                        type="checkbox"
                                        checked={selectedDocIds.includes(doc.id)}
                                        onChange={() =>
                                            setSelectedDocIds((prev) =>
                                                prev.includes(doc.id)
                                                    ? prev.filter((x) => x !== doc.id)
                                                    : [...prev, doc.id],
                                            )
                                        }
                                        className="h-2.5 w-2.5 rounded border-[#C7C7B2] cursor-pointer accent-black"
                                    />
                                </div>
                                <div className={`sticky left-8 z-[60] ${NAME_COL_W} p-2 ${rowBg} group-hover:bg-[#F5F5F5]`}>
                                <div className="flex items-center gap-2">
                                    {isProcessing ? (
                                        <Loader2 className="h-4 w-4 animate-spin text-[#292629]/40 shrink-0" />
                                    ) : isError ? (
                                        <AlertCircle className="h-4 w-4 text-red-500 shrink-0" />
                                    ) : (
                                        <DocIcon fileType={doc.file_type} />
                                    )}
                                    <span className="text-sm text-[#292629]/90 truncate">{doc.filename}</span>
                                </div>
                                </div>
                                <div className="ml-auto w-20 shrink-0 text-xs text-[#292629]/50 uppercase truncate">
                                    {doc.file_type ?? <span className="text-[#292629]/30">—</span>}
                                </div>
                                <div className="w-24 shrink-0 text-sm text-[#292629]/50 truncate">
                                    {doc.size_bytes != null ? formatBytes(doc.size_bytes) : <span className="text-[#292629]/30">—</span>}
                                </div>
                                <div
                                    className="w-20 shrink-0 text-sm text-[#292629]/50 flex items-center gap-1"
                                    onClick={(e) => e.stopPropagation()}
                                >
                                    {hasVersions ? (
                                        <button
                                            onClick={() => void toggleVersions(doc.id)}
                                            className="flex items-center gap-1 rounded px-1 py-0.5 hover:bg-[#F5F5F5] transition-colors"
                                        >
                                            <span>{doc.latest_version_number}</span>
                                            {isVersionsOpen ? (
                                                <ChevronDown className="h-3 w-3 text-[#292629]/40" />
                                            ) : (
                                                <ChevronRight className="h-3 w-3 text-[#292629]/40" />
                                            )}
                                        </button>
                                    ) : (
                                        <span className="text-[#292629]/30 pl-1">—</span>
                                    )}
                                </div>
                                <div className="w-32 shrink-0 text-sm text-[#292629]/50 truncate">
                                    {doc.created_at ? formatDate(doc.created_at) : <span className="text-[#292629]/30">—</span>}
                                </div>
                                <div className="w-32 shrink-0 text-sm text-[#292629]/50 truncate">
                                    {doc.updated_at ? formatDate(doc.updated_at) : <span className="text-[#292629]/30">—</span>}
                                </div>
                                <div className="w-8 shrink-0 flex justify-end">
                                    {!isProcessing && (
                                        <RowActions
                                            onDownload={() => downloadDoc(doc.id)}
                                            onShowAllVersions={
                                                hasVersions && !isVersionsOpen
                                                    ? () => void toggleVersions(doc.id)
                                                    : undefined
                                            }
                                            onUploadNewVersion={() =>
                                                void handleUploadNewVersion(doc)
                                            }
                                            onRemoveFromFolder={doc.folder_id ? () => handleRemoveDocFromFolder(doc.id) : undefined}
                                            onDelete={() => handleRemoveDoc(doc.id)}
                                        />
                                    )}
                                </div>
                                        </>
                                    );
                                })()}
                            </div>
                            {isVersionsOpen && (
                                <DocVersionHistory
                                    docId={doc.id}
                                    filename={doc.filename}
                                    loading={loadingVersionDocIds.has(doc.id)}
                                    versions={versionsByDocId.get(doc.id) ?? []}
                                    onDownloadVersion={downloadDocVersion}
                                    onOpenVersion={(versionId, label) => {
                                        setViewingDocVersion({ id: versionId, label });
                                        setViewingDoc(doc);
                                    }}
                                    onRenameVersion={(versionId, displayName) =>
                                        handleRenameVersion(doc.id, versionId, displayName)
                                    }
                                />
                            )}
                        </div>
                    );
                })}

                {/* Subfolders after files, sorted alphabetically */}
                {childFolders.map((folder) => {
                    const isExpanded = expandedFolderIds.has(folder.id);
                    const isRenaming = renamingFolderId === folder.id;
                    return (
                        <div key={`folder-${folder.id}`}>
                            <div
                                draggable
                                onDragStart={(e) => {
                                    e.dataTransfer.setData("application/mike-folder", folder.id);
                                    e.dataTransfer.effectAllowed = "move";
                                    e.stopPropagation();
                                }}
                                onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setDragOverFolderId(folder.id); }}
                                onDragLeave={(e) => { e.stopPropagation(); setDragOverFolderId(null); }}
                                onDrop={async (e) => { e.preventDefault(); e.stopPropagation(); setDragOverFolderId(null); setDragOverRoot(false); await handleDropOnFolder(folder.id, e.dataTransfer); }}
                                onClick={() => toggleFolder(folder.id)}
                                onContextMenu={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    setContextMenu({ x: e.clientX, y: e.clientY, folderId: folder.id, showFolderActions: true });
                                }}
                                className={`group flex items-center h-10 pr-8 border-b border-[#C7C7B2]/30 hover:bg-[#F5F5F5] cursor-pointer transition-colors select-none ${dragOverFolderId === folder.id ? "bg-[#F5F5F5] ring-1 ring-inset ring-[#FEEA0F]/40" : ""}`}
                            >
                                <div className={`sticky left-0 z-[60] ${CHECK_W} p-2 flex items-center justify-center ${dragOverFolderId === folder.id ? "bg-[#F5F5F5]" : "bg-white"} group-hover:bg-[#F5F5F5] self-stretch`}>
                                    {isExpanded
                                        ? <ChevronDown className="h-3.5 w-3.5 text-[#292629]/40 shrink-0" />
                                        : <ChevronRight className="h-3.5 w-3.5 text-[#292629]/40 shrink-0" />
                                    }
                                </div>
                                <div className={`sticky left-8 z-[60] ${NAME_COL_W} p-2 ${dragOverFolderId === folder.id ? "bg-[#F5F5F5]" : "bg-white"} group-hover:bg-[#F5F5F5]`}>
                                <div className="flex items-center gap-1.5">
                                    {isExpanded
                                        ? <FolderOpen className="h-4 w-4 text-amber-500 shrink-0" />
                                        : <Folder className="h-4 w-4 text-amber-500 shrink-0" />
                                    }
                                    {isRenaming ? (
                                        <input
                                            autoFocus
                                            className="flex-1 min-w-0 text-sm text-[#292629]/90 bg-transparent outline-none"
                                            value={renameFolderValue}
                                            onChange={(e) => setRenameFolderValue(e.target.value)}
                                            onKeyDown={(e) => {
                                                if (e.key === "Enter") void handleRenameFolder(folder.id);
                                                if (e.key === "Escape") setRenamingFolderId(null);
                                            }}
                                            onBlur={() => void handleRenameFolder(folder.id)}
                                            onClick={(e) => e.stopPropagation()}
                                        />
                                    ) : (
                                        <span className="text-sm text-[#292629]/90 truncate">{folder.name}</span>
                                    )}
                                </div>
                                </div>
                                <div className="ml-auto w-20 shrink-0 text-xs text-[#292629]/30">—</div>
                                <div className="w-24 shrink-0 text-sm text-[#292629]/30">—</div>
                                <div className="w-20 shrink-0 text-sm text-[#292629]/30">—</div>
                                <div className="w-32 shrink-0 text-sm text-[#292629]/30">—</div>
                                <div className="w-32 shrink-0 text-sm text-[#292629]/30">—</div>
                                <div
                                    className="w-8 shrink-0 flex justify-end"
                                    onClick={(e) => e.stopPropagation()}
                                >
                                    <RowActions
                                        onRename={() => {
                                            setRenameFolderValue(folder.name);
                                            setRenamingFolderId(folder.id);
                                        }}
                                        onDelete={() => handleDeleteFolder(folder.id)}
                                    />
                                </div>
                            </div>
                            {isExpanded && renderLevel(folder.id, depth + 1)}
                        </div>
                    );
                })}

                {/* New-folder input row at the bottom of this level */}
                {renderFolderInput(parentId)}
            </>
        );
    }

    // ── Loading skeleton ──────────────────────────────────────────────────────

    if (loading) {
        return (
            <div className="flex-1 overflow-y-auto bg-white">
                <div className="flex items-start justify-between px-8 py-4">
                    <div className="flex items-center gap-1.5 text-3xl font-bold font-sans">
                        <span className="text-[#292629]/40">Projects</span>
                        <span className="text-[#292629]/30">›</span>
                        <div className="h-6 w-40 rounded bg-[#F5F5F5] animate-pulse" />
                    </div>
                    <div className="flex items-center gap-2">
                        <div className="h-8 w-16 rounded bg-[#F5F5F5] animate-pulse" />
                        <div className="h-8 w-28 rounded bg-[#F5F5F5] animate-pulse" />
                    </div>
                </div>
                <div className="flex items-center h-10 px-8 border-b border-[#C7C7B2] gap-5">
                    <div className="h-3 w-20 rounded bg-[#F5F5F5] animate-pulse" />
                    <div className="h-3 w-10 rounded bg-[#F5F5F5] animate-pulse" />
                    <div className="h-3 w-24 rounded bg-[#F5F5F5] animate-pulse" />
                </div>
                <div className="flex items-center h-8 pr-8 border-b border-[#C7C7B2]">
                    <div className="w-8 shrink-0" />
                    <div className="flex-1 min-w-0 pl-3 pr-4"><div className="h-2.5 w-8 rounded bg-[#F5F5F5] animate-pulse" /></div>
                    <div className="w-20 shrink-0"><div className="h-2.5 w-8 rounded bg-[#F5F5F5] animate-pulse" /></div>
                    <div className="w-24 shrink-0"><div className="h-2.5 w-8 rounded bg-[#F5F5F5] animate-pulse" /></div>
                    <div className="w-8 shrink-0" />
                </div>
                {[1, 2, 3, 4, 5].map((i) => (
                    <div key={i} className="flex items-center h-10 pr-8 border-b border-[#C7C7B2]/30">
                        <div className="w-8 shrink-0" />
                        <div className="flex-1 min-w-0 pl-3 pr-4"><div className="h-3.5 w-56 rounded bg-[#F5F5F5] animate-pulse" /></div>
                        <div className="w-20 shrink-0"><div className="h-3 w-8 rounded bg-[#F5F5F5] animate-pulse" /></div>
                        <div className="w-24 shrink-0"><div className="h-3 w-12 rounded bg-[#F5F5F5] animate-pulse" /></div>
                        <div className="w-8 shrink-0" />
                    </div>
                ))}
            </div>
        );
    }

    if (!project) {
        return (
            <div className="flex h-full items-center justify-center">
                <p className="text-[#292629]/40">Project not found</p>
            </div>
        );
    }

    const docs = project.documents || [];
    const q = search.toLowerCase();
    const filteredDocs = q ? docs.filter((d) => d.filename.toLowerCase().includes(q)) : docs;
    const filteredChats = q ? chats.filter((c) => (c.title ?? "").toLowerCase().includes(q)) : chats;
    const filteredReviews = q ? projectReviews.filter((r) => (r.title ?? "").toLowerCase().includes(q)) : projectReviews;

    const allDocsSelected = filteredDocs.length > 0 && filteredDocs.every((d) => selectedDocIds.includes(d.id));
    const someDocsSelected = !allDocsSelected && filteredDocs.some((d) => selectedDocIds.includes(d.id));
    const allChatsSelected = filteredChats.length > 0 && filteredChats.every((c) => selectedChatIds.includes(c.id));
    const someChatsSelected = !allChatsSelected && filteredChats.some((c) => selectedChatIds.includes(c.id));
    const allReviewsSelected = filteredReviews.length > 0 && filteredReviews.every((r) => selectedReviewIds.includes(r.id));
    const someReviewsSelected = !allReviewsSelected && filteredReviews.some((r) => selectedReviewIds.includes(r.id));

    const currentSelectionCount =
        tab === "documents" ? selectedDocIds.length :
        tab === "assistant" ? selectedChatIds.length :
        selectedReviewIds.length;

    const handleDeleteSelected =
        tab === "documents" ? handleDeleteSelectedDocs :
        tab === "assistant" ? handleDeleteSelectedChats :
        handleDeleteSelectedReviews;

    const actionsDropdown = currentSelectionCount > 0 ? (
        <div ref={actionsRef} className="relative">
            <button
                onClick={() => setActionsOpen((v) => !v)}
                className="flex items-center gap-1 text-xs font-medium text-[#292629]/80 hover:text-[#292629] transition-colors"
            >
                Actions
                <ChevronDown className="h-3.5 w-3.5" />
            </button>
            {actionsOpen && (
                <div className="absolute top-full right-0 mt-1 w-36 rounded-lg border border-[#C7C7B2]/50 bg-white shadow-lg z-50 overflow-hidden">
                    {tab === "documents" && (
                        <button
                            onClick={handleDownloadSelectedDocs}
                            className="w-full px-3 py-1.5 text-left text-xs text-[#292629]/60 hover:bg-[#F5F5F5] transition-colors"
                        >
                            Download
                        </button>
                    )}
                    {tab === "documents" && selectedDocIds.some((id) => docs.find((d) => d.id === id)?.folder_id != null) && (
                        <button
                            onClick={handleRemoveSelectedFromFolder}
                            className="w-full px-3 py-1.5 text-left text-xs text-[#292629]/60 hover:bg-[#F5F5F5] transition-colors"
                        >
                            Remove from subfolder
                        </button>
                    )}
                    <button
                        onClick={handleDeleteSelected}
                        className="w-full px-3 py-1.5 text-left text-xs text-red-600 hover:bg-red-50 transition-colors"
                    >
                        Delete
                    </button>
                </div>
            )}
        </div>
    ) : null;

    const toolbarActions = (
        <div className="flex items-center gap-2">
            {actionsDropdown}
            {tab === "documents" && (
                <>
                    <button
                        onClick={() => { setCreatingFolderIn(null); setNewFolderName(""); }}
                        className="flex items-center gap-1 text-xs px-3 font-medium text-[#292629]/50 hover:text-[#292629]/80 transition-colors"
                    >
                        <FolderPlus className="h-3.5 w-3.5" />
                        Add Subfolder
                    </button>
                    <button
                        onClick={() => setAddDocsOpen(true)}
                        className="flex items-center gap-1 text-xs px-3 font-medium text-[#292629]/50 hover:text-[#292629]/80 transition-colors"
                    >
                        <Upload className="h-3.5 w-3.5" />
                        Add Documents
                    </button>
                </>
            )}
        </div>
    );

    return (
        <div className="flex-1 overflow-y-auto bg-white flex flex-col h-full">
            {/* Page header */}
            <div className="flex items-start justify-between px-8 py-4">
                <div>
                    <div className="flex items-center gap-1.5 text-3xl font-bold font-sans">
                        <button
                            onClick={() => router.push("/projects")}
                            className="text-[#292629]/40 hover:text-[#292629]/60 transition-colors"
                        >
                            Projects
                        </button>
                        <span className="text-[#292629]/30">›</span>
                        {tab !== "documents" ? (
                            <button
                                onClick={() => router.push(`/projects/${projectId}`)}
                                className="text-[#292629]/50 hover:text-[#292629]/80 transition-colors"
                            >
                                {project.name}
                                {project.cm_number ? <span className="ml-1 text-[#292629]/40">(#{project.cm_number})</span> : null}
                            </button>
                        ) : (
                            <RenameableTitle
                                value={project.name}
                                onCommit={handleTitleCommit}
                                suffix={project.cm_number ? <span className="ml-1 text-[#292629]/40">(#{project.cm_number})</span> : null}
                            />
                        )}
                        {tab !== "documents" && (
                            <>
                                <span className="text-[#292629]/30">›</span>
                                <span className="text-[#292629]">{tab === "assistant" ? "Assistant" : "Tabular Reviews"}</span>
                            </>
                        )}
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    <HeaderSearchBtn value={search} onChange={setSearch} placeholder="Search…" />
                    <button
                        onClick={() => setPeopleModalOpen(true)}
                        className="flex h-8 w-8 items-center justify-center text-sm text-[#292629]/50 transition-colors hover:text-[#292629] cursor-pointer"
                        title="People with access"
                        aria-label="People with access"
                    >
                        <Users className="h-4 w-4" />
                    </button>
                    <div className="relative group">
                        <button
                            onClick={() => !creatingChat && handleNewChat()}
                            className={`flex h-8 items-center justify-center gap-1.5 px-3 text-sm transition-colors ${
                                !creatingChat ? "text-[#292629]/50 hover:text-[#292629] cursor-pointer" : "text-[#292629]/30 cursor-default"
                            }`}
                        >
                            {creatingChat ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                            Chat
                        </button>
                    </div>
                    <div className="relative group">
                        <button
                            onClick={() => docs.length > 0 && !creatingReview && handleNewReview()}
                            className={`flex h-8 items-center justify-center gap-1.5 px-3 text-sm transition-colors ${
                                docs.length > 0 ? "text-[#292629]/50 hover:text-[#292629] cursor-pointer" : "text-[#292629]/30 cursor-default"
                            }`}
                        >
                            {creatingReview ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                            Tabular Review
                        </button>
                        {docs.length === 0 && (
                            <div className="pointer-events-none absolute right-0 top-full mt-1.5 z-10 hidden group-hover:flex items-center whitespace-nowrap rounded-lg bg-[#292629] px-2.5 py-1.5 text-xs text-white shadow-lg">
                                Upload a document first
                            </div>
                        )}
                    </div>
                </div>
            </div>

            <ToolbarTabs
                tabs={[
                    { id: "documents", label: "Documents" },
                    { id: "assistant", label: "Assistant" },
                    { id: "reviews", label: "Tabular Reviews" },
                ]}
                active={tab}
                onChange={handleTabChange}
                actions={
                    <>
                        {toolbarActions}
                    </>
                }
            />

            {/* Table content */}
            <div className="w-full flex-1 min-h-0 overflow-x-auto">
            <div className="min-w-max flex min-h-full flex-col">

                {/* Tab: Documents */}
                {tab === "documents" && (
                    <div className="flex-1 flex flex-col min-h-0">
                        {/* Table header */}
                        <div className="flex items-center h-8 pr-8 border-b border-[#C7C7B2] text-xs text-[#292629]/50 font-medium select-none shrink-0">
                            <div className={`sticky left-0 z-[60] ${CHECK_W} relative bg-white flex items-center justify-center self-stretch before:absolute before:inset-x-0 before:bottom-0 before:h-px before:bg-white`}>
                                <input
                                    type="checkbox"
                                    checked={allDocsSelected}
                                    ref={(el) => { if (el) el.indeterminate = someDocsSelected; }}
                                    onChange={() => {
                                        if (allDocsSelected) setSelectedDocIds([]);
                                        else setSelectedDocIds(filteredDocs.map((d) => d.id));
                                    }}
                                    className="h-2.5 w-2.5 rounded border-[#C7C7B2] cursor-pointer accent-black"
                                />
                            </div>
                            <div className={`sticky left-8 z-[60] ${NAME_COL_W} bg-white pl-2 text-left`}>
                                Name
                            </div>
                            <div className="ml-auto w-20 shrink-0 text-left">Type</div>
                            <div className="w-24 shrink-0 text-left">Size</div>
                            <div className="w-20 shrink-0 text-left">Version</div>
                            <div className="w-32 shrink-0 text-left">Created</div>
                            <div className="w-32 shrink-0 text-left">Updated</div>
                            <div className="w-8 shrink-0" />
                        </div>

                        {/* Blue ring wraps everything below the header when root-dropping */}
                        <div className="flex-1 flex flex-col min-h-0 relative">
                            {dragOverRoot && dragOverFolderId === null && (
                                <div className="absolute inset-0 border-2 border-[#898344] pointer-events-none z-20" />
                            )}

                        {/* Empty state */}
                        {docs.length === 0 && folders.length === 0 ? (
                            <div
                                onClick={() => setAddDocsOpen(true)}
                                className="flex-1 flex cursor-pointer flex-col items-center justify-center py-24 text-center"
                            >
                                <Upload className="h-8 w-8 text-[#C7C7B2] mb-3" />
                                <p className="text-sm text-[#292629]/40">Drop PDF or DOCX files here</p>
                            </div>
                        ) : (
                            <div
                                className="flex-1 flex flex-col"
                                onContextMenu={(e) => {
                                    e.preventDefault();
                                    setContextMenu({ x: e.clientX, y: e.clientY, folderId: null, showFolderActions: false });
                                }}
                                onClick={() => setContextMenu(null)}
                                onDragOver={(e) => { e.preventDefault(); setDragOverRoot(true); }}
                                onDragLeave={(e) => {
                                    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                                        setDragOverRoot(false);
                                    }
                                }}
                                onDrop={async (e) => {
                                    e.preventDefault();
                                    setDragOverRoot(false);
                                    setDragOverFolderId(null);
                                    await handleDropOnFolder(null, e.dataTransfer);
                                }}
                            >
                                {/* Search: flat list; no search: folder tree */}
                                {q ? (
                                    filteredDocs.map((doc) => {
                                        const isProcessing = doc.status === "pending" || doc.status === "processing";
                                        const isError = doc.status === "error";
                                        const isVersionsOpen = expandedVersionDocIds.has(doc.id);
                                        const hasVersions =
                                            typeof doc.latest_version_number === "number" &&
                                            doc.latest_version_number >= 1;
                                        return (
                                            <div key={doc.id}>
                                                <div
                                                    onClick={() => {
                                    setViewingDocVersion(null);
                                    setViewingDoc(doc);
                                }}
                                                    className="group flex items-center h-10 pr-8 border-b border-[#C7C7B2]/30 hover:bg-[#F5F5F5] cursor-pointer transition-colors"
                                                >
                                                    <div className={`sticky left-0 z-[60] ${CHECK_W} p-2 flex items-center justify-center ${selectedDocIds.includes(doc.id) ? "bg-[#F5F5F5]" : "bg-white"} group-hover:bg-[#F5F5F5]`} onClick={(e) => e.stopPropagation()}>
                                                        <input
                                                            type="checkbox"
                                                            checked={selectedDocIds.includes(doc.id)}
                                                            onChange={() => setSelectedDocIds((prev) => prev.includes(doc.id) ? prev.filter((x) => x !== doc.id) : [...prev, doc.id])}
                                                            className="h-2.5 w-2.5 rounded border-[#C7C7B2] cursor-pointer accent-black"
                                                        />
                                                    </div>
                                                    <div className={`sticky left-8 z-[60] ${NAME_COL_W} p-2 ${selectedDocIds.includes(doc.id) ? "bg-[#F5F5F5]" : "bg-white"} group-hover:bg-[#F5F5F5]`}>
                                                    <div className="flex items-center gap-2">
                                                        {isProcessing ? <Loader2 className="h-4 w-4 animate-spin text-[#292629]/40 shrink-0" /> : isError ? <AlertCircle className="h-4 w-4 text-red-500 shrink-0" /> : <DocIcon fileType={doc.file_type} />}
                                                        <span className="text-sm text-[#292629]/90 truncate">{doc.filename}</span>
                                                    </div>
                                                    </div>
                                                    <div className="ml-auto w-20 shrink-0 text-xs text-[#292629]/50 uppercase truncate">{doc.file_type ?? <span className="text-[#292629]/30">—</span>}</div>
                                                    <div className="w-24 shrink-0 text-sm text-[#292629]/50 truncate">{doc.size_bytes != null ? formatBytes(doc.size_bytes) : <span className="text-[#292629]/30">—</span>}</div>
                                                    <div
                                                        className="w-20 shrink-0 text-sm text-[#292629]/50 flex items-center gap-1"
                                                        onClick={(e) => e.stopPropagation()}
                                                    >
                                                        {hasVersions ? (
                                                            <button
                                                                onClick={() => void toggleVersions(doc.id)}
                                                                className="flex items-center gap-1 rounded px-1 py-0.5 hover:bg-[#F5F5F5] transition-colors"
                                                            >
                                                                <span>{doc.latest_version_number}</span>
                                                                {isVersionsOpen ? (
                                                                    <ChevronDown className="h-3 w-3 text-[#292629]/40" />
                                                                ) : (
                                                                    <ChevronRight className="h-3 w-3 text-[#292629]/40" />
                                                                )}
                                                            </button>
                                                        ) : (
                                                            <span className="text-[#292629]/30 pl-1">—</span>
                                                        )}
                                                    </div>
                                                    <div className="w-32 shrink-0 text-sm text-[#292629]/50 truncate">
                                                        {doc.created_at ? formatDate(doc.created_at) : <span className="text-[#292629]/30">—</span>}
                                                    </div>
                                                    <div className="w-32 shrink-0 text-sm text-[#292629]/50 truncate">
                                                        {doc.updated_at ? formatDate(doc.updated_at) : <span className="text-[#292629]/30">—</span>}
                                                    </div>
                                                    <div className="w-8 shrink-0 flex justify-end">
                                                        {!isProcessing && (
                                                            <RowActions
                                                                onDownload={() => downloadDoc(doc.id)}
                                                                onShowAllVersions={
                                                                    hasVersions && !isVersionsOpen
                                                                        ? () => void toggleVersions(doc.id)
                                                                        : undefined
                                                                }
                                                                onUploadNewVersion={() =>
                                                                    void handleUploadNewVersion(doc)
                                                                }
                                                                onDelete={() => handleRemoveDoc(doc.id)}
                                                            />
                                                        )}
                                                    </div>
                                                </div>
                                                {isVersionsOpen && (
                                                    <DocVersionHistory
                                                        docId={doc.id}
                                                        filename={doc.filename}
                                                        loading={loadingVersionDocIds.has(doc.id)}
                                                        versions={versionsByDocId.get(doc.id) ?? []}
                                                        onDownloadVersion={downloadDocVersion}
                                                        onOpenVersion={(versionId, label) => {
                                                            setViewingDocVersion({ id: versionId, label });
                                                            setViewingDoc(doc);
                                                        }}
                                                        onRenameVersion={(versionId, displayName) =>
                                                            handleRenameVersion(doc.id, versionId, displayName)
                                                        }
                                                    />
                                                )}
                                            </div>
                                        );
                                    })
                                ) : (
                                    renderLevel(null, 0)
                                )}
                                {/* Spacer — fills remaining height and extends the root drop zone */}
                                <div className="flex-1 min-h-16" />
                            </div>
                        )}

                        {/* Context menu */}
                        {contextMenu && (
                            <div
                                ref={contextMenuRef}
                                className="fixed z-50 w-44 rounded-lg border border-[#C7C7B2]/50 bg-white shadow-lg overflow-hidden text-xs"
                                style={{ top: contextMenu.y, left: contextMenu.x }}
                                onClick={(e) => e.stopPropagation()}
                            >
                                <button
                                    className="w-full px-3 py-1.5 text-left text-[#292629]/80 hover:bg-[#F5F5F5] flex items-center gap-2"
                                    onClick={() => {
                                        setCreatingFolderIn(contextMenu.folderId);
                                        setNewFolderName("");
                                        if (contextMenu.folderId) setExpandedFolderIds((prev) => new Set([...prev, contextMenu.folderId!]));
                                        setContextMenu(null);
                                    }}
                                >
                                    <FolderPlus className="h-3.5 w-3.5 text-[#292629]/40" />
                                    {contextMenu.showFolderActions ? "New subfolder inside" : "New subfolder"}
                                </button>
                                {contextMenu.showFolderActions && contextMenu.folderId && (
                                    <>
                                        <button
                                            className="w-full px-3 py-1.5 text-left text-[#292629]/80 hover:bg-[#F5F5F5]"
                                            onClick={() => {
                                                const f = folders.find((x) => x.id === contextMenu.folderId);
                                                setRenameFolderValue(f?.name ?? "");
                                                setRenamingFolderId(contextMenu.folderId!);
                                                setContextMenu(null);
                                            }}
                                        >
                                            Rename folder
                                        </button>
                                        <button
                                            className="w-full px-3 py-1.5 text-left text-red-600 hover:bg-red-50"
                                            onClick={() => {
                                                handleDeleteFolder(contextMenu.folderId!);
                                                setContextMenu(null);
                                            }}
                                        >
                                            Delete folder
                                        </button>
                                    </>
                                )}
                            </div>
                        )}

                        </div>{/* end blue ring wrapper */}
                    </div>
                )}

                {/* Tab: Assistant */}
                {tab === "assistant" && (
                    <>
                        <div className="flex items-center h-8 pr-8 border-b border-[#C7C7B2] text-xs text-[#292629]/50 font-medium select-none">
                            <div className={`sticky left-0 z-[60] ${CHECK_W} relative bg-white flex items-center justify-center self-stretch before:absolute before:inset-x-0 before:bottom-0 before:h-px before:bg-white`}>
                                <input
                                    type="checkbox"
                                    checked={allChatsSelected}
                                    ref={(el) => { if (el) el.indeterminate = someChatsSelected; }}
                                    onChange={() => {
                                        if (allChatsSelected) setSelectedChatIds([]);
                                        else setSelectedChatIds(filteredChats.map((c) => c.id));
                                    }}
                                    className="h-2.5 w-2.5 rounded border-[#C7C7B2] cursor-pointer accent-black"
                                />
                            </div>
                            <div className={`sticky left-8 z-[60] ${NAME_COL_W} bg-white pl-2 text-left`}>
                                Chats
                            </div>
                            <div className="ml-auto w-32 shrink-0 text-left">Created</div>
                            <div className="w-8 shrink-0" />
                        </div>
                        {chats.length === 0 ? (
                            <div className="flex flex-col items-start py-24 w-full max-w-xs mx-auto">
                                <MessageSquare className="h-8 w-8 text-[#292629]/30 mb-4" />
                                <p className="text-3xl font-bold font-sans text-[#292629]">Assistant</p>
                                <p className="mt-1 text-xs text-[#292629]/40 max-w-xs">Ask questions and get answers grounded in the documents in this project.</p>
                                <button onClick={() => handleNewChat()} className="mt-4 inline-flex items-center gap-1 rounded-full bg-[#292629] px-3 py-1 text-xs font-medium text-white hover:bg-[#292629]/90 transition-colors shadow-md">
                                    + Create New
                                </button>
                            </div>
                        ) : (
                            <div>
                                {filteredChats.map((chat) => (
                                    <div
                                        key={chat.id}
                                        onClick={() => { if (renamingChatId === chat.id) return; router.push(`/projects/${projectId}/assistant/chat/${chat.id}`); }}
                                        className="group flex items-center h-10 pr-8 border-b border-[#C7C7B2]/30 hover:bg-[#F5F5F5] cursor-pointer transition-colors"
                                    >
                                        <div className={`sticky left-0 z-[60] ${CHECK_W} p-2 flex items-center justify-center ${selectedChatIds.includes(chat.id) ? "bg-[#F5F5F5]" : "bg-white"} group-hover:bg-[#F5F5F5]`} onClick={(e) => e.stopPropagation()}>
                                            <input type="checkbox" checked={selectedChatIds.includes(chat.id)} onChange={() => setSelectedChatIds((prev) => prev.includes(chat.id) ? prev.filter((x) => x !== chat.id) : [...prev, chat.id])} className="h-2.5 w-2.5 rounded border-[#C7C7B2] cursor-pointer accent-black" />
                                        </div>
                                        <div className={`sticky left-8 z-[60] ${NAME_COL_W} p-2 ${selectedChatIds.includes(chat.id) ? "bg-[#F5F5F5]" : "bg-white"} group-hover:bg-[#F5F5F5]`}>
                                            {renamingChatId === chat.id ? (
                                                <input autoFocus value={renameChatValue} onChange={(e) => setRenameChatValue(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") submitChatRename(chat.id); if (e.key === "Escape") setRenamingChatId(null); }} onBlur={() => submitChatRename(chat.id)} onClick={(e) => e.stopPropagation()} className="w-full text-sm text-[#292629]/90 bg-transparent outline-none" />
                                            ) : (
                                                <span className="text-sm text-[#292629]/90 truncate block">{chat.title ?? "Untitled Chat"}</span>
                                            )}
                                        </div>
                                        <div className="ml-auto w-32 shrink-0 text-sm text-[#292629]/50 truncate">{formatDate(chat.created_at)}</div>
                                        <div className="w-8 shrink-0 flex justify-end" onClick={(e) => e.stopPropagation()}>
                                            <RowActions
                                                onRename={() => {
                                                    if (user?.id && chat.user_id !== user.id) {
                                                        setOwnerOnlyAction("rename this chat");
                                                        return;
                                                    }
                                                    setRenameChatValue(chat.title ?? "Untitled Chat");
                                                    setRenamingChatId(chat.id);
                                                }}
                                                onDelete={async () => {
                                                    if (user?.id && chat.user_id !== user.id) {
                                                        setOwnerOnlyAction("delete this chat");
                                                        return;
                                                    }
                                                    await deleteChat(chat.id);
                                                    setChats((prev) => prev.filter((c) => c.id !== chat.id));
                                                }}
                                            />
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </>
                )}

                {/* Tab: Reviews */}
                {tab === "reviews" && (
                    <>
                        <div className="flex items-center h-8 pr-8 border-b border-[#C7C7B2] text-xs text-[#292629]/50 font-medium select-none">
                            <div className={`sticky left-0 z-[60] ${CHECK_W} relative bg-white flex items-center justify-center self-stretch before:absolute before:inset-x-0 before:bottom-0 before:h-px before:bg-white`}>
                                <input
                                    type="checkbox"
                                    checked={allReviewsSelected}
                                    ref={(el) => { if (el) el.indeterminate = someReviewsSelected; }}
                                    onChange={() => {
                                        if (allReviewsSelected) setSelectedReviewIds([]);
                                        else setSelectedReviewIds(filteredReviews.map((r) => r.id));
                                    }}
                                    className="h-2.5 w-2.5 rounded border-[#C7C7B2] cursor-pointer accent-black"
                                />
                            </div>
                            <div className={`sticky left-8 z-[60] ${NAME_COL_W} bg-white pl-2 text-left`}>
                                Name
                            </div>
                            <div className="ml-auto w-24 shrink-0 text-left">Columns</div>
                            <div className="w-24 shrink-0 text-left">Documents</div>
                            <div className="w-32 shrink-0 text-left">Created</div>
                            <div className="w-8 shrink-0" />
                        </div>
                        {projectReviews.length === 0 ? (
                            <div className="flex flex-col items-start py-24 w-full max-w-xs mx-auto">
                                <Table2 className="h-8 w-8 text-[#292629]/30 mb-4" />
                                <p className="text-3xl font-bold font-sans text-[#292629]">Tabular Reviews</p>
                                <p className="mt-1 text-xs text-[#292629]/40 max-w-xs">Extract data from project documents into tables using AI.</p>
                                <button onClick={handleNewReview} disabled={creatingReview || docs.length === 0} className="mt-4 inline-flex items-center gap-1 rounded-full bg-[#292629] px-3 py-1 text-xs font-medium text-white hover:bg-[#292629]/90 transition-colors shadow-md disabled:opacity-40">
                                    + Create New
                                </button>
                            </div>
                        ) : (
                            <div>
                                {filteredReviews.map((review) => (
                                    <div
                                        key={review.id}
                                        onClick={() => { if (renamingReviewId === review.id) return; router.push(`/projects/${projectId}/tabular-reviews/${review.id}`); }}
                                        className="group flex items-center h-10 pr-8 border-b border-[#C7C7B2]/30 hover:bg-[#F5F5F5] cursor-pointer transition-colors"
                                    >
                                        <div className={`sticky left-0 z-[60] ${CHECK_W} p-2 flex items-center justify-center ${selectedReviewIds.includes(review.id) ? "bg-[#F5F5F5]" : "bg-white"} group-hover:bg-[#F5F5F5]`} onClick={(e) => e.stopPropagation()}>
                                            <input type="checkbox" checked={selectedReviewIds.includes(review.id)} onChange={() => setSelectedReviewIds((prev) => prev.includes(review.id) ? prev.filter((x) => x !== review.id) : [...prev, review.id])} className="h-2.5 w-2.5 rounded border-[#C7C7B2] cursor-pointer accent-black" />
                                        </div>
                                        <div className={`sticky left-8 z-[60] ${NAME_COL_W} p-2 ${selectedReviewIds.includes(review.id) ? "bg-[#F5F5F5]" : "bg-white"} group-hover:bg-[#F5F5F5]`}>
                                            {renamingReviewId === review.id ? (
                                                <input autoFocus value={renameReviewValue} onChange={(e) => setRenameReviewValue(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") submitReviewRename(review.id); if (e.key === "Escape") setRenamingReviewId(null); }} onBlur={() => submitReviewRename(review.id)} onClick={(e) => e.stopPropagation()} className="w-full text-sm text-[#292629]/90 bg-transparent outline-none" />
                                            ) : (
                                                <span className="text-sm text-[#292629]/90 truncate block">{review.title ?? "Untitled Review"}</span>
                                            )}
                                        </div>
                                        <div className="ml-auto w-24 shrink-0 text-sm text-[#292629]/50 truncate">{review.columns_config?.length ?? 0}</div>
                                        <div className="w-24 shrink-0 text-sm text-[#292629]/50 truncate">{review.document_count ?? 0}</div>
                                        <div className="w-32 shrink-0 text-sm text-[#292629]/50 truncate">{review.created_at ? formatDate(review.created_at) : <span className="text-[#292629]/30">—</span>}</div>
                                        <div className="w-8 shrink-0 flex justify-end" onClick={(e) => e.stopPropagation()}>
                                            <RowActions
                                                onRename={() => {
                                                    if (user?.id && review.user_id !== user.id) {
                                                        setOwnerOnlyAction("rename this tabular review");
                                                        return;
                                                    }
                                                    setRenameReviewValue(review.title ?? "Untitled Review");
                                                    setRenamingReviewId(review.id);
                                                }}
                                                onDelete={async () => {
                                                    if (user?.id && review.user_id !== user.id) {
                                                        setOwnerOnlyAction("delete this tabular review");
                                                        return;
                                                    }
                                                    await deleteTabularReview(review.id);
                                                    setProjectReviews((prev) => prev.filter((r) => r.id !== review.id));
                                                }}
                                            />
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </>
                )}
            </div>
            </div>

            <AddDocumentsModal
                open={addDocsOpen}
                onClose={() => setAddDocsOpen(false)}
                onSelect={handleDocsSelected}
                breadcrumb={["Projects", project.name + (project.cm_number ? ` (${project.cm_number})` : ""), "Add Documents"]}
                projectId={projectId}
            />

            <UploadNewVersionModal
                open={!!uploadVersionDoc}
                doc={uploadVersionDoc}
                onClose={() => setUploadVersionDoc(null)}
                onSubmit={(file, displayName) =>
                    submitNewVersion(uploadVersionDoc!, file, displayName)
                }
            />

            <DocViewModal
                doc={viewingDoc}
                versionId={viewingDocVersion?.id ?? null}
                versionLabel={viewingDocVersion?.label ?? null}
                onClose={() => {
                    setViewingDoc(null);
                    setViewingDocVersion(null);
                }}
                onDelete={(doc) => handleRemoveDoc(doc.id)}
            />

            <AddNewTRModal
                open={newTRModalOpen}
                onClose={() => setNewTRModalOpen(false)}
                onAdd={handleCreateReview}
                projectDocs={project?.documents?.filter((d) => d.status === "ready")}
                projectName={project?.name}
                projectCmNumber={project?.cm_number}
            />

            <OwnerOnlyModal
                open={!!ownerOnlyAction}
                action={ownerOnlyAction ?? undefined}
                onClose={() => setOwnerOnlyAction(null)}
            />

            <PeopleModal
                open={peopleModalOpen}
                onClose={() => setPeopleModalOpen(false)}
                resource={project}
                fetchPeople={getProjectPeople}
                currentUserEmail={user?.email ?? null}
                breadcrumb={[
                    "Projects",
                    project
                        ? project.name +
                          (project.cm_number ? ` (${project.cm_number})` : "")
                        : "",
                    "People",
                ]}
                // Only owners may modify the member list. Without this prop
                // PeopleModal renders read-only — non-owners can still see
                // who has access but the add/remove controls are hidden.
                onSharedWithChange={
                    project.is_owner === false
                        ? undefined
                        : async (next) => {
                              const updated = await updateProject(projectId, {
                                  shared_with: next,
                              });
                              setProject((prev) =>
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
        </div>
    );
}
