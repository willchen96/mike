"use client";

import {
    useMemo,
    useRef,
    useState,
    type Dispatch,
    type SetStateAction,
} from "react";
import {
    RowActionMenuItems,
    RowActions,
} from "@/app/components/shared/RowActions";
import {
    TABLE_CHECKBOX_CLASS,
    SkeletonCheckbox,
    SkeletonLine,
    TableBody,
    TableCell,
    TableEmptyState,
    TableFilters,
    type TableFilterOption,
    TableHeaderCell,
    TableHeaderRow,
    TablePrimaryCell,
    TableRow,
    TableScrollArea,
    rowActionSelectionIds,
    selectedIdsAfterRangeClick,
    selectedIdsAfterShiftClick,
    type TableSortDirection,
    TableStickyCell,
} from "@/app/components/shared/TablePrimitive";
import { ConfirmPopup } from "@/app/components/popups/ConfirmPopup";
import { EmptyState } from "@/app/components/ui/empty-state";
import { PillButton } from "@/app/components/ui/pill-button";
import { ChatSkeuoIcon } from "@/app/components/shared/AppSidebarSkeuoIcons";
import type { Chat } from "@/app/components/shared/types";
import { can, roleFrom } from "@/app/lib/permissions";
import type { OwnerGate } from "./ProjectWorkspace";
import { formatDate } from "./ProjectPageParts";

function creatorLabel(chat: Chat, currentUserId?: string | null) {
    if (currentUserId && chat.user_id === currentUserId) return "Me";
    return chat.creator_display_name?.trim() || "Shared";
}

type ProjectChatSortKey = "name" | "created";

const SORT_OPTIONS: TableFilterOption<TableSortDirection>[] = [
    { value: "asc", label: "Ascending" },
    { value: "desc", label: "Descending" },
];

