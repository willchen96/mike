import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Suspense, type ReactNode } from "react";
import type { Chat } from "@/app/components/shared/types";
import { MikeApiError } from "@/app/lib/mikeApi";
import ProjectAssistantPage from "./page";

// What this file pins: WHO the client offers chat deletion to, and what the
// user is told when the server says no. Both were wrong before — the page
// gated on `chat.user_id === user.id` (a project admin was refused a
// colleague's chat, and the copy said "only the chat creator can delete a
// chat", which is not the rule any more) and the bulk path swallowed every
// failure with `.catch(() => {})`, so a 403 was indistinguishable from a
// successful delete until the next reload.

const { deleteChat, renameChat, setOwnerOnlyAction, setProjectChats } =
    vi.hoisted(() => ({
        deleteChat: vi.fn(),
        renameChat: vi.fn(),
        setOwnerOnlyAction: vi.fn(),
        setProjectChats: vi.fn(),
    }));

const chats = vi.hoisted(() => ({ current: [] as Chat[] }));

// importOriginal so MikeApiError stays the real class — userFacingApiError
// decides whether to show the server's message with an `instanceof` test, and
// a stubbed-out class would silently take the generic branch.
vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
    deleteChat: (...args: unknown[]) => deleteChat(...args),
    renameChat: (...args: unknown[]) => renameChat(...args),
}));

vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
    useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({ user: { id: "u1" } }),
}));

vi.mock("@/app/components/projects/ProjectWorkspace", () => ({
    ProjectSectionToolbar: ({ actions }: { actions?: ReactNode }) => (
        <div>{actions}</div>
    ),
    useProjectWorkspace: () => ({
        projectId: "p1",
        projectChats: chats.current,
        setProjectChats,
        ensureProjectChats: vi.fn(async () => chats.current),
        search: "",
        setOwnerOnlyAction,
        createChat: vi.fn(),
    }),
}));

// The table itself is exercised in ProjectAssistantTable.roles.test.tsx; here
// it is a thin harness that lets the test drive the page's handlers directly.
vi.mock("@/app/components/projects/ProjectAssistantTable", () => ({
    ProjectAssistantTable: ({
        chats: rows,
        onDeleteChat,
        setSelectedChatIds,
    }: {
        chats: Chat[];
        onDeleteChat: (chat: Chat) => void;
        setSelectedChatIds: (ids: string[]) => void;
    }) => (
        <div>
            {rows.map((chat) => (
                <button key={chat.id} onClick={() => onDeleteChat(chat)}>
                    {`delete ${chat.id}`}
                </button>
            ))}
            <button onClick={() => setSelectedChatIds(rows.map((r) => r.id))}>
                select all
            </button>
        </div>
    ),
}));

function chat(id: string, overrides: Partial<Chat> = {}): Chat {
    return {
        id,
        project_id: "p1",
        user_id: "u2",
        title: id,
        created_at: "2026-01-01T00:00:00Z",
        ...overrides,
    };
}

// The page reads its route params with React's `use()`, which suspends until
// the promise settles — so it needs a boundary and a first await.
async function renderPage(rows: Chat[]) {
    chats.current = rows;
    let view!: ReturnType<typeof render>;
    await act(async () => {
        view = render(
            <Suspense fallback={null}>
                <ProjectAssistantPage params={Promise.resolve({ id: "p1" })} />
            </Suspense>,
        );
    });
    await screen.findByText("select all");
    return view;
}

beforeEach(() => {
    vi.clearAllMocks();
    deleteChat.mockResolvedValue(undefined);
});

describe("project assistant chat deletion gating", () => {
    it("lets a project admin delete a colleague's chat", async () => {
        // The served role, not the row's user_id: this chat was created by
        // "u2" and the caller is an admin of the project it lives in.
        await renderPage([
            chat("c1", { access_role: "owner", is_owner: false }),
        ]);

        fireEvent.click(screen.getByText("delete c1"));

        await waitFor(() => expect(deleteChat).toHaveBeenCalledWith("c1"));
        expect(setOwnerOnlyAction).not.toHaveBeenCalled();
    });

    it("refuses a member their own chat's deletion and never calls the API", async () => {
        // A member reaches this chat through the project (or a share list).
        // container.delete is admin-tier, so the client must not offer it —
        // and must not fire a request that would come back 403.
        await renderPage([
            chat("c1", { access_role: "editor", is_owner: false }),
        ]);

        fireEvent.click(screen.getByText("delete c1"));

        await waitFor(() =>
            expect(setOwnerOnlyAction).toHaveBeenCalledWith("delete this chat"),
        );
        expect(deleteChat).not.toHaveBeenCalled();
    });

    it("surfaces a refused delete instead of dropping the row", async () => {
        deleteChat.mockRejectedValue(
            new MikeApiError({
                message: "You do not have permission to delete this chat",
                status: 403,
            }),
        );
        await renderPage([chat("c1", { access_role: "owner" })]);

        fireEvent.click(screen.getByText("delete c1"));

        // The user is told. Previously the row disappeared locally and came
        // back on reload with no explanation at all.
        expect(
            await screen.findByText("The chat was not deleted"),
        ).toBeInTheDocument();
        // The server's own 4xx wording is shown, not a generic fallback.
        expect(
            screen.getByText(
                "You do not have permission to delete this chat",
            ),
        ).toBeInTheDocument();
        expect(setProjectChats).not.toHaveBeenCalled();
    });

    it("reports blocked and failed rows after a bulk delete", async () => {
        deleteChat.mockImplementation(async (id: string) => {
            if (id === "c-fails") throw new Error("network");
        });
        await renderPage([
            chat("c-ok", { access_role: "owner" }),
            chat("c-fails", { access_role: "owner" }),
            chat("c-blocked", { access_role: "editor" }),
        ]);

        fireEvent.click(screen.getByText("select all"));
        fireEvent.click(await screen.findByText("Actions"));
        fireEvent.click(await screen.findByText("Delete"));

        // The bulk path asks first — nothing is sent until it is confirmed.
        expect(await screen.findByText("Delete 3 chats?")).toBeInTheDocument();
        expect(deleteChat).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole("button", { name: "Delete" }));

        const notice = await screen.findByText(/skipped because only a project owner/);
        expect(notice.textContent).toContain(
            "1 selected chat was skipped because only a project owner can delete them.",
        );
        expect(notice.textContent).toContain(
            "1 chat was not deleted because the request failed.",
        );
        // The member-tier row was never sent — the deletable two were.
        expect(deleteChat).toHaveBeenCalledTimes(2);
        expect(deleteChat).not.toHaveBeenCalledWith("c-blocked");
    });
});
