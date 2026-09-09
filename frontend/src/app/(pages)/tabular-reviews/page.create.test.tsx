import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MikeApiError } from "@/app/lib/mikeApi";
import type { TabularReview } from "@/app/components/shared/types";
import TabularReviewsPage from "./page";

// What this file pins: what happens when the review is created but sharing it
// is refused. The handler used to let the grant's rejection escape, so the
// dialog showed the generic "Could not create the review." and a second Create
// created a SECOND review. The review now survives the failure in a ref, the
// message names what actually failed, and Create retries only the grants.

const { createTabularReview, grantTabularReviewAccess, push, retry } =
    vi.hoisted(() => ({
        createTabularReview: vi.fn(),
        grantTabularReviewAccess: vi.fn(),
        push: vi.fn(),
        retry: vi.fn(),
    }));

// importOriginal so MikeApiError stays the real class: userFacingApiError
// decides with an `instanceof` test whether the server's own message may be
// shown, and a stubbed class would silently take the generic branch.
vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
    createTabularReview: (...args: unknown[]) => createTabularReview(...args),
    grantTabularReviewAccess: (...args: unknown[]) =>
        grantTabularReviewAccess(...args),
    listProjects: vi.fn(async () => []),
    listWorkflows: vi.fn(async () => []),
}));

vi.mock("next/navigation", () => ({
    usePathname: () => "/tabular-reviews",
    useRouter: () => ({ push, replace: vi.fn() }),
    useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({ user: { id: "me", email: "me@firm.test" } }),
}));

vi.mock("@/app/contexts/UserProfileContext", () => ({
    useUserProfile: () => ({
        profile: {
            tabularModel: "gemini-3-flash-preview",
            apiKeys: {
                claude: { configured: false, source: null },
                gemini: { configured: true, source: "user" },
                openai: { configured: false, source: null },
                openrouter: { configured: false, source: null },
                vercel: { configured: false, source: null },
                "opencode-go": { configured: false, source: null },
                courtlistener: { configured: false, source: null },
            },
            openRouterModels: [],
            vercelModels: [],
            openCodeGoModels: [],
        },
        loading: false,
        apiKeysDegraded: false,
    }),
}));

vi.mock("@/app/hooks/useOllamaModels", () => ({
    useOllamaModels: () => [],
}));

// The list itself is not what this file is about; the hook would otherwise
// fetch on mount.
vi.mock("@/app/hooks/usePaginatedTabularReviews", () => ({
    usePaginatedTabularReviews: () => ({
        reviews: [],
        setReviews: vi.fn(),
        loading: false,
        loadingMore: false,
        hasMore: false,
        error: null,
        loadMoreError: null,
        loadMore: vi.fn(),
        retry,
        selectedReviewIds: [],
        setSelectedReviewIds: vi.fn(),
        selectAllMatching: vi.fn(),
        selectingAll: false,
        getReviewOwnerId: () => undefined,
    }),
}));

type HeaderAction = { type: string; title?: string; onClick?: () => void };
vi.mock("@/app/components/shared/PageHeader", () => ({
    PageHeader: ({
        actions,
        children,
    }: {
        actions?: HeaderAction[];
        children?: ReactNode;
    }) => (
        <div>
            {children}
            {(actions ?? [])
                .filter((action) => action.type === "new")
                .map((action) => (
                    <button
                        key={action.title}
                        type="button"
                        onClick={action.onClick}
                    >
                        {action.title}
                    </button>
                ))}
        </div>
    ),
}));

vi.mock("@/app/components/shared/FileDirectory", () => ({
    FileDirectory: () => <div>Document directory</div>,
}));

// The real access step is a user-lookup surface of its own; here it just has
// to hand the dialog one recipient to share with.
vi.mock("@/app/components/modals/CreateAccessStep", () => ({
    CreateAccessStep: ({
        onDirectGrantsChange,
    }: {
        onDirectGrantsChange: (
            grants: {
                email: string;
                display_name: string | null;
                role: "editor";
            }[],
        ) => void;
    }) => {
        const recipient = (email: string) =>
            ({ email, display_name: null, role: "editor" }) as const;
        return (
            <>
                <button
                    type="button"
                    onClick={() =>
                        onDirectGrantsChange([recipient("colleague@firm.test")])
                    }
                >
                    add recipient
                </button>
                <button
                    type="button"
                    onClick={() =>
                        onDirectGrantsChange([
                            recipient("colleague@firm.test"),
                            recipient("partner@firm.test"),
                        ])
                    }
                >
                    add two recipients
                </button>
            </>
        );
    },
}));

const createdReview = {
    id: "review-1",
    project_id: null,
    user_id: "me",
    title: "Diligence",
    columns_config: [],
    document_ids: [],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
} as unknown as TabularReview;

// The empty state behind the dialog offers its own "Create"; the one under
// test is the dialog's submit button.
function createButton() {
    const submit = screen
        .getAllByRole("button", { name: "Create" })
        .find((button) => button.getAttribute("type") === "submit");
    if (!submit) throw new Error("dialog Create button not found");
    return submit;
}

