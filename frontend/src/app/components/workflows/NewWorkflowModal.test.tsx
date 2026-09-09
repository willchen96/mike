import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    copyDocumentsToWorkflowAssets,
    createWorkflow,
    listOrgMembers,
    listOrgs,
    lookupUserByEmail,
    MikeApiError,
    shareWorkflow,
    updateWorkflow,
} from "@/app/lib/mikeApi";
import type { Document, Workflow } from "../shared/types";
import { NewWorkflowModal } from "./NewWorkflowModal";

const { useUserProfile } = vi.hoisted(() => ({
    useUserProfile: vi.fn(),
}));

vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
    copyDocumentsToWorkflowAssets: vi.fn(),
    createWorkflow: vi.fn(),
    listOrgMembers: vi.fn(),
    listOrgs: vi.fn(),
    lookupUserByEmail: vi.fn(),
    shareWorkflow: vi.fn(),
    updateWorkflow: vi.fn(),
}));

vi.mock("../shared/FileDirectory", () => ({
    FileDirectory: ({
        onChange,
    }: {
        onChange: (documents: Document[]) => void;
    }) => (
        <button
            type="button"
            onClick={() =>
                onChange([
                    {
                        id: "document-1",
                        filename: "Precedent.pdf",
                    } as Document,
                ])
            }
        >
            Select asset
        </button>
    ),
}));

vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({ user: { id: "me", email: "me@firm.test" } }),
}));
vi.mock("@/app/contexts/UserProfileContext", () => ({
    useUserProfile,
}));

const workflow = {
    id: "workflow-1",
    is_owner: true,
    metadata: {
        title: "Contract Intake",
        type: "assistant",
        language: "English",
        practice: "Litigation",
        jurisdictions: ["Singapore"],
    },
} as Workflow;

