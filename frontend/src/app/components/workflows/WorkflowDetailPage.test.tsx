import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    deleteWorkflowShare,
    getWorkflow,
    getWorkflowPeople,
    listWorkflowShares,
    MikeApiError,
    shareWorkflow,
} from "@/app/lib/mikeApi";
import type { Workflow } from "../shared/types";
import { WorkflowDetailPage } from "./WorkflowDetailPage";

// `importOriginal` keeps the real `MikeApiError`: `userFacingApiError`
// decides with `instanceof`, so a stand-in class would make every 4xx look
// like an unexpected failure.
vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
    deleteWorkflow: vi.fn(),
    deleteWorkflowShare: vi.fn(),
    getWorkflow: vi.fn(),
    getWorkflowPeople: vi.fn(),
    listWorkflowShares: vi.fn(),
    shareWorkflow: vi.fn(),
    updateWorkflow: vi.fn(),
}));

vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: vi.fn() }),
    useSearchParams: () => ({ get: () => null }),
}));

vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({ user: { id: "me", email: "me@firm.test" } }),
}));
vi.mock("@/app/contexts/UserProfileContext", () => ({
    useUserProfile: () => ({ profile: { practiceAreas: [] } }),
}));
vi.mock("@/app/hooks/useQueryParamTab", () => ({
    useQueryParamTab: () => ["prompt", vi.fn()],
}));

vi.mock("@/app/components/workflows/WorkflowPromptEditor", () => ({
    WorkflowPromptEditor: () => null,
}));
vi.mock("./WorkflowAssets", () => ({
    WorkflowAssets: () => null,
}));
vi.mock("@/app/components/workflows/UseWorkflowModal", () => ({
    UseWorkflowModal: () => null,
}));
vi.mock("@/app/components/workflows/NewWorkflowModal", () => ({
    NewWorkflowModal: () => null,
}));
vi.mock("@/app/components/modals/AddDocumentsModal", () => ({
    AddDocumentsModal: () => null,
}));

const workflow = {
    id: "workflow-1",
    is_owner: true,
    access_role: "owner",
    org_id: null,
    metadata: {
        title: "Contract Intake",
        type: "assistant",
        language: "English",
        practice: null,
        jurisdictions: null,
    },
    skill_md: "",
} as unknown as Workflow;

function people() {
    return Promise.resolve({
        owner: {
            user_id: "me",
            email: "me@firm.test",
            display_name: "Me",
            role: "owner" as const,
        },
        members: [
            {
                email: "counsel@firm.test",
                display_name: null,
                role: "viewer" as const,
            },
        ],
    });
}

describe("WorkflowDetailPage access mutations", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getWorkflow).mockResolvedValue(workflow);
        vi.mocked(getWorkflowPeople).mockImplementation(people);
        vi.mocked(listWorkflowShares).mockResolvedValue([]);
        vi.mocked(shareWorkflow).mockResolvedValue(undefined);
        vi.mocked(deleteWorkflowShare).mockResolvedValue(undefined);
        vi.stubGlobal(
            "matchMedia",
            vi.fn().mockReturnValue({
                matches: true,
                addEventListener: vi.fn(),
                removeEventListener: vi.fn(),
            }),
        );
    });

    async function openAccess(user: ReturnType<typeof userEvent.setup>) {
        render(<WorkflowDetailPage id="workflow-1" workflowType="assistant" />);
        await user.click(
            await screen.findByRole("button", {
                name: "Open workflow access",
            }),
        );
        return screen.findByRole("button", {
            name: "Role for counsel@firm.test",
        });
    }

    it("does not report a role change as failed when only the re-read fails", async () => {
        const user = userEvent.setup();
        vi.mocked(listWorkflowShares).mockRejectedValue(
            new MikeApiError({ message: "Shares unavailable.", status: 500 }),
        );

        const rolePill = await openAccess(user);
        await user.click(rolePill);
        await user.click(screen.getByRole("menuitem", { name: "Owner" }));

        await waitFor(() =>
            expect(shareWorkflow).toHaveBeenCalledWith("workflow-1", {
                emails: ["counsel@firm.test"],
                role: "owner",
            }),
        );
        expect(
            screen.queryByText("Could not change that role."),
        ).not.toBeInTheDocument();
    });

    it("says the list is stale when the re-read fails", async () => {
        // `.catch(() => {})` left the roster showing the roles as they were
        // BEFORE a change the server accepted, with nothing saying the screen
        // had stopped tracking the server.
        const user = userEvent.setup();
        vi.mocked(listWorkflowShares).mockRejectedValue(
            new MikeApiError({ message: "Shares unavailable.", status: 500 }),
        );

        const rolePill = await openAccess(user);
        await user.click(rolePill);
        await user.click(screen.getByRole("menuitem", { name: "Owner" }));

        expect(
            await screen.findByText(
                "The change was saved, but this list could not be reloaded. Reopen Access to see the current one.",
            ),
        ).toBeVisible();
        // Still not reported as a failed change.
        expect(
            screen.queryByText("Could not change that role."),
        ).not.toBeInTheDocument();
    });

    it("does not report a revoke as failed when only the re-read fails", async () => {
        const user = userEvent.setup();
        vi.mocked(listWorkflowShares).mockRejectedValue(
            new MikeApiError({ message: "Shares unavailable.", status: 500 }),
        );

        await openAccess(user);
        await user.click(
            screen.getByRole("button", {
                name: "Actions for counsel@firm.test",
            }),
        );
        await user.click(screen.getByRole("menuitem", { name: "Remove" }));

        await waitFor(() =>
            expect(listWorkflowShares).toHaveBeenCalledWith("workflow-1"),
        );
        expect(
            screen.queryByText("Could not remove access."),
        ).not.toBeInTheDocument();
    });

    it("still reports a role change the grant itself refused", async () => {
        const user = userEvent.setup();
        vi.mocked(shareWorkflow).mockRejectedValue(
            new MikeApiError({
                message: "Only owners can share this workflow.",
                status: 403,
            }),
        );

        const rolePill = await openAccess(user);
        await user.click(rolePill);
        await user.click(screen.getByRole("menuitem", { name: "Owner" }));

        expect(
            await screen.findByText("Only owners can share this workflow."),
        ).toBeVisible();
    });
});