async function openDialogAndReachCreate() {
    render(<TabularReviewsPage />);
    fireEvent.click(screen.getByRole("button", { name: "New tabular review" }));
    fireEvent.change(await screen.findByLabelText("Review name"), {
        target: { value: "Diligence" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "add recipient" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    return createButton();
}

describe("Tabular reviews page creation", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        window.matchMedia = vi.fn().mockImplementation((query: string) => ({
            matches: true,
            media: query,
            onchange: null,
            addListener: vi.fn(),
            removeListener: vi.fn(),
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            dispatchEvent: vi.fn(),
        }));
    });

    it("keeps the created review and reports the refused grant instead of creating a second review", async () => {
        createTabularReview.mockResolvedValue(createdReview);
        grantTabularReviewAccess.mockRejectedValue(
            new MikeApiError({
                message: "That address is not in your organization.",
                status: 400,
            }),
        );

        const create = await openDialogAndReachCreate();
        fireEvent.click(create);

        expect(
            await screen.findByText(
                "Review created, but access was not granted to colleague@firm.test: That address is not in your organization.",
            ),
        ).toBeInTheDocument();
        expect(createTabularReview).toHaveBeenCalledTimes(1);
        expect(push).not.toHaveBeenCalled();

        // Pressing Create again is the user's retry of the sharing, not of the
        // review: a second review here is the duplicate this fix exists for.
        fireEvent.click(createButton());
        await waitFor(() =>
            expect(grantTabularReviewAccess).toHaveBeenCalledTimes(2),
        );
        expect(createTabularReview).toHaveBeenCalledTimes(1);
    });

    it("navigates once the retried grant succeeds", async () => {
        createTabularReview.mockResolvedValue(createdReview);
        grantTabularReviewAccess.mockRejectedValueOnce(
            new MikeApiError({ message: "Rate limited", status: 429 }),
        );
        grantTabularReviewAccess.mockResolvedValue({});

        const create = await openDialogAndReachCreate();
        fireEvent.click(create);
        expect(
            await screen.findByText(/Review created, but access was not granted/),
        ).toBeInTheDocument();

        fireEvent.click(createButton());
        await waitFor(() =>
            expect(push).toHaveBeenCalledWith("/tabular-reviews/review-1"),
        );
        expect(createTabularReview).toHaveBeenCalledTimes(1);
    });

    it("reports one refusal per recipient without losing the others", async () => {
        createTabularReview.mockResolvedValue(createdReview);
        grantTabularReviewAccess.mockRejectedValue(
            new MikeApiError({ message: "No such user.", status: 404 }),
        );

        render(<TabularReviewsPage />);
        fireEvent.click(
            screen.getByRole("button", { name: "New tabular review" }),
        );
        fireEvent.change(await screen.findByLabelText("Review name"), {
            target: { value: "Diligence" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Next" }));
        fireEvent.click(
            screen.getByRole("button", { name: "add two recipients" }),
        );
        fireEvent.click(screen.getByRole("button", { name: "Next" }));
        fireEvent.click(createButton());

        // One refusal must not abandon the recipients behind it: the loop used
        // to stop at the first throw, so the second address was never tried
        // and never named.
        expect(
            await screen.findByText(
                "Review created, but access was not granted to colleague@firm.test, partner@firm.test: No such user.",
            ),
        ).toBeInTheDocument();
        expect(grantTabularReviewAccess).toHaveBeenCalledTimes(2);
        expect(grantTabularReviewAccess).toHaveBeenCalledWith(
            "review-1",
            "partner@firm.test",
            "editor",
        );
    });

    it("refetches the list when a partially created review is dismissed", async () => {
        // The page only puts a new review on screen through the navigation a
        // successful create performs, so a review created behind a refused
        // grant was invisible until a reload.
        createTabularReview.mockResolvedValue(createdReview);
        grantTabularReviewAccess.mockRejectedValue(
            new MikeApiError({ message: "No such user.", status: 404 }),
        );

        const create = await openDialogAndReachCreate();
        fireEvent.click(create);
        await screen.findByText(/Review created, but access was not granted/);

        fireEvent.click(screen.getByRole("button", { name: "Close" }));
        expect(retry).toHaveBeenCalledTimes(1);
    });

    it("does not refetch when the dialog is dismissed with nothing created", async () => {
        render(<TabularReviewsPage />);
        fireEvent.click(
            screen.getByRole("button", { name: "New tabular review" }),
        );
        await screen.findByLabelText("Review name");

        fireEvent.click(screen.getByRole("button", { name: "Close" }));

        expect(retry).not.toHaveBeenCalled();
    });

    it("cannot be dismissed while the review is being created", async () => {
        // Leaving mid-create strands the only account of what happened to it.
        createTabularReview.mockReturnValue(new Promise(() => {}));

        const create = await openDialogAndReachCreate();
        fireEvent.click(create);
        await waitFor(() => expect(createTabularReview).toHaveBeenCalled());

        fireEvent.click(screen.getByRole("button", { name: "Close" }));

        expect(screen.getByRole("dialog")).toBeInTheDocument();
        expect(retry).not.toHaveBeenCalled();
    });
});
