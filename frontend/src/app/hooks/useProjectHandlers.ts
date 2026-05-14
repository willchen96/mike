"use client";

import { useState } from "react";
import {
    deleteDocument,
    uploadProjectDocument,
    createProjectFolder,
    renameProjectFolder,
    deleteProjectFolder,
    moveDocumentToFolder,
    moveSubfolderToFolder,
} from "@/app/lib/mikeApi";
import type { MikeProject } from "@/app/components/shared/types";

/**
 * Encapsulates the project document and folder mutation handlers used by
 * ProjectAssistantChatPage, keeping the page thin.
 */
export function useProjectHandlers(
    projectId: string,
    project: MikeProject | null,
    setProject: React.Dispatch<React.SetStateAction<MikeProject | null>>,
    onTabDocDeleted?: (docId: string) => void,
) {
    const [uploading, setUploading] = useState(false);

    async function uploadFiles(files: File[]) {
        if (!files.length) return;
        setUploading(true);
        try {
            const uploaded = await Promise.all(files.map((f) => uploadProjectDocument(projectId, f)));
            setProject((prev) => prev ? { ...prev, documents: [...(prev.documents ?? []), ...uploaded] } : prev);
        } catch (err) {
            console.error("[project-chat] upload failed:", err);
        } finally {
            setUploading(false);
        }
    }

    const handleCreateFolder = async (parentId: string | null, name: string) => {
        const folder = await createProjectFolder(projectId, name, parentId ?? undefined);
        setProject((prev) => prev ? { ...prev, folders: [...(prev.folders ?? []), folder] } : prev);
    };

    const handleRenameFolder = async (folderId: string, name: string) => {
        await renameProjectFolder(projectId, folderId, name);
        setProject((prev) =>
            prev ? { ...prev, folders: (prev.folders ?? []).map((f) => f.id === folderId ? { ...f, name } : f) } : prev,
        );
    };

    const handleDeleteFolder = async (folderId: string) => {
        const toDelete = new Set<string>();
        function collectIds(id: string) {
            toDelete.add(id);
            (project?.folders ?? []).filter((f) => f.parent_folder_id === id).forEach((f) => collectIds(f.id));
        }
        collectIds(folderId);
        await deleteProjectFolder(projectId, folderId);
        setProject((prev) =>
            prev ? {
                ...prev,
                folders: (prev.folders ?? []).filter((f) => !toDelete.has(f.id)),
                documents: (prev.documents ?? []).map((d) =>
                    d.folder_id && toDelete.has(d.folder_id) ? { ...d, folder_id: null } : d,
                ),
            } : prev,
        );
    };

    const handleMoveDoc = async (docId: string, targetFolderId: string | null) => {
        setProject((prev) =>
            prev ? { ...prev, documents: (prev.documents ?? []).map((d) => d.id === docId ? { ...d, folder_id: targetFolderId } : d) } : prev,
        );
        await moveDocumentToFolder(projectId, docId, targetFolderId);
    };

    const handleMoveFolder = async (folderId: string, targetFolderId: string | null) => {
        setProject((prev) =>
            prev ? { ...prev, folders: (prev.folders ?? []).map((f) => f.id === folderId ? { ...f, parent_folder_id: targetFolderId } : f) } : prev,
        );
        await moveSubfolderToFolder(projectId, folderId, targetFolderId);
    };

    const handleDeleteDoc = async (docId: string) => {
        await deleteDocument(docId);
        setProject((prev) => prev ? { ...prev, documents: (prev.documents ?? []).filter((d) => d.id !== docId) } : prev);
        onTabDocDeleted?.(docId);
    };

    return {
        uploading,
        uploadFiles,
        handleCreateFolder,
        handleRenameFolder,
        handleDeleteFolder,
        handleMoveDoc,
        handleMoveFolder,
        handleDeleteDoc,
    };
}
