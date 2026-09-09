import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarChatItem } from "./SidebarChatItem";
import type { Chat } from "@/app/components/shared/types";

// The live round left this surface as the one place still gating on
// `chat.user_id === user.id` with failures swallowed. These tests pin the
// ladder rules the rest of the stack enforces: rename is member-tier
// (content.edit), delete is admin-tier (container.delete), and a failed
// delete is told to the user instead of silently reappearing on reload.

const renameChat = vi.fn();
const deleteChat = vi.fn();

vi.mock("@/app/contexts/ChatHistoryContext", () => ({
    useChatHistoryContext: () => ({ renameChat, deleteChat }),
}));
vi.mock("@/app/components/assistant/ChatAccessModal", () => ({
    ChatAccessModal: ({ open }: { open: boolean }) =>
        open ? <div>Chat access modal</div> : null,
}));

function chat(overrides: Partial<Chat>): Chat {
    return {
        id: "chat-1",
        title: "Quarterly filing",
        user_id: "someone-else",
        created_at: new Date().toISOString(),
        ...overrides,
    } as Chat;
}

function openMenu() {
    // Radix opens on pointerdown, not click.
    const trigger = screen.getByRole("button", {
        name: "Actions for Quarterly filing",
    });
    fireEvent.pointerDown(
        trigger,
        new MouseEvent("pointerdown", { bubbles: true, cancelable: true }),
    );
    fireEvent.click(trigger);
}

beforeEach(() => {
    vi.clearAllMocks();
    deleteChat.mockResolvedValue(undefined);
});

