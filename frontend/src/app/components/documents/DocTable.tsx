"use client";

import {
    type Dispatch,
    type DragEvent,
    type ReactNode,
    type SetStateAction,
    type UIEvent,
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import { createPortal } from "react-dom";
import { Loader2, AlertCircle, ChevronDown, ChevronRight } from "lucide-react";
import {
    UploadBatchError,
    deleteDocument,
    getDocument,
    getDocumentUrl,
    downloadDocumentsZip,
    listDocumentVersions,
    uploadDocumentVersion,
    replaceDocumentVersionFile,
    copyDocumentVersionFromDocument,
    deleteDocumentVersion,
    failedUploadMessage,
    renameDocumentVersion,
    type DocumentVersion,
    type UploadOutcome,
    type UploadProgress,
    type UploadProgressStatus,
} from "@/app/lib/mikeApi";
import { runUserExport } from "@/app/lib/asyncExport";
import type {
    Document,
    Folder as ProjectFolder,
    LibraryFolder,
} from "@/app/components/shared/types";
import {
    closeRowActionMenus,
    RowActionMenuItems,
    RowActions,
    type RowActionMenuSurfaceProps,
} from "@/app/components/shared/RowActions";
import { SubfolderSvgIcon } from "@/app/components/shared/FolderSvgIcon";
import { useAuth } from "@/app/contexts/AuthContext";
import {
    creatorScopedAllowed,
    type Capability,
} from "@/app/lib/permissions";
import type { OwnerGate } from "@/app/components/projects/ProjectWorkspace";
import { WarningPopup } from "@/app/components/popups/WarningPopup";
import { UploadOverlay } from "@/app/components/assistant/UploadOverlay";
import { ConfirmPopup } from "@/app/components/popups/ConfirmPopup";
import { userFacingApiError } from "@/app/lib/userFacingError";
import { restoreOptimisticallyDeletedRows } from "@/app/lib/optimisticRows";
import { useRemountPersistentState } from "@/app/hooks/useRemountPersistentState";
import {
    formatUnsupportedDocumentWarning,
    partitionSupportedDocumentFiles,
    SUPPORTED_DOCUMENT_ACCEPT,
} from "@/app/lib/documentUploadValidation";
import {
    collectDroppedDocumentUploadEntries,
    dataTransferHasDirectory,
    DOCUMENT_UPLOAD_CONCURRENCY,
    documentUploadEntriesFromFiles,
    documentUploadFolderSegments,
    folderUploadProgressLabel,
    resolvedDocumentUploadProgressEntries,
    MAX_DOCUMENTS_PER_DIRECTORY_UPLOAD,
    resolveDocumentUploadRootFolder,
    type DocumentUploadEntry,
    type DocumentUploadFolderPathResolution,
    type DocumentUploadProgressEntry,
} from "@/app/lib/documentDirectoryUpload";
import { settleWithConcurrency } from "@/shared/lib/settleWithConcurrency";
import {
    collectionSelectAllState,
    folderSelectionRootIds,
    folderTreeIds as collectFolderTreeIds,
    MULTI_DOCUMENT_DRAG_TYPE,
    readDocumentDragPayload,
    SINGLE_DOCUMENT_DRAG_TYPE,
    writeDocumentDragPayload,
} from "@/app/lib/docTableSelection";
import { setDocumentRowsDragPreview } from "@/app/lib/docTableDragPreview";
import {
    DOC_NAME_COL_W,
    DocIcon,
    DocVersionHistory,
    formatBytes,
    formatDate,
    treeNameCellStyle,
    type ProjectContextMenu,
} from "@/app/components/projects/ProjectPageParts";
import { DocumentSidePanel } from "@/app/components/shared/DocumentSidePanel";
import { TableLoadMoreRow } from "@/app/components/shared/TableLoadMoreRow";
import { LibrarySkeuoIcon } from "@/app/components/shared/AppSidebarSkeuoIcons";
import { EmptyState } from "@/app/components/ui/empty-state";
import { PillButton } from "@/app/components/ui/pill-button";
import {
    LIQUID_GLASS_SELECTED_CLASS,
    LIQUID_GLASS_GROUP_HOVER_CLASS,
    LIQUID_GLASS_HOVER_CLASS,
} from "@/app/components/ui/liquid-surface";
import {
    TABLE_CHECKBOX_CLASS,
    selectionAnchorAfterRowSelection,
    selectionRangeIds,
    TableFilters,
    TableHeaderCell,
    TableHeaderRow,
    TableEmptyState,
    TableScrollArea,
    TableStickyCell,
    type TableFilterOption,
    type TableSortDirection,
} from "@/app/components/shared/TablePrimitive";

// Above this many documents the zip is built by a background export job
// instead of inside the request: a small selection zips in well under a second
// and should download instantly, while a large one risks an out-of-memory or a
// gateway timeout and is worth the polling round trips.
const ASYNC_ZIP_THRESHOLD = 10;
const DOC_TABLE_STICKY_CELL_CLASS = "table-sticky-cell";

export type DocTableFolder = ProjectFolder | LibraryFolder;
export type DocTableFolderBreadcrumb = {
    id: string;
    name: string;
    onClick: () => void;
};
export interface DocTableSelectionActions {
    selectedCount: number;
    hasDocumentsInFolders: boolean;
    onDownload: () => Promise<void>;
    onRemoveFromFolder: () => Promise<void>;
    onDelete: () => Promise<void>;
}

export type DocumentSortKey = "name" | "size" | "version" | "created" | "updated";

export type DocumentSort = {
    key: DocumentSortKey;
    direction: TableSortDirection;
};

export interface DocTableQuery {
    search: string;
    fileType: string | null;
    sort: DocumentSort | null;
}

const SORT_OPTIONS: TableFilterOption<TableSortDirection>[] = [
    { value: "asc", label: "Ascending" },
    { value: "desc", label: "Descending" },
];

const SORT_KEY_LABELS: Record<DocumentSortKey, string> = {
    name: "Name",
    size: "Size",
    version: "Version",
    created: "Created",
    updated: "Updated",
};

interface DocTableOperations {
    uploadDocument: (
        file: File,
        folderId?: string | null,
    ) => Promise<Document>;
    uploadDocuments?: (
        files: Array<{
            file: File;
            folderId: string | null;
            clientId: string;
        }>,
        options?: {
            onProgress?: (progress: UploadProgress<Document>) => void;
        },
    ) => Promise<UploadOutcome<Document>[]>;
    refreshCollection: () => Promise<void>;
    createFolder: (name: string, parentFolderId?: string | null) => Promise<DocTableFolder>;
    resolveFolderPath: (
        segments: string[],
        baseFolderId: string | null,
        conflictResolution?: "error" | "reuse" | "rename",
    ) => Promise<DocumentUploadFolderPathResolution<DocTableFolder>>;
    renameFolder: (folderId: string, name: string) => Promise<DocTableFolder>;
    deleteFolder: (folderId: string) => Promise<void>;
    moveFolder: (folderId: string, parentFolderId: string | null) => Promise<DocTableFolder>;
    moveDocument: (documentId: string, folderId: string | null) => Promise<Document>;
    renameDocument: (documentId: string, filename: string) => Promise<Document>;
    bulkDeleteDocuments?: (documentIds: string[]) => Promise<{ deletedIds: string[] }>;
}

interface DocTableProps {
    scopeKey: string;
    documents: Document[];
    setDocuments: Dispatch<SetStateAction<Document[]>>;
    folders: DocTableFolder[];
    setFolders: Dispatch<SetStateAction<DocTableFolder[]>>;
    loading: boolean;
    search: string;
    operations: DocTableOperations;
    emptyStateTitle: string;
    renderAddDocumentsModal?: (
        open: boolean,
        onClose: () => void,
        onSelect: (documents: Document[]) => void,
    ) => ReactNode;
    onAddDocumentsActionChange?: (action: (() => void) | null) => void;
    onUploadFilesActionChange?: (action: (() => void) | null) => void;
    onUploadFolderActionChange?: (action: (() => void) | null) => void;
    onCreateFolderActionChange?: (action: (() => void) | null) => void;
    onFolderViewBackActionChange?: (action: (() => void) | null) => void;
    onFolderViewChange?: (path: DocTableFolderBreadcrumb[]) => void;
    folderViewId?: string | null;
    onFolderViewIdChange?: (folderId: string | null) => void;
    onSelectionActionsChange?: (actions: DocTableSelectionActions | null) => void;
    onOwnerOnlyAction?: Dispatch<SetStateAction<OwnerGate | null>>;
    /**
     * Role-based capability check for the containing collection. Required:
     * a table whose job here is gating must be told what the caller may do,
     * and a surface with no role model at all (the personal library) says so
     * by passing `NO_ROLE_MODEL` rather than by leaving this out.
     */
    canDo: (capability: Capability) => boolean;
    enableHeaderFilters?: boolean;
    // When provided, folder contents are fetched on demand as folders are
    // expanded (instead of the whole tree being loaded and auto-expanded
    // up front). Called once per folder id the first time it's expanded.
    onExpandFolder?: (folderId: string) => void | Promise<void>;
    // Per-level document pagination, keyed by parent folder id (root uses
    // the sentinel "root"). When onLoadMoreDocuments is provided, a level
    // with more documents than are currently loaded shows a "load more" row.
    documentsHasMoreByLevel?: Record<string, boolean>;
    loadingMoreDocumentsByLevel?: Record<string, boolean>;
    onLoadMoreDocuments?: (parentId: string | null) => void;
    // Optional client-side visibility limits for collections that already
    // contain every document but should present the same paged directory UI.
    documentLimitByLevel?: Record<string, number>;
    // When non-null, these are already filtered/sorted server results and are
    // rendered as a flat list instead of the folder tree.
    serverDocuments?: Document[] | null;
    serverQueryLoading?: boolean;
    serverQueryHasMore?: boolean;
    serverQueryLoadingMore?: boolean;
    onLoadMoreServerDocuments?: () => void;
    onServerQueryChange?: (query: DocTableQuery) => void;
    onSelectAllMatching?: (query: DocTableQuery) => Promise<string[]>;
    documentTypeOptions?: TableFilterOption<string>[];
    autoLoadOnScroll?: boolean;
    defaultSort?: DocumentSort | null;
}

function documentTypeValue(doc: Document): string {
    const explicit = doc.file_type?.trim();
    if (explicit) return explicit.toLowerCase();

    const extension = doc.filename.includes(".")
        ? doc.filename.split(".").pop()?.trim()
        : null;
    return (extension || "file").toLowerCase();
}

function dateTimeValue(value: string | null | undefined): number {
    if (!value) return 0;
    const time = new Date(value).getTime();
    return Number.isFinite(time) ? time : 0;
}

function documentVersionNumber(doc: Document): number | null {
    return doc.active_version_number ?? doc.latest_version_number ?? null;
}

function ProjectTableLoadingHeader() {
    return (
        <TableHeaderRow className="pr-3">
            <TableStickyCell
                header
                widthClassName={DOC_NAME_COL_W}
            >
                <div className="mr-3 h-2.5 w-2.5 rounded bg-gray-100 animate-pulse" />
                <span className="mr-1">Name</span>
            </TableStickyCell>
            <TableHeaderCell className="ml-auto flex w-20 items-center gap-1">
                <span>Type</span>
            </TableHeaderCell>
            <TableHeaderCell className="flex w-24 items-center gap-1">
                <span>Size</span>
            </TableHeaderCell>
            <TableHeaderCell className="flex w-20 items-center gap-1">
                <span>Version</span>
            </TableHeaderCell>
            <TableHeaderCell className="flex w-32 items-center gap-1">
                <span>Created</span>
            </TableHeaderCell>
            <TableHeaderCell className="flex w-32 items-center gap-1">
                <span>Updated</span>
            </TableHeaderCell>
            <TableHeaderCell className="w-8" />
        </TableHeaderRow>
    );
}

function ProjectTableLoading() {
    return (
        <div className="flex-1 flex flex-col min-h-0">
            {[1, 2, 3, 4, 5].map((i) => (
                <div key={i} className="flex h-10 min-w-max items-center pr-3">
                    <div className={`${DOC_TABLE_STICKY_CELL_CLASS} sticky left-0 z-[60] ${DOC_NAME_COL_W} py-2 pl-3 pr-2`}>
                        <div className="flex min-w-0 items-center">
                            <div className="mr-3 h-2.5 w-2.5 shrink-0 rounded bg-gray-100 animate-pulse" />
                            <div className="mr-2 h-4 w-4 shrink-0 rounded bg-gray-100 animate-pulse" />
                            <div
                                className="h-3.5 min-w-0 flex-1 rounded bg-gray-100 animate-pulse"
                                style={{ maxWidth: `${160 + i * 20}px` }}
                            />
                        </div>
                    </div>
                    <div className="ml-auto w-20 shrink-0">
                        <div className="h-3 w-8 rounded bg-gray-100 animate-pulse" />
                    </div>
                    <div className="w-24 shrink-0">
                        <div className="h-3 w-12 rounded bg-gray-100 animate-pulse" />
                    </div>
                    <div className="w-20 shrink-0">
                        <div className="h-3 w-5 rounded bg-gray-100 animate-pulse" />
                    </div>
                    <div className="w-32 shrink-0">
                        <div className="h-3 w-16 rounded bg-gray-100 animate-pulse" />
                    </div>
                    <div className="w-32 shrink-0">
                        <div className="h-3 w-16 rounded bg-gray-100 animate-pulse" />
                    </div>
                    <div className="w-8 shrink-0" />
                </div>
            ))}
        </div>
    );
}

function UploadingTrailingLabel() {
    return (
        <span role="status" aria-label="Uploading">
            <span aria-hidden="true">Uploading</span>
            <span aria-hidden="true" className="uploading-ellipsis">
                <span className="uploading-ellipsis-one">.</span>
                <span className="uploading-ellipsis-two">..</span>
                <span className="uploading-ellipsis-three">...</span>
            </span>
        </span>
    );
}

export function DocTable({
    scopeKey,
    documents,
    setDocuments,
    folders,
    setFolders,
    loading,
    search,
    operations,
    emptyStateTitle,
    renderAddDocumentsModal,
    onAddDocumentsActionChange,
    onUploadFilesActionChange,
    onUploadFolderActionChange,
    onCreateFolderActionChange,
    onFolderViewBackActionChange,
    onFolderViewChange,
    folderViewId,
    onFolderViewIdChange,
    onSelectionActionsChange,
    onOwnerOnlyAction,
    canDo,
    enableHeaderFilters = false,
    onExpandFolder,
    documentsHasMoreByLevel,
    loadingMoreDocumentsByLevel,
    onLoadMoreDocuments,
    documentLimitByLevel,
    serverDocuments = null,
    serverQueryLoading = false,
    serverQueryHasMore = false,
    serverQueryLoadingMore = false,
    onLoadMoreServerDocuments,
    onServerQueryChange,
    onSelectAllMatching,
    documentTypeOptions,
    autoLoadOnScroll = false,
    defaultSort = null,
}: DocTableProps) {
    const [addDocsOpen, setAddDocsOpen] = useState(false);
    const { user } = useAuth();
    const [viewingDoc, setViewingDoc] = useState<Document | null>(null);
    const [viewingDocVersion, setViewingDocVersion] = useState<{
        id: string;
        label: string;
    } | null>(null);
    const [selectedDocIds, setSelectedDocIds] = useState<string[]>([]);
    const [selectedFolderIds, setSelectedFolderIds] = useState<Set<string>>(
        () => new Set(),
    );
    const [selectionCameFromSelectAll, setSelectionCameFromSelectAll] = useState(false);
    const [selectingAllDocuments, setSelectingAllDocuments] = useState(false);
    const [confirmDeleteAllOpen, setConfirmDeleteAllOpen] = useState(false);
    const [typeFilter, setTypeFilter] = useState<string | null>(null);
    const [sort, setSort] = useState<DocumentSort | null>(null);
    const serverQueryActive = serverDocuments !== null;
    const documentUploadInputRef = useRef<HTMLInputElement>(null);
    const directoryUploadInputRef = useRef<HTMLInputElement>(null);
    const tableRootRef = useRef<HTMLDivElement>(null);
    const selectionAnchorKeyRef = useRef<string | null>(null);
    const autoLoadTriggeredRef = useRef(false);
    const loadingRef = useRef(loading);
    const renderAddDocumentsModalRef = useRef(renderAddDocumentsModal);
    const setOwnerOnlyAction = useMemo(() => onOwnerOnlyAction ?? (() => {}), [onOwnerOnlyAction]);
    const allowed = canDo;
    /** Guard: false + popup when the caller's role lacks the capability. */
    const requireCapability = useCallback(
        (
            capability: Capability,
            action: string,
            requiredRole: "owner" | "editor",
        ) => {
            if (allowed(capability)) return true;
            setOwnerOnlyAction({ action, requiredRole });
            return false;
        },
        [allowed, setOwnerOnlyAction],
    );

    useEffect(() => {
        loadingRef.current = loading;
        renderAddDocumentsModalRef.current = renderAddDocumentsModal;
    }, [loading, renderAddDocumentsModal]);

    const openAddDocuments = useCallback(() => {
        if (loadingRef.current) return;
        // Same capability the header Add button is gated on — this also
        // covers the empty-state click, which calls openAddDocuments
        // directly.
        if (!requireCapability("content.edit", "add documents", "editor"))
            return;
        if (renderAddDocumentsModalRef.current) {
            setAddDocsOpen(true);
            return;
        }
        documentUploadInputRef.current?.click();
    }, [requireCapability]);

    useEffect(() => {
        onAddDocumentsActionChange?.(openAddDocuments);
        return () => onAddDocumentsActionChange?.(null);
    }, [onAddDocumentsActionChange, openAddDocuments]);

    const openUploadFiles = useCallback(() => {
        if (loadingRef.current) return;
        documentUploadInputRef.current?.click();
    }, []);

    useEffect(() => {
        onUploadFilesActionChange?.(openUploadFiles);
        return () => onUploadFilesActionChange?.(null);
    }, [onUploadFilesActionChange, openUploadFiles]);

    const openUploadFolder = useCallback(() => {
        if (loadingRef.current) return;
        directoryUploadInputRef.current?.click();
    }, []);

    useEffect(() => {
        onUploadFolderActionChange?.(openUploadFolder);
        return () => onUploadFolderActionChange?.(null);
    }, [onUploadFolderActionChange, openUploadFolder]);

    // Version-history expansion (per-doc). versionsByDocId caches fetched
    // versions so toggling closed + open again doesn't refetch. loadingIds
    // drives the inline spinner in the version cell while a fetch is in
    // flight.
    const [expandedVersionDocIds, setExpandedVersionDocIds] = useState<Set<string>>(() => new Set());
    const [versionsByDocId, setVersionsByDocId] = useState<
        Map<string, { currentVersionId: string | null; versions: DocumentVersion[] }>
    >(() => new Map());
    const [loadingVersionDocIds, setLoadingVersionDocIds] = useState<Set<string>>(() => new Set());

    const loadDocumentVersions = async (docId: string, options: { expand?: boolean; force?: boolean } = {}) => {
        if (options.expand) {
            setExpandedVersionDocIds((prev) => new Set([...prev, docId]));
        }
        if (!options.force && versionsByDocId.has(docId)) return;
        setLoadingVersionDocIds((prev) => new Set([...prev, docId]));
        try {
            const res = await listDocumentVersions(docId);
            setVersionsByDocId((prev) => {
                const next = new Map(prev);
                next.set(docId, {
                    currentVersionId: res.current_version_id,
                    versions: res.versions,
                });
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
        await loadDocumentVersions(docId, { expand: true });
    };

    async function downloadDocVersion(docId: string, versionId: string, filename: string) {
        try {
            const resolved = await getDocumentUrl(docId, versionId);
            const a = document.createElement("a");
            a.href = resolved.url;
            // Prefer the backend's resolved filename (which honours the
            // version filename). Fall back to the passed filename
            // if for some reason it's missing.
            a.download = resolved.filename || filename;
            a.click();
        } catch (e) {
            console.error("downloadDocVersion failed", e);
        }
    }

    function handleUploadNewVersion(doc: Document) {
        setVersionUploadTargetDoc(doc);
        window.setTimeout(() => versionUploadInputRef.current?.click(), 0);
    }

    async function handleVersionUploadInputChange(e: React.ChangeEvent<HTMLInputElement>) {
        const file = e.target.files?.[0] ?? null;
        e.target.value = "";
        const doc = versionUploadTargetDoc;
        setVersionUploadTargetDoc(null);
        if (!file || !doc) return;
        await handleDropDocumentVersions(doc, [file]);
    }

    /**
     * Version file-replace and delete are creator-scoped server-side, not
     * role-based: `DELETE /single-documents/:id/versions/:versionId` and
     * `PUT …/versions/:versionId/file` both call
     * `creatorScopedAllowed(access, doc.user_id)` (backend/src/lib/access.ts),
     * which is
     *
     *     the document's uploader
     *     — or, ONLY once that account is gone and `user_id` is null,
     *       somebody holding container.delete on the project.
     *
     * The departed-uploader arm exists because deleting an account blanks
     * `documents.user_id`; while an uploader still exists, "an admin does not
     * get to reach into a colleague's versions" (that comment is the server's
     * own). No capability in the matrix expresses this, so it is checked here
     * against the row, and the refusal says which rule it is.
     */
    function requireDocOwnerForVersions(docId: string, action: string): boolean {
        const doc = documents.find((d) => d.id === docId);
        if (!doc) {
            // Fail closed. This used to `return true` — a document we cannot
            // find is one we know nothing about, and the one thing we must
            // not do with an unknown is wave it through.
            setOwnerOnlyAction({
                title: "Document unavailable",
                message:
                    "That document is not loaded, so its versions cannot be changed. Reload and try again.",
            });
            return false;
        }
        if (
            creatorScopedAllowed(
                doc.user_id,
                user?.id,
                allowed("container.delete"),
            )
        )
            return true;
        if (doc.user_id) {
            // Not "Only an admin can …", which is what the admin-tier popup
            // used to claim: no admin can lift this while the uploader's
            // account exists, so naming that tier sent people to somebody who
            // could not help. And no "ask …" line, for the same reason.
            setOwnerOnlyAction({
                title: "Uploader only",
                message: `Only the person who uploaded this document can ${action}.`,
            });
            return false;
        }
        // No uploader on the row: the server does hand these versions to
        // project admins, so here the admin tier IS the rule and the normal
        // popup — with its contact line — is the right one.
        setOwnerOnlyAction({ action, requiredRole: "owner" });
        return false;
    }

    async function submitNewVersion(doc: Document, file: File, filename: string) {
        // Same tier as the server's POST /versions guard (content.edit).
        if (!requireCapability("content.edit", "upload a new version", "editor"))
            return;
        try {
            await uploadDocumentVersion(doc.id, file, filename);
            await refreshDocumentVersionState(doc.id);
        } catch (e) {
            console.error("uploadDocumentVersion failed", e);
            setDocumentUploadWarning("Version upload failed. Please try again.");
        }
    }

    async function replaceVersionFile(docId: string, versionId: string, file: File, filename: string) {
        if (
            !requireDocOwnerForVersions(docId, "replace this version's file")
        )
            return;
        await replaceDocumentVersionFile(docId, versionId, file, filename);
        const res = await refreshDocumentVersionState(docId);
        const replaced = res.versions.find((version) => version.id === versionId);
        if (replaced) {
            setViewingDocVersion({
                id: replaced.id,
                label: replaced.filename?.trim() || "Version",
            });
        }
    }

    async function refreshDocumentVersionState(docId: string) {
        // Refresh the collection so doc.active_version_number and filename advance.
        await operations.refreshCollection();
        // Re-fetch versions while keeping the previous rows visible until the
        // updated list arrives.
        const res = await listDocumentVersions(docId);
        setVersionsByDocId((prev) => {
            const next = new Map(prev);
            next.set(docId, {
                currentVersionId: res.current_version_id,
                versions: res.versions,
            });
            return next;
        });
        return res;
    }

    /**
     * Patch a version filename and update the local cache in place.
     */
    async function handleRenameVersion(docId: string, versionId: string, filename: string | null) {
        // Server PATCH /versions/:id guard is content.edit.
        if (!requireCapability("content.edit", "rename versions", "editor"))
            return;
        const previousFilename = versionsByDocId
            .get(docId)
            ?.versions.find((version) => version.id === versionId)
            ?.filename?.trim();
        if (previousFilename && (filename == null || hasFilenameExtensionChange(previousFilename, filename))) {
            setDocumentRenameWarning(extensionChangeWarning(previousFilename));
            return;
        }

        try {
            const updated = await renameDocumentVersion(docId, versionId, filename);
            setVersionsByDocId((prev) => {
                const cached = prev.get(docId);
                if (!cached) return prev;
                const next = new Map(prev);
                next.set(docId, {
                    ...cached,
                    versions: cached.versions.map((v) => (v.id === versionId ? updated : v)),
                });
                return next;
            });
        } catch (e) {
            console.error("renameDocumentVersion failed", e);
        }
    }

    async function handleDeleteVersion(docId: string, versionId: string) {
        if (!requireDocOwnerForVersions(docId, "delete document versions"))
            return;
        try {
            await deleteDocumentVersion(docId, versionId);
            const res = await refreshDocumentVersionState(docId);
            const activeVersions = res.versions.filter((version) => version.deleted_at == null);
            const nextVersion =
                activeVersions.find((version) => version.id === res.current_version_id) ??
                activeVersions[activeVersions.length - 1] ??
                null;
            setViewingDocVersion(
                nextVersion
                    ? {
                          id: nextVersion.id,
                          label: nextVersion.filename?.trim() || "Version",
                      }
                    : null,
            );
        } catch (e) {
            console.error("deleteDocumentVersion failed", e);
            setDocumentRenameWarning("Could not delete this version.");
        }
    }

    const [renamingDocumentId, setRenamingDocumentId] = useState<string | null>(null);
    const [renameDocumentValue, setRenameDocumentValue] = useState("");

    // Folder state
    const [expandedFolderIds, setExpandedFolderIds] = useState<Set<string>>(new Set());
    const [viewedFolderId, setViewedFolderId] = useState<string | null>(
        folderViewId ?? null,
    );
    const [loadingChildFolderIds, setLoadingChildFolderIds] = useState<Set<string>>(() => new Set());
    // undefined = not creating; null = creating at root; string = creating inside that folder id
    const [creatingFolderIn, setCreatingFolderIn] = useState<string | null | undefined>(undefined);
    const [newFolderName, setNewFolderName] = useState("");
    const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
    const [renameFolderValue, setRenameFolderValue] = useState("");
    const [contextMenu, setContextMenu] = useState<ProjectContextMenu | null>(null);
    const contextMenuRef = useRef<HTMLDivElement>(null);
    const newFolderInputRef = useRef<HTMLDivElement | null>(null);
    const versionUploadInputRef = useRef<HTMLInputElement>(null);
    const [dragOverFolderId, setDragOverFolderId] = useState<string | null>(null);
    const [dragOverRoot, setDragOverRoot] = useState(false);
    const [dragOverFileRoot, setDragOverFileRoot] = useState(false);
    const [isDraggingCollectionFiles, setIsDraggingCollectionFiles] = useState(false);
    const collectionDragDepthRef = useRef(0);
    const [dragOverVersionDocId, setDragOverVersionDocId] = useState<string | null>(null);
    const [uploadingVersionDocIds, setUploadingVersionDocIds] = useState<Set<string>>(() => new Set());
    const [versionUploadTargetDoc, setVersionUploadTargetDoc] = useState<Document | null>(null);
    const [collectionUploadProgress, setCollectionUploadProgress] =
        useRemountPersistentState<Array<{
            uploadId: string;
            parentFolderId: string | null;
            entries: DocumentUploadProgressEntry[];
            files: Array<{
                clientId: string;
                entry: DocumentUploadEntry;
                status: UploadProgressStatus;
            }>;
        }>>(`document-upload:${scopeKey}`, []);
    const [folderUploadConflict, setFolderUploadConflict] = useState<{
        folderName: string;
        suggestedName: string;
    } | null>(null);
    const folderUploadConflictResolverRef = useRef<
        ((choice: "rename" | "cancel") => void) | null
    >(null);
    const [deletingDocIds, setDeletingDocIds] = useState<Set<string>>(() => new Set());
    const [documentUploadWarning, setDocumentUploadWarning] = useState<string | null>(null);
    const [documentRenameWarning, setDocumentRenameWarning] = useState<string | null>(null);
    const [collectionActionWarning, setCollectionActionWarning] = useState<string | null>(null);
    const [pendingVersionDrop, setPendingVersionDrop] = useState<{
        targetDoc: Document;
        sourceDoc: Document;
    } | null>(null);
    const [pendingDeleteDoc, setPendingDeleteDoc] = useState<Document | null>(null);
    const [pendingDeleteStatus, setPendingDeleteStatus] = useState<"idle" | "deleting" | "deleted">("idle");
    const [pendingDeleteFolder, setPendingDeleteFolder] = useState<{
        folder: DocTableFolder;
        folderIds: string[];
        documentIds: string[];
        documentCount: number;
    } | null>(null);
    const [pendingDeleteFolderStatus, setPendingDeleteFolderStatus] = useState<"idle" | "deleting" | "deleted">("idle");

    useEffect(
        () => () => {
            folderUploadConflictResolverRef.current?.("cancel");
            folderUploadConflictResolverRef.current = null;
        },
        [],
    );

    const openCreateFolder = useCallback(() => {
        if (loadingRef.current) return;
        setCreatingFolderIn(viewedFolderId);
        setNewFolderName("");
    }, [viewedFolderId]);

    useEffect(() => {
        onCreateFolderActionChange?.(openCreateFolder);
        return () => onCreateFolderActionChange?.(null);
    }, [onCreateFolderActionChange, openCreateFolder]);

    useEffect(() => {
        setSelectedDocIds([]);
        setSelectedFolderIds(new Set());
        setExpandedFolderIds(new Set());
        setViewedFolderId(null);
        setSelectionCameFromSelectAll(false);
        setConfirmDeleteAllOpen(false);
        setContextMenu(null);
        selectionAnchorKeyRef.current = null;
        setTypeFilter(null);
        setSort(null);
    }, [scopeKey]);

    const foldersRef = useRef(folders);
    foldersRef.current = folders;
    const viewedFolderIdRef = useRef(viewedFolderId);
    viewedFolderIdRef.current = viewedFolderId;
    const onFolderViewIdChangeRef = useRef(onFolderViewIdChange);
    onFolderViewIdChangeRef.current = onFolderViewIdChange;

    const updateViewedFolder = useCallback((folderId: string | null) => {
        if (viewedFolderIdRef.current === folderId) return;
        viewedFolderIdRef.current = folderId;
        setViewedFolderId(folderId);
        onFolderViewIdChangeRef.current?.(folderId);
    }, []);

    useEffect(() => {
        if (folderViewId === undefined) return;
        viewedFolderIdRef.current = folderViewId;
        setViewedFolderId(folderViewId);
    }, [folderViewId, scopeKey]);

    const backFromFolderView = useCallback(() => {
        const currentFolderId = viewedFolderIdRef.current;
        if (!currentFolderId) return;
        updateViewedFolder(
            foldersRef.current.find(
                (folder) => folder.id === currentFolderId,
            )?.parent_folder_id ?? null,
        );
    }, [updateViewedFolder]);

    const navigateToFolder = useCallback((folderId: string) => {
        updateViewedFolder(folderId);
        setExpandedFolderIds((previous) => {
            if (previous.has(folderId)) return previous;
            return new Set([...previous, folderId]);
        });
    }, [updateViewedFolder]);

    const navigateToFolderRoot = useCallback(() => {
        updateViewedFolder(null);
    }, [updateViewedFolder]);

    useEffect(() => {
        onFolderViewBackActionChange?.(
            viewedFolderId ? backFromFolderView : null,
        );
    }, [
        backFromFolderView,
        onFolderViewBackActionChange,
        viewedFolderId,
    ]);

    const folderPathRef = useRef<DocTableFolder[]>([]);
    const folderPathKey = useMemo(() => {
        const path: DocTableFolder[] = [];
        let current = viewedFolderId
            ? folders.find((folder) => folder.id === viewedFolderId)
            : undefined;
        while (current) {
            path.unshift(current);
            current = current.parent_folder_id
                ? folders.find(
                      (folder) => folder.id === current?.parent_folder_id,
                )
                : undefined;
        }
        folderPathRef.current = path;
        return JSON.stringify(
            path.map((folder) => [folder.id, folder.name]),
        );
    }, [folders, viewedFolderId]);

    useEffect(() => {
        onFolderViewChange?.(
            folderPathRef.current.map((folder) => ({
                id: folder.id,
                name: folder.name,
                onClick: () => navigateToFolder(folder.id),
            })),
        );
    }, [folderPathKey, navigateToFolder, onFolderViewChange]);

    const onFolderViewBackActionChangeRef = useRef(
        onFolderViewBackActionChange,
    );
    onFolderViewBackActionChangeRef.current = onFolderViewBackActionChange;
    const onFolderViewChangeRef = useRef(onFolderViewChange);
    onFolderViewChangeRef.current = onFolderViewChange;

    useEffect(
        () => () => {
            onFolderViewBackActionChangeRef.current?.(null);
            onFolderViewChangeRef.current?.([]);
        },
        [],
    );

    useEffect(() => {
        if (search.trim() || serverQueryActive) navigateToFolderRoot();
    }, [navigateToFolderRoot, search, serverQueryActive]);

    // Close context menu on outside click
    useEffect(() => {
        if (!contextMenu) return;
        function handle(e: MouseEvent) {
            if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) setContextMenu(null);
        }
        document.addEventListener("mousedown", handle);
        return () => document.removeEventListener("mousedown", handle);
    }, [contextMenu]);

    // Clear all drag state when any drag operation ends
    useEffect(() => {
        function handleDragEnd() {
            setDragOverFolderId(null);
            setDragOverRoot(false);
            setDragOverFileRoot(false);
            collectionDragDepthRef.current = 0;
            setIsDraggingCollectionFiles(false);
        }
        document.addEventListener("dragend", handleDragEnd);
        return () => document.removeEventListener("dragend", handleDragEnd);
    }, []);

    // Poll documents stuck in deferred conversion until the backend marks
    // them "ready"/"error" (async conversion flips status server-side)
    useEffect(() => {
        const converting = documents.filter(
            (d) => d.status === "pending" || d.status === "processing",
        );
        if (converting.length === 0) return;

        let cancelled = false;
        const interval = window.setInterval(() => {
            for (const doc of converting) {
                getDocument(doc.id)
                    .then((latest) => {
                        if (cancelled || latest.status === doc.status) return;
                        setDocuments((prev) =>
                            prev.map((d) =>
                                d.id === doc.id ? { ...d, ...latest } : d,
                            ),
                        );
                    })
                    .catch(() => {
                        // Transient fetch failure — keep polling
                    });
            }
        }, 3000);
        return () => {
            cancelled = true;
            window.clearInterval(interval);
        };
    }, [documents, setDocuments]);

    // Scroll new-folder input into view whenever it appears
    useEffect(() => {
        if (creatingFolderIn !== undefined) {
            newFolderInputRef.current?.scrollIntoView({
                behavior: "smooth",
                block: "nearest",
            });
        }
    }, [creatingFolderIn]);

    // ── Folder handlers ───────────────────────────────────────────────────────

    async function expandFolderChildren(folderId: string) {
        if (!onExpandFolder) return;
        setLoadingChildFolderIds((prev) => new Set([...prev, folderId]));
        try {
            await onExpandFolder(folderId);
        } catch (e) {
            console.error("expand folder failed", e);
        } finally {
            setLoadingChildFolderIds((prev) => {
                const next = new Set(prev);
                next.delete(folderId);
                return next;
            });
        }
    }

    function toggleFolder(id: string) {
        const opening = !expandedFolderIds.has(id);
        setExpandedFolderIds((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
        if (opening) void expandFolderChildren(id);
    }

    function openFolderView(id: string) {
        updateViewedFolder(id);
        if (expandedFolderIds.has(id)) return;
        setExpandedFolderIds((prev) => new Set([...prev, id]));
        void expandFolderChildren(id);
    }

    async function handleCreateFolder(parentId: string | null) {
        const name = newFolderName.trim();
        setNewFolderName("");
        if (!name) {
            setCreatingFolderIn(undefined);
            return;
        }
        if (!requireCapability("docs.organize", "create folders", "editor")) {
            setCreatingFolderIn(undefined);
            return;
        }

        // Immediately hide the input and show an optimistic folder row
        setCreatingFolderIn(undefined);
        const tempId = `temp-${Date.now()}`;
        const optimistic = {
            id: tempId,
            user_id: "",
            name,
            parent_folder_id: parentId,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
        } as DocTableFolder;
        setFolders((prev) => [...prev, optimistic]);
        setExpandedFolderIds((prev) => new Set([...prev, tempId]));
        if (parentId) {
            const wasExpanded = expandedFolderIds.has(parentId);
            setExpandedFolderIds((prev) => new Set([...prev, parentId]));
            if (!wasExpanded) void expandFolderChildren(parentId);
        }

        // Replace with real folder from API
        const folder = await operations.createFolder(name, parentId ?? null);
        setFolders((prev) => prev.map((f) => (f.id === tempId ? folder : f)));
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
        // Folder operations are member-level: organizing the shelf is part
        // of collaborating on what sits on it, not an administrative act.
        if (!requireCapability("docs.organize", "rename folders", "editor"))
            return;
        const updatedAt = new Date().toISOString();
        setFolders((prev) =>
            prev.map((folder) =>
                folder.id === folderId
                    ? { ...folder, name, updated_at: updatedAt }
                    : folder,
            ),
        );
        const updated = await operations.renameFolder(folderId, name);
        setFolders((prev) =>
            prev.map((folder) =>
                folder.id === folderId ? { ...folder, ...updated } : folder,
            ),
        );
    }

    function folderDeleteImpact(folderId: string) {
        const childrenByParent = new Map<string, string[]>();
        for (const folder of folders) {
            if (!folder.parent_folder_id) continue;
            const children = childrenByParent.get(folder.parent_folder_id) ?? [];
            children.push(folder.id);
            childrenByParent.set(folder.parent_folder_id, children);
        }

        const toDelete = new Set<string>();
        const stack = [folderId];
        while (stack.length > 0) {
            const id = stack.pop();
            if (!id || toDelete.has(id)) continue;
            toDelete.add(id);
            stack.push(...(childrenByParent.get(id) ?? []));
        }

        const folderIds = [...toDelete];
        const documentIds = documents.filter((d) => d.folder_id && toDelete.has(d.folder_id)).map((d) => d.id);
        return { folderIds, documentIds, documentCount: documentIds.length };
    }

    function requestDeleteFolder(folderId: string) {
        if (
            !requireCapability(
                "docs.organize",
                "delete folders and their documents",
                "editor",
            )
        )
            return;
        const folder = folders.find((f) => f.id === folderId);
        if (!folder) return;
        const impact = folderDeleteImpact(folderId);
        setPendingDeleteFolderStatus("idle");
        setPendingDeleteFolder({
            folder,
            folderIds: impact.folderIds,
            documentIds: impact.documentIds,
            documentCount: impact.documentCount,
        });
    }

    async function confirmDeletePendingFolder() {
        const pending = pendingDeleteFolder;
        if (!pending || pendingDeleteFolderStatus === "deleting") return;
        setPendingDeleteFolderStatus("deleting");
        const folderSnapshot = folders;
        const documentSnapshot = documents;
        const toDelete = new Set(pending.folderIds);
        setFolders((prev) => prev.filter((f) => !toDelete.has(f.id)));
        setDocuments((prev) => prev.filter((d) => !d.folder_id || !toDelete.has(d.folder_id)));

        try {
            await operations.deleteFolder(pending.folder.id);
            const currentFolderId = viewedFolderIdRef.current;
            if (currentFolderId && toDelete.has(currentFolderId)) {
                updateViewedFolder(pending.folder.parent_folder_id ?? null);
            }
            setExpandedFolderIds((prev) => {
                const next = new Set(prev);
                for (const id of toDelete) next.delete(id);
                return next;
            });
            if (renamingFolderId && toDelete.has(renamingFolderId)) {
                setRenamingFolderId(null);
            }
            if (contextMenu?.folderId && toDelete.has(contextMenu.folderId)) {
                setContextMenu(null);
            }
            const deletedDocIds = new Set(pending.documentIds);
            setSelectedDocIds((prev) => prev.filter((id) => !deletedDocIds.has(id)));
            setSelectedFolderIds((prev) => {
                const next = new Set(prev);
                for (const id of toDelete) next.delete(id);
                return next;
            });
            setExpandedVersionDocIds((prev) => {
                const next = new Set(prev);
                for (const id of pending.documentIds) next.delete(id);
                return next;
            });
            setVersionsByDocId((prev) => {
                const next = new Map(prev);
                for (const id of pending.documentIds) next.delete(id);
                return next;
            });
            setPendingDeleteFolderStatus("deleted");
            window.setTimeout(() => {
                setPendingDeleteFolder(null);
                setPendingDeleteFolderStatus("idle");
            }, 650);
        } catch (err) {
            console.error("delete folder failed", err);
            setFolders((current) =>
                restoreOptimisticallyDeletedRows(
                    current,
                    folderSnapshot,
                    pending.folderIds,
                ),
            );
            setDocuments((current) =>
                restoreOptimisticallyDeletedRows(
                    current,
                    documentSnapshot,
                    pending.documentIds,
                ),
            );
            setPendingDeleteFolderStatus("idle");
            setCollectionActionWarning("Folder could not be deleted. Please try again.");
        }
    }

    // ── Doc/chat/review handlers ──────────────────────────────────────────────

    function handleDocsSelected(newDocs: Document[]) {
        setDocuments((prev) => [...prev, ...newDocs.filter((d) => !prev.some((e) => e.id === d.id))]);
    }

    function removeDocumentFromLocalState(docId: string) {
        setDocuments((prev) => prev.filter((doc) => doc.id !== docId));
        setSelectedDocIds((prev) => prev.filter((id) => id !== docId));
        setExpandedVersionDocIds((prev) => {
            const next = new Set(prev);
            next.delete(docId);
            return next;
        });
        setVersionsByDocId((prev) => {
            const next = new Map(prev);
            next.delete(docId);
            return next;
        });
        setLoadingVersionDocIds((prev) => {
            const next = new Set(prev);
            next.delete(docId);
            return next;
        });
        setUploadingVersionDocIds((prev) => {
            const next = new Set(prev);
            next.delete(docId);
            return next;
        });
        setViewingDoc((prev) => (prev?.id === docId ? null : prev));
        if (renamingDocumentId === docId) setRenamingDocumentId(null);
        if (contextMenu?.docId === docId) setContextMenu(null);
    }

    function restoreDocumentToLocalState(
        doc: Document,
        snapshot: {
            index: number;
            selected: boolean;
            versionsOpen: boolean;
            versions?: DocumentVersion[];
            currentVersionId?: string | null;
            loadingVersions: boolean;
            uploadingVersion: boolean;
            viewing: boolean;
            viewingVersion: typeof viewingDocVersion;
        },
    ) {
        setDocuments((prev) => {
            if (prev.some((d) => d.id === doc.id)) return prev;
            const nextDocs = [...prev];
            nextDocs.splice(Math.max(0, Math.min(snapshot.index, nextDocs.length)), 0, doc);
            return nextDocs;
        });
        if (snapshot.selected) {
            setSelectedDocIds((prev) => (prev.includes(doc.id) ? prev : [...prev, doc.id]));
        }
        if (snapshot.versionsOpen) {
            setExpandedVersionDocIds((prev) => new Set([...prev, doc.id]));
        }
        const versions = snapshot.versions;
        if (versions) {
            setVersionsByDocId((prev) => {
                const next = new Map(prev);
                next.set(doc.id, {
                    currentVersionId: snapshot.currentVersionId ?? null,
                    versions,
                });
                return next;
            });
        }
        if (snapshot.loadingVersions) {
            setLoadingVersionDocIds((prev) => new Set([...prev, doc.id]));
        }
        if (snapshot.uploadingVersion) {
            setUploadingVersionDocIds((prev) => new Set([...prev, doc.id]));
        }
        if (snapshot.viewing) {
            setViewingDoc(doc);
            setViewingDocVersion(snapshot.viewingVersion);
        }
    }

    async function handleRemoveDocFromFolder(docId: string) {
        if (
            !requireCapability("docs.organize", "move documents", "editor")
        )
            return;
        setDocuments((prev) => prev.map((d) => (d.id === docId ? { ...d, folder_id: null } : d)));
        await operations.moveDocument(docId, null);
    }

    async function submitDocumentRename(docId: string) {
        const trimmed = renameDocumentValue.trim();
        if (!trimmed) {
            setRenamingDocumentId(null);
            return;
        }
        const previous = documents.find((d) => d.id === docId);
        if (!previous || trimmed === previous.filename) {
            setRenamingDocumentId(null);
            return;
        }
        if (
            !requireCapability("docs.organize", "rename documents", "editor")
        ) {
            setRenamingDocumentId(null);
            return;
        }
        if (hasFilenameExtensionChange(previous.filename, trimmed)) {
            setDocumentRenameWarning(extensionChangeWarning(previous.filename));
            return;
        }

        setRenamingDocumentId(null);

        setDocuments((prev) =>
            prev.map((d) =>
                d.id === docId
                    ? {
                          ...d,
                          filename: trimmed,
                          updated_at: new Date().toISOString(),
                      }
                    : d,
            ),
        );
        try {
            const updated = await operations.renameDocument(docId, trimmed);
            setDocuments((prev) => prev.map((d) => (d.id === docId ? { ...d, ...updated } : d)));
        } catch (e) {
            console.error("renameDocument failed", e);
            setDocuments((prev) => (previous ? prev.map((d) => (d.id === docId ? previous : d)) : prev));
        }
    }

    async function handleRemoveDoc(docId: string) {
        const doc = docs.find((d) => d.id === docId);
        // Backend only lets the document's uploader delete. Warn the
        // requester instead of letting the request 404 silently — and refuse
        // when we cannot establish ownership, which the old condition read as
        // permission (it required `doc`, `user.id` AND `doc.user_id` to be
        // present before it would refuse anything).
        if (!canDeleteDocument(doc)) {
            refuseDocumentDelete("delete it");
            return;
        }
        setDeletingDocIds((prev) => new Set([...prev, docId]));
        const snapshot = docs;
        setDocuments((prev) => prev.filter((d) => d.id !== docId));
        try {
            await deleteDocument(docId);
        } catch (error) {
            setDocuments((current) =>
                restoreOptimisticallyDeletedRows(current, snapshot, [docId]),
            );
            throw error;
        } finally {
            setDeletingDocIds((prev) => {
                const next = new Set(prev);
                next.delete(docId);
                return next;
            });
        }
    }

    function requestRemoveDoc(doc: Document) {
        if (doc && user?.id && doc.user_id && doc.user_id !== user.id) {
            setOwnerOnlyAction("delete this document");
            return;
        }
        const versionCount = versionsByDocId.get(doc.id)?.versions.length ?? currentVersionNumber(doc) ?? 1;
        if (versionCount <= 1) {
            // No confirmation dialog owns this failure, so surface it here
            // instead of letting the rethrow become an unhandled rejection and
            // the row reappear with no explanation.
            void handleRemoveDoc(doc.id).catch((error) => {
                console.error("delete document failed", error);
                setCollectionActionWarning(
                    userFacingApiError(
                        error,
                        "This file could not be deleted. Please try again.",
                    ),
                );
            });
            return;
        }
        setPendingDeleteStatus("idle");
        setPendingDeleteDoc(doc);
    }

    async function confirmRemovePendingDoc() {
        const pending = pendingDeleteDoc;
        if (!pending || pendingDeleteStatus === "deleting") return;
        setPendingDeleteStatus("deleting");
        try {
            await handleRemoveDoc(pending.id);
            setPendingDeleteStatus("deleted");
            window.setTimeout(() => {
                setPendingDeleteDoc(null);
                setPendingDeleteStatus("idle");
            }, 650);
        } catch (err) {
            console.error("delete document failed", err);
            setPendingDeleteStatus("idle");
        }
    }

    // ── Drag & drop ───────────────────────────────────────────────────────────

    function wouldCreateCycle(movingId: string, targetId: string): boolean {
        // Returns true if targetId is movingId or a descendant of it
        let cur: DocTableFolder | undefined = folders.find((f) => f.id === targetId);
        while (cur) {
            if (cur.id === movingId) return true;
            if (!cur.parent_folder_id) break;
            cur = folders.find((f) => f.id === cur!.parent_folder_id);
        }
        return false;
    }

    function hasMovePayload(dt: DataTransfer): boolean {
        return Array.from(dt.types).some(
            (type) =>
                type === SINGLE_DOCUMENT_DRAG_TYPE ||
                type === MULTI_DOCUMENT_DRAG_TYPE ||
                type === "application/mike-folder",
        );
    }

    function hasFilePayload(dt: DataTransfer): boolean {
        return Array.from(dt.types).includes("Files");
    }

    function hasDocumentPayload(dt: DataTransfer): boolean {
        return Array.from(dt.types).includes(SINGLE_DOCUMENT_DRAG_TYPE);
    }

    function currentVersionNumber(doc: Document): number | null {
        return documentVersionNumber(doc);
    }

    /**
     * Whether the caller may delete this document.
     *
     * `DELETE /single-documents/:documentId` (backend/src/routes/documents.ts)
     * selects the row with `.eq("id", documentId).eq("user_id", userId)` and
     * 404s if that finds nothing. There is no `ensureDocAccess`, no `can()`,
     * no departed-uploader arm — deletion is pure row ownership, and a
     * project admin genuinely cannot delete a colleague's document. So this
     * stays keyed on the uploader rather than moving to `canDo`; a role-based
     * check here would be the client promising something the server refuses.
     *
     * What changes is that both halves must now be KNOWN. The old
     * `isSharedDocument(doc)` test answered false — "not somebody else's" —
     * for a document with no uploader at all and for a caller whose id had
     * not resolved, and both were being read as "yours, go ahead", enabling
     * a delete the server was always going to 404.
     */
    const canDeleteDocument = useCallback(
        (doc: Document | null | undefined): boolean =>
            // Creator-scoped with NO departed-uploader arm: this route has no
            // `ensureDocAccess` at all, so when `user_id` is null the row is
            // deletable by nobody.
            creatorScopedAllowed(doc?.user_id, user?.id, false),
        [user?.id],
    );

    /** The refusal for a delete: the uploader rule, and nobody to ask. */
    function refuseDocumentDelete(action: string) {
        setOwnerOnlyAction({
            title: "Uploader only",
            message: `Only the person who uploaded this document can ${action}.`,
        });
    }

    function requestFolderUploadConflictChoice(conflict: {
        folder_name: string;
        suggested_name: string;
    }): Promise<"rename" | "cancel"> {
        folderUploadConflictResolverRef.current?.("cancel");
        setFolderUploadConflict({
            folderName: conflict.folder_name,
            suggestedName: conflict.suggested_name,
        });
        return new Promise((resolve) => {
            folderUploadConflictResolverRef.current = resolve;
        });
    }

    function finishFolderUploadConflict(
        choice: "rename" | "cancel",
    ) {
        const resolve = folderUploadConflictResolverRef.current;
        folderUploadConflictResolverRef.current = null;
        setFolderUploadConflict(null);
        resolve?.(choice);
    }

    async function handleCollectionUploadEntries(
        entries: DocumentUploadEntry[],
        baseFolderId: string | null = viewedFolderIdRef.current,
    ) {
        if (entries.length === 0) return;
        // Drag-and-drop and the folder picker bypass the
        // (capability-gated) Add button, so they need the same
        // content.edit check: viewers get the role popup instead of a
        // doomed upload that the backend would 403 anyway.
        if (!requireCapability("content.edit", "add documents", "editor"))
            return;
        const { supported, unsupported } = partitionSupportedDocumentFiles(
            entries.map((entry) => entry.file),
        );
        setDocumentUploadWarning(formatUnsupportedDocumentWarning(unsupported));
        if (supported.length === 0) return;
        const supportedFiles = new Set(supported);
        const supportedEntries = entries.filter((entry) =>
            supportedFiles.has(entry.file),
        );
        if (
            supportedEntries.length > MAX_DOCUMENTS_PER_DIRECTORY_UPLOAD
        ) {
            setCollectionActionWarning(
                `You can upload up to ${MAX_DOCUMENTS_PER_DIRECTORY_UPLOAD} supported documents at a time. Nothing was uploaded.`,
            );
            return;
        }
        const progressFiles = supportedEntries.map((entry) => ({
            clientId: crypto.randomUUID(),
            entry,
            status: "pending" as UploadProgressStatus,
        }));
        const uploadId = crypto.randomUUID();
        const clientIdByFile = new Map(
            progressFiles.map((progress) => [
                progress.entry.file,
                progress.clientId,
            ]),
        );
        const resolvedRootFolderNames = new Map<string, string>();
        const updateCollectionUploadProgress = () => {
            setCollectionUploadProgress((current) => {
                const existing = current.find(
                    (upload) => upload.uploadId === uploadId,
                );
                const nextUpload = {
                    uploadId,
                    parentFolderId: baseFolderId,
                    entries: resolvedDocumentUploadProgressEntries(
                        supportedEntries,
                        resolvedRootFolderNames,
                    ),
                    files: existing?.files ?? progressFiles,
                };
                return existing
                    ? current.map((upload) =>
                          upload.uploadId === uploadId ? nextUpload : upload,
                      )
                    : [...current, nextUpload];
            });
        };
        updateCollectionUploadProgress();

        try {
            const addResolvedFolders = (resolvedFolders: DocTableFolder[]) => {
                setFolders((current) => {
                    const next = [...current];
                    const knownIds = new Set(current.map((folder) => folder.id));
                    for (const folder of resolvedFolders) {
                        if (knownIds.has(folder.id)) continue;
                        knownIds.add(folder.id);
                        next.push(folder);
                    }
                    return next;
                });
            };

            const rootFolderNames = Array.from(
                new Set(
                    supportedEntries.flatMap((entry) => {
                        const segments = documentUploadFolderSegments(entry);
                        return segments.length > 0 ? [segments[0]] : [];
                    }),
                ),
            );
            const resolvedRoots = new Map<
                string,
                { folderId: string }
            >();

            for (const rootFolderName of rootFolderNames) {
                const resolution = await resolveDocumentUploadRootFolder({
                    rootFolderName,
                    baseFolderId,
                    resolveFolderPath: operations.resolveFolderPath,
                    chooseConflict: requestFolderUploadConflictChoice,
                });
                if (!resolution) return;

                resolvedRootFolderNames.set(
                    rootFolderName,
                    resolution.resolved_name,
                );
                updateCollectionUploadProgress();
                addResolvedFolders(resolution.folders);
                resolvedRoots.set(rootFolderName, {
                    folderId: resolution.folder_id,
                });
            }

            const folderPathPromises = new Map<string, Promise<string>>();
            const resolveEntryFolder = async (entry: DocumentUploadEntry) => {
                const segments = documentUploadFolderSegments(entry);
                if (segments.length === 0) return baseFolderId;
                const root = resolvedRoots.get(segments[0]);
                if (!root) throw new Error("Folder root was not resolved");
                const remainingSegments = segments.slice(1);
                if (remainingSegments.length === 0) return root.folderId;
                const key = JSON.stringify([root.folderId, remainingSegments]);
                const existing = folderPathPromises.get(key);
                if (existing) return existing;
                const pending = operations
                    .resolveFolderPath(
                        remainingSegments,
                        root.folderId,
                        "reuse",
                    )
                    .then((nestedResolution) => {
                        if (nestedResolution.conflict) {
                            throw new Error("Nested folder path conflicted");
                        }
                        addResolvedFolders(nestedResolution.folders);
                        return nestedResolution.folder_id;
                    });
                folderPathPromises.set(key, pending);
                return pending;
            };

            const folderResults = await settleWithConcurrency(
                supportedEntries,
                DOCUMENT_UPLOAD_CONCURRENCY,
                async (entry) => {
                    const folderId = await resolveEntryFolder(entry);
                    return { entry, folderId };
                },
            );
            const resolvedEntries = folderResults.flatMap((result) =>
                result.status === "fulfilled" ? [result.value] : [],
            );
            const folderFailureOutcomes = folderResults.flatMap(
                (result, index): UploadOutcome<Document>[] =>
                    result.status === "rejected"
                        ? [
                              {
                                  clientId: progressFiles[index].clientId,
                                  filename:
                                      progressFiles[index].entry.file.name,
                                  status: "error",
                                  result: null,
                                  errorCode: "folder_resolution_failed",
                              },
                          ]
                        : [],
            );
            let batchOutcomes: UploadOutcome<Document>[] | null = null;
            let uploaded: Document[];
            if (operations.uploadDocuments) {
                batchOutcomes = await operations.uploadDocuments(
                    resolvedEntries.map(({ entry, folderId }) => ({
                        file: entry.file,
                        folderId,
                        clientId: clientIdByFile.get(entry.file)!,
                    })),
                    {
                        onProgress: (progress) => {
                            setCollectionUploadProgress((current) =>
                                current.map((upload) =>
                                    upload.uploadId === uploadId
                                        ? {
                                              ...upload,
                                              files: upload.files.map((file) =>
                                                  file.clientId ===
                                                  progress.clientId
                                                      ? {
                                                            ...file,
                                                            status: progress.status,
                                                        }
                                                      : file,
                                              ),
                                          }
                                        : upload,
                                ),
                            );
                            if (
                                progress.status === "completed" &&
                                progress.result
                            ) {
                                handleDocsSelected([progress.result]);
                            }
                        },
                    },
                );
                uploaded = batchOutcomes.flatMap((outcome) =>
                    outcome.status === "completed" && outcome.result
                        ? [outcome.result]
                        : [],
                );
            } else {
                const results = await settleWithConcurrency(
                    resolvedEntries,
                    DOCUMENT_UPLOAD_CONCURRENCY,
                    ({ entry, folderId }) =>
                        operations.uploadDocument(entry.file, folderId),
                );
                uploaded = results.flatMap((result) =>
                    result.status === "fulfilled" ? [result.value] : [],
                );
            }
            handleDocsSelected(uploaded);
            const failedCount = supportedEntries.length - uploaded.length;
            if (failedCount > 0) {
                setCollectionActionWarning(
                    failedUploadMessage([
                        ...folderFailureOutcomes,
                        ...(batchOutcomes ?? []),
                    ]),
                );
            }
        } catch (err) {
            console.error("Document drop upload failed", err);
            setCollectionActionWarning(
                err instanceof UploadBatchError
                    ? failedUploadMessage(err.outcomes)
                    : userFacingApiError(
                          err,
                          "This folder could not be uploaded. Please try again.",
                      ),
            );
        } finally {
            setCollectionUploadProgress((current) =>
                current.filter((upload) => upload.uploadId !== uploadId),
            );
        }
    }

    function handleDropCollectionFiles(
        files: File[],
        baseFolderId?: string | null,
    ) {
        return handleCollectionUploadEntries(
            documentUploadEntriesFromFiles(files),
            baseFolderId,
        );
    }

    async function handleDroppedCollectionDataTransfer(
        dataTransfer: DataTransfer,
        baseFolderId?: string | null,
    ) {
        try {
            const entries =
                await collectDroppedDocumentUploadEntries(dataTransfer);
            await handleCollectionUploadEntries(entries, baseFolderId);
        } catch (error) {
            console.error("Folder drop traversal failed", error);
            setCollectionActionWarning(
                "This folder could not be read. Please try selecting it with Upload folder.",
            );
        }
    }

    useEffect(() => {
        const hasFiles = (dataTransfer: DataTransfer | null) =>
            !!dataTransfer && Array.from(dataTransfer.types).includes("Files");

        function handleDragEnter(event: globalThis.DragEvent) {
            if (!hasFiles(event.dataTransfer)) return;
            event.preventDefault();
            collectionDragDepthRef.current += 1;
            setIsDraggingCollectionFiles(true);
        }

        function handleDragOver(event: globalThis.DragEvent) {
            if (!hasFiles(event.dataTransfer)) return;
            event.preventDefault();
            if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
        }

        function handleDragLeave(event: globalThis.DragEvent) {
            if (!hasFiles(event.dataTransfer)) return;
            collectionDragDepthRef.current = Math.max(0, collectionDragDepthRef.current - 1);
            if (collectionDragDepthRef.current === 0) {
                setIsDraggingCollectionFiles(false);
            }
        }

        function handleDrop(event: globalThis.DragEvent) {
            if (!hasFiles(event.dataTransfer)) return;
            event.preventDefault();
            event.stopPropagation();
            const dataTransfer = event.dataTransfer;
            collectionDragDepthRef.current = 0;
            setIsDraggingCollectionFiles(false);
            setDragOverFileRoot(false);
            if (!dataTransfer) return;
            void handleDroppedCollectionDataTransfer(dataTransfer);
        }

        window.addEventListener("dragenter", handleDragEnter);
        window.addEventListener("dragover", handleDragOver);
        window.addEventListener("dragleave", handleDragLeave);
        window.addEventListener("drop", handleDrop);
        return () => {
            window.removeEventListener("dragenter", handleDragEnter);
            window.removeEventListener("dragover", handleDragOver);
            window.removeEventListener("dragleave", handleDragLeave);
            window.removeEventListener("drop", handleDrop);
        };
    });

    async function handleDropDocumentVersions(doc: Document, files: File[]) {
        if (files.length === 0) return;
        // Same tier as the server's POST /versions guard (content.edit) —
        // without it an org viewer's drop fails into console.error only.
        if (!requireCapability("content.edit", "upload a new version", "editor"))
            return;
        const { supported, unsupported } = partitionSupportedDocumentFiles(files);
        setDocumentUploadWarning(formatUnsupportedDocumentWarning(unsupported));
        if (supported.length === 0) return;

        setUploadingVersionDocIds((prev) => new Set([...prev, doc.id]));
        try {
            for (const file of supported) {
                await uploadDocumentVersion(doc.id, file, file.name);
            }
            await refreshDocumentVersionState(doc.id);
        } catch (err) {
            console.error("Document version drop upload failed", err);
            setDocumentUploadWarning("Version upload failed. Please try again.");
        } finally {
            setUploadingVersionDocIds((prev) => {
                const next = new Set(prev);
                next.delete(doc.id);
                return next;
            });
        }
    }

    async function saveExistingDocumentAsNewVersion(targetDoc: Document, sourceDoc: Document) {
        const sourceIndex = documents.findIndex((doc) => doc.id === sourceDoc.id);
        const sourceSnapshot = {
            index: sourceIndex >= 0 ? sourceIndex : 0,
            selected: selectedDocIds.includes(sourceDoc.id),
            versionsOpen: expandedVersionDocIds.has(sourceDoc.id),
            versions: versionsByDocId.get(sourceDoc.id)?.versions,
            currentVersionId: versionsByDocId.get(sourceDoc.id)?.currentVersionId,
            loadingVersions: loadingVersionDocIds.has(sourceDoc.id),
            uploadingVersion: uploadingVersionDocIds.has(sourceDoc.id),
            viewing: viewingDoc?.id === sourceDoc.id,
            viewingVersion: viewingDoc?.id === sourceDoc.id ? viewingDocVersion : null,
        };

        setUploadingVersionDocIds((prev) => new Set([...prev, targetDoc.id]));
        removeDocumentFromLocalState(sourceDoc.id);
        try {
            await copyDocumentVersionFromDocument(targetDoc.id, sourceDoc.id, sourceDoc.filename);
            await refreshDocumentVersionState(targetDoc.id);
        } catch (err) {
            console.error("Existing document version drop failed", err);
            restoreDocumentToLocalState(sourceDoc, sourceSnapshot);
            setCollectionActionWarning(
                userFacingApiError(
                    err,
                    "Could not save this document as a new version.",
                ),
            );
        } finally {
            setUploadingVersionDocIds((prev) => {
                const next = new Set(prev);
                next.delete(targetDoc.id);
                return next;
            });
        }
    }

    function handleDropExistingDocumentVersion(targetDoc: Document, sourceDocId: string) {
        if (!sourceDocId || sourceDocId === targetDoc.id) return;
        const sourceDoc = documents.find((doc) => doc.id === sourceDocId);
        if (!sourceDoc) return;
        setPendingVersionDrop({ targetDoc, sourceDoc });
    }

    function handleDocumentVersionDragOver(e: DragEvent<HTMLDivElement>, docId: string) {
        if (dataTransferHasDirectory(e.dataTransfer)) return;
        if (!hasFilePayload(e.dataTransfer) && !hasDocumentPayload(e.dataTransfer)) {
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "copy";
        setDragOverVersionDocId(docId);
        setDragOverFileRoot(false);
        setDragOverRoot(false);
    }

    function handleDocumentVersionDragLeave(e: DragEvent<HTMLDivElement>) {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) {
            setDragOverVersionDocId(null);
        }
    }

    function handleDocumentVersionDrop(e: DragEvent<HTMLDivElement>, doc: Document) {
        if (dataTransferHasDirectory(e.dataTransfer)) return;
        if (!hasFilePayload(e.dataTransfer) && !hasDocumentPayload(e.dataTransfer)) {
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        setDragOverVersionDocId(null);
        setDragOverFileRoot(false);
        collectionDragDepthRef.current = 0;
        setIsDraggingCollectionFiles(false);
        setDragOverRoot(false);
        setDragOverFolderId(null);
        if (hasFilePayload(e.dataTransfer)) {
            void handleDropDocumentVersions(doc, Array.from(e.dataTransfer.files));
            return;
        }
        void handleDropExistingDocumentVersion(
            doc,
            readDocumentDragPayload(e.dataTransfer)[0] ?? "",
        );
    }

    async function handleDropOnFolder(targetFolderId: string | null, dt: DataTransfer) {
        if (!hasMovePayload(dt)) return;
        const docIds = readDocumentDragPayload(dt);
        const subFolderId = dt.getData("application/mike-folder");
        if (docIds.length > 0) {
            const movingIds = docIds.filter((id) => {
                const doc = documents.find((candidate) => candidate.id === id);
                return doc && (doc.folder_id ?? null) !== targetFolderId;
            });
            if (movingIds.length === 0) return;
            if (
                !requireCapability("docs.organize", "move documents", "editor")
            )
                return;
            const updatedAt = new Date().toISOString();
            setDocuments((prev) =>
                prev.map((document) =>
                    movingIds.includes(document.id)
                        ? {
                              ...document,
                              folder_id: targetFolderId,
                              updated_at: updatedAt,
                          }
                        : document,
                ),
            );
            const results = await Promise.allSettled(
                movingIds.map((documentId) =>
                    operations.moveDocument(documentId, targetFolderId),
                ),
            );
            const updatedById = new Map(
                results.flatMap((result) =>
                    result.status === "fulfilled"
                        ? [[result.value.id, result.value] as const]
                        : [],
                ),
            );
            setDocuments((prev) =>
                prev.map((document) =>
                    updatedById.has(document.id)
                        ? { ...document, ...updatedById.get(document.id)! }
                        : document,
                ),
            );
            const failedCount = results.length - updatedById.size;
            if (failedCount > 0) {
                await operations.refreshCollection();
                setCollectionActionWarning(
                    `${failedCount} ${failedCount === 1 ? "document" : "documents"} could not be moved. Please try again.`,
                );
            }
        } else if (subFolderId && subFolderId !== targetFolderId) {
            if (
                !requireCapability("docs.organize", "move folders", "editor")
            )
                return;
            if (targetFolderId !== null && wouldCreateCycle(subFolderId, targetFolderId)) return;
            const folder = folders.find((f) => f.id === subFolderId);
            if (!folder || (folder.parent_folder_id ?? null) === targetFolderId) return;
            const updatedAt = new Date().toISOString();
            setFolders((prev) =>
                prev.map((candidate) =>
                    candidate.id === subFolderId
                        ? {
                              ...candidate,
                              parent_folder_id: targetFolderId,
                              updated_at: updatedAt,
                          }
                        : candidate,
                ),
            );
            const updated = await operations.moveFolder(
                subFolderId,
                targetFolderId,
            );
            setFolders((prev) =>
                prev.map((candidate) =>
                    candidate.id === subFolderId
                        ? { ...candidate, ...updated }
                        : candidate,
                ),
            );
        }
    }

    // ── Tree rendering ────────────────────────────────────────────────────────

    function renderFolderInput(parentId: string | null, depth: number) {
        if (creatingFolderIn !== parentId) return null;
        return (
            <div
                ref={newFolderInputRef}
                className="group flex h-10 min-w-max items-center pr-3"
                key={`new-folder-${parentId ?? "root"}`}
            >
                <div
                    className={`${DOC_TABLE_STICKY_CELL_CLASS} sticky left-0 z-[60] ${DOC_NAME_COL_W} py-2 pl-3 pr-2`}
                    style={treeNameCellStyle(depth)}
                >
                    <div className="flex items-center">
                        <input
                            type="checkbox"
                            disabled
                            aria-label="Select files in new folder"
                            className={`${TABLE_CHECKBOX_CLASS} cursor-default opacity-40`}
                        />
                        <span className="mr-2 flex h-4 w-4 shrink-0 items-center justify-center">
                            <ChevronRight className="h-4 w-4 text-gray-300" />
                        </span>
                        <SubfolderSvgIcon className="mr-2 h-4 w-4 shrink-0" />
                        <input
                            autoFocus
                            className="flex-1 min-w-0 text-xs text-gray-800 bg-transparent outline-none border-b border-gray-300"
                            placeholder="Folder name"
                            value={newFolderName}
                            onChange={(e) => setNewFolderName(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === "Enter") void handleCreateFolder(parentId);
                                if (e.key === "Escape") {
                                    setCreatingFolderIn(undefined);
                                    setNewFolderName("");
                                }
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

    function renderDocumentActivityRow({
        key,
        filename,
        fileType,
        depth,
        statusLabel,
        nameTrailingLabel,
        entryKind = "file",
    }: {
        key: string;
        filename: string;
        fileType: string | null;
        depth: number;
        statusLabel: string;
        nameTrailingLabel?: ReactNode;
        entryKind?: "file" | "folder";
    }) {
        return (
            <div key={key} className="group flex h-10 min-w-max items-center pr-3">
                <div
                    className={`${DOC_TABLE_STICKY_CELL_CLASS} sticky left-0 z-[60] ${DOC_NAME_COL_W} py-2 pl-3 pr-2`}
                    style={treeNameCellStyle(depth)}
                >
                    <div className="flex min-w-0 items-center">
                        <Loader2 className="mr-3 h-2.5 w-2.5 animate-spin text-gray-400 shrink-0" />
                        {entryKind === "folder" && (
                            <span className="mr-2 flex h-4 w-4 shrink-0 items-center justify-center">
                                <ChevronRight className="h-4 w-4 text-gray-400" />
                            </span>
                        )}
                        <span className="mr-2 shrink-0">
                            {entryKind === "folder" ? (
                                <SubfolderSvgIcon className="h-4 w-4 opacity-50" />
                            ) : (
                                <DocIcon fileType={fileType ?? filename} muted />
                            )}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-xs text-gray-400">
                            {filename}
                        </span>
                        {nameTrailingLabel && (
                            <span className="ml-2 shrink-0 text-xs tabular-nums text-gray-400">
                                {nameTrailingLabel}
                            </span>
                        )}
                    </div>
                </div>
                <div className="ml-auto w-20 shrink-0 text-xs text-gray-300 lowercase truncate">
                    {entryKind === "folder"
                        ? "folder"
                        : fileType ??
                          (filename.includes(".")
                              ? filename.split(".").pop()
                              : "file")}
                </div>
                <div className="w-24 shrink-0 text-xs text-gray-300">{statusLabel}</div>
                <div className="w-20 shrink-0 text-xs text-gray-300">—</div>
                <div className="w-32 shrink-0 text-xs text-gray-300">—</div>
                <div className="w-32 shrink-0 text-xs text-gray-300">—</div>
                <div className="w-8 shrink-0" />
            </div>
        );
    }

    function renderUploadingDocumentRows(
        depth: number,
        parentFolderId: string | null,
    ) {
        const visibleUploads = collectionUploadProgress.filter(
            (upload) => upload.parentFolderId === parentFolderId,
        );
        const directRows = visibleUploads.flatMap((upload) =>
            upload.files
                .filter(
                    (file) =>
                        documentUploadFolderSegments(file.entry).length === 0 &&
                        file.status !== "completed" &&
                        file.status !== "error",
                )
                .map((file) =>
                    renderDocumentActivityRow({
                        key: `uploading-file-${upload.uploadId}-${file.clientId}`,
                        filename: file.entry.file.name,
                        fileType: null,
                        depth,
                        statusLabel: "",
                        nameTrailingLabel: <UploadingTrailingLabel />,
                    }),
                ),
        );
        const folderRows = visibleUploads.flatMap((upload) =>
            upload.entries
                .filter((entry) => entry.kind === "folder")
                .map((entry, index) => {
                    const folderFiles = upload.files.filter(
                        (file) =>
                            documentUploadFolderSegments(file.entry)[0] ===
                            entry.sourceName,
                    );
                    return renderDocumentActivityRow({
                        key: `uploading-folder-${upload.uploadId}-${entry.name}-${index}`,
                        filename: entry.name,
                        fileType: null,
                        depth,
                        statusLabel: "",
                        nameTrailingLabel: folderUploadProgressLabel(
                            folderFiles.map((file) => file.status),
                        ),
                        entryKind: "folder",
                    });
                }),
        );
        return [...directRows, ...folderRows];
    }

    const effectiveSort = sort ?? defaultSort;

    const foldersByParentId = useMemo(() => {
        const byParentId = new Map<string | null, DocTableFolder[]>();
        for (const folder of folders) {
            const parentId = folder.parent_folder_id ?? null;
            byParentId.set(parentId, [
                ...(byParentId.get(parentId) ?? []),
                folder,
            ]);
        }
        return byParentId;
    }, [folders]);
    const uploadingFolderNamesByParentId = useMemo(() => {
        const byParentId = new Map<string | null, Set<string>>();
        for (const upload of collectionUploadProgress) {
            const names = byParentId.get(upload.parentFolderId) ?? new Set();
            for (const entry of upload.entries) {
                if (entry.kind === "folder") names.add(entry.name);
            }
            byParentId.set(upload.parentFolderId, names);
        }
        return byParentId;
    }, [collectionUploadProgress]);
    const childFoldersForLevel = useCallback(
        (parentId: string | null) => {
            const nameMultiplier =
                enableHeaderFilters &&
                effectiveSort?.key === "name" &&
                effectiveSort.direction === "desc"
                    ? -1
                    : 1;
            const uploadingFolderNames =
                uploadingFolderNamesByParentId.get(parentId);
            return (foldersByParentId.get(parentId) ?? [])
                .filter(
                    (folder) => !uploadingFolderNames?.has(folder.name),
                )
                .sort(
                    (left, right) =>
                        left.name.localeCompare(right.name) * nameMultiplier,
                );
        },
        [
            effectiveSort,
            enableHeaderFilters,
            foldersByParentId,
            uploadingFolderNamesByParentId,
        ],
    );

    const folderTreeIds = useCallback(
        (folderId: string) => collectFolderTreeIds(folders, [folderId]),
        [folders],
    );

    /**
     * Document ids implied by a set of selected folders — the same derivation
     * `selectedFolderDocumentIds` uses for the rendered checkmarks.
     */
    function documentIdsImpliedByFolders(
        folderIds: ReadonlySet<string>,
    ): Set<string> {
        if (folderIds.size === 0) return new Set();
        const treeIds = collectFolderTreeIds(
            folders,
            folderSelectionRootIds(folders, folderIds),
        );
        return new Set(
            docs
                .filter(
                    (candidate) =>
                        candidate.folder_id != null &&
                        treeIds.has(candidate.folder_id),
                )
                .map((candidate) => candidate.id),
        );
    }

    /**
     * Drop the folder selection that made `documentIds` look selected.
     *
     * A checked folder selects its documents by derivation, so those documents
     * are not in `selectedDocIds`. Clearing the folder alone would therefore
     * uncheck every sibling as well. Materialize the documents the cleared
     * folders implied into `selectedDocIds` first, so only the documents the
     * user actually deselected lose their checkmark.
     */
    function clearSelectedFolderAncestors(documentIds: readonly string[]) {
        const ancestorIds = new Set<string>();
        for (const documentId of documentIds) {
            let currentId: string | null =
                docs.find((candidate) => candidate.id === documentId)
                    ?.folder_id ?? null;
            while (currentId && !ancestorIds.has(currentId)) {
                ancestorIds.add(currentId);
                currentId =
                    folders.find((folder) => folder.id === currentId)
                        ?.parent_folder_id ?? null;
            }
        }
        if (ancestorIds.size === 0) return;

        const nextFolderIds = new Set(selectedFolderIds);
        let cleared = false;
        for (const id of ancestorIds) {
            if (nextFolderIds.delete(id)) cleared = true;
        }
        if (!cleared) return;

        const stillImplied = documentIdsImpliedByFolders(nextFolderIds);
        const materialized = [
            ...documentIdsImpliedByFolders(selectedFolderIds),
        ].filter((id) => !stillImplied.has(id));

        setSelectedFolderIds(nextFolderIds);
        if (materialized.length > 0) {
            setSelectedDocIds((current) => [
                ...new Set([...current, ...materialized]),
            ]);
        }
    }

    function visibleDocumentIds(): string[] {
        return Array.from(
            tableRootRef.current?.querySelectorAll<HTMLElement>(
                "[data-document-row][data-document-id]",
            ) ?? [],
            (row) => row.dataset.documentId,
        ).filter((id): id is string => !!id);
    }

    function visibleCollectionRowKeys(): string[] {
        const rows = Array.from(
            tableRootRef.current?.querySelectorAll<HTMLElement>(
                "[data-collection-row-key]",
            ) ?? [],
        );
        rows.sort((left, right) => {
            const topDifference =
                left.getBoundingClientRect().top -
                right.getBoundingClientRect().top;
            if (topDifference !== 0) return topDifference;
            return left.compareDocumentPosition(right) &
                Node.DOCUMENT_POSITION_PRECEDING
                ? 1
                : -1;
        });
        return rows
            .map((row) => row.dataset.collectionRowKey)
            .filter((key): key is string => !!key);
    }

    function updateCollectionRowSelection(
        rowKeys: readonly string[],
        selected: boolean,
    ) {
        const documentIds = rowKeys
            .filter((key) => key.startsWith("document:"))
            .map((key) => key.slice("document:".length));
        const folderIds = rowKeys
            .filter((key) => key.startsWith("folder:"))
            .map((key) => key.slice("folder:".length));
        setSelectionCameFromSelectAll(false);
        setSelectedFolderIds((current) => {
            const next = new Set(current);
            for (const id of folderIds) {
                if (selected) next.add(id);
                else next.delete(id);
            }
            return next;
        });
        setSelectedDocIds((current) => {
            const next = new Set(current);
            for (const id of documentIds) {
                if (selected) next.add(id);
                else next.delete(id);
            }
            return [...next];
        });
    }

    function updateDocumentSelection(
        doc: Document,
        selected: boolean,
        shiftKey: boolean,
    ) {
        const targetKey = `document:${doc.id}`;
        const rowKeys = shiftKey
            ? selectionRangeIds(
                  visibleCollectionRowKeys(),
                  selectionAnchorKeyRef.current,
                  targetKey,
              )
            : [targetKey];
        if (!selected) {
            clearSelectedFolderAncestors(
                rowKeys
                    .filter((key) => key.startsWith("document:"))
                    .map((key) => key.slice("document:".length)),
            );
        }
        updateCollectionRowSelection(rowKeys, selected);
        selectionAnchorKeyRef.current = selectionAnchorAfterRowSelection(
            selectionAnchorKeyRef.current,
            targetKey,
            rowKeys,
            selected,
        );
    }

    function handleDocumentRowClick(
        event: React.MouseEvent<HTMLDivElement>,
        doc: Document,
    ) {
        if (event.shiftKey) {
            event.preventDefault();
            updateDocumentSelection(doc, true, true);
            return;
        }
        if (event.ctrlKey || event.metaKey) {
            event.preventDefault();
            updateDocumentSelection(doc, true, false);
            return;
        }
        setViewingDocVersion(null);
        setViewingDoc(doc);
    }

    function handleDocumentDragStart(
        event: DragEvent<HTMLDivElement>,
        doc: Document,
    ) {
        if (renamingDocumentId === doc.id) {
            event.preventDefault();
            return;
        }
        const visibleIds = new Set(visibleDocumentIds());
        const selectedVisibleIds = [...effectiveSelectedDocIdSet].filter((id) =>
            visibleIds.has(id),
        );
        const draggedIds = writeDocumentDragPayload(
            event.dataTransfer,
            doc.id,
            selectedVisibleIds,
        );
        setDocumentRowsDragPreview({
            dataTransfer: event.dataTransfer,
            tableRoot: tableRootRef.current,
            draggedDocumentIds: draggedIds,
            draggedDocumentId: doc.id,
            clientX: event.clientX,
            clientY: event.clientY,
        });
        if (!effectiveSelectedDocIdSet.has(doc.id)) {
            setSelectedFolderIds(new Set());
            setSelectionCameFromSelectAll(false);
            setSelectedDocIds(draggedIds);
        }
        selectionAnchorKeyRef.current = `document:${doc.id}`;
    }

    function renderLevel(parentId: string | null, depth: number) {
        const childFolders = childFoldersForLevel(parentId);
        const allChildDocs = filteredDocs.filter(
            (d) => (d.folder_id ?? null) === parentId,
        );
        const levelKey = parentId ?? "root";
        const levelLimit = documentLimitByLevel?.[levelKey];
        const childDocs =
            !q && levelLimit != null
                ? allChildDocs.slice(0, levelLimit)
                : allChildDocs;
        const combinedSortKey =
            effectiveSort?.key === "name" ||
            effectiveSort?.key === "created" ||
            effectiveSort?.key === "updated"
                ? effectiveSort.key
                : null;
        const combinedDirection = effectiveSort?.direction === "desc" ? -1 : 1;
        const rowOrder = new Map(
            [
                ...childDocs.map((document) => ({
                    key: `document:${document.id}`,
                    name: document.filename,
                    createdAt: document.created_at,
                    updatedAt: document.updated_at ?? document.created_at,
                    fallbackGroup: 0,
                })),
                ...childFolders.map((folder) => ({
                    key: `folder:${folder.id}`,
                    name: folder.name,
                    createdAt: folder.created_at,
                    updatedAt: folder.updated_at ?? folder.created_at,
                    fallbackGroup: 1,
                })),
            ]
                .sort((a, b) => {
                    if (combinedSortKey === "name") {
                        return (
                            a.name.localeCompare(b.name) * combinedDirection
                        );
                    }
                    if (combinedSortKey === "created") {
                        const difference =
                            dateTimeValue(a.createdAt) -
                            dateTimeValue(b.createdAt);
                        return difference === 0
                            ? a.name.localeCompare(b.name)
                            : difference * combinedDirection;
                    }
                    if (combinedSortKey === "updated") {
                        const difference =
                            dateTimeValue(a.updatedAt) -
                            dateTimeValue(b.updatedAt);
                        return difference === 0
                            ? a.name.localeCompare(b.name)
                            : difference * combinedDirection;
                    }
                    return (
                        a.fallbackGroup - b.fallbackGroup ||
                        a.name.localeCompare(b.name)
                    );
                })
                .map((row, index) => [row.key, index + 1]),
        );
        const trailingRowOrder = rowOrder.size + 2;

        return (
            <div className="flex flex-col">
                {renderUploadingDocumentRows(depth, parentId)}
                {childDocs.map((doc) => {
                    const docName = doc.filename;
                    const isProcessing = doc.status === "pending" || doc.status === "processing";
                    const isError = doc.status === "error";
                    const isVersionsOpen = expandedVersionDocIds.has(doc.id);
                    const versionNumber = currentVersionNumber(doc);
                    const hasVersions = typeof versionNumber === "number" && versionNumber > 1;
                    const isVersionDragOver = dragOverVersionDocId === doc.id;
                    const isUploadingVersion = uploadingVersionDocIds.has(doc.id);
                    const isSelected = effectiveSelectedDocIdSet.has(doc.id);
                    const isDeletingDoc = deletingDocIds.has(doc.id);
                    if (isDeletingDoc) {
                        return renderDocumentActivityRow({
                            key: `deleting-doc-${doc.id}`,
                            filename: doc.filename,
                            fileType: doc.file_type,
                            depth,
                            statusLabel: "Deleting...",
                        });
                    }
                    return (
                        <div
                            key={`doc-${doc.id}`}
                            style={{
                                order:
                                    rowOrder.get(`document:${doc.id}`) ?? 1,
                            }}
                        >
                            <div
                                data-document-row
                                data-document-id={doc.id}
                                data-collection-row-key={`document:${doc.id}`}
                                draggable={renamingDocumentId !== doc.id}
                                onDragStart={(event) =>
                                    handleDocumentDragStart(event, doc)
                                }
                                onDragEnd={() => {
                                    setDragOverRoot(false);
                                    setDragOverFolderId(null);
                                    setDragOverVersionDocId(null);
                                }}
                                onDragOver={(e) => handleDocumentVersionDragOver(e, doc.id)}
                                onDragLeave={handleDocumentVersionDragLeave}
                                onDrop={(e) => handleDocumentVersionDrop(e, doc)}
                                onClick={(event) =>
                                    handleDocumentRowClick(event, doc)
                                }
                                onContextMenu={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    closeRowActionMenus();
                                    setContextMenu({
                                        x: e.clientX,
                                        y: e.clientY,
                                        docId: doc.id,
                                        folderId: null,
                                        showFolderActions: false,
                                    });
                                }}
                                className={`group flex h-10 min-w-max items-center pr-3 cursor-pointer transition-colors ${isVersionDragOver ? "bg-blue-50 ring-1 ring-inset ring-blue-200" : isSelected ? LIQUID_GLASS_SELECTED_CLASS : LIQUID_GLASS_HOVER_CLASS}`}
                            >
                                {(() => {
                                    const rowBg = isVersionDragOver
                                        ? "bg-blue-50"
                                        : isSelected
                                          ? LIQUID_GLASS_SELECTED_CLASS
                                          : "";
                                    return (
                                        <>
                                            <div
                                                className={`${DOC_TABLE_STICKY_CELL_CLASS} sticky left-0 z-[60] ${DOC_NAME_COL_W} ${rowBg} py-2 pl-3 pr-2 transition-colors ${isVersionDragOver || isSelected ? "" : LIQUID_GLASS_GROUP_HOVER_CLASS}`}
                                                style={treeNameCellStyle(depth)}
                                            >
                                                <div className="flex items-center">
                                                    {isProcessing || isUploadingVersion ? (
                                                        <Loader2 className="mr-3 h-2.5 w-2.5 animate-spin text-gray-400 shrink-0" />
                                                    ) : (
                                                        <input
                                                            type="checkbox"
                                                            checked={effectiveSelectedDocIdSet.has(doc.id)}
                                                            onChange={(event) =>
                                                                updateDocumentSelection(
                                                                    doc,
                                                                    event.target.checked,
                                                                    (
                                                                        event.nativeEvent as MouseEvent
                                                                    ).shiftKey,
                                                                )
                                                            }
                                                            onClick={(e) => e.stopPropagation()}
                                                            aria-label={`Select ${doc.filename}`}
                                                            className={TABLE_CHECKBOX_CLASS}
                                                        />
                                                    )}
                                                    <span className="mr-2 shrink-0">
                                                        {isError ? (
                                                            <AlertCircle className="h-4 w-4 text-red-500" />
                                                        ) : (
                                                            <DocIcon fileType={doc.file_type} />
                                                        )}
                                                    </span>
                                                    {renamingDocumentId === doc.id ? (
                                                        <input
                                                            autoFocus
                                                            className="min-w-0 flex-1 text-xs text-gray-800 bg-transparent outline-none border-b border-gray-300"
                                                            value={renameDocumentValue}
                                                            onClick={(e) => e.stopPropagation()}
                                                            onDragStart={(e) => {
                                                                e.preventDefault();
                                                                e.stopPropagation();
                                                            }}
                                                            onChange={(e) => setRenameDocumentValue(e.target.value)}
                                                            onKeyDown={(e) => {
                                                                if (e.key === "Enter")
                                                                    void submitDocumentRename(doc.id);
                                                                if (e.key === "Escape") {
                                                                    setRenamingDocumentId(null);
                                                                    setRenameDocumentValue("");
                                                                }
                                                            }}
                                                            onBlur={() => void submitDocumentRename(doc.id)}
                                                        />
                                                    ) : (
                                                        <span className="text-xs text-gray-800 truncate">
                                                            {docName}
                                                        </span>
                                                    )}
                                                </div>
                                            </div>
                                            <div className="ml-auto w-20 shrink-0 text-xs text-gray-500 lowercase truncate">
                                                {doc.file_type ?? <span className="text-gray-300">—</span>}
                                            </div>
                                            <div className="w-24 shrink-0 text-xs text-gray-500 truncate">
                                                {doc.size_bytes != null ? (
                                                    formatBytes(doc.size_bytes)
                                                ) : (
                                                    <span className="text-gray-300">—</span>
                                                )}
                                            </div>
                                            <div
                                                className="w-20 shrink-0 text-xs text-gray-500 flex items-center gap-1"
                                                onClick={(e) => e.stopPropagation()}
                                            >
                                                {hasVersions ? (
                                                    <button
                                                        onClick={() => void toggleVersions(doc.id)}
                                                        className={`flex items-center gap-1 rounded px-1 py-0.5 transition-colors ${LIQUID_GLASS_HOVER_CLASS}`}
                                                    >
                                                        <span>{versionNumber}</span>
                                                        {isVersionsOpen ? (
                                                            <ChevronDown className="h-3 w-3 text-gray-400" />
                                                        ) : (
                                                            <ChevronRight className="h-3 w-3 text-gray-400" />
                                                        )}
                                                    </button>
                                                ) : (
                                                    <span className="text-gray-300 pl-1">—</span>
                                                )}
                                            </div>
                                            <div className="w-32 shrink-0 text-xs text-gray-500 truncate">
                                                {doc.created_at ? (
                                                    formatDate(doc.created_at)
                                                ) : (
                                                    <span className="text-gray-300">—</span>
                                                )}
                                            </div>
                                            <div className="w-32 shrink-0 text-xs text-gray-500 truncate">
                                                {doc.updated_at ? (
                                                    formatDate(doc.updated_at)
                                                ) : (
                                                    <span className="text-gray-300">—</span>
                                                )}
                                            </div>
                                            <div className="w-8 shrink-0 flex justify-end">
                                                {!isProcessing && (
                                                    <RowActions
                                                        onView={() => {
                                                            setViewingDocVersion(null);
                                                            setViewingDoc(doc);
                                                        }}
                                                        onRename={() => {
                                                            setRenameDocumentValue(docName);
                                                            setRenamingDocumentId(doc.id);
                                                        }}
                                                        renameLabel="Rename document"
                                                        onDownload={() => downloadDoc(doc.id)}
                                                        onShowAllVersions={
                                                            hasVersions && !isVersionsOpen
                                                                ? () => void toggleVersions(doc.id)
                                                                : undefined
                                                        }
                                                        onUploadNewVersion={() => void handleUploadNewVersion(doc)}
                                                        onRemoveFromFolder={
                                                            doc.folder_id
                                                                ? () => handleRemoveDocFromFolder(doc.id)
                                                                : undefined
                                                        }
                                                        onDelete={() => requestRemoveDoc(doc)}
                                                        deleteDisabled={!canDeleteDocument(doc)}
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
                                    filename={docName}
                                    activeVersionNumber={versionNumber}
                                    loading={loadingVersionDocIds.has(doc.id)}
                                    versions={versionsByDocId.get(doc.id)?.versions ?? []}
                                    currentVersionId={versionsByDocId.get(doc.id)?.currentVersionId ?? null}
                                    depth={depth}
                                    onDownloadVersion={downloadDocVersion}
                                    onOpenVersion={(versionId, label) => {
                                        setViewingDocVersion({
                                            id: versionId,
                                            label,
                                        });
                                        setViewingDoc(doc);
                                    }}
                                    onRenameVersion={(versionId, filename) =>
                                        handleRenameVersion(doc.id, versionId, filename)
                                    }
                                    onExtensionChangeBlocked={(filename) =>
                                        setDocumentRenameWarning(extensionChangeWarning(filename))
                                    }
                                />
                            )}
                        </div>
                    );
                })}

                {onLoadMoreDocuments && !q && (
                    <div
                        style={{
                            ...treeNameCellStyle(depth),
                            order: trailingRowOrder,
                        }}
                    >
                        <TableLoadMoreRow
                            autoLoadOnVisible={autoLoadOnScroll}
                            loading={false}
                            hasMore={!!documentsHasMoreByLevel?.[levelKey]}
                            itemCount={childDocs.length}
                            loadingMore={!!loadingMoreDocumentsByLevel?.[levelKey]}
                            hasError={false}
                            onLoadMore={() => onLoadMoreDocuments(parentId)}
                        />
                    </div>
                )}

                {childFolders.map((folder) => {
                    const isExpanded = expandedFolderIds.has(folder.id);
                    const isRenaming = renamingFolderId === folder.id;
                    const isLoadingChildren = loadingChildFolderIds.has(folder.id);
                    const folderIds = folderTreeIds(folder.id);
                    const folderDocumentIds = docs
                        .filter(
                            (document) =>
                                document.folder_id != null &&
                                folderIds.has(document.folder_id),
                        )
                        .map((document) => document.id);
                    const folderExplicitlySelected = selectedFolderIds.has(
                        folder.id,
                    );
                    const allFolderDocumentsSelected =
                        folderExplicitlySelected ||
                        (folderDocumentIds.length > 0 &&
                            folderDocumentIds.every((id) =>
                                effectiveSelectedDocIdSet.has(id),
                            ));
                    const someFolderDocumentsSelected =
                        !allFolderDocumentsSelected &&
                        folderDocumentIds.some((id) =>
                            effectiveSelectedDocIdSet.has(id),
                        );
                    return (
                        <div
                            key={`folder-${folder.id}`}
                            style={{
                                order:
                                    rowOrder.get(`folder:${folder.id}`) ?? 1,
                            }}
                        >
                            <div
                                data-folder-row
                                data-folder-id={folder.id}
                                data-collection-row-key={`folder:${folder.id}`}
                                draggable={!isRenaming}
                                onDragStart={(e) => {
                                    if (isRenaming) {
                                        e.preventDefault();
                                        return;
                                    }
                                    e.dataTransfer.setData("application/mike-folder", folder.id);
                                    e.dataTransfer.effectAllowed = "move";
                                    e.stopPropagation();
                                }}
                                onDragOver={(e) => {
                                    if (
                                        !hasMovePayload(e.dataTransfer) &&
                                        !hasFilePayload(e.dataTransfer)
                                    ) {
                                        return;
                                    }
                                    e.preventDefault();
                                    e.stopPropagation();
                                    e.dataTransfer.dropEffect = hasFilePayload(
                                        e.dataTransfer,
                                    )
                                        ? "copy"
                                        : "move";
                                    setDragOverFolderId(folder.id);
                                    setDragOverVersionDocId(null);
                                }}
                                onDragLeave={(e) => {
                                    e.stopPropagation();
                                    setDragOverFolderId(null);
                                }}
                                onDrop={async (e) => {
                                    if (
                                        !hasMovePayload(e.dataTransfer) &&
                                        !hasFilePayload(e.dataTransfer)
                                    ) {
                                        return;
                                    }
                                    e.preventDefault();
                                    e.stopPropagation();
                                    setDragOverFolderId(null);
                                    setDragOverRoot(false);
                                    setDragOverVersionDocId(null);
                                    if (hasFilePayload(e.dataTransfer)) {
                                        await handleDroppedCollectionDataTransfer(
                                            e.dataTransfer,
                                            folder.id,
                                        );
                                        return;
                                    }
                                    await handleDropOnFolder(folder.id, e.dataTransfer);
                                }}
                                onClick={(event) => {
                                    if (
                                        !event.shiftKey &&
                                        !event.ctrlKey &&
                                        !event.metaKey
                                    ) {
                                        openFolderView(folder.id);
                                        return;
                                    }
                                    event.preventDefault();
                                    const targetKey = `folder:${folder.id}`;
                                    const selectedRowKeys = event.shiftKey
                                        ? selectionRangeIds(
                                              visibleCollectionRowKeys(),
                                              selectionAnchorKeyRef.current,
                                              targetKey,
                                          )
                                        : [targetKey];
                                    updateCollectionRowSelection(
                                        selectedRowKeys,
                                        true,
                                    );
                                    selectionAnchorKeyRef.current = targetKey;
                                }}
                                onContextMenu={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    closeRowActionMenus();
                                    setContextMenu({
                                        x: e.clientX,
                                        y: e.clientY,
                                        folderId: folder.id,
                                        showFolderActions: true,
                                    });
                                }}
                                className={`group flex h-10 min-w-max items-center pr-3 ${folderExplicitlySelected ? LIQUID_GLASS_SELECTED_CLASS : LIQUID_GLASS_HOVER_CLASS} cursor-pointer transition-colors ${isRenaming ? "" : "select-none"} ${dragOverFolderId === folder.id ? "bg-blue-50 ring-1 ring-inset ring-blue-200" : ""}`}
                            >
                                <div
                                    className={`${DOC_TABLE_STICKY_CELL_CLASS} sticky left-0 z-[60] ${DOC_NAME_COL_W} py-2 pl-3 pr-2 ${dragOverFolderId === folder.id ? "bg-blue-50" : folderExplicitlySelected ? LIQUID_GLASS_SELECTED_CLASS : ""} transition-colors ${dragOverFolderId === folder.id || folderExplicitlySelected ? "" : LIQUID_GLASS_GROUP_HOVER_CLASS}`}
                                    style={treeNameCellStyle(depth)}
                                >
                                    <div className="flex items-center">
                                        <input
                                            type="checkbox"
                                            checked={allFolderDocumentsSelected}
                                            ref={(element) => {
                                                if (element) {
                                                    element.indeterminate =
                                                        someFolderDocumentsSelected;
                                                }
                                            }}
                                            onChange={() => {
                                                selectionAnchorKeyRef.current =
                                                    `folder:${folder.id}`;
                                                setSelectionCameFromSelectAll(false);
                                                setSelectedFolderIds((current) => {
                                                    const next = new Set(current);
                                                    if (allFolderDocumentsSelected) {
                                                        next.delete(folder.id);
                                                    } else {
                                                        next.add(folder.id);
                                                    }
                                                    return next;
                                                });
                                                if (allFolderDocumentsSelected) {
                                                    setSelectedDocIds((current) => {
                                                        const next = new Set(current);
                                                        folderDocumentIds.forEach((id) =>
                                                            next.delete(id),
                                                        );
                                                        return [...next];
                                                    });
                                                }
                                            }}
                                            onClick={(event) =>
                                                event.stopPropagation()
                                            }
                                            className={TABLE_CHECKBOX_CLASS}
                                            aria-label={`Select files in ${folder.name}`}
                                            title={`Select files in ${folder.name}`}
                                        />
                                        <button
                                            type="button"
                                            aria-label={
                                                isExpanded
                                                    ? `Collapse ${folder.name}`
                                                    : `Expand ${folder.name}`
                                            }
                                            onClick={(event) => {
                                                event.stopPropagation();
                                                toggleFolder(folder.id);
                                            }}
                                            className="mr-2 flex h-4 w-4 shrink-0 items-center justify-center"
                                        >
                                            {isLoadingChildren ? (
                                                <Loader2 className="h-4 w-4 animate-spin text-gray-400" />
                                            ) : isExpanded ? (
                                                <ChevronDown className="h-4 w-4 text-gray-400" />
                                            ) : (
                                                <ChevronRight className="h-4 w-4 text-gray-400" />
                                            )}
                                        </button>
                                        <SubfolderSvgIcon open={isExpanded} className="mr-2 h-4 w-4 shrink-0" />
                                        {isRenaming ? (
                                            <input
                                                autoFocus
                                                className="flex-1 min-w-0 text-xs text-gray-800 bg-transparent outline-none"
                                                value={renameFolderValue}
                                                onDragStart={(e) => {
                                                    e.preventDefault();
                                                    e.stopPropagation();
                                                }}
                                                onChange={(e) => setRenameFolderValue(e.target.value)}
                                                onKeyDown={(e) => {
                                                    if (e.key === "Enter") void handleRenameFolder(folder.id);
                                                    if (e.key === "Escape") setRenamingFolderId(null);
                                                }}
                                                onBlur={() => void handleRenameFolder(folder.id)}
                                                onClick={(e) => e.stopPropagation()}
                                            />
                                        ) : (
                                            <span className="text-xs text-gray-800 truncate">{folder.name}</span>
                                        )}
                                    </div>
                                </div>
                                <div className="ml-auto w-20 shrink-0 text-xs text-gray-300">—</div>
                                <div className="w-24 shrink-0 text-xs text-gray-300">—</div>
                                <div className="w-20 shrink-0 text-xs text-gray-300">—</div>
                                <div className="w-32 shrink-0 truncate text-xs text-gray-500">
                                    {formatDate(folder.created_at)}
                                </div>
                                <div className="w-32 shrink-0 truncate text-xs text-gray-500">
                                    {formatDate(
                                        folder.updated_at ?? folder.created_at,
                                    )}
                                </div>
                                <div className="w-8 shrink-0 flex justify-end" onClick={(e) => e.stopPropagation()}>
                                    <RowActions
                                        onView={() => openFolderView(folder.id)}
                                        viewLabel="Open"
                                        onRename={() => {
                                            setRenameFolderValue(folder.name);
                                            setRenamingFolderId(folder.id);
                                        }}
                                        onDelete={() => requestDeleteFolder(folder.id)}
                                    />
                                </div>
                            </div>
                            {isExpanded && renderLevel(folder.id, depth + 1)}
                        </div>
                    );
                })}

                <div style={{ order: trailingRowOrder + 1 }}>
                    {renderFolderInput(parentId, depth)}
                </div>
            </div>
        );
    }

    // ── Loading skeleton ──────────────────────────────────────────────────────

    const docs = serverDocuments ?? documents;
    const downloadDoc = useCallback(async (docId: string) => {
        const { url, filename } = await getDocumentUrl(docId);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.click();
    }, []);

    const selectedFolderRootIds = useMemo(
        () => folderSelectionRootIds(folders, selectedFolderIds),
        [folders, selectedFolderIds],
    );

    const selectedFolderTreeIds = useMemo(
        () => collectFolderTreeIds(folders, selectedFolderRootIds),
        [folders, selectedFolderRootIds],
    );

    const selectedFolderDocumentIds = useMemo(
        () =>
            docs
                .filter(
                    (document) =>
                        document.folder_id != null &&
                        selectedFolderTreeIds.has(document.folder_id),
                )
                .map((document) => document.id),
        [docs, selectedFolderTreeIds],
    );
    const selectedFolderDocumentIdSet = useMemo(
        () => new Set(selectedFolderDocumentIds),
        [selectedFolderDocumentIds],
    );
    const effectiveSelectedDocIdSet = useMemo(
        () => new Set([...selectedDocIds, ...selectedFolderDocumentIdSet]),
        [selectedDocIds, selectedFolderDocumentIdSet],
    );

    const selectedStandaloneDocIds = useMemo(
        () =>
            selectedDocIds.filter(
                (id) => !selectedFolderDocumentIdSet.has(id),
            ),
        [selectedDocIds, selectedFolderDocumentIdSet],
    );

    const handleDownloadSelectedDocs = useCallback(async () => {
        try {
            if (
                selectedStandaloneDocIds.length === 1 &&
                selectedFolderRootIds.length === 0
            ) {
                await downloadDoc(selectedStandaloneDocIds[0]);
                return;
            }
            // Doc-only selections above the threshold go through the async
            // export job instead of a synchronous ZIP request. Folder
            // selections stay on the direct path so the archive keeps its
            // folder structure.
            const { blob, filename } =
                selectedFolderRootIds.length === 0 &&
                selectedStandaloneDocIds.length > ASYNC_ZIP_THRESHOLD
                    ? await runUserExport("documents-zip", {
                          document_ids: selectedStandaloneDocIds,
                      })
                    : {
                          blob: await downloadDocumentsZip(
                              selectedStandaloneDocIds,
                              selectedFolderRootIds,
                          ),
                          filename: null,
                      };
            const a = document.createElement("a");
            a.href = URL.createObjectURL(blob);
            a.download = filename ?? "documents.zip";
            a.click();
            URL.revokeObjectURL(a.href);
        } catch (error) {
            setCollectionActionWarning(
                userFacingApiError(
                    error,
                    "The selected files and folders could not be downloaded.",
                ),
            );
        }
    }, [downloadDoc, selectedFolderRootIds, selectedStandaloneDocIds]);

    const handleRemoveSelectedFromFolder = useCallback(async () => {
        if (
            !requireCapability("docs.organize", "move documents", "editor")
        )
            return;
        const ids = selectedStandaloneDocIds.filter(
            (id) => docs.find((d) => d.id === id)?.folder_id != null,
        );
        if (ids.length === 0) return;
        setSelectedFolderIds(new Set());
        setDocuments((prev) => prev.map((d) => (ids.includes(d.id) ? { ...d, folder_id: null } : d)));
        await Promise.all(ids.map((id) => operations.moveDocument(id, null).catch(() => {})));
    }, [docs, operations, requireCapability, selectedStandaloneDocIds, setDocuments]);

    const deleteDocumentIds = useCallback(async (ids: string[]) => {
        const owned = ids.filter((id) => {
            const doc = documents.find((candidate) => candidate.id === id);
            // A row we can see is judged on its uploader, both halves known.
            // A row we cannot see is left to the server, and deliberately so:
            // unlike project delete — where an admin's sweep really could
            // destroy rows they never looked at — this endpoint filters on
            // `user_id = me`, so an id we cannot resolve is at worst a 404
            // counted in the failure notice. Excluding those would break
            // select-all-matching in the library, where every row is the
            // caller's own but few are paged in.
            if (!doc) return true;
            return canDeleteDocument(doc);
        });
        const blocked = ids.length - owned.length;
        const snapshot = docs;
        setDocuments((current) =>
            current.filter((doc) => !owned.includes(doc.id)),
        );
        let deletedIds: string[] = [];
        if (operations.bulkDeleteDocuments) {
            try {
                const result = await operations.bulkDeleteDocuments(owned);
                deletedIds = result.deletedIds;
            } catch {
                deletedIds = [];
            }
        } else {
            // Keep destructive requests bounded for project tables, which do
            // not yet expose a collection-specific bulk endpoint.
            const pending = [...owned];
            const workers = Array.from({ length: Math.min(8, pending.length) }, async () => {
                const workerDeleted: string[] = [];
                while (pending.length > 0) {
                    const id = pending.shift();
                    if (!id) break;
                    try {
                        await deleteDocument(id);
                        workerDeleted.push(id);
                    } catch {
                        // Report the aggregate failure below.
                    }
                }
                return workerDeleted;
            });
            deletedIds = (await Promise.all(workers)).flat();
        }
        const failedIds = owned.filter((id) => !deletedIds.includes(id));
        const failedCount = failedIds.length;
        if (failedIds.length > 0) {
            setDocuments((current) =>
                restoreOptimisticallyDeletedRows(current, snapshot, failedIds),
            );
            setSelectedDocIds(failedIds);
        }
        if (deletedIds.length > 0) {
            setExpandedVersionDocIds((prev) => {
                const next = new Set(prev);
                for (const id of deletedIds) next.delete(id);
                return next;
            });
            setVersionsByDocId((prev) => {
                const next = new Map(prev);
                for (const id of deletedIds) next.delete(id);
                return next;
            });
        }
        if (failedCount > 0) {
            setCollectionActionWarning((current) =>
                [
                    current,
                    `${failedCount} ${failedCount === 1 ? "document" : "documents"} could not be deleted. Please try again.`,
                ]
                    .filter(Boolean)
                    .join(" "),
            );
        }
        if (blocked > 0) {
            setOwnerOnlyAction(
                `delete ${blocked} of the selected documents — only the document creator can delete a document`,
            );
        }
        if (deletedIds.length > 0 && operations.bulkDeleteDocuments) {
            await operations.refreshCollection();
        }
    }, [
        canDeleteDocument,
        docs,
        documents,
        operations,
        selectedDocIds,
        setDocuments,
        setOwnerOnlyAction,
    ]);

    const handleDeleteSelectedItems = useCallback(async () => {
        setConfirmDeleteAllOpen(false);
        setSelectionCameFromSelectAll(false);
        setSelectedDocIds([]);
        setSelectedFolderIds(new Set());

        const folderSnapshot = folders;
        const documentSnapshot = docs;
        const selectedTreeIds = selectedFolderTreeIds;

        if (selectedTreeIds.size > 0) {
            setFolders((current) =>
                current.filter((folder) => !selectedTreeIds.has(folder.id)),
            );
            setDocuments((current) =>
                current.filter(
                    (doc) => !selectedFolderDocumentIdSet.has(doc.id),
                ),
            );
        }

        const folderResults = await Promise.all(
            selectedFolderRootIds.map(async (folderId) => {
                try {
                    await operations.deleteFolder(folderId);
                    return { folderId, deleted: true };
                } catch (error) {
                    console.error("delete selected folder failed", error);
                    return { folderId, deleted: false };
                }
            }),
        );
        const failedFolderRootIds = folderResults
            .filter((result) => !result.deleted)
            .map((result) => result.folderId);
        const failedFolderTreeIds = new Set(
            failedFolderRootIds.flatMap((folderId) => [
                ...folderTreeIds(folderId),
            ]),
        );
        const failedFolderDocumentIds = documentSnapshot
            .filter(
                (document) =>
                    document.folder_id != null &&
                    failedFolderTreeIds.has(document.folder_id),
            )
            .map((document) => document.id);

        if (failedFolderTreeIds.size > 0) {
            setFolders((current) =>
                restoreOptimisticallyDeletedRows(
                    current,
                    folderSnapshot,
                    [...failedFolderTreeIds],
                ),
            );
            setDocuments((current) =>
                restoreOptimisticallyDeletedRows(
                    current,
                    documentSnapshot,
                    failedFolderDocumentIds,
                ),
            );
            setSelectedFolderIds(new Set(failedFolderRootIds));
            setCollectionActionWarning(
                `${failedFolderRootIds.length} ${failedFolderRootIds.length === 1 ? "folder" : "folders"} could not be deleted. Please try again.`,
            );
        }

        const deletedFolderTreeIds = new Set(
            [...selectedTreeIds].filter(
                (folderId) => !failedFolderTreeIds.has(folderId),
            ),
        );
        if (deletedFolderTreeIds.size > 0) {
            const deletedFolderDocumentIds = documentSnapshot
                .filter(
                    (document) =>
                        document.folder_id != null &&
                        deletedFolderTreeIds.has(document.folder_id),
                )
                .map((document) => document.id);
            const currentFolderId = viewedFolderIdRef.current;
            if (currentFolderId && deletedFolderTreeIds.has(currentFolderId)) {
                updateViewedFolder(null);
            }
            setExpandedFolderIds((current) => {
                const next = new Set(current);
                for (const id of deletedFolderTreeIds) next.delete(id);
                return next;
            });
            setExpandedVersionDocIds((current) => {
                const next = new Set(current);
                for (const id of deletedFolderDocumentIds) next.delete(id);
                return next;
            });
            setVersionsByDocId((current) => {
                const next = new Map(current);
                for (const id of deletedFolderDocumentIds) next.delete(id);
                return next;
            });
        }

        await deleteDocumentIds(selectedStandaloneDocIds);
        if (folderResults.some((result) => result.deleted)) {
            await operations.refreshCollection();
        }
    }, [
        deleteDocumentIds,
        docs,
        folderTreeIds,
        folders,
        operations,
        selectedFolderDocumentIdSet,
        selectedFolderRootIds,
        selectedFolderTreeIds,
        selectedStandaloneDocIds,
        setDocuments,
        setFolders,
        updateViewedFolder,
    ]);

    const requestDeleteSelectedItems = useCallback(() => {
        setConfirmDeleteAllOpen(true);
    }, []);

    const sidePanelDoc = viewingDoc ? (docs.find((doc) => doc.id === viewingDoc.id) ?? viewingDoc) : null;
    const versionUploadAccept = ".pdf,.docx,.doc,.xlsx,.xlsm,.xls,.pptx,.ppt";
    const q = serverQueryActive ? "__server_results__" : search.toLowerCase();
    const viewedFolder = viewedFolderId
        ? folders.find((folder) => folder.id === viewedFolderId) ?? null
        : null;
    const derivedTypeOptions = useMemo(
        () =>
            Array.from(new Set(docs.map(documentTypeValue)))
                .sort((a, b) => a.localeCompare(b))
                .map((type) => ({
                    value: type,
                    label: type.toUpperCase(),
                })),
        [docs],
    );
    const typeOptions = documentTypeOptions ?? derivedTypeOptions;

    useEffect(() => {
        onServerQueryChange?.({ search, fileType: typeFilter, sort });
    }, [onServerQueryChange, search, sort, typeFilter]);

    const activeDirectoryLevelKey = viewedFolderId ?? "root";
    const activePageLoadingMore = serverQueryActive
        ? serverQueryLoadingMore
        : !!loadingMoreDocumentsByLevel?.[activeDirectoryLevelKey];

    useEffect(() => {
        if (!activePageLoadingMore) autoLoadTriggeredRef.current = false;
    }, [activePageLoadingMore]);

    function handleTableScroll(event: UIEvent<HTMLDivElement>) {
        if (!autoLoadOnScroll || autoLoadTriggeredRef.current) return;
        const viewport = event.currentTarget;
        const distanceFromBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
        if (distanceFromBottom > 80) return;

        if (
            serverQueryActive &&
            serverQueryHasMore &&
            !serverQueryLoading &&
            !serverQueryLoadingMore &&
            onLoadMoreServerDocuments
        ) {
            autoLoadTriggeredRef.current = true;
            onLoadMoreServerDocuments();
            return;
        }

        if (
            !serverQueryActive &&
            documentsHasMoreByLevel?.[activeDirectoryLevelKey] &&
            !loadingMoreDocumentsByLevel?.[activeDirectoryLevelKey] &&
            onLoadMoreDocuments
        ) {
            autoLoadTriggeredRef.current = true;
            onLoadMoreDocuments(viewedFolderId ?? null);
        }
    }

    function clearCollectionSelection() {
        setSelectedDocIds([]);
        setSelectedFolderIds(new Set());
        selectionAnchorKeyRef.current = null;
        setSelectionCameFromSelectAll(false);
        setConfirmDeleteAllOpen(false);
    }

    function handleTypeFilterChange(value: string | null) {
        setTypeFilter(value);
        clearCollectionSelection();
    }

    function handleSortChange(key: DocumentSortKey, direction: TableSortDirection | null) {
        setSort(direction ? { key, direction } : null);
        clearCollectionSelection();
    }

    const filteredDocs = useMemo(() => {
        if (serverQueryActive) return docs;

        const rows = docs
            .filter((doc) => !q || doc.filename.toLowerCase().includes(q))
            .filter((doc) => !enableHeaderFilters || !typeFilter || documentTypeValue(doc) === typeFilter);

        if (!enableHeaderFilters || !effectiveSort) return rows;

        return [...rows].sort((a, b) => {
            const multiplier = effectiveSort.direction === "asc" ? 1 : -1;

            if (effectiveSort.key === "size") {
                return ((a.size_bytes ?? 0) - (b.size_bytes ?? 0)) * multiplier;
            }

            if (effectiveSort.key === "version") {
                return ((documentVersionNumber(a) ?? 0) - (documentVersionNumber(b) ?? 0)) * multiplier;
            }

            if (effectiveSort.key === "created") {
                return (dateTimeValue(a.created_at) - dateTimeValue(b.created_at)) * multiplier;
            }

            if (effectiveSort.key === "updated") {
                return (dateTimeValue(a.updated_at) - dateTimeValue(b.updated_at)) * multiplier;
            }

            return a.filename.localeCompare(b.filename) * multiplier;
        });
    }, [docs, effectiveSort, enableHeaderFilters, q, serverQueryActive, typeFilter]);
    const hasVisibleCollectionUpload =
        collectionUploadProgress.some(
            (upload) =>
                upload.parentFolderId === viewedFolderId &&
                upload.entries.length > 0,
        );
    const viewedFolderIsEmpty =
        !!viewedFolder &&
        !loadingChildFolderIds.has(viewedFolder.id) &&
        !docs.some((document) => document.folder_id === viewedFolder.id) &&
        !folders.some(
            (folder) => folder.parent_folder_id === viewedFolder.id,
        ) &&
        creatingFolderIn !== viewedFolder.id &&
        !hasVisibleCollectionUpload;

    const nameSortDirection = effectiveSort?.key === "name" ? effectiveSort.direction : null;
    const sizeSortDirection = effectiveSort?.key === "size" ? effectiveSort.direction : null;
    const versionSortDirection = effectiveSort?.key === "version" ? effectiveSort.direction : null;
    const createdSortDirection = effectiveSort?.key === "created" ? effectiveSort.direction : null;
    const updatedSortDirection = effectiveSort?.key === "updated" ? effectiveSort.direction : null;
    const resetSortLabel = defaultSort
        ? `Default (${SORT_KEY_LABELS[defaultSort.key]})`
        : "Default Order";
    const nameFilterButton = enableHeaderFilters ? (
        <TableFilters
            label="Sort by name"
            value={nameSortDirection}
            allLabel={resetSortLabel}
            widthClassName="w-40"
            align="right"
            options={SORT_OPTIONS}
            onChange={(direction) => handleSortChange("name", direction)}
        />
    ) : null;
    const typeFilterButton = enableHeaderFilters ? (
        <TableFilters
            label="Filter by file type"
            value={typeFilter}
            allLabel="All Types"
            widthClassName="w-40"
            options={typeOptions}
            onChange={handleTypeFilterChange}
        />
    ) : null;
    const sizeFilterButton = enableHeaderFilters ? (
        <TableFilters
            label="Sort by size"
            value={sizeSortDirection}
            allLabel={resetSortLabel}
            widthClassName="w-40"
            options={SORT_OPTIONS}
            onChange={(direction) => handleSortChange("size", direction)}
        />
    ) : null;
    const versionFilterButton = enableHeaderFilters ? (
        <TableFilters
            label="Sort by version"
            value={versionSortDirection}
            allLabel={resetSortLabel}
            widthClassName="w-40"
            options={SORT_OPTIONS}
            onChange={(direction) => handleSortChange("version", direction)}
        />
    ) : null;
    const createdFilterButton = enableHeaderFilters ? (
        <TableFilters
            label="Sort by created date"
            value={createdSortDirection}
            allLabel={resetSortLabel}
            widthClassName="w-40"
            options={SORT_OPTIONS}
            onChange={(direction) => handleSortChange("created", direction)}
        />
    ) : null;
    const updatedFilterButton = enableHeaderFilters ? (
        <TableFilters
            label="Sort by updated date"
            value={updatedSortDirection}
            allLabel={resetSortLabel}
            widthClassName="w-40"
            options={SORT_OPTIONS}
            onChange={(direction) => handleSortChange("updated", direction)}
        />
    ) : null;

    const selectAllFolderIds = useMemo(() => {
        if (q) return [];

        const visibleFolderIds: string[] = [];
        const visitedFolderIds = new Set<string>();
        const visitLevel = (parentId: string | null) => {
            for (const folder of childFoldersForLevel(parentId)) {
                if (visitedFolderIds.has(folder.id)) {
                    continue;
                }
                visitedFolderIds.add(folder.id);
                visibleFolderIds.push(folder.id);
                if (expandedFolderIds.has(folder.id)) {
                    visitLevel(folder.id);
                }
            }
        };

        visitLevel(viewedFolderId);
        return visibleFolderIds;
    }, [
        childFoldersForLevel,
        expandedFolderIds,
        q,
        viewedFolderId,
    ]);
    const selectAllFolderTreeIds = useMemo(
        () => collectFolderTreeIds(folders, selectAllFolderIds),
        [folders, selectAllFolderIds],
    );
    /**
     * Folder subtree the current view is responsible for, or `null` when the
     * view spans the whole collection (the root level, and search, which
     * renders one flat list across every folder).
     */
    const viewedFolderTreeIds = useMemo(
        () =>
            !q && viewedFolderId
                ? collectFolderTreeIds(folders, [viewedFolderId])
                : null,
        [folders, q, viewedFolderId],
    );
    /**
     * Documents the header "select all" may reach. Folder rows are already
     * scoped to the viewed level by `selectAllFolderIds`; without the same
     * scope here, select-all inside a subfolder would silently pull in every
     * document in the collection and feed it to the bulk actions.
     */
    const viewScopedDocumentIds = useCallback(
        (documentIds: readonly string[]) => {
            if (!viewedFolderTreeIds) return [...documentIds];
            const folderIdByDocumentId = new Map(
                docs.map((document) => [document.id, document.folder_id ?? null]),
            );
            return documentIds.filter((documentId) => {
                // An id with no loaded row cannot be placed in the viewed
                // folder, so leave it out rather than selecting a document
                // this view never showed.
                const folderId = folderIdByDocumentId.get(documentId) ?? null;
                return !!folderId && viewedFolderTreeIds.has(folderId);
            });
        },
        [docs, viewedFolderTreeIds],
    );
    const visibleSelectableDocumentIds = useMemo(
        () => viewScopedDocumentIds(filteredDocs.map((document) => document.id)),
        [filteredDocs, viewScopedDocumentIds],
    );
    /**
     * The document half of "select all": in view scope, minus the documents
     * already covered by a selected folder row.
     */
    const selectAllDocumentIds = useCallback(
        (documentIds: readonly string[]) => {
            const folderIdByDocumentId = new Map(
                docs.map((document) => [document.id, document.folder_id ?? null]),
            );
            return viewScopedDocumentIds(documentIds).filter((documentId) => {
                const folderId = folderIdByDocumentId.get(documentId) ?? null;
                return folderId == null || !selectAllFolderTreeIds.has(folderId);
            });
        },
        [docs, selectAllFolderTreeIds, viewScopedDocumentIds],
    );
    const {
        allSelected: allVisibleRowsSelected,
        someSelected: someVisibleRowsSelected,
    } = collectionSelectAllState(
        visibleSelectableDocumentIds,
        selectAllFolderIds,
        [...effectiveSelectedDocIdSet],
        selectedFolderIds,
    );

    const handleToggleAllDocuments = useCallback(async () => {
        selectionAnchorKeyRef.current = null;
        if (allVisibleRowsSelected || selectionCameFromSelectAll) {
            setSelectedDocIds([]);
            setSelectedFolderIds(new Set());
            setSelectionCameFromSelectAll(false);
            return;
        }

        // Inside a folder the "all matching" endpoint cannot help: it answers
        // for the whole collection and takes no folder scope, so every id it
        // returns outside this subtree would have to be discarded anyway.
        // Select from the rows this level has loaded instead.
        if (!onSelectAllMatching || viewedFolderTreeIds) {
            setSelectedDocIds(
                selectAllDocumentIds(
                    filteredDocs.map((document) => document.id),
                ),
            );
            setSelectedFolderIds(new Set(selectAllFolderIds));
            setSelectionCameFromSelectAll(true);
            return;
        }

        setSelectingAllDocuments(true);
        try {
            const ids = await onSelectAllMatching({
                search,
                fileType: typeFilter,
                sort,
            });
            setSelectedDocIds(selectAllDocumentIds(ids));
            setSelectedFolderIds(new Set(selectAllFolderIds));
            setSelectionCameFromSelectAll(true);
        } catch (error) {
            console.error("Select all matching documents failed", error);
            setCollectionActionWarning(
                userFacingApiError(
                    error,
                    "All matching files could not be selected. Please try again.",
                ),
            );
        } finally {
            setSelectingAllDocuments(false);
        }
    }, [
        allVisibleRowsSelected,
        filteredDocs,
        onSelectAllMatching,
        search,
        selectAllDocumentIds,
        selectAllFolderIds,
        selectionCameFromSelectAll,
        sort,
        typeFilter,
        viewedFolderTreeIds,
    ]);

    const selectedItemCount =
        selectedFolderIds.size + selectedStandaloneDocIds.length;
    const selectionActions = useMemo<DocTableSelectionActions | null>(() => {
        if (selectedItemCount === 0) return null;
        return {
            selectedCount: selectedItemCount,
            hasDocumentsInFolders: selectedStandaloneDocIds.some(
                (id) => docs.find((d) => d.id === id)?.folder_id != null,
            ),
            onDownload: handleDownloadSelectedDocs,
            onRemoveFromFolder: handleRemoveSelectedFromFolder,
            onDelete: async () => requestDeleteSelectedItems(),
        };
    }, [
        docs,
        handleDownloadSelectedDocs,
        handleRemoveSelectedFromFolder,
        requestDeleteSelectedItems,
        selectedItemCount,
        selectedStandaloneDocIds,
    ]);

    useEffect(() => {
        onSelectionActionsChange?.(selectionActions);
    }, [onSelectionActionsChange, selectionActions]);

    useEffect(() => {
        return () => onSelectionActionsChange?.(null);
    }, [onSelectionActionsChange]);

    const pendingVersionDropMessage = pendingVersionDrop ? (
        <div className="space-y-2">
            <p>
                You are about to save{" "}
                <span className="font-medium text-gray-950">{pendingVersionDrop.sourceDoc.filename}</span> as a new
                version of <span className="font-medium text-gray-950">{pendingVersionDrop.targetDoc.filename}</span>.
            </p>
            <p>
                <span className="font-medium text-gray-950">{pendingVersionDrop.sourceDoc.filename}</span> will no
                longer exist as a separate document
                {(currentVersionNumber(pendingVersionDrop.sourceDoc) ?? 1) > 1
                    ? " and its older versions will be deleted"
                    : ""}
                .
            </p>
        </div>
    ) : undefined;
    const pendingDeleteDocVersionCount = pendingDeleteDoc
        ? (versionsByDocId.get(pendingDeleteDoc.id)?.versions.length ?? currentVersionNumber(pendingDeleteDoc) ?? 1)
        : 0;
    const pendingDeleteDocMessage = pendingDeleteDoc ? (
        <div className="space-y-2">
            <p>
                <span className="font-medium text-gray-950">{pendingDeleteDoc.filename}</span> has{" "}
                {pendingDeleteDocVersionCount} {pendingDeleteDocVersionCount === 1 ? "version" : "versions"}. Deleting
                this document will delete all of its versions.
            </p>
        </div>
    ) : undefined;
    const pendingDeleteFolderMessage = pendingDeleteFolder ? (
        <div className="space-y-2">
            <p>
                This will permanently delete{" "}
                <span className="font-medium text-gray-950">
                    {pendingDeleteFolder.folderIds.length}{" "}
                    {pendingDeleteFolder.folderIds.length === 1 ? "folder" : "folders"}
                </span>
                , including <span className="font-medium text-gray-950">{pendingDeleteFolder.folder.name}</span>
                {pendingDeleteFolder.folderIds.length > 1 ? " and its nested subfolders" : ""}.
            </p>
            {pendingDeleteFolder.documentCount > 0 && (
                <p>
                    {pendingDeleteFolder.documentCount}{" "}
                    {pendingDeleteFolder.documentCount === 1 ? "document" : "documents"} in the deleted{" "}
                    {pendingDeleteFolder.folderIds.length === 1 ? "folder" : "folders"} will also be permanently
                    deleted.
                </p>
            )}
        </div>
    ) : undefined;
    const selectedDeleteSummary = [
        selectedFolderIds.size > 0
            ? `${selectedFolderIds.size} ${selectedFolderIds.size === 1 ? "folder" : "folders"}`
            : null,
        selectedStandaloneDocIds.length > 0
            ? `${selectedStandaloneDocIds.length} ${selectedStandaloneDocIds.length === 1 ? "file" : "files"}`
            : null,
    ]
        .filter(Boolean)
        .join(" and ");

    return (
        <div
            ref={tableRootRef}
            className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden"
        >
            <input
                ref={versionUploadInputRef}
                type="file"
                accept={versionUploadAccept}
                className="hidden"
                onChange={handleVersionUploadInputChange}
            />
            <input
                ref={documentUploadInputRef}
                type="file"
                accept={SUPPORTED_DOCUMENT_ACCEPT}
                multiple
                className="hidden"
                onChange={(event) => {
                    const files = Array.from(event.target.files ?? []);
                    event.target.value = "";
                    void handleDropCollectionFiles(files);
                }}
            />
            <input
                ref={directoryUploadInputRef}
                type="file"
                accept={SUPPORTED_DOCUMENT_ACCEPT}
                multiple
                className="hidden"
                {...{ webkitdirectory: "", directory: "" }}
                onChange={(event) => {
                    const entries = documentUploadEntriesFromFiles(
                        event.target.files ?? [],
                    );
                    event.target.value = "";
                    void handleCollectionUploadEntries(entries);
                }}
            />
            <UploadOverlay
                open={isDraggingCollectionFiles}
                label="Drop files or folders here to upload"
                warning={documentUploadWarning}
                onWarningClose={() => setDocumentUploadWarning(null)}
            />
            <WarningPopup
                open={!!documentRenameWarning}
                onClose={() => setDocumentRenameWarning(null)}
                message={documentRenameWarning}
            />
            <WarningPopup
                open={!!collectionActionWarning}
                onClose={() => setCollectionActionWarning(null)}
                message={collectionActionWarning}
            />
            <ConfirmPopup
                open={!!folderUploadConflict}
                title="Folder already exists"
                message={
                    folderUploadConflict
                        ? `A folder named “${folderUploadConflict.folderName}” already exists. This folder will be uploaded as “${folderUploadConflict.suggestedName}”.`
                        : undefined
                }
                confirmLabel="Continue"
                cancelLabel="Cancel"
                onCancel={() => finishFolderUploadConflict("cancel")}
                onConfirm={() => finishFolderUploadConflict("rename")}
            />
            <ConfirmPopup
                open={confirmDeleteAllOpen && !!selectionActions}
                title="Delete selected items?"
                message={
                    <div className="space-y-2">
                        <p>
                            This will permanently delete{" "}
                            <span className="font-medium text-gray-950">
                                {selectedDeleteSummary}
                            </span>
                            .
                        </p>
                        {selectedFolderIds.size > 0 && (
                            <p>
                                All nested folders and files contained in the
                                selected folders will also be deleted.
                            </p>
                        )}
                        <p>
                            Files owned by others will be skipped. This action
                            cannot be undone.
                        </p>
                    </div>
                }
                confirmLabel="Delete"
                confirmVariant="danger"
                cancelLabel="Cancel"
                onCancel={() => setConfirmDeleteAllOpen(false)}
                onConfirm={() => void handleDeleteSelectedItems()}
            />
            <ConfirmPopup
                open={!!pendingVersionDrop}
                title="Save as new version?"
                message={pendingVersionDropMessage}
                confirmLabel="Confirm"
                cancelLabel="Cancel"
                onCancel={() => setPendingVersionDrop(null)}
                onConfirm={() => {
                    const pending = pendingVersionDrop;
                    if (!pending) return;
                    setPendingVersionDrop(null);
                    void saveExistingDocumentAsNewVersion(pending.targetDoc, pending.sourceDoc);
                }}
            />
            <ConfirmPopup
                open={!!pendingDeleteDoc}
                title="Delete document?"
                message={pendingDeleteDocMessage}
                confirmLabel="Delete"
                confirmVariant="danger"
                confirmStatus={
                    pendingDeleteStatus === "deleting"
                        ? "loading"
                        : pendingDeleteStatus === "deleted"
                          ? "complete"
                          : "idle"
                }
                cancelLabel="Cancel"
                onCancel={() => {
                    if (pendingDeleteStatus === "deleting") return;
                    setPendingDeleteDoc(null);
                    setPendingDeleteStatus("idle");
                }}
                onConfirm={() => void confirmRemovePendingDoc()}
            />
            <ConfirmPopup
                open={!!pendingDeleteFolder}
                title="Delete folder?"
                message={pendingDeleteFolderMessage}
                confirmLabel="Delete"
                confirmVariant="danger"
                confirmStatus={
                    pendingDeleteFolderStatus === "deleting"
                        ? "loading"
                        : pendingDeleteFolderStatus === "deleted"
                          ? "complete"
                          : "idle"
                }
                cancelLabel="Cancel"
                onCancel={() => {
                    if (pendingDeleteFolderStatus === "deleting") return;
                    setPendingDeleteFolder(null);
                    setPendingDeleteFolderStatus("idle");
                }}
                onConfirm={() => void confirmDeletePendingFolder()}
            />
            {/* Table content */}
            <TableScrollArea
                onScroll={handleTableScroll}
                viewportOverlay={
                    <>
                        {dragOverRoot && dragOverFolderId === null && (
                            <div className="absolute inset-0 z-[80] rounded-b-2xl border-2 border-blue-400 pointer-events-none" />
                        )}
                        {dragOverFileRoot && (
                            <div className="absolute inset-0 z-[90] rounded-b-2xl border-2 border-blue-400 bg-blue-50/40 pointer-events-none" />
                        )}
                    </>
                }
                header={
                    loading || (serverQueryActive && serverQueryLoading) ? (
                        <ProjectTableLoadingHeader />
                    ) : (
                        <TableHeaderRow className="pr-3">
                            <TableStickyCell header widthClassName={DOC_NAME_COL_W}>
                                <input
                                    type="checkbox"
                                    checked={
                                        selectionCameFromSelectAll ||
                                        allVisibleRowsSelected
                                    }
                                    disabled={selectingAllDocuments}
                                    ref={(el) => {
                                        if (el) {
                                            el.indeterminate =
                                                !selectionCameFromSelectAll &&
                                                someVisibleRowsSelected;
                                        }
                                    }}
                                    onChange={() => void handleToggleAllDocuments()}
                                    className={TABLE_CHECKBOX_CLASS}
                                    aria-label="Select all files and folders"
                                />
                                <span className="mr-1">Name</span>
                                {nameFilterButton}
                            </TableStickyCell>
                            <TableHeaderCell className="ml-auto flex w-20 items-center gap-1">
                                <span>Type</span>
                                {typeFilterButton}
                            </TableHeaderCell>
                            <TableHeaderCell className="flex w-24 items-center gap-1">
                                <span>Size</span>
                                {sizeFilterButton}
                            </TableHeaderCell>
                            <TableHeaderCell className="flex w-20 items-center gap-1">
                                <span>Version</span>
                                {versionFilterButton}
                            </TableHeaderCell>
                            <TableHeaderCell className="flex w-32 items-center gap-1">
                                <span>Created</span>
                                {createdFilterButton}
                            </TableHeaderCell>
                            <TableHeaderCell className="flex w-32 items-center gap-1">
                                <span>Updated</span>
                                {updatedFilterButton}
                            </TableHeaderCell>
                            <TableHeaderCell className="w-8" />
                        </TableHeaderRow>
                    )
                }
            >
                {loading || (serverQueryActive && serverQueryLoading) ? (
                    <ProjectTableLoading />
                ) : (
                    <div className="flex-1 flex flex-col min-h-0">
                        <div
                            className="flex-1 flex flex-col min-h-0 relative"
                            onDragOver={(e) => {
                                if (!hasFilePayload(e.dataTransfer)) return;
                                e.preventDefault();
                                e.dataTransfer.dropEffect = "copy";
                                setDragOverFileRoot(true);
                                setDragOverVersionDocId(null);
                            }}
                            onDragLeave={(e) => {
                                if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                                    setDragOverFileRoot(false);
                                }
                            }}
                            onDrop={async (e) => {
                                if (!hasFilePayload(e.dataTransfer)) return;
                                e.preventDefault();
                                e.stopPropagation();
                                setDragOverFileRoot(false);
                                collectionDragDepthRef.current = 0;
                                setIsDraggingCollectionFiles(false);
                                setDragOverRoot(false);
                                setDragOverFolderId(null);
                                setDragOverVersionDocId(null);
                                await handleDroppedCollectionDataTransfer(
                                    e.dataTransfer,
                                );
                            }}
                        >
                            {/* Empty state */}
                            {viewedFolderIsEmpty ? (
                                <div className="flex flex-1 items-center justify-center py-24 text-center">
                                    <p className="text-sm text-gray-400">
                                        Empty folder
                                    </p>
                                </div>
                            ) : docs.length === 0 &&
                            (serverQueryActive || folders.length === 0) &&
                            creatingFolderIn === undefined &&
                            !hasVisibleCollectionUpload ? (
                                serverQueryActive ? (
                                    <div className="flex-1 flex flex-col items-center justify-center py-24 text-center">
                                        <p className="text-sm text-gray-400">No matches found</p>
                                    </div>
                                ) : (
                                    <div
                                        onClick={openAddDocuments}
                                        className="flex flex-1 cursor-pointer"
                                    >
                                        <TableEmptyState>
                                            <EmptyState
                                                icon={<LibrarySkeuoIcon />}
                                                title={emptyStateTitle}
                                                description="Upload documents or drop files and folders here"
                                                action={
                                                    <PillButton
                                                        tone="black"
                                                        size="sm"
                                                        // Uploading here is
                                                        // editor-tier, and the
                                                        // empty state was the
                                                        // one Upload that
                                                        // still looked live to
                                                        // a viewer.
                                                        disabled={
                                                            !allowed(
                                                                "content.edit",
                                                            )
                                                        }
                                                        aria-disabled={
                                                            !allowed(
                                                                "content.edit",
                                                            ) || undefined
                                                        }
                                                        title={
                                                            allowed(
                                                                "content.edit",
                                                            )
                                                                ? undefined
                                                                : "Only an editor can add documents"
                                                        }
                                                        onClick={(event) => {
                                                            event.stopPropagation();
                                                            openAddDocuments();
                                                        }}
                                                    >
                                                        Upload
                                                    </PillButton>
                                                }
                                            />
                                        </TableEmptyState>
                                    </div>
                                )
                            ) : (
                                <div
                                    className="flex-1 flex flex-col"
                                    onContextMenu={(e) => {
                                        e.preventDefault();
                                        closeRowActionMenus();
                                        setContextMenu({
                                            x: e.clientX,
                                            y: e.clientY,
                                            folderId: null,
                                            showFolderActions: false,
                                        });
                                    }}
                                    onClick={() => setContextMenu(null)}
                                    onDragOver={(e) => {
                                        if (!hasMovePayload(e.dataTransfer)) return;
                                        e.preventDefault();
                                        setDragOverRoot(true);
                                        setDragOverVersionDocId(null);
                                    }}
                                    onDragLeave={(e) => {
                                        if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                                            setDragOverRoot(false);
                                        }
                                    }}
                                    onDrop={async (e) => {
                                        if (!hasMovePayload(e.dataTransfer)) return;
                                        e.preventDefault();
                                        setDragOverRoot(false);
                                        setDragOverFolderId(null);
                                        setDragOverVersionDocId(null);
                                        await handleDropOnFolder(
                                            viewedFolderId,
                                            e.dataTransfer,
                                        );
                                    }}
                                >
                                    {/* Search: flat list; no search: folder tree */}
                                    {q ? (
                                        <>
                                            {renderUploadingDocumentRows(
                                                0,
                                                viewedFolderId,
                                            )}
                                            {filteredDocs.map((doc) => {
                                                const docName = doc.filename;
                                                const isProcessing =
                                                    doc.status === "pending" || doc.status === "processing";
                                                const isError = doc.status === "error";
                                                const isVersionsOpen = expandedVersionDocIds.has(doc.id);
                                                const versionNumber = currentVersionNumber(doc);
                                                const hasVersions =
                                                    typeof versionNumber === "number" && versionNumber > 1;
                                                const isVersionDragOver = dragOverVersionDocId === doc.id;
                                                const isUploadingVersion = uploadingVersionDocIds.has(doc.id);
                                                const isSelected = effectiveSelectedDocIdSet.has(doc.id);
                                                const isDeletingDoc = deletingDocIds.has(doc.id);
                                                if (isDeletingDoc) {
                                                    return renderDocumentActivityRow({
                                                        key: `deleting-doc-${doc.id}`,
                                                        filename: doc.filename,
                                                        fileType: doc.file_type,
                                                        depth: 0,
                                                        statusLabel: "Deleting...",
                                                    });
                                                }
                                                return (
                                                    <div key={doc.id}>
                                                        <div
                                                            data-document-row
                                                            data-document-id={doc.id}
                                                            data-collection-row-key={`document:${doc.id}`}
                                                            draggable={renamingDocumentId !== doc.id}
                                                            onDragStart={(event) =>
                                                                handleDocumentDragStart(
                                                                    event,
                                                                    doc,
                                                                )
                                                            }
                                                            onDragEnd={() => {
                                                                setDragOverRoot(false);
                                                                setDragOverFolderId(null);
                                                                setDragOverVersionDocId(null);
                                                            }}
                                                            onDragOver={(e) => handleDocumentVersionDragOver(e, doc.id)}
                                                            onDragLeave={handleDocumentVersionDragLeave}
                                                            onDrop={(e) => handleDocumentVersionDrop(e, doc)}
                                                            onClick={(event) =>
                                                                handleDocumentRowClick(
                                                                    event,
                                                                    doc,
                                                                )
                                                            }
                                                            onContextMenu={(e) => {
                                                                e.preventDefault();
                                                                e.stopPropagation();
                                                                closeRowActionMenus();
                                                                setContextMenu({
                                                                    x: e.clientX,
                                                                    y: e.clientY,
                                                                    docId: doc.id,
                                                                    folderId: null,
                                                                    showFolderActions: false,
                                                                });
                                                            }}
                                                            className={`group flex h-10 min-w-max items-center pr-3 cursor-pointer transition-colors ${isVersionDragOver ? "bg-blue-50 ring-1 ring-inset ring-blue-200" : isSelected ? LIQUID_GLASS_SELECTED_CLASS : LIQUID_GLASS_HOVER_CLASS}`}
                                                        >
                                                            <div
                                                                className={`${DOC_TABLE_STICKY_CELL_CLASS} sticky left-0 z-[60] ${DOC_NAME_COL_W} ${isVersionDragOver ? "bg-blue-50" : isSelected ? LIQUID_GLASS_SELECTED_CLASS : ""} py-2 pl-3 pr-2 transition-colors ${isVersionDragOver || isSelected ? "" : LIQUID_GLASS_GROUP_HOVER_CLASS}`}
                                                            >
                                                                <div className="flex items-center">
                                                                    {isProcessing || isUploadingVersion ? (
                                                                        <Loader2 className="mr-3 h-2.5 w-2.5 animate-spin text-gray-400 shrink-0" />
                                                                    ) : (
                                                                        <input
                                                                            type="checkbox"
                                                                            checked={effectiveSelectedDocIdSet.has(doc.id)}
                                                                            onChange={(event) =>
                                                                                updateDocumentSelection(
                                                                                    doc,
                                                                                    event.target.checked,
                                                                                    (
                                                                                        event.nativeEvent as MouseEvent
                                                                                    ).shiftKey,
                                                                                )
                                                                            }
                                                                            onClick={(e) => e.stopPropagation()}
                                                                            aria-label={`Select ${docName}`}
                                                                            className={TABLE_CHECKBOX_CLASS}
                                                                        />
                                                                    )}
                                                                    <span className="mr-2 shrink-0">
                                                                        {isError ? (
                                                                            <AlertCircle className="h-4 w-4 text-red-500" />
                                                                        ) : (
                                                                            <DocIcon fileType={doc.file_type} />
                                                                        )}
                                                                    </span>
                                                                    {renamingDocumentId === doc.id ? (
                                                                        <input
                                                                            autoFocus
                                                                            className="min-w-0 flex-1 text-xs text-gray-800 bg-transparent outline-none border-b border-gray-300"
                                                                            value={renameDocumentValue}
                                                                            onClick={(e) => e.stopPropagation()}
                                                                            onDragStart={(e) => {
                                                                                e.preventDefault();
                                                                                e.stopPropagation();
                                                                            }}
                                                                            onChange={(e) =>
                                                                                setRenameDocumentValue(e.target.value)
                                                                            }
                                                                            onKeyDown={(e) => {
                                                                                if (e.key === "Enter")
                                                                                    void submitDocumentRename(doc.id);
                                                                                if (e.key === "Escape") {
                                                                                    setRenamingDocumentId(null);
                                                                                    setRenameDocumentValue("");
                                                                                }
                                                                            }}
                                                                            onBlur={() =>
                                                                                void submitDocumentRename(doc.id)
                                                                            }
                                                                        />
                                                                    ) : (
                                                                        <span className="text-xs text-gray-800 truncate">
                                                                            {docName}
                                                                        </span>
                                                                    )}
                                                                </div>
                                                            </div>
                                                            <div className="ml-auto w-20 shrink-0 text-xs text-gray-500 lowercase truncate">
                                                                {doc.file_type ?? (
                                                                    <span className="text-gray-300">—</span>
                                                                )}
                                                            </div>
                                                            <div className="w-24 shrink-0 text-xs text-gray-500 truncate">
                                                                {doc.size_bytes != null ? (
                                                                    formatBytes(doc.size_bytes)
                                                                ) : (
                                                                    <span className="text-gray-300">—</span>
                                                                )}
                                                            </div>
                                                            <div
                                                                className="w-20 shrink-0 text-xs text-gray-500 flex items-center gap-1"
                                                                onClick={(e) => e.stopPropagation()}
                                                            >
                                                                {hasVersions ? (
                                                                    <button
                                                                        onClick={() => void toggleVersions(doc.id)}
                                                                        className={`flex items-center gap-1 rounded px-1 py-0.5 transition-colors ${LIQUID_GLASS_HOVER_CLASS}`}
                                                                    >
                                                                        <span>{versionNumber}</span>
                                                                        {isVersionsOpen ? (
                                                                            <ChevronDown className="h-3 w-3 text-gray-400" />
                                                                        ) : (
                                                                            <ChevronRight className="h-3 w-3 text-gray-400" />
                                                                        )}
                                                                    </button>
                                                                ) : (
                                                                    <span className="text-gray-300 pl-1">—</span>
                                                                )}
                                                            </div>
                                                            <div className="w-32 shrink-0 text-xs text-gray-500 truncate">
                                                                {doc.created_at ? (
                                                                    formatDate(doc.created_at)
                                                                ) : (
                                                                    <span className="text-gray-300">—</span>
                                                                )}
                                                            </div>
                                                            <div className="w-32 shrink-0 text-xs text-gray-500 truncate">
                                                                {doc.updated_at ? (
                                                                    formatDate(doc.updated_at)
                                                                ) : (
                                                                    <span className="text-gray-300">—</span>
                                                                )}
                                                            </div>
                                                            <div className="w-8 shrink-0 flex justify-end">
                                                                {!isProcessing && (
                                                                    <RowActions
                                                                        onView={() => {
                                                                            setViewingDocVersion(null);
                                                                            setViewingDoc(doc);
                                                                        }}
                                                                        onRename={() => {
                                                                            setRenameDocumentValue(docName);
                                                                            setRenamingDocumentId(doc.id);
                                                                        }}
                                                                        renameLabel="Rename document"
                                                                        onDownload={() => downloadDoc(doc.id)}
                                                                        onShowAllVersions={
                                                                            hasVersions && !isVersionsOpen
                                                                                ? () => void toggleVersions(doc.id)
                                                                                : undefined
                                                                        }
                                                                        onUploadNewVersion={() =>
                                                                            void handleUploadNewVersion(doc)
                                                                        }
                                                                        onDelete={() => requestRemoveDoc(doc)}
                                                                        deleteDisabled={!canDeleteDocument(doc)}
                                                                    />
                                                                )}
                                                            </div>
                                                        </div>
                                                        {isVersionsOpen && (
                                                            <DocVersionHistory
                                                                docId={doc.id}
                                                                filename={docName}
                                                                activeVersionNumber={versionNumber}
                                                                loading={loadingVersionDocIds.has(doc.id)}
                                                                versions={versionsByDocId.get(doc.id)?.versions ?? []}
                                                                currentVersionId={
                                                                    versionsByDocId.get(doc.id)?.currentVersionId ??
                                                                    null
                                                                }
                                                                onDownloadVersion={downloadDocVersion}
                                                                onOpenVersion={(versionId, label) => {
                                                                    setViewingDocVersion({
                                                                        id: versionId,
                                                                        label,
                                                                    });
                                                                    setViewingDoc(doc);
                                                                }}
                                                                onRenameVersion={(versionId, filename) =>
                                                                    handleRenameVersion(doc.id, versionId, filename)
                                                                }
                                                                onExtensionChangeBlocked={(filename) =>
                                                                    setDocumentRenameWarning(
                                                                        extensionChangeWarning(filename),
                                                                    )
                                                                }
                                                            />
                                                        )}
                                                    </div>
                                                );
                                            })}
                                            {serverQueryActive && onLoadMoreServerDocuments && (
                                                <TableLoadMoreRow
                                                    loading={false}
                                                    hasMore={serverQueryHasMore}
                                                    itemCount={filteredDocs.length}
                                                    loadingMore={serverQueryLoadingMore}
                                                    hasError={false}
                                                    onLoadMore={onLoadMoreServerDocuments}
                                                />
                                            )}
                                        </>
                                    ) : (
                                        viewedFolder ? (
                                            renderLevel(viewedFolder.id, 0)
                                        ) : (
                                            renderLevel(null, 0)
                                        )
                                    )}
                                </div>
                            )}

                            {/* Context menu */}
                            {contextMenu &&
                                (() => {
                                    const menuDoc = contextMenu.docId
                                        ? docs.find((doc) => doc.id === contextMenu.docId)
                                        : null;
                                    const menuDocVersionNumber = menuDoc ? currentVersionNumber(menuDoc) : null;
                                    const menuDocHasVersions =
                                        typeof menuDocVersionNumber === "number" && menuDocVersionNumber > 1;
                                    const menuDocVersionsOpen = menuDoc ? expandedVersionDocIds.has(menuDoc.id) : false;
                                    const menuDocIsSelected =
                                        !!menuDoc &&
                                        effectiveSelectedDocIdSet.has(menuDoc.id);
                                    const menuAppliesToSelection =
                                        menuDocIsSelected &&
                                        selectedItemCount > 1;
                                    const menuFolderIsSelected =
                                        !!contextMenu.folderId &&
                                        selectedFolderIds.has(
                                            contextMenu.folderId,
                                        );
                                    const menuFolderAppliesToSelection =
                                        menuFolderIsSelected &&
                                        selectedItemCount > 1;
                                    const surfaceProps: RowActionMenuSurfaceProps = {
                                        className: "fixed z-[120]",
                                        style: {
                                            top: contextMenu.y,
                                            left: contextMenu.x,
                                        },
                                        onClick: (e) => e.stopPropagation(),
                                    };

                                    return createPortal(
                                        menuDoc ? (
                                            <RowActionMenuItems
                                                ref={contextMenuRef}
                                                surfaceProps={surfaceProps}
                                                onClose={() => setContextMenu(null)}
                                                onDeselect={
                                                    menuDocIsSelected
                                                        ? clearCollectionSelection
                                                        : undefined
                                                }
                                                onView={
                                                    menuAppliesToSelection
                                                        ? undefined
                                                        : () => {
                                                              setViewingDocVersion(null);
                                                              setViewingDoc(menuDoc);
                                                          }
                                                }
                                                onRename={
                                                    menuAppliesToSelection
                                                        ? undefined
                                                        : () => {
                                                              setRenameDocumentValue(menuDoc.filename);
                                                              setRenamingDocumentId(menuDoc.id);
                                                          }
                                                }
                                                renameLabel="Rename document"
                                                onDownload={() =>
                                                    menuAppliesToSelection
                                                        ? handleDownloadSelectedDocs()
                                                        : downloadDoc(menuDoc.id)
                                                }
                                                onShowAllVersions={
                                                    !menuAppliesToSelection &&
                                                    menuDocHasVersions &&
                                                    !menuDocVersionsOpen
                                                        ? () => void toggleVersions(menuDoc.id)
                                                        : undefined
                                                }
                                                onUploadNewVersion={
                                                    menuAppliesToSelection
                                                        ? undefined
                                                        : () => void handleUploadNewVersion(menuDoc)
                                                }
                                                onRemoveFromFolder={
                                                    menuAppliesToSelection
                                                        ? selectedStandaloneDocIds.some(
                                                              (id) => docs.find((doc) => doc.id === id)?.folder_id,
                                                          )
                                                            ? () => void handleRemoveSelectedFromFolder()
                                                            : undefined
                                                        : menuDoc.folder_id
                                                          ? () => void handleRemoveDocFromFolder(menuDoc.id)
                                                        : undefined
                                                }
                                                onDelete={() =>
                                                    menuAppliesToSelection
                                                        ? requestDeleteSelectedItems()
                                                        : requestRemoveDoc(menuDoc)
                                                }
                                                deleteLabel={
                                                    menuAppliesToSelection
                                                        ? `Delete ${selectedItemCount} items`
                                                        : undefined
                                                }
                                                deleteDisabled={
                                                    !menuAppliesToSelection &&
                                                    !canDeleteDocument(menuDoc)
                                                }
                                            />
                                        ) : (
                                            <RowActionMenuItems
                                                ref={contextMenuRef}
                                                surfaceProps={surfaceProps}
                                                onClose={() => setContextMenu(null)}
                                                onDeselect={
                                                    menuFolderIsSelected
                                                        ? clearCollectionSelection
                                                        : undefined
                                                }
                                                onView={
                                                    !menuFolderAppliesToSelection &&
                                                    contextMenu.showFolderActions &&
                                                    contextMenu.folderId
                                                        ? () =>
                                                              openFolderView(
                                                                  contextMenu.folderId!,
                                                              )
                                                        : undefined
                                                }
                                                viewLabel="Open"
                                                onDownload={
                                                    menuFolderAppliesToSelection
                                                        ? handleDownloadSelectedDocs
                                                        : undefined
                                                }
                                                newSubfolderDisabled={!allowed("docs.organize")}
                                                onNewSubfolder={menuFolderAppliesToSelection ? undefined : () => {
                                                    // The name prompt itself is
                                                    // only offered to a role
                                                    // that may create the
                                                    // folder; the submit gate
                                                    // in handleCreateFolder
                                                    // stays as the backstop.
                                                    if (
                                                        !requireCapability(
                                                            "docs.organize",
                                                            "create folders",
                                                            "editor",
                                                        )
                                                    )
                                                        return;
                                                    setCreatingFolderIn(contextMenu.folderId);
                                                    setNewFolderName("");
                                                    if (contextMenu.folderId) {
                                                        const wasExpanded = expandedFolderIds.has(contextMenu.folderId);
                                                        if (!wasExpanded)
                                                            void expandFolderChildren(contextMenu.folderId);
                                                        setExpandedFolderIds(
                                                            (prev) => new Set([...prev, contextMenu.folderId!]),
                                                        );
                                                    }
                                                }}
                                                newSubfolderLabel={
                                                    contextMenu.showFolderActions
                                                        ? "New subfolder inside"
                                                        : "New subfolder"
                                                }
                                                onRename={
                                                    !menuFolderAppliesToSelection &&
                                                    contextMenu.showFolderActions && contextMenu.folderId
                                                        ? () => {
                                                              const f = folders.find(
                                                                  (x) => x.id === contextMenu.folderId,
                                                              );
                                                              setRenameFolderValue(f?.name ?? "");
                                                              setRenamingFolderId(contextMenu.folderId!);
                                                          }
                                                        : undefined
                                                }
                                                renameLabel="Rename folder"
                                                onDelete={
                                                    menuFolderAppliesToSelection
                                                        ? requestDeleteSelectedItems
                                                        : contextMenu.showFolderActions && contextMenu.folderId
                                                        ? () => requestDeleteFolder(contextMenu.folderId!)
                                                        : undefined
                                                }
                                                deleteLabel={
                                                    menuFolderAppliesToSelection
                                                        ? `Delete ${selectedItemCount} items`
                                                        : "Delete folder"
                                                }
                                            />
                                        ),
                                        document.body,
                                    );
                                })()}
                        </div>
                        {/* end blue ring wrapper */}
                    </div>
                )}
            </TableScrollArea>

            {renderAddDocumentsModal?.(addDocsOpen, () => setAddDocsOpen(false), handleDocsSelected)}

            <DocumentSidePanel
                doc={sidePanelDoc}
                versionId={viewingDocVersion?.id ?? null}
                currentVersionId={
                    sidePanelDoc ? (versionsByDocId.get(sidePanelDoc.id)?.currentVersionId ?? null) : null
                }
                versions={sidePanelDoc ? (versionsByDocId.get(sidePanelDoc.id)?.versions ?? []) : []}
                versionsLoading={sidePanelDoc ? loadingVersionDocIds.has(sidePanelDoc.id) : false}
                onClose={() => {
                    setViewingDoc(null);
                    setViewingDocVersion(null);
                }}
                onLoadVersions={(docId) => loadDocumentVersions(docId)}
                onSelectVersion={(versionId, label) => setViewingDocVersion({ id: versionId, label })}
                onDownloadDocument={downloadDoc}
                onDownloadVersion={downloadDocVersion}
                onRenameVersion={handleRenameVersion}
                onDeleteVersion={handleDeleteVersion}
                onUploadNewVersion={submitNewVersion}
                onReplaceVersion={replaceVersionFile}
                canDelete={canDeleteDocument(sidePanelDoc)}
                onOwnerOnlyAction={setOwnerOnlyAction}
                onDelete={async (doc) => {
                    await handleRemoveDoc(doc.id);
                }}
            />
        </div>
    );
}

function filenameExtension(filename: string) {
    const trimmed = filename.trim();
    const dotIndex = trimmed.lastIndexOf(".");
    if (dotIndex <= 0 || dotIndex === trimmed.length - 1) return null;
    return trimmed.slice(dotIndex);
}

function hasFilenameExtensionChange(previous: string, next: string) {
    const previousExtension = filenameExtension(previous);
    if (previousExtension == null) return false;
    return (
        filenameExtension(next)?.toLowerCase() !==
        previousExtension.toLowerCase()
    );
}

function extensionChangeWarning(filename: string) {
    const extension = filenameExtension(filename);
    return extension
        ? `File extensions cannot be changed here. Keep ${extension} at the end of the name.`
        : "File extensions cannot be changed here.";
}
