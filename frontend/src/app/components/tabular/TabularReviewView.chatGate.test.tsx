import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { getTabularReview } from "@/app/lib/mikeApi";
import type { TabularReview } from "@/app/components/shared/types";
import { TRView } from "./TabularReviewView";

// What this file pins: the review chat composer has THREE states, not two.
// `canSend={false}` is a sentence — ChatInput renders "Viewing only — sending
// needs edit access" — and the review's role is unknown for the whole of GET
// /tabular-review/:id, so an owner opening their own review from a chat link
// was told they were a viewer until it landed.
vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
    useSearchParams: () => new URLSearchParams("chat=new"),
}));
vi.mock("@/app/lib/mikeApi", () => ({
    MikeApiError: class MikeApiError extends Error {},
    clearTabularCells: vi.fn(),
    deleteTabularReview: vi.fn(),
    getTabularReview: vi.fn(),
    getTabularReviewAccess: vi.fn(async () => ({
        grants: [],
        scope: "direct",
        org_id: null,
        access_role: "viewer",
    })),
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
vi.mock("./TRChatPanel", () => ({
    TRChatPanel: ({ canSend }: { canSend?: boolean | null }) => (
        <div data-testid="tr-can-send">{String(canSend)}</div>
    ),
}));
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
vi.mock("../modals/AccessModal", () => ({ AccessModal: () => null }));

function review(over: Partial<TabularReview>): TabularReview {
    return {
        id: "r1",
        project_id: null,
        user_id: "owner",
        title: "Diligence",
        columns_config: [],
        document_ids: [],
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        ...over,
    } as TabularReview;
}

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

describe("TabularReviewView review-chat composer", () => {
    it("says nothing about sending until the review's role arrives", async () => {
        vi.mocked(getTabularReview).mockReturnValue(new Promise(() => {}));

        render(<TRView reviewId="r1" />);

        expect(await screen.findByTestId("tr-can-send")).toHaveTextContent(
            "null",
        );
    });

    it("hands a viewer a read-only composer once the role is known", async () => {
        vi.mocked(getTabularReview).mockResolvedValue({
            review: review({ access_role: "viewer" }),
            cells: [],
            rows: [],
            documents: [],
        });

        render(<TRView reviewId="r1" />);

        await waitFor(() =>
            expect(screen.getByTestId("tr-can-send")).toHaveTextContent(
                "false",
            ),
        );
    });

    it("opens the composer for an editor", async () => {
        vi.mocked(getTabularReview).mockResolvedValue({
            review: review({ access_role: "editor" }),
            cells: [],
            rows: [],
            documents: [],
        });

        render(<TRView reviewId="r1" />);

        await waitFor(() =>
            expect(screen.getByTestId("tr-can-send")).toHaveTextContent("true"),
        );
    });
});