describe("SidebarChatItem role gates", () => {
    it("opens chat access from an owner's Share action", async () => {
        render(
            <SidebarChatItem
                chat={chat({ is_owner: true })}
                isActive
                onSelect={vi.fn()}
            />,
        );
        openMenu();
        fireEvent.click(await screen.findByText("Share"));

        expect(await screen.findByText("Chat access modal")).toBeInTheDocument();
    });

    it("gates Share for a non-owner", async () => {
        render(
            <SidebarChatItem
                chat={chat({ is_owner: false, access_role: "editor" })}
                isActive
                onSelect={vi.fn()}
            />,
        );
        openMenu();
        fireEvent.click(await screen.findByText("Share"));

        expect(screen.queryByText("Chat access modal")).not.toBeInTheDocument();
        expect(await screen.findByText(/only an owner/i)).toBeInTheDocument();
    });

    it("lets a shared member rename but not delete", async () => {
        render(
            <SidebarChatItem
                chat={chat({ is_owner: false, access_role: "editor" })}
                isActive
                onSelect={vi.fn()}
            />,
        );
        openMenu();
        fireEvent.click(await screen.findByText("Delete"));

        expect(deleteChat).not.toHaveBeenCalled();
        expect(
            await screen.findByText(/only an owner/i),
        ).toBeInTheDocument();
    });

    it("lets the creator delete — is_owner alone derives admin", async () => {
        render(
            <SidebarChatItem
                chat={chat({ is_owner: true })}
                isActive
                onSelect={vi.fn()}
            />,
        );
        openMenu();
        fireEvent.click(await screen.findByText("Delete"));

        expect(deleteChat).toHaveBeenCalledWith("chat-1");
    });

    it("refuses a viewer's rename with the member tier", async () => {
        render(
            <SidebarChatItem
                chat={chat({ is_owner: false, access_role: "viewer" })}
                isActive
                onSelect={vi.fn()}
            />,
        );
        openMenu();
        fireEvent.click(await screen.findByText("Rename"));

        expect(
            await screen.findByText(/only an editor/i),
        ).toBeInTheDocument();
    });

    it("lets a project admin delete a colleague's chat", async () => {
        // The exact shape the overview RPC serves an org/project admin for a
        // thread they did not start: is_owner false, access_role "owner".
        // Before the RPC served access_role, this row fell back to "editor"
        // and the admin was refused a delete the server accepts — the
        // headline widening, unreachable from the sidebar.
        render(
            <SidebarChatItem
                chat={chat({ is_owner: false, access_role: "owner" })}
                isActive
                onSelect={vi.fn()}
            />,
        );
        openMenu();
        fireEvent.click(await screen.findByText("Delete"));

        expect(deleteChat).toHaveBeenCalledWith("chat-1");
    });

    it("fails closed to viewer when a row carries no role fields at all", async () => {
        // A row with neither is_owner nor access_role has told us nothing;
        // offering member-tier affordances on it is how the sidebar ended up
        // offering renames the server refuses. Nothing may be offered.
        render(
            <SidebarChatItem
                chat={chat({})}
                isActive
                onSelect={vi.fn()}
            />,
        );
        openMenu();
        fireEvent.click(await screen.findByText("Rename"));

        expect(renameChat).not.toHaveBeenCalled();
        expect(
            await screen.findByText(/only an editor/i),
        ).toBeInTheDocument();
    });

    it("surfaces a failed rename instead of a silent revert", async () => {
        // The context reloads the list on failure, snapping the title back.
        // Without a popup the user just watches their edit undo itself —
        // the rename twin of the surfaced delete failure below.
        renameChat.mockRejectedValue(new Error("boom"));
        render(
            <SidebarChatItem
                chat={chat({ is_owner: true })}
                isActive
                onSelect={vi.fn()}
            />,
        );
        openMenu();
        fireEvent.click(await screen.findByText("Rename"));
        const input = screen.getByRole("textbox");
        fireEvent.change(input, { target: { value: "New title" } });
        fireEvent.keyDown(input, { key: "Enter" });

        expect(
            await screen.findByText(/could not be renamed/i),
        ).toBeInTheDocument();
    });

    it("marks a colleague's chat as shared", async () => {
        // get_chats_overview now lists colleagues' organization-project chats
        // in the same sidebar list as the caller's own, with nothing in the
        // row telling them apart — so a rename or a delete could land on
        // somebody else's thread by mistake.
        render(
            <SidebarChatItem
                chat={chat({ is_owner: false, access_role: "editor" })}
                isActive
                onSelect={vi.fn()}
            />,
        );

        // Plain text, not a pill badge (AGENTS.md: informational labels are
        // text), at a size and colour that meets the contrast baseline —
        // text-[10px] text-gray-400 measured about 2.6:1.
        const marker = screen.getByText("Shared");
        expect(marker).toHaveClass("text-xs", "text-gray-500");
        // The marker renders in a sibling element, so it reached neither the
        // row's tooltip nor its accessible name: a screen-reader user heard
        // exactly what the thread's owner hears.
        expect(
            screen.getByRole("button", { name: "Quarterly filing (Shared)" }),
        ).toHaveAttribute("title", "Quarterly filing (Shared)");
    });

    it("does not mark the caller's own chat", () => {
        render(
            <SidebarChatItem
                chat={chat({ is_owner: true })}
                isActive
                onSelect={vi.fn()}
            />,
        );

        expect(screen.queryByText("Shared")).not.toBeInTheDocument();
    });

    it("claims nothing about a row that carries no is_owner at all", () => {
        // A row with no ownership field has told us nothing; "Shared" would
        // be a claim we cannot make, the same reason roleFrom fails closed.
        render(
            <SidebarChatItem chat={chat({})} isActive onSelect={vi.fn()} />,
        );

        expect(screen.queryByText("Shared")).not.toBeInTheDocument();
    });

    it("surfaces a failed delete instead of swallowing it", async () => {
        deleteChat.mockRejectedValue(new Error("boom"));
        render(
            <SidebarChatItem
                chat={chat({ is_owner: true })}
                isActive
                onSelect={vi.fn()}
            />,
        );
        openMenu();
        fireEvent.click(await screen.findByText("Delete"));

        expect(
            await screen.findByText(/could not be deleted/i),
        ).toBeInTheDocument();
    });
});
