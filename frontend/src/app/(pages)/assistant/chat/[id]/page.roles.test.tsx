import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Grant-reachable chats appear in the global sidebar since the parity
// change, so a project viewer can land on this page. GET /chat/:id serves
// the caller's standing; this file pins that the page actually consumes it
// — dropping it handed a viewer a live composer whose sends 403.

const { getChat } = vi.hoisted(() => ({ getChat: vi.fn() }));

vi.mock("next/navigation", () => ({
    useParams: () => ({ id: "chat-1" }),
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/app/lib/mikeApi", () => ({
    getChat: (...args: unknown[]) => getChat(...args),
}));
vi.mock("@/app/contexts/ChatHistoryContext", () => ({
    useChatHistoryContext: () => ({
        setCurrentChatId: vi.fn(),
        newChatMessages: null,
        setNewChatMessages: vi.fn(),
    }),
}));
vi.mock("@/app/hooks/useAssistantChat", () => ({
    useAssistantChat: () => ({
        messages: [],
        isResponseLoading: false,
        handleChat: vi.fn(),
        setMessages: vi.fn(),
        cancel: vi.fn(),
    }),
}));
vi.mock("@/app/components/assistant/ChatView", () => ({
    ChatView: ({
        canSend,
        chat,
    }: {
        canSend?: boolean | null;
        chat?: { access_role?: string } | null;
    }) => (
        <>
            <span data-testid="can-send">{String(canSend)}</span>
            <span data-testid="chat-role">{chat?.access_role ?? "unknown"}</span>
        </>
    ),
}));

import AssistantChatPage from "./page";

function chatDetail(access_role: "owner" | "editor" | "viewer") {
    return {
        chat: {
            id: "chat-1",
            title: "Quarterly filing",
            model: null,
            reasoning_level: null,
            is_owner: false,
            access_role,
        },
        messages: [{ id: "m1", role: "user", content: "hi" }],
    };
}

beforeEach(() => {
    vi.clearAllMocks();
});

describe("global chat page composer gating", () => {
    it("hands a project viewer a read-only composer", async () => {
        getChat.mockResolvedValue(chatDetail("viewer"));
        render(<AssistantChatPage />);
        await waitFor(() =>
            expect(screen.getByTestId("can-send")).toHaveTextContent("false"),
        );
        expect(screen.getByTestId("chat-role")).toHaveTextContent("viewer");
    });

    it("keeps the composer live for a role the server lets write", async () => {
        getChat.mockResolvedValue(chatDetail("editor"));
        render(<AssistantChatPage />);
        await waitFor(() =>
            expect(screen.getByTestId("can-send")).toHaveTextContent("true"),
        );
        expect(screen.getByTestId("chat-role")).toHaveTextContent("editor");
    });

    it("says 'not known yet' rather than 'viewing only' while getChat is in flight", async () => {
        // Every cold load starts with no initialMessages, so the old
        // `useState(initialMessages.length > 0)` opened at FALSE — and a
        // chat's own owner was told "Viewing only — sending needs edit
        // access" until the fetch landed. null is the third answer: still
        // fail-closed (ChatInput disables on it), but it asserts nothing
        // about the caller's access.
        let settle!: (value: ReturnType<typeof chatDetail>) => void;
        getChat.mockReturnValue(
            new Promise((resolve) => {
                settle = resolve;
            }),
        );

        render(<AssistantChatPage />);

        expect(screen.getByTestId("can-send")).toHaveTextContent("null");

        await act(async () => {
            settle(chatDetail("owner"));
        });
        await waitFor(() =>
            expect(screen.getByTestId("can-send")).toHaveTextContent("true"),
        );
    });

    it("stays fail-closed when getChat never answers", async () => {
        getChat.mockRejectedValue(new Error("boom"));
        render(<AssistantChatPage />);

        await waitFor(() => expect(getChat).toHaveBeenCalled());
        // null, not true: an unknown standing is never a licence.
        expect(screen.getByTestId("can-send")).not.toHaveTextContent("true");
    });
});