describe("NewWorkflowModal editing", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(listOrgs).mockResolvedValue([]);
        vi.mocked(listOrgMembers).mockResolvedValue([]);
        vi.mocked(createWorkflow).mockResolvedValue(workflow);
        vi.mocked(copyDocumentsToWorkflowAssets).mockResolvedValue([]);
        vi.mocked(shareWorkflow).mockResolvedValue(undefined);
        vi.mocked(lookupUserByEmail).mockResolvedValue({
            exists: true,
            email: "counsel@firm.test",
            display_name: "Counsel",
        });
        vi.mocked(updateWorkflow).mockResolvedValue(workflow);
        useUserProfile.mockReturnValue({ profile: { practiceAreas: [] } });
    });

    it("pairs Type with Jurisdiction and presets Practice area from the profile", async () => {
        useUserProfile.mockReturnValue({
            profile: { practiceAreas: ["Litigation"] },
        });
        render(<NewWorkflowModal open onClose={vi.fn()} onCreated={vi.fn()} />);

        const typeField = screen.getByText("Type").parentElement;
        const jurisdictionField =
            screen.getByText("Jurisdiction").parentElement;
        expect(typeField?.parentElement).toBe(jurisdictionField?.parentElement);
        expect(typeField?.parentElement).toHaveClass("grid", "md:grid-cols-2");
        expect(await screen.findByLabelText("Practice area")).toHaveTextContent(
            "Litigation",
        );
    });

    it("disables Save until details change", () => {
        render(
            <NewWorkflowModal
                open
                editWorkflow={workflow}
                onClose={vi.fn()}
                onCreated={vi.fn()}
                onUpdated={vi.fn()}
            />,
        );

        const save = screen.getByRole("button", { name: "Save" });
        expect(save).toBeDisabled();

        const title = screen.getByLabelText("Title");
        fireEvent.change(title, { target: { value: "Contract Review" } });
        expect(save).toBeEnabled();

        fireEvent.change(title, { target: { value: "Contract Intake" } });
        expect(save).toBeDisabled();
    });

    it("shows the current organisation in workflow details", async () => {
        vi.mocked(listOrgs).mockResolvedValue([
            { id: "org-1", name: "Elite Law LLP" } as never,
        ]);

        render(
            <NewWorkflowModal
                open
                editWorkflow={{ ...workflow, org_id: "org-1" }}
                onClose={vi.fn()}
                onCreated={vi.fn()}
                onUpdated={vi.fn()}
            />,
        );

        const organisation = await screen.findByLabelText("Organisation");
        expect(organisation).toBeDisabled();
        expect(organisation).toHaveTextContent("Elite Law LLP");
    });

    it("creates an assistant workflow only after the Assets screen", async () => {
        const user = userEvent.setup({ delay: null });
        const onCreated = vi.fn();
        render(
            <NewWorkflowModal open onClose={vi.fn()} onCreated={onCreated} />,
        );

        await user.type(screen.getByLabelText("Title"), "New workflow");
        await user.click(screen.getByRole("button", { name: "Next" }));

        expect(screen.getByRole("dialog", { name: "Access" })).toBeVisible();
        expect(screen.getByText("Share Access")).toBeInTheDocument();
        expect(createWorkflow).not.toHaveBeenCalled();
        expect(onCreated).not.toHaveBeenCalled();

        const skip = screen.getByRole("button", { name: "Skip" });
        const next = screen.getByRole("button", { name: "Next" });
        expect(skip.parentElement).toBe(next.parentElement);
        expect(skip).toHaveClass("text-gray-500");
        expect(screen.getByRole("button", { name: "Back" })).toHaveClass(
            "bg-blue-600/90",
        );

        await user.click(next);
        expect(
            screen.getByRole("dialog", { name: "Add Assets" }),
        ).toBeVisible();
        expect(createWorkflow).not.toHaveBeenCalled();
        expect(onCreated).not.toHaveBeenCalled();

        await user.click(
            screen.getByRole("button", { name: "Create workflow" }),
        );
        await waitFor(() => expect(createWorkflow).toHaveBeenCalledTimes(1));
        expect(onCreated).toHaveBeenCalledWith({
            ...workflow,
            access_scope: "private",
            organization_name: null,
        });
    });

    it("moves a skipped assistant Access screen to Assets before creating", async () => {
        const user = userEvent.setup({ delay: null });
        const onCreated = vi.fn();
        render(
            <NewWorkflowModal open onClose={vi.fn()} onCreated={onCreated} />,
        );

        await user.type(screen.getByLabelText("Title"), "New workflow");
        await user.click(screen.getByRole("button", { name: "Next" }));
        expect(createWorkflow).not.toHaveBeenCalled();

        await user.click(screen.getByRole("button", { name: "Skip" }));
        expect(
            screen.getByRole("dialog", { name: "Add Assets" }),
        ).toBeVisible();
        expect(createWorkflow).not.toHaveBeenCalled();

        await user.click(
            screen.getByRole("button", { name: "Create workflow" }),
        );
        await waitFor(() => expect(createWorkflow).toHaveBeenCalledTimes(1));
        expect(shareWorkflow).not.toHaveBeenCalled();
        expect(onCreated).toHaveBeenCalledWith({
            ...workflow,
            access_scope: "private",
            organization_name: null,
        });
    });

    it("copies selected directory files before completing assistant creation", async () => {
        const user = userEvent.setup({ delay: null });
        const onCreated = vi.fn();
        render(
            <NewWorkflowModal open onClose={vi.fn()} onCreated={onCreated} />,
        );

        await user.type(screen.getByLabelText("Title"), "New workflow");
        await user.click(screen.getByRole("button", { name: "Next" }));
        await user.click(screen.getByRole("button", { name: "Next" }));
        await user.click(screen.getByRole("button", { name: "Select asset" }));
        expect(createWorkflow).not.toHaveBeenCalled();

        await user.click(
            screen.getByRole("button", { name: "Create workflow" }),
        );

        await waitFor(() =>
            expect(copyDocumentsToWorkflowAssets).toHaveBeenCalledWith(
                "workflow-1",
                ["document-1"],
            ),
        );
        expect(onCreated).toHaveBeenCalled();
        expect(
            vi.mocked(copyDocumentsToWorkflowAssets).mock
                .invocationCallOrder[0],
        ).toBeLessThan(onCreated.mock.invocationCallOrder[0]);
    });

    it("reports a failed asset copy against the workflow that exists", async () => {
        // The copy ran before the grants and outside any try of its own, so a
        // failure came back as "Failed to create workflow" — about a workflow
        // the server had already made — and the retry re-copied everything
        // that had worked.
        const user = userEvent.setup({ delay: null });
        const onCreated = vi.fn();
        vi.mocked(copyDocumentsToWorkflowAssets).mockRejectedValueOnce(
            new Error("copy failed"),
        );
        render(
            <NewWorkflowModal open onClose={vi.fn()} onCreated={onCreated} />,
        );

        await user.type(screen.getByLabelText("Title"), "New workflow");
        await user.click(screen.getByRole("button", { name: "Next" }));
        await user.click(screen.getByRole("button", { name: "Next" }));
        await user.click(screen.getByRole("button", { name: "Select asset" }));
        await user.click(
            screen.getByRole("button", { name: "Create workflow" }),
        );

        expect(
            await screen.findByText(
                "Workflow created, but 1 asset could not be copied. Press Create again to retry the copy.",
            ),
        ).toBeInTheDocument();
        expect(
            screen.queryByText("Failed to create workflow"),
        ).not.toBeInTheDocument();
        // Held open on the only screen that knows: the row never reached the
        // caller's list.
        expect(onCreated).not.toHaveBeenCalled();

        // The retry reuses the workflow and re-sends only the missing asset.
        await user.click(
            screen.getByRole("button", { name: "Create workflow" }),
        );
        await waitFor(() => expect(onCreated).toHaveBeenCalled());
        expect(createWorkflow).toHaveBeenCalledTimes(1);
        expect(copyDocumentsToWorkflowAssets).toHaveBeenCalledTimes(2);
    });

    it("copies assets only after the grants have been written", async () => {
        // Grants first: a refused grant stops the submit, and an asset copied
        // before it would have to be redone on the retry.
        const user = userEvent.setup({ delay: null });
        vi.mocked(shareWorkflow).mockRejectedValue(new Error("nope"));
        render(<NewWorkflowModal open onClose={vi.fn()} onCreated={vi.fn()} />);

        await user.type(screen.getByLabelText("Title"), "New workflow");
        await user.click(screen.getByRole("button", { name: "Next" }));
        await user.click(screen.getByPlaceholderText("Add by email..."));
        // paste, not per-key typing: one input event cannot be cut off
        // mid-word by a slow re-render on a loaded machine.
        await user.paste("counsel@firm.test");
        await user.click(screen.getByRole("button", { name: "Add" }));
        await user.click(screen.getByRole("button", { name: "Next" }));
        await user.click(screen.getByRole("button", { name: "Select asset" }));
        await user.click(
            screen.getByRole("button", { name: "Create workflow" }),
        );

        expect(
            await screen.findByText(
                /Workflow created, but access was not granted to counsel@firm\.test/,
            ),
        ).toBeInTheDocument();
        expect(copyDocumentsToWorkflowAssets).not.toHaveBeenCalled();
        expect(
            screen.getByText(
                /The 1 selected file is still pending and will be copied when you try again\./,
            ),
        ).toBeInTheDocument();
    });

    it("finishes a tabular workflow on Access without showing Assets", async () => {
        const user = userEvent.setup({ delay: null });
        const onCreated = vi.fn();
        render(
            <NewWorkflowModal open onClose={vi.fn()} onCreated={onCreated} />,
        );

        await user.click(screen.getByRole("button", { name: "Tabular" }));
        await user.type(screen.getByLabelText("Title"), "Tabular workflow");
        await user.click(screen.getByRole("button", { name: "Next" }));

        expect(screen.getByRole("dialog", { name: "Access" })).toBeVisible();
        expect(
            screen.getByRole("button", { name: "Create workflow" }),
        ).toBeVisible();
        expect(screen.queryByText("Select asset")).not.toBeInTheDocument();
        expect(createWorkflow).not.toHaveBeenCalled();

        await user.click(
            screen.getByRole("button", { name: "Create workflow" }),
        );
        await waitFor(() => expect(createWorkflow).toHaveBeenCalledTimes(1));
        expect(copyDocumentsToWorkflowAssets).not.toHaveBeenCalled();
        expect(onCreated).toHaveBeenCalled();
    });

    it("never creates a new workflow from a generic form submission", () => {
        const onCreated = vi.fn();
        render(
            <NewWorkflowModal open onClose={vi.fn()} onCreated={onCreated} />,
        );

        fireEvent.change(screen.getByLabelText("Title"), {
            target: { value: "New workflow" },
        });
        const form = document.getElementById("workflow-modal-form");
        expect(form).not.toBeNull();

        fireEvent.submit(form!);
        expect(screen.getByRole("dialog", { name: "Access" })).toBeVisible();
        fireEvent.submit(form!);

        expect(createWorkflow).not.toHaveBeenCalled();
        expect(onCreated).not.toHaveBeenCalled();
    });

    it("puts organization sharing last and names its access screen", async () => {
        const user = userEvent.setup({ delay: null });
        vi.mocked(listOrgs).mockResolvedValue([
            { id: "org-1", name: "Elite Law LLP" } as never,
        ]);
        render(<NewWorkflowModal open onClose={vi.fn()} onCreated={vi.fn()} />);

        const jurisdiction = screen.getByLabelText("Jurisdiction");
        const organization = await screen.findByLabelText(
            "Share across Organisation",
        );
        expect(
            jurisdiction.compareDocumentPosition(organization) &
                Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();

        await user.click(organization);
        await user.click(
            await screen.findByRole("menuitem", { name: "Elite Law LLP" }),
        );
        await user.type(screen.getByLabelText("Title"), "Firm workflow");
        await user.click(screen.getByRole("button", { name: "Next" }));

        expect(
            screen.getByRole("dialog", { name: "Organisational Access" }),
        ).toBeVisible();
        expect(
            screen.getByText(
                "Add Elite Law LLP members as owners with rights to manage access, settings and delete the workflow.",
            ),
        ).not.toHaveClass("pl-3");
        const denyToggle = screen.getByRole("button", { name: "Deny list" });
        expect(denyToggle).toHaveAttribute("aria-expanded", "false");
        expect(
            screen.queryByRole("searchbox", { name: "Deny list" }),
        ).not.toBeInTheDocument();
        await user.click(denyToggle);
        expect(
            screen.getByText(
                "Deny Elite Law LLP members from accessing this workflow.",
            ),
        ).not.toHaveClass("pl-3");
    });

    async function reachCreateWithOneRecipient(
        user: ReturnType<typeof userEvent.setup>,
    ) {
        await user.click(screen.getByRole("button", { name: "Tabular" }));
        await user.type(screen.getByLabelText("Title"), "Tabular workflow");
        await user.click(screen.getByRole("button", { name: "Next" }));

        await user.click(screen.getByPlaceholderText("Add by email..."));
        // paste, not per-key typing: one input event cannot be cut off
        // mid-word by a slow re-render on a loaded machine.
        await user.paste("counsel@firm.test");
        await user.click(screen.getByRole("button", { name: "Add" }));
    }

    it("reports a refused grant against the workflow that was created", async () => {
        const user = userEvent.setup({ delay: null });
        const onCreated = vi.fn();
        const onClose = vi.fn();
        vi.mocked(shareWorkflow).mockRejectedValueOnce(
            new MikeApiError({
                message: "Only owners can share this workflow.",
                status: 403,
            }),
        );
        render(
            <NewWorkflowModal
                open
                onClose={onClose}
                onCreated={onCreated}
            />,
        );

        await reachCreateWithOneRecipient(user);
        await user.click(
            screen.getByRole("button", { name: "Create workflow" }),
        );

        expect(
            await screen.findByText(
                "Workflow created, but access was not granted to counsel@firm.test: Only owners can share this workflow.",
            ),
        ).toBeVisible();
        expect(createWorkflow).toHaveBeenCalledTimes(1);
        expect(onCreated).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();

        // Pressing Create again must retry only the grant, against the
        // workflow that already exists.
        await user.click(
            screen.getByRole("button", { name: "Create workflow" }),
        );
        await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
        expect(createWorkflow).toHaveBeenCalledTimes(1);
        expect(shareWorkflow).toHaveBeenCalledTimes(2);
    });

    it("tells the caller to refetch when a created workflow is dismissed unshared", async () => {
        const user = userEvent.setup({ delay: null });
        const onClose = vi.fn();
        vi.mocked(shareWorkflow).mockRejectedValue(
            new MikeApiError({
                message: "Only owners can share this workflow.",
                status: 403,
            }),
        );
        render(
            <NewWorkflowModal open onClose={onClose} onCreated={vi.fn()} />,
        );

        await reachCreateWithOneRecipient(user);
        await user.click(
            screen.getByRole("button", { name: "Create workflow" }),
        );
        await screen.findByText(/Workflow created, but access was not granted/);

        await user.click(screen.getByRole("button", { name: "Close" }));
        expect(onClose).toHaveBeenCalledWith(true);
    });

    it("does not ask for a refetch when nothing was created", async () => {
        const user = userEvent.setup({ delay: null });
        const onClose = vi.fn();
        render(
            <NewWorkflowModal open onClose={onClose} onCreated={vi.fn()} />,
        );

        await user.click(screen.getByRole("button", { name: "Close" }));
        expect(onClose).toHaveBeenCalledWith(false);
    });

    it("refuses to dismiss while a create is in flight", async () => {
        const user = userEvent.setup({ delay: null });
        const onClose = vi.fn();
        vi.mocked(createWorkflow).mockReturnValue(new Promise(() => {}));
        render(
            <NewWorkflowModal open onClose={onClose} onCreated={vi.fn()} />,
        );

        await reachCreateWithOneRecipient(user);
        await user.click(
            screen.getByRole("button", { name: "Create workflow" }),
        );
        await screen.findByRole("button", { name: "Creating…" });

        await user.keyboard("{Escape}");
        await user.click(screen.getByRole("button", { name: "Close" }));
        expect(onClose).not.toHaveBeenCalled();
    });

    it("surfaces a failure to load the organization list", async () => {
        vi.mocked(listOrgs).mockRejectedValue(
            new MikeApiError({
                message: "Organizations are unavailable.",
                status: 403,
            }),
        );
        render(<NewWorkflowModal open onClose={vi.fn()} onCreated={vi.fn()} />);

        expect(
            await screen.findByText("Organizations are unavailable."),
        ).toBeVisible();
    });
});
