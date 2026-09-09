import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
    getTabularReview,
    getTabularReviewAccess,
    grantTabularReviewAccess,
    revokeTabularReviewAccess,
    type ContentAccessGrant,
} from "@/app/lib/mikeApi";
import type { TabularReview } from "@/app/components/shared/types";
import { TRView } from "./TabularReviewView";

// What this file pins: an access change the server accepted is never reported
// as a failure. Reloading the roster afterwards is bookkeeping, and its failure
// used to travel back out of the handler into AccessModal's catch — so a role
// that was granted came back as "Could not change that role."
vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
    useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/app/lib/mikeApi", () => ({
    MikeApiError: class MikeApiError extends Error {},
    clearTabularCells: vi.fn(),
    deleteTabularReview: vi.fn(),
    getTabularReview: vi.fn(),
    getTabularReviewAccess: vi.fn(),
    getProject: vi.fn(),
    getTabularReviewPeople: vi.fn(async () => ({ owner: null, members: [] })),
    getOllamaModels: vi.fn(async () => []),
    grantTabularReviewAccess: vi.fn(),
    listProjects: vi.fn(async () => []),
    regenerateTabularCell: vi.fn(),
    revokeTabularReviewAccess: vi.fn(),
    streamTabularGeneration: vi.fn(),
    streamTabularGenerationResume: vi.fn(),
    updateTabularReview: vi.fn(),
    uploadReviewDocument: vi.fn(),
}));
vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({ user: { id: "me", email: "me@firm.test" } }),
}));
vi.mock("@/app/contexts/UserProfileContext", () => ({
    useUserProfile: () => ({ profile: { apiKeys: {} }, apiKeysDegraded: false }),
}));
vi.mock("@/app/contexts/SidebarContext", () => ({
    useSidebar: () => ({ setSidebarOpen: vi.fn() }),
}));
vi.mock("../assistant/ModelToggle", () => ({ ModelToggle: () => null }));
vi.mock("./TRTable", () => ({ TRTable: () => <div /> }));
vi.mock("./TRSidePanel", () => ({ TRSidePanel: () => null }));
vi.mock("./TRChatPanel", () => ({ TRChatPanel: () => null }));
vi.mock("./AddColumnModal", () => ({ AddColumnModal: () => null }));
vi.mock("./TRWorkflowModal", () => ({ TRWorkflowModal: () => null }));
vi.mock("./TabularReviewDetailsModal", () => ({
    TabularReviewDetailsModal: () => null,
}));
vi.mock("../modals/AddDocumentsModal", () => ({
    AddDocumentsModal: () => null,
}));
vi.mock("../popups/ApiKeyMissingPopup", () => ({
    ApiKeyMissingPopup: () => null,
}));

// A stand-in for AccessModal keeping the one behaviour under test: the real
// modal awaits the handler it is given and turns any rejection into a message
// (AccessModal.tsx `changeRole`/`remove`). It renders whether or not the modal
// is open so the handlers can be driven without walking the header menu.
vi.mock("../modals/AccessModal", async () => {
    const { useState } = await import("react");
    const { userFacingApiError } = await import("@/app/lib/userFacingError");
    return {
        AccessModal: ({
            access,
        }: {
            access: {
                onGrant: (email: string, role: string) => Promise<void>;
                onRevoke: (email: string) => Promise<void>;
            };
        }) => {
            const [error, setError] = useState<string | null>(null);
            return (
                <div>
                    <button
                        type="button"
                        onClick={async () => {
                            try {
                                await access.onGrant(
                                    "colleague@firm.test",
                                    "editor",
                                );
                            } catch (cause) {
                                setError(
                                    userFacingApiError(
                                        cause,
                                        "Could not change that role.",
                                    ),
                                );
                            }
                        }}
                    >
                        grant editor
                    </button>
                    <button
                        type="button"
                        onClick={async () => {
                            try {
                                await access.onRevoke("colleague@firm.test");
                            } catch (cause) {
                                setError(
                                    userFacingApiError(
                                        cause,
                                        "Could not remove access.",
                                    ),
                                );
                            }
                        }}
                    >
                        remove access
                    </button>
                    {error && <p role="alert">{error}</p>}
                </div>
            );
        },
    };
});

function review(over: Partial<TabularReview>): TabularReview {
    return {
        id: "r1",
        project_id: null,
        user_id: "me",
        title: "Diligence",
        columns_config: [],
        document_ids: [],
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        ...over,
    } as TabularReview;
}

describe("TabularReviewView access mutations", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getTabularReview).mockResolvedValue({
            review: review({ access_role: "owner" }),
            cells: [],
            rows: [],
            documents: [],
        });
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

    it("does not report a granted role when only the roster reload fails", async () => {
        vi.mocked(grantTabularReviewAccess).mockResolvedValue(
            {} as ContentAccessGrant,
        );
        vi.mocked(getTabularReviewAccess).mockRejectedValue(
            new Error("roster unavailable"),
        );

        render(<TRView reviewId="r1" />);
        fireEvent.click(await screen.findByText("grant editor"));

        await waitFor(() =>
            expect(grantTabularReviewAccess).toHaveBeenCalledWith(
                "r1",
                "colleague@firm.test",
                "editor",
            ),
        );
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("does not report a revoke when only the roster reload fails", async () => {
        vi.mocked(revokeTabularReviewAccess).mockResolvedValue(undefined);
        vi.mocked(getTabularReviewAccess).mockRejectedValue(
            new Error("roster unavailable"),
        );

        render(<TRView reviewId="r1" />);
        fireEvent.click(await screen.findByText("remove access"));

        await waitFor(() =>
            expect(revokeTabularReviewAccess).toHaveBeenCalledWith(
                "r1",
                "colleague@firm.test",
            ),
        );
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("still reports a grant the server refused", async () => {
        // The other half of the same rule: swallowing the reload must not
        // swallow the mutation.
        vi.mocked(grantTabularReviewAccess).mockRejectedValue(
            new Error("refused"),
        );
        vi.mocked(getTabularReviewAccess).mockResolvedValue({
            grants: [],
            scope: "direct",
            org_id: null,
            access_role: "owner",
        });

        render(<TRView reviewId="r1" />);
        fireEvent.click(await screen.findByText("grant editor"));

        expect(await screen.findByRole("alert")).toHaveTextContent(
            "Could not change that role.",
        );
    });
});
