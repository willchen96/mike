import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Suspense, type ReactNode } from "react";
import { MikeApiError } from "@/app/lib/mikeApi";
import ProjectAssistantChatPage from "./page";

// What this file pins, for a chat that lives INSIDE a project:
//
//   1. Who is offered what. The server derives the caller's whole standing
//      here from the project role (ensureSharedRowAccess): delete needs
//      container.delete, rename and send need content.edit. The page used to
//      add "…or I created this chat", which disagreed with the server in both
//      directions — an editor who started the thread was offered a Delete that
//      came back 403, a project owner who did not start it was refused one the
//      server accepts, and a demoted viewer kept a live composer on their own
//      old threads.
//   2. That a refused rename or delete is SAID. ChatHistoryContext rethrows;
//      the page awaited both with no catch, so the refusal became an unhandled
//      rejection and the user saw a header title that had changed, a sidebar
//      that snapped back, and no explanation.

const {
    deleteChat,
    getChat,
    getProject,
    renameChatInHistory,
    push,
} = vi.hoisted(() => ({
    deleteChat: vi.fn(),
    getChat: vi.fn(),
    getProject: vi.fn(),
    renameChatInHistory: vi.fn(),
    push: vi.fn(),
}));

// importOriginal so MikeApiError stays the real class — userFacingApiError
// decides whether to show the server's own message with an `instanceof` test.
vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
    deleteChat: (...args: unknown[]) => deleteChat(...args),
    getChat: (...args: unknown[]) => getChat(...args),
    getProject: (...args: unknown[]) => getProject(...args),
    deleteDocument: vi.fn(),
    uploadProjectDocuments: vi.fn(),
    createProjectFolder: vi.fn(),
    renameProjectFolder: vi.fn(),
    deleteProjectFolder: vi.fn(),
    moveDocumentToFolder: vi.fn(),
    moveSubfolderToFolder: vi.fn(),
}));

vi.mock("next/navigation", () => ({
    useRouter: () => ({ push, replace: vi.fn() }),
}));

vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({ user: { id: "creator", email: "creator@example.com" } }),
}));
vi.mock("@/app/contexts/UserProfileContext", () => ({
    useUserProfile: () => ({ profile: null }),
}));
vi.mock("@/app/contexts/SidebarContext", () => ({
    useSidebar: () => ({ setSidebarOpen: vi.fn() }),
}));
vi.mock("@/app/contexts/ChatHistoryContext", () => ({
    useChatHistoryContext: () => ({
        setCurrentChatId: vi.fn(),
        newChatMessages: null,
        setNewChatMessages: vi.fn(),
        chats: [],
        saveChat: vi.fn(),
        renameChat: renameChatInHistory,
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

// Heavy children reduced to the one fact each test needs.
vi.mock("@/app/components/assistant/ChatInput", () => ({
    ChatInput: ({ canSend }: { canSend?: boolean | null }) => (
        <div data-testid="can-send">{String(canSend)}</div>
    ),
}));
vi.mock("@/app/components/assistant/UserMessage", () => ({
    UserMessage: () => null,
}));
vi.mock("@/app/components/assistant/AssistantMessage", () => ({
    AssistantMessage: () => null,
}));
vi.mock("@/app/components/projects/ProjectExplorer", () => ({
    ProjectExplorer: () => null,
}));
vi.mock("@/app/components/shared/views/PdfView", () => ({ PdfView: () => null }));
vi.mock("@/app/components/shared/views/SpreadsheetView", () => ({
    SpreadsheetView: () => null,
}));
vi.mock("@/app/components/shared/views/DocxView", () => ({
    DocxView: () => null,
}));
vi.mock("@/app/components/chat/mike-icon", () => ({ MikeIcon: () => null }));

// PageHeader renders its custom actions; HeaderActionsMenu is flattened to
// plain buttons so the test can drive the page's handlers without Radix.
vi.mock("@/app/components/shared/PageHeader", () => ({
    PageHeader: ({
        actions,
    }: {
        actions?: ({ type?: string; render?: ReactNode } | null | false)[];
    }) => (
        <div>
            {(actions ?? []).map((action, index) =>
                action && action.type === "custom" ? (
                    <div key={index}>{action.render}</div>
                ) : null,
            )}
        </div>
    ),
}));
vi.mock("@/app/components/shared/HeaderActionsMenu", () => ({
    HeaderActionsMenu: ({
        items,
    }: {
        items: { label: string; onSelect: () => void; disabled?: boolean }[];
    }) => (
        <div>
            {items.map((item) => (
                <button
                    key={item.label}
                    type="button"
                    disabled={item.disabled}
                    onClick={item.onSelect}
                >
                    {item.label}
                </button>
            ))}
        </div>
    ),
}));

/** The project payload GET /projects/:id serves the caller. */
function project(access_role: "owner" | "editor" | "viewer") {
    return {
        id: "p1",
        name: "Matter",
        access_role,
        is_owner: access_role === "owner",
        documents: [],
        folders: [],
    };
}

/**
 * The chat detail. `user_id` is the CREATOR — deliberately the signed-in
 * user in most cases here, because the creator arm is exactly what these
 * tests prove is no longer consulted.
 */
function chatDetail(userId = "creator") {
    return {
        chat: {
            id: "c1",
            project_id: "p1",
            user_id: userId,
            title: "Quarterly filing",
            model: null,
            reasoning_level: null,
        },
        messages: [{ id: "m1", role: "user", content: "hi" }],
    };
}

// The page reads its route params with React's `use()`, which suspends until
// the promise settles — so it needs a boundary and a first await.
async function renderPage() {
    await act(async () => {
        render(
            <Suspense fallback={null}>
                <ProjectAssistantChatPage
                    params={Promise.resolve({ id: "p1", chatId: "c1" })}
                />
            </Suspense>,
        );
    });
    await screen.findByText("Rename");
}

beforeEach(() => {
    vi.clearAllMocks();
    deleteChat.mockResolvedValue(undefined);
    renameChatInHistory.mockResolvedValue(undefined);
    getChat.mockResolvedValue(chatDetail());
    vi.spyOn(window, "prompt").mockReturnValue("Renamed thread");
});

describe("project chat page — the project ladder, not the creator", () => {
    it("refuses an editor the delete of a chat they created themselves", async () => {
        // The headline reversal. content.edit does not reach
        // container.delete, and the server would answer 403 — so the client
        // must not fire the request at all.
        getProject.mockResolvedValue(project("editor"));
        await renderPage();
        await waitFor(() =>
            expect(screen.getByTestId("can-send")).toHaveTextContent("true"),
        );

        fireEvent.click(screen.getByRole("button", { name: "Delete" }));

        await screen.findByText("Owner-only action");
        expect(deleteChat).not.toHaveBeenCalled();
    });

    it("lets a project owner delete a colleague's chat", async () => {
        // The other direction: the sidebar already offers this delete and the
        // server accepts it, but the page refused it as "owner-only" because
        // the caller did not start the thread.
        getProject.mockResolvedValue(project("owner"));
        getChat.mockResolvedValue(chatDetail("someone-else"));
        await renderPage();

        fireEvent.click(screen.getByRole("button", { name: "Delete" }));

        await waitFor(() => expect(deleteChat).toHaveBeenCalledWith("c1"));
        expect(screen.queryByText("Owner-only action")).not.toBeInTheDocument();
    });

    it("hands a demoted viewer a read-only composer on their own chat", async () => {
        // Creating a thread does not outrank being demoted to viewer.
        getProject.mockResolvedValue(project("viewer"));
        await renderPage();

        await waitFor(() =>
            expect(screen.getByTestId("can-send")).toHaveTextContent("false"),
        );
    });

    it("refuses a viewer's rename at the editor tier, not the owner one", async () => {
        getProject.mockResolvedValue(project("viewer"));
        await renderPage();

        fireEvent.click(screen.getByRole("button", { name: "Rename" }));

        expect(await screen.findByText("Editors only")).toBeInTheDocument();
        expect(renameChatInHistory).not.toHaveBeenCalled();
        expect(window.prompt).not.toHaveBeenCalled();
    });

    it("raises no refusal while the project role is still unknown", async () => {
        // `roleFromLoaded(null)` is "not known", not "not allowed". Telling
        // somebody they lack a role before the payload lands is a guess.
        getProject.mockReturnValue(new Promise(() => {}));
        await renderPage();

        fireEvent.click(screen.getByRole("button", { name: "Delete" }));

        await waitFor(() => expect(deleteChat).not.toHaveBeenCalled());
        expect(screen.queryByText("Owner-only action")).not.toBeInTheDocument();
    });

    it("disables Rename and Delete while the project role is unknown", async () => {
        // Silence was the right answer to "should we accuse them?" and the
        // wrong one to "what does this menu item do?": clicking did nothing,
        // with no refusal and no disabled state, which reads as broken.
        getProject.mockReturnValue(new Promise(() => {}));
        await renderPage();

        expect(screen.getByRole("button", { name: "Rename" })).toBeDisabled();
        expect(screen.getByRole("button", { name: "Delete" })).toBeDisabled();
    });

    it("re-enables them once the role arrives", async () => {
        getProject.mockResolvedValue(project("owner"));
        await renderPage();

        await waitFor(() =>
            expect(
                screen.getByRole("button", { name: "Rename" }),
            ).toBeEnabled(),
        );
        expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled();
    });

    it("says nothing about sending until the project role is known", async () => {
        // `false` here is an accusation — the composer reads "Viewing only".
        // A project owner opening their own chat cold was told that for the
        // length of the project fetch.
        getProject.mockReturnValue(new Promise(() => {}));
        await renderPage();

        expect(screen.getByTestId("can-send")).toHaveTextContent("null");
    });
});

describe("project chat page — refused mutations are surfaced", () => {
    it("tells the user when a delete is refused", async () => {
        getProject.mockResolvedValue(project("owner"));
        deleteChat.mockRejectedValue(
            new MikeApiError({
                message: "You do not have permission to delete this chat",
                status: 403,
            }),
        );
        await renderPage();

        fireEvent.click(screen.getByRole("button", { name: "Delete" }));

        expect(await screen.findByText("Chat not deleted")).toBeInTheDocument();
        // The server's own 4xx wording, not a generic fallback.
        expect(
            screen.getByText("You do not have permission to delete this chat"),
        ).toBeInTheDocument();
        expect(push).not.toHaveBeenCalled();
    });

    it("puts the header title back when a rename is refused, and says so", async () => {
        getProject.mockResolvedValue(project("owner"));
        renameChatInHistory.mockRejectedValue(
            new MikeApiError({
                message: "You do not have permission to rename this chat",
                status: 403,
            }),
        );
        await renderPage();

        fireEvent.click(screen.getByRole("button", { name: "Rename" }));

        expect(await screen.findByText("Chat not renamed")).toBeInTheDocument();
        expect(
            screen.getByText("You do not have permission to rename this chat"),
        ).toBeInTheDocument();
    });

    it("falls back to generic wording for a non-4xx delete failure", async () => {
        getProject.mockResolvedValue(project("owner"));
        deleteChat.mockRejectedValue(new Error("network"));
        await renderPage();

        fireEvent.click(screen.getByRole("button", { name: "Delete" }));

        expect(
            await screen.findByText(
                "The chat could not be deleted. Please try again.",
            ),
        ).toBeInTheDocument();
    });
});
