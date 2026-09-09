"use client";

import { useState, useRef, useEffect } from "react";
import { MoreHorizontal, Pencil, Trash2, Check, X, Users } from "lucide-react";
import {
    DropdownMenu,
    DropdownMenuTrigger,
} from "@/app/components/ui/dropdown-menu";
import {
    LiquidDropdownContent,
    LiquidDropdownItem,
} from "@/app/components/ui/liquid-dropdown";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import { PermissionDeniedPopup } from "@/app/components/popups/PermissionDeniedPopup";
import { WarningPopup } from "@/app/components/popups/WarningPopup";
import { can, roleFrom } from "@/app/lib/permissions";
import { userFacingApiError } from "@/app/lib/userFacingError";
import type { Chat } from "@/app/components/shared/types";
import { ChatSkeuoIcon } from "@/app/components/shared/AppSidebarSkeuoIcons";
import { ChatAccessModal } from "@/app/components/assistant/ChatAccessModal";
import { cn } from "@/app/lib/utils";
import {
    LIQUID_GLASS_SELECTED_CLASS,
    LIQUID_GLASS_HOVER_CLASS,
    LIQUID_GLASS_SUBTLE_CLASS,
} from "@/app/components/ui/liquid-surface";

interface Props {
    chat: Chat;
    isActive: boolean;
    onSelect: () => void;
    projectName?: string;
}

