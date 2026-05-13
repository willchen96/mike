"use client";

import { useState, useRef, useEffect } from "react";
import { MoreHorizontal, Pencil, Trash2, Check, X } from "lucide-react";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import { useAuth } from "@/contexts/AuthContext";
import { OwnerOnlyModal } from "@/app/components/shared/OwnerOnlyModal";
import type { MikeChat } from "@/app/components/shared/types";
import { useTranslations } from "next-intl";

interface Props {
    chat: MikeChat;
    isActive: boolean;
    onSelect: () => void;
    projectName?: string;
}

export function SidebarChatItem({ chat, isActive, onSelect, projectName }: Props) {
    const { renameChat, deleteChat } = useChatHistoryContext();
    const { user } = useAuth();
    const t = useTranslations("assistant");
    const [isRenaming, setIsRenaming] = useState(false);
    const [editTitle, setEditTitle] = useState(chat.title ?? "");
    const [ownerOnlyAction, setOwnerOnlyAction] = useState<string | null>(null);
    const editInputRef = useRef<HTMLInputElement>(null);
    // Sidebar can show collaborator chats from projects the user owns;
    // rename/delete are still creator-only on the backend, so guard here.
    const isChatOwner = !!user?.id && chat.user_id === user.id;

    useEffect(() => {
        if (isRenaming) editInputRef.current?.focus();
    }, [isRenaming]);

    const handleRenameSave = async () => {
        const trimmed = editTitle.trim();
        if (trimmed) await renameChat(chat.id, trimmed);
        setIsRenaming(false);
    };

    const handleRenameCancel = () => {
        setIsRenaming(false);
        setEditTitle(chat.title ?? "");
    };

    return (
        <div
            className={`group relative flex items-center w-full h-9 rounded-md transition-colors ${
                isActive ? "bg-gray-100" : "hover:bg-gray-100"
            }`}
        >
            {isRenaming ? (
                <div className="flex items-center w-full px-2 py-1">
                    <input
                        ref={editInputRef}
                        type="text"
                        value={editTitle}
                        onChange={(e) => setEditTitle(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter") void handleRenameSave();
                            if (e.key === "Escape") handleRenameCancel();
                        }}
                        className="flex-1 bg-white shadow-inner rounded px-1 py-0.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
                    />
                    <button
                        onClick={() => void handleRenameSave()}
                        className="ml-1.5 py-2 hover:bg-gray-200 rounded text-green-600"
                    >
                        <Check className="h-3 w-3" />
                    </button>
                    <button
                        onClick={handleRenameCancel}
                        className="ml-1 py-2 hover:bg-gray-200 rounded text-red-600"
                    >
                        <X className="h-3 w-3" />
                    </button>
                </div>
            ) : (
                <>
                    <button
                        onClick={onSelect}
                        onMouseEnter={(e) => {
                            const el = e.currentTarget;
                            const overflow = el.scrollWidth - el.clientWidth;
                            if (overflow > 0) el.scrollTo({ left: overflow, behavior: "smooth" });
                        }}
                        onMouseLeave={(e) => {
                            e.currentTarget.scrollTo({ left: 0, behavior: "smooth" });
                        }}
                        className={`flex-1 min-w-0 text-left px-3 py-2 text-xs overflow-x-hidden whitespace-nowrap scrollbar-none ${
                            isActive ? "text-gray-900" : "text-gray-700"
                        }`}
                        title={projectName ? `${projectName}: ${chat.title ?? t("conversaSemTitulo")}` : (chat.title ?? t("conversaSemTitulo"))}
                    >
                        {projectName && (
                            <span className="text-gray-400 font-normal">{projectName}: </span>
                        )}
                        {chat.title ?? t("conversaSemTitulo")}
                    </button>

                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <button
                                className={`p-1 mr-1 text-gray-500 transition-opacity hover:text-gray-900 ${
                                    isActive
                                        ? "opacity-100"
                                        : "opacity-0 group-hover:opacity-100"
                                }`}
                            >
                                <MoreHorizontal className="h-4 w-4" />
                            </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="z-101">
                            <DropdownMenuItem
                                onClick={() => {
                                    if (!isChatOwner) {
                                        setOwnerOnlyAction(t("renomearConversa"));
                                        return;
                                    }
                                    setEditTitle(chat.title ?? "");
                                    setIsRenaming(true);
                                }}
                            >
                                <Pencil className="mr-2 h-4 w-4" />
                                {t("renomear")}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                                onClick={() => {
                                    if (!isChatOwner) {
                                        setOwnerOnlyAction(t("excluirConversa"));
                                        return;
                                    }
                                    void deleteChat(chat.id);
                                }}
                                className="text-red-600 focus:text-red-600"
                            >
                                <Trash2 className="mr-2 h-4 w-4" />
                                {t("excluir")}
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                </>
            )}
            <OwnerOnlyModal
                open={!!ownerOnlyAction}
                action={ownerOnlyAction ?? undefined}
                onClose={() => setOwnerOnlyAction(null)}
            />
        </div>
    );
}