export function ProjectAssistantTable({
    chats,
    filteredChats,
    selectedChatIds,
    renamingChatId,
    renameChatValue,
    currentUserId,
    onCreateChat,
    onOpenChat,
    onDeleteChat,
    onDeleteSelectedChats,
    onOwnerOnlyAction,
    submitChatRename,
    setSelectedChatIds,
    setRenamingChatId,
    setRenameChatValue,
    loading = false,
}: {
    chats: Chat[];
    filteredChats: Chat[];
    selectedChatIds: string[];
    allChatsSelected: boolean;
    someChatsSelected: boolean;
    renamingChatId: string | null;
    renameChatValue: string;
    currentUserId?: string | null;
    onCreateChat: () => void;
    onOpenChat: (chatId: string) => void;
    onDeleteChat: (chat: Chat) => Promise<void> | void;
    onDeleteSelectedChats: () => Promise<void> | void;
    onOwnerOnlyAction: (action: OwnerGate) => void;
    submitChatRename: (chatId: string) => Promise<void> | void;
    setSelectedChatIds: Dispatch<SetStateAction<string[]>>;
    setRenamingChatId: Dispatch<SetStateAction<string | null>>;
    setRenameChatValue: Dispatch<SetStateAction<string>>;
    loading?: boolean;
}) {
    const [creatorFilter, setCreatorFilter] = useState<string | null>(null);
    const [sort, setSort] = useState<{
        key: ProjectChatSortKey;
        direction: TableSortDirection;
    } | null>(null);
    const rowSelectionAnchorIdRef = useRef<string | null>(null);
    const [chatPendingDelete, setChatPendingDelete] = useState<Chat | null>(
        null,
    );

    /**
     * Deleting a chat is destructive and irreversible, and a project admin's
     * Delete reaches a colleague's thread — so it is confirmed first, the way
     * every other delete in the app is. The role gate runs BEFORE the
     * confirmation: asking a viewer to confirm a delete the server will refuse
     * is two dialogs for one refusal.
     */
    function requestDeleteChat(chat: Chat) {
        if (!can(roleFrom(chat), "container.delete")) {
            onOwnerOnlyAction("delete this chat");
            return;
        }
        setChatPendingDelete(chat);
    }

    function clearSelection() {
        rowSelectionAnchorIdRef.current = null;
        setSelectedChatIds([]);
    }

    function handleCreatorFilterChange(value: string | null) {
        setCreatorFilter(value);
        clearSelection();
    }

    function handleSortChange(
        key: ProjectChatSortKey,
        direction: TableSortDirection | null,
    ) {
        setSort(direction ? { key, direction } : null);
        clearSelection();
    }

    const creatorOptions = useMemo(
        () =>
            Array.from(
                new Set(chats.map((chat) => creatorLabel(chat, currentUserId))),
            )
                .sort((a, b) => a.localeCompare(b))
                .map((creator) => ({ value: creator, label: creator })),
        [chats, currentUserId],
    );

    const visibleChats = useMemo(() => {
        const rows = filteredChats.filter(
            (chat) =>
                !creatorFilter ||
                creatorLabel(chat, currentUserId) === creatorFilter,
        );
        if (!sort) return rows;

        return [...rows].sort((a, b) => {
            const multiplier = sort.direction === "asc" ? 1 : -1;
            if (sort.key === "created") {
                return (
                    (new Date(a.created_at).getTime() -
                        new Date(b.created_at).getTime()) *
                    multiplier
                );
            }

            return (
                (a.title ?? "Untitled Chat").localeCompare(
                    b.title ?? "Untitled Chat",
                ) * multiplier
            );
        });
    }, [creatorFilter, currentUserId, filteredChats, sort]);

    const allVisibleChatsSelected =
        visibleChats.length > 0 &&
        visibleChats.every((chat) => selectedChatIds.includes(chat.id));
    const someVisibleChatsSelected =
        !allVisibleChatsSelected &&
        visibleChats.some((chat) => selectedChatIds.includes(chat.id));
    const nameSortDirection = sort?.key === "name" ? sort.direction : null;
    const createdSortDirection =
        sort?.key === "created" ? sort.direction : null;
    const nameFilterButton = (
        <TableFilters
            label="Sort by chat name"
            value={nameSortDirection}
            allLabel="Default Order"
            widthClassName="w-40"
            align="right"
            options={SORT_OPTIONS}
            onChange={(direction) => handleSortChange("name", direction)}
        />
    );
    const creatorFilterButton = (
        <TableFilters
            label="Filter by creator"
            value={creatorFilter}
            allLabel="All Creators"
            widthClassName="w-44"
            options={creatorOptions}
            onChange={handleCreatorFilterChange}
        />
    );
    const createdFilterButton = (
        <TableFilters
            label="Sort by created date"
            value={createdSortDirection}
            allLabel="Default Order"
            widthClassName="w-40"
            options={SORT_OPTIONS}
            onChange={(direction) => handleSortChange("created", direction)}
        />
    );

    return (
        <>
        <TableScrollArea
            header={
                <TableHeaderRow className="pr-8 md:pr-8">
                    <TableStickyCell header>
                        {loading ? (
                            <SkeletonCheckbox />
                        ) : (
                            <input
                                type="checkbox"
                                checked={allVisibleChatsSelected}
                                ref={(el) => {
                                    if (el)
                                        el.indeterminate =
                                            someVisibleChatsSelected;
                                }}
                                onChange={() => {
                                    rowSelectionAnchorIdRef.current = null;
                                    if (allVisibleChatsSelected)
                                        setSelectedChatIds([]);
                                    else
                                        setSelectedChatIds(
                                            visibleChats.map((c) => c.id),
                                        );
                                }}
                                className={TABLE_CHECKBOX_CLASS}
                            />
                        )}
                        <span className="mr-1">Chats</span>
                        {!loading && nameFilterButton}
                    </TableStickyCell>
                    <TableHeaderCell className="ml-auto w-32">
                        <div className="flex items-center gap-1">
                            <span>Creator</span>
                            {!loading && creatorFilterButton}
                        </div>
                    </TableHeaderCell>
                    <TableHeaderCell className="w-32">
                        <div className="flex items-center gap-1">
                            <span>Created</span>
                            {!loading && createdFilterButton}
                        </div>
                    </TableHeaderCell>
                    <TableHeaderCell className="w-8" />
                </TableHeaderRow>
            }
        >
            {loading ? (
                <ProjectAssistantLoadingRows />
            ) : chats.length === 0 ? (
                <TableEmptyState>
                    <EmptyState
                        icon={<ChatSkeuoIcon />}
                        title="Assistant"
                        description="Ask questions and get answers grounded in the documents in this project."
                        action={
                            <PillButton
                                tone="black"
                                size="sm"
                                onClick={onCreateChat}
                            >
                                Create
                            </PillButton>
                        }
                    />
                </TableEmptyState>
            ) : (
                <TableBody>
                    {visibleChats.map((chat) => {
                        const actionIds = rowActionSelectionIds(
                            chat.id,
                            selectedChatIds,
                        );
                        const appliesToSelection = actionIds.length > 1;
                        return (
                        <TableRow
                            key={chat.id}
                            selected={selectedChatIds.includes(chat.id)}
                            rightClickDropdown={(close, menuProps) => (
                                <RowActionMenuItems
                                    onClose={close}
                                    surfaceProps={menuProps}
                                    onView={
                                        appliesToSelection
                                            ? undefined
                                            : () => onOpenChat(chat.id)
                                    }
                                    onRename={
                                        appliesToSelection
                                            ? undefined
                                            : () => {
                                                  // Renaming is content.edit
                                                  // (member+) judged on the
                                                  // SERVED role, not on "did
                                                  // I create this row": a
                                                  // project admin renames a
                                                  // colleague's chat, and a
                                                  // viewer cannot rename one
                                                  // they may only read.
                                                  if (
                                                      !can(
                                                          roleFrom(chat),
                                                          "content.edit",
                                                      )
                                                  ) {
                                                      onOwnerOnlyAction({
                                                          action: "rename this chat",
                                                          requiredRole:
                                                              "editor",
                                                      });
                                                      return;
                                                  }
                                                  setRenameChatValue(
                                                      chat.title ??
                                                          "Untitled Chat",
                                                  );
                                                  setRenamingChatId(chat.id);
                                              }
                                    }
                                    onDelete={() =>
                                        appliesToSelection
                                            ? onDeleteSelectedChats()
                                            : requestDeleteChat(chat)
                                    }
                                    deleteLabel={
                                        appliesToSelection
                                            ? `Delete ${actionIds.length} chats`
                                            : undefined
                                    }
                                />
                            )}
                            onClick={(event) => {
                                if (renamingChatId === chat.id) return;
                                if (event.shiftKey) {
                                    event.preventDefault();
                                    const anchorId =
                                        rowSelectionAnchorIdRef.current;
                                    setSelectedChatIds((current) =>
                                        selectedIdsAfterRangeClick(
                                            chat.id,
                                            visibleChats.map(
                                                (visibleChat) => visibleChat.id,
                                            ),
                                            current,
                                            anchorId,
                                        ),
                                    );
                                    rowSelectionAnchorIdRef.current = chat.id;
                                    return;
                                }
                                if (event.ctrlKey || event.metaKey) {
                                    event.preventDefault();
                                    setSelectedChatIds((current) =>
                                        selectedIdsAfterShiftClick(
                                            chat.id,
                                            current,
                                        ),
                                    );
                                    rowSelectionAnchorIdRef.current = chat.id;
                                    return;
                                }
                                onOpenChat(chat.id);
                            }}
                            className="pr-8 md:pr-8"
                        >
                            <TablePrimaryCell
                                selected={selectedChatIds.includes(chat.id)}
                                onSelectionChange={() =>
                                    setSelectedChatIds((prev) => {
                                        rowSelectionAnchorIdRef.current =
                                            chat.id;
                                        return prev.includes(chat.id)
                                            ? prev.filter((x) => x !== chat.id)
                                            : [...prev, chat.id];
                                    })
                                }
                                label={chat.title ?? "Untitled Chat"}
                                editing={renamingChatId === chat.id}
                                editValue={renameChatValue}
                                onEditValueChange={setRenameChatValue}
                                onEditCommit={() =>
                                    void submitChatRename(chat.id)
                                }
                                onEditCancel={() => setRenamingChatId(null)}
                            />
                            <TableCell className="ml-auto w-32">
                                {creatorLabel(chat, currentUserId)}
                            </TableCell>
                            <TableCell className="w-32">
                                {formatDate(chat.created_at)}
                            </TableCell>
                            <div
                                className="w-8 shrink-0 flex justify-end"
                                onClick={(e) => e.stopPropagation()}
                            >
                                <RowActions
                                    onView={() => onOpenChat(chat.id)}
                                    onRename={() => {
                                        // Renaming is content.edit (member+)
                                        // judged on the SERVED role, not on
                                        // "did I create this row": a project
                                        // admin renames a colleague's chat,
                                        // and a viewer cannot rename one they
                                        // may only read.
                                        if (
                                            !can(
                                                roleFrom(chat),
                                                "content.edit",
                                            )
                                        ) {
                                            onOwnerOnlyAction({
                                                action: "rename this chat",
                                                requiredRole: "editor",
                                            });
                                            return;
                                        }
                                        setRenameChatValue(
                                            chat.title ?? "Untitled Chat",
                                        );
                                        setRenamingChatId(chat.id);
                                    }}
                                    onDelete={() => requestDeleteChat(chat)}
                                />
                            </div>
                        </TableRow>
                        );
                    })}
                </TableBody>
            )}
        </TableScrollArea>
        <ConfirmPopup
            open={chatPendingDelete !== null}
            title="Delete chat?"
            message="This cannot be undone."
            confirmLabel="Delete"
            confirmVariant="danger"
            onCancel={() => setChatPendingDelete(null)}
            onConfirm={() => {
                const chat = chatPendingDelete;
                setChatPendingDelete(null);
                if (chat) void onDeleteChat(chat);
            }}
        />
        </>
    );
}

function ProjectAssistantLoadingRows() {
    const titleWidths = ["w-36", "w-40", "w-44", "w-48", "w-52"];

    return (
        <TableBody>
            {[1, 2, 3, 4, 5].map((i) => (
                <TableRow
                    key={i}
                    interactive={false}
                    className="pr-8 md:pr-8"
                >
                    <TableStickyCell hover={false}>
                        <div className="flex min-w-0 items-center">
                            <SkeletonCheckbox />
                            <SkeletonLine
                                className={`h-3.5 ${titleWidths[i - 1]}`}
                            />
                        </div>
                    </TableStickyCell>
                    <TableCell className="ml-auto w-32">
                        <SkeletonLine className="w-16" />
                    </TableCell>
                    <TableCell className="w-32">
                        <SkeletonLine className="w-16" />
                    </TableCell>
                    <TableCell className="w-8" />
                </TableRow>
            ))}
        </TableBody>
    );
}
