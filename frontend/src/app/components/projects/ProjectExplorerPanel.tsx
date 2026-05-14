"use client";

import { useRef } from "react";
import { ChevronLeft, ChevronRight, Loader2, Upload } from "lucide-react";
import { ProjectExplorer } from "@/app/components/projects/ProjectExplorer";
import type { MikeDocument, MikeFolder } from "@/app/components/shared/types";

interface Props {
    width: number;
    collapsed: boolean;
    uploading: boolean;
    documents: MikeDocument[];
    folders: MikeFolder[];
    selectedDocId: string | null;
    projectName?: string | null;
    onCollapse: () => void;
    onExpand: () => void;
    onUploadFiles: (files: File[]) => Promise<void>;
    onDocClick: (doc: MikeDocument) => void;
    onCreateFolder: (parentId: string | null, name: string) => Promise<void>;
    onRenameFolder: (folderId: string, name: string) => Promise<void>;
    onDeleteFolder: (folderId: string) => Promise<void>;
    onDeleteDoc: (docId: string) => Promise<void>;
    onMoveDoc: (docId: string, targetFolderId: string | null) => Promise<void>;
    onMoveFolder: (folderId: string, targetFolderId: string | null) => Promise<void>;
}

export function ProjectExplorerPanel({
    width,
    collapsed,
    uploading,
    documents,
    folders,
    selectedDocId,
    projectName,
    onCollapse,
    onExpand,
    onUploadFiles,
    onDocClick,
    onCreateFolder,
    onRenameFolder,
    onDeleteFolder,
    onDeleteDoc,
    onMoveDoc,
    onMoveFolder,
}: Props) {
    const fileInputRef = useRef<HTMLInputElement>(null);

    if (collapsed) {
        return (
            <div className="shrink-0 flex flex-col border-r border-gray-200">
                <div className="h-10 flex items-center justify-center border-b border-gray-200 shrink-0 px-1">
                    <button
                        onClick={onExpand}
                        title="Expand explorer"
                        className="p-1 rounded text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors"
                    >
                        <ChevronRight className="h-3.5 w-3.5" />
                    </button>
                </div>
            </div>
        );
    }

    return (
        <div
            style={{ width }}
            className="shrink-0 flex flex-col border-r border-gray-200"
            onDragOver={(e) => {
                e.preventDefault();
                // Only show the upload overlay for external file drags, not internal moves
            }}
            onDrop={async (e) => {
                e.preventDefault();
                const files = Array.from(e.dataTransfer.files);
                if (files.length) await onUploadFiles(files);
            }}
        >
            {/* Explorer header */}
            <div className="h-10 flex items-center justify-between px-3 border-b border-gray-200 shrink-0">
                <span className="text-xs text-gray-700">Explorer</span>
                <div className="flex items-center gap-1">
                    <input
                        ref={fileInputRef}
                        type="file"
                        accept=".pdf,.docx,.doc"
                        multiple
                        className="hidden"
                        onChange={(e) =>
                            onUploadFiles(Array.from(e.target.files ?? []))
                        }
                    />
                    <button
                        onClick={() => fileInputRef.current?.click()}
                        disabled={uploading}
                        title="Upload documents"
                        className="p-1 rounded text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors disabled:opacity-40"
                    >
                        {uploading ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                            <Upload className="h-3.5 w-3.5" />
                        )}
                    </button>
                    <button
                        onClick={onCollapse}
                        title="Collapse explorer"
                        className="p-1 rounded text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors"
                    >
                        <ChevronLeft className="h-3.5 w-3.5" />
                    </button>
                </div>
            </div>

            {/* File tree */}
            <div
                className="flex-1 overflow-y-auto relative h-full"
                onDragOver={(e) => e.preventDefault()}
                onDrop={async (e) => {
                    e.preventDefault();
                    const docId = e.dataTransfer.getData("application/mike-doc");
                    const folderId = e.dataTransfer.getData("application/mike-folder");
                    if (docId) {
                        e.stopPropagation();
                        await onMoveDoc(docId, null);
                    } else if (folderId) {
                        e.stopPropagation();
                        await onMoveFolder(folderId, null);
                    }
                }}
            >
                <ProjectExplorer
                    projectName={projectName}
                    documents={documents}
                    folders={folders}
                    selectedDocId={selectedDocId}
                    onDocClick={onDocClick}
                    onCreateFolder={onCreateFolder}
                    onRenameFolder={onRenameFolder}
                    onDeleteFolder={onDeleteFolder}
                    onDeleteDoc={onDeleteDoc}
                    onMoveDoc={onMoveDoc}
                    onMoveFolder={onMoveFolder}
                />
            </div>
        </div>
    );
}
