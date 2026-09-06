import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Chat } from "@/app/components/shared/types";
import { ProjectAssistantTable } from "./ProjectAssistantTable";

// Owner rows: deleting is `container.delete`, which the table now checks
// before it offers the confirmation, so a row with no served role would be
// refused here rather than reaching the handler.
const chats: Chat[] = [
    {
        id: "chat-1",
        project_id: "project-1",
        user_id: "user-1",
        title: "First chat",
        created_at: "2026-08-27T00:00:00.000Z",
        access_role: "owner",
    },
    {
        id: "chat-2",
        project_id: "project-1",
        user_id: "user-1",
        title: "Second chat",
        created_at: "2026-08-27T00:00:00.000Z",
        access_role: "owner",
    },
];

function renderTable(selectedChatIds: string[]) {
    const onDeleteChat = vi.fn();
    const onDeleteSelectedChats = vi.fn();
    const onOpenChat = vi.fn();
    const setSelectedChatIds = vi.fn();
    render(
        <ProjectAssistantTable
            chats={chats}
            filteredChats={chats}
            selectedChatIds={selectedChatIds}
            allChatsSelected={selectedChatIds.length === chats.length}
            someChatsSelected={selectedChatIds.length > 0}
            renamingChatId={null}
            renameChatValue=""
            currentUserId="user-1"
            onCreateChat={vi.fn()}
            onOpenChat={onOpenChat}
            onDeleteChat={onDeleteChat}
            onDeleteSelectedChats={onDeleteSelectedChats}
            onOwnerOnlyAction={vi.fn()}
            submitChatRename={vi.fn()}
            setSelectedChatIds={setSelectedChatIds}
            setRenamingChatId={vi.fn()}
            setRenameChatValue={vi.fn()}
        />,
    );
    return {
        onDeleteChat,
        onDeleteSelectedChats,
        onOpenChat,
        setSelectedChatIds,
    };
}

describe("ProjectAssistantTable row context actions", () => {
    it("deletes the whole selection when right-clicking a selected row", async () => {
        const user = userEvent.setup();
        const { onDeleteChat, onDeleteSelectedChats } = renderTable([
            "chat-1",
            "chat-2",
        ]);

        fireEvent.contextMenu(screen.getByText("First chat"));
        expect(screen.queryByRole("button", { name: "Rename" })).toBeNull();
        expect(screen.queryByRole("button", { name: "View" })).toBeNull();
        await user.click(screen.getByRole("button", { name: "Delete 2 chats" }));

        expect(onDeleteSelectedChats).toHaveBeenCalledOnce();
        expect(onDeleteChat).not.toHaveBeenCalled();
    });

    it("targets only an unselected row", async () => {
        const user = userEvent.setup();
        const { onDeleteChat, onDeleteSelectedChats } = renderTable(["chat-2"]);

        fireEvent.contextMenu(screen.getByText("First chat"));
        await user.click(screen.getByRole("button", { name: "Delete" }));
        // The single-row delete is confirmed first; the bulk one is confirmed
        // by the page that owns the selection.
        await user.click(screen.getByRole("button", { name: "Delete" }));

        expect(onDeleteChat).toHaveBeenCalledWith(chats[0]);
        expect(onDeleteSelectedChats).not.toHaveBeenCalled();
    });

    it("views a single row from its right-click menu", async () => {
        const user = userEvent.setup();
        const { onOpenChat } = renderTable([]);

        fireEvent.contextMenu(screen.getByText("First chat"));
        await user.click(screen.getByRole("button", { name: "View" }));

        expect(onOpenChat).toHaveBeenCalledWith("chat-1");
    });

    it("opens on click and adds one row on command/control-click", () => {
        const { onOpenChat, setSelectedChatIds } = renderTable(["chat-2"]);
        const rowLabel = screen.getByText("First chat");

        fireEvent.click(rowLabel);
        expect(onOpenChat).toHaveBeenCalledWith("chat-1");
        expect(setSelectedChatIds).not.toHaveBeenCalled();

        for (const modifier of [{ metaKey: true }, { ctrlKey: true }]) {
            onOpenChat.mockClear();
            setSelectedChatIds.mockClear();
            fireEvent.click(rowLabel, modifier);
            const update = setSelectedChatIds.mock.calls[0]?.[0] as (
                current: string[],
            ) => string[];

            expect(update(["chat-2"])).toEqual(["chat-2", "chat-1"]);
        }
        expect(onOpenChat).not.toHaveBeenCalled();
    });

    it("selects the inclusive range between shift-clicked rows", () => {
        const { onOpenChat, setSelectedChatIds } = renderTable([]);

        fireEvent.click(screen.getByText("First chat"), { shiftKey: true });
        fireEvent.click(screen.getByText("Second chat"), { shiftKey: true });

        const firstUpdate = setSelectedChatIds.mock.calls[0]?.[0] as (
            current: string[],
        ) => string[];
        const secondUpdate = setSelectedChatIds.mock.calls[1]?.[0] as (
            current: string[],
        ) => string[];
        const firstSelection = firstUpdate([]);

        expect(firstSelection).toEqual(["chat-1"]);
        expect(secondUpdate(firstSelection)).toEqual(["chat-1", "chat-2"]);
        expect(onOpenChat).not.toHaveBeenCalled();
    });
});
