import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { getTabularReview } from "@/app/lib/mikeApi";
import type { TabularReview } from "@/app/components/shared/types";
import { TRView } from "./TabularReviewView";

// What this file pins: the Add Columns button refuses a viewer BEFORE the
// modal opens. The refusal used to fire on submit only, so a viewer named a
// column, wrote its prompt and chose its format before being told that adding
// columns is for editors.
vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
    useSearchParams: () => new URLSearchParams(),
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
vi.mock("./TRChatPanel", () => ({ TRChatPanel: () => null }));
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
// The real modal is a large form; all this test needs is whether it opened.
vi.mock("./AddColumnModal", () => ({
    AddColumnModal: ({ open }: { open: boolean }) =>
        open ? <div data-testid="add-column-modal" /> : null,
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

function renderAs(role: "viewer" | "editor") {
    vi.mocked(getTabularReview).mockResolvedValue({
        review: review({ access_role: role }),
        cells: [],
        rows: [],
        documents: [],
    });
    return render(<TRView reviewId="r1" />);
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

describe("TabularReviewView Add Columns gating", () => {
    it("refuses a viewer at the button instead of at the submit", async () => {
        renderAs("viewer");

        fireEvent.click(await screen.findByText("Add Columns"));

        expect(await screen.findByText("Editors only")).toBeInTheDocument();
        expect(
            screen.getByText("Only an editor can add columns."),
        ).toBeInTheDocument();
        expect(screen.queryByTestId("add-column-modal")).not.toBeInTheDocument();
    });

    it("opens the modal for an editor", async () => {
        renderAs("editor");

        fireEvent.click(await screen.findByText("Add Columns"));

        expect(screen.getByTestId("add-column-modal")).toBeInTheDocument();
        expect(screen.queryByText("Editors only")).not.toBeInTheDocument();
    });
});