export function SidebarChatItem({ chat, isActive, onSelect, projectName }: Props) {
    const { renameChat, deleteChat } = useChatHistoryContext();
    const [isRenaming, setIsRenaming] = useState(false);
    const [shareOpen, setShareOpen] = useState(false);
    const [editTitle, setEditTitle] = useState(chat.title ?? "");
    const [gate, setGate] = useState<{
        action: string;
        requiredRole: "owner" | "editor";
    } | null>(null);
    const [deleteError, setDeleteError] = useState<string | null>(null);
    const [renameError, setRenameError] = useState<string | null>(null);
    const editInputRef = useRef<HTMLInputElement>(null);
    // Chats joined the project role ladder: rename is content collaboration
    // (member+, the tier the server's PATCH asks for) and delete sits at the
    // top (the creator — is_owner ⇒ admin via roleFrom — or a project
    // admin). The overview RPC serves BOTH is_owner and access_role on every
    // row — the same verdict its own visibility predicate filtered on — so
    // this gate reflects what the server would actually answer; roleFrom
    // fails closed to viewer when a row carries neither field.
    const role = roleFrom(chat);
    const canRename = can(role, "content.edit");
    const canShare = can(role, "access.manage");
    const canDelete = can(role, "container.delete");
    // One label for the row's tooltip and its accessible name, so the
    // "Shared" marker rendered beside the title is part of both.
    const chatTitle = chat.title ?? "Untitled chat";
    const rowLabel = [
        projectName ? `${projectName}: ${chatTitle}` : chatTitle,
        chat.is_owner === false ? "(Shared)" : null,
    ]
        .filter(Boolean)
        .join(" ");

    useEffect(() => {
        if (isRenaming) editInputRef.current?.focus();
    }, [isRenaming]);

    const handleRenameSave = async () => {
        const trimmed = editTitle.trim();
        setIsRenaming(false);
        if (!trimmed) return;
        try {
            await renameChat(chat.id, trimmed);
        } catch (error) {
            // The context put the old title back; without this the user
            // watches their edit silently revert — the rename twin of the
            // surfaced delete failure below.
            setRenameError(
                userFacingApiError(
                    error,
                    "The chat could not be renamed. Please try again.",
                ),
            );
        }
    };

    const handleRenameCancel = () => {
        setIsRenaming(false);
        setEditTitle(chat.title ?? "");
    };

    return (
        <div
            className={cn(
                "group relative flex h-8 w-full items-center rounded-md transition-colors",
                isActive
                    ? `${LIQUID_GLASS_SELECTED_CLASS} pr-1`
                    : `pr-3 ${LIQUID_GLASS_HOVER_CLASS} hover:pr-1`,
            )}
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
                        className={`flex-1 rounded px-1 py-0.5 text-sm ${LIQUID_GLASS_SUBTLE_CLASS} focus:outline-none focus:ring-1 focus:ring-blue-500`}
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
                    <ChatSkeuoIcon className="ml-2.5 h-3.5 w-3.5 shrink-0" />
                    <button
                        type="button"
                        onClick={onSelect}
                        onMouseEnter={(e) => {
                            const el = e.currentTarget;
                            const overflow = el.scrollWidth - el.clientWidth;
                            if (overflow > 0) el.scrollTo({ left: overflow, behavior: "smooth" });
                        }}
                        onMouseLeave={(e) => {
                            e.currentTarget.scrollTo({ left: 0, behavior: "smooth" });
                        }}
                        className={cn(
                            "min-w-0 flex-1 overflow-x-hidden whitespace-nowrap scrollbar-none py-1 pl-2 text-left text-xs",
                            isActive
                                ? "pr-3 text-gray-900"
                                : "pr-0 text-gray-700 group-hover:pr-3",
                        )}
                        // The "Shared" marker sits in a SIBLING element, so
                        // neither the tooltip nor the accessible name of this
                        // row carried it: a screen-reader user heard exactly
                        // what the owner of the thread hears. It belongs in
                        // both.
                        title={rowLabel}
                        aria-label={rowLabel}
                    >
                        {projectName && (
                            <span className="text-gray-400 font-normal">{projectName}: </span>
                        )}
                        {chat.title ?? "Untitled chat"}
                    </button>

                    {/* Somebody else's thread. get_chats_overview now lists
                        colleagues' organization-project chats alongside the
                        caller's own, and nothing in the row said which was
                        which — the same list, the same weight, so a rename
                        or a delete could land on a colleague's work by
                        mistake. Plain text, not a pill: this is an
                        informational label (AGENTS.md).

                        Strictly `=== false`: a row that carries no is_owner
                        at all has told us nothing, and marking it "Shared"
                        would be a claim we cannot make. */}
                    {chat.is_owner === false && (
                        // `text-[10px] text-gray-400` measured about 2.6:1 —
                        // below the 4.5:1 the accessibility baseline requires,
                        // on the one word in the row that says whose work this
                        // is. text-xs on the muted gray that does meet it.
                        <span className="mr-1 shrink-0 text-xs text-gray-500">
                            Shared
                        </span>
                    )}

                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <button
                                type="button"
                                aria-label={`Actions for ${chat.title ?? "Untitled chat"}`}
                                className={`flex h-6 w-0 shrink-0 items-center justify-center overflow-hidden rounded-md bg-transparent text-gray-500 opacity-0 transition-opacity hover:text-gray-900 ${
                                    isActive
                                        ? "w-6 opacity-100"
                                        : "pointer-events-none group-hover:w-6 group-hover:pointer-events-auto group-hover:opacity-100"
                                }`}
                            >
                                <MoreHorizontal className="h-4 w-4" />
                            </button>
                        </DropdownMenuTrigger>
                        <LiquidDropdownContent align="end" className="z-101">
                            <LiquidDropdownItem
                                onSelect={() => {
                                    if (!canShare) {
                                        setGate({
                                            action: "share this chat",
                                            requiredRole: "owner",
                                        });
                                        return;
                                    }
                                    setShareOpen(true);
                                }}
                            >
                                <Users className="mr-2 h-4 w-4" />
                                Share
                            </LiquidDropdownItem>
                            <LiquidDropdownItem
                                onSelect={() => {
                                    if (!canRename) {
                                        setGate({
                                            action: "rename this chat",
                                            requiredRole: "editor",
                                        });
                                        return;
                                    }
                                    setEditTitle(chat.title ?? "");
                                    setIsRenaming(true);
                                }}
                            >
                                <Pencil className="mr-2 h-4 w-4" />
                                Rename
                            </LiquidDropdownItem>
                            <LiquidDropdownItem
                                onSelect={() => {
                                    if (!canDelete) {
                                        setGate({
                                            action: "delete this chat",
                                            requiredRole: "owner",
                                        });
                                        return;
                                    }
                                    deleteChat(chat.id).catch((error) => {
                                        setDeleteError(
                                            userFacingApiError(
                                                error,
                                                "The chat could not be deleted. Please try again.",
                                            ),
                                        );
                                    });
                                }}
                                className="text-red-600 focus:text-red-600"
                            >
                                <Trash2 className="mr-2 h-4 w-4" />
                                Delete
                            </LiquidDropdownItem>
                        </LiquidDropdownContent>
                    </DropdownMenu>
                </>
            )}
            {/* TODO(contacts): no `contacts` to pass. The sidebar rows come
                from get_chats_overview and GET /chat/:id serves only
                chat + is_owner + access_role, so no ranked admin list
                reaches a chat surface and the popup's "Ask …" line can never
                render here. Needs the server to return the shape project
                detail already returns as `admin_contacts`. */}
            <PermissionDeniedPopup
                open={!!gate}
                action={gate?.action}
                requiredRole={gate?.requiredRole}
                onClose={() => setGate(null)}
            />
            <WarningPopup
                open={!!deleteError}
                title="Chat not deleted"
                message={deleteError}
                onClose={() => setDeleteError(null)}
            />
            <WarningPopup
                open={!!renameError}
                title="Chat not renamed"
                message={renameError}
                onClose={() => setRenameError(null)}
            />
            {shareOpen ? (
                <ChatAccessModal
                    open={shareOpen}
                    chat={chat}
                    onClose={() => setShareOpen(false)}
                />
            ) : null}
        </div>
    );
}
