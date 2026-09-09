import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import { uploadProjectDocument } from "@/app/lib/mikeApi";
import { ChatInput } from "./ChatInput";

vi.mock("@/app/lib/mikeApi", () => ({
    listWorkflows: vi.fn(async () => []),
    uploadProjectDocument: vi.fn(),
    uploadStandaloneDocument: vi.fn(),
}));

vi.mock("@/app/contexts/UserProfileContext", () => ({
    useUserProfile: vi.fn(),
}));

vi.mock("@/app/lib/modelAvailability", () => ({
    getModelProvider: vi.fn(),
    isModelAvailable: vi.fn(() => true),
}));

vi.mock("./ModelToggle", async (importOriginal) => ({
    ...(await importOriginal<typeof import("./ModelToggle")>()),
    ModelToggle: () => null,
}));

vi.mock("./AddDocButton", () => ({
    AddDocButton: () => <button aria-label="Add documents" />,
}));
vi.mock("./UploadOverlay", () => ({ UploadOverlay: () => null }));
vi.mock("../shared/FileTypeIcon", () => ({ FileTypeIcon: () => null }));
vi.mock("../modals/AddDocumentsModal", () => ({
    AddDocumentsModal: () => null,
}));
vi.mock("./AssistantWorkflowModal", () => ({
    AssistantWorkflowModal: () => null,
}));
vi.mock("../popups/ApiKeyMissingPopup", () => ({
    ApiKeyMissingPopup: () => null,
}));

class ResizeObserverMock {
    observe() {}
    disconnect() {}
}

function mockProfile() {
    vi.mocked(useUserProfile).mockReturnValue({
        profile: {
            openRouterModels: [],
            vercelModels: [],
            openCodeGoModels: [],
            apiKeys: {},
        },
        loading: false,
        apiKeysDegraded: false,
    } as unknown as ReturnType<typeof useUserProfile>);
}

function renderInput(canSend: boolean | null, onSubmit = vi.fn()) {
    render(
        <ChatInput
            onSubmit={onSubmit}
            onCancel={vi.fn()}
            isLoading={false}
            canSend={canSend}
            projectId="p1"
        />,
    );
    return onSubmit;
}

describe("ChatInput canSend gating", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        window.localStorage.clear();
        vi.stubGlobal("ResizeObserver", ResizeObserverMock);
        mockProfile();
    });

    it("renders a read-only composer when canSend is false", () => {
        renderInput(false);

        const textarea = screen.getByPlaceholderText(
            "Viewing only — sending needs edit access",
        );
        expect(textarea).toBeDisabled();
        expect(
            screen.getByRole("button", { name: "Send message" }),
        ).toBeDisabled();
        expect(
            screen.queryByRole("button", { name: "Add documents" }),
        ).toBeNull();
        expect(
            screen.queryByRole("button", { name: "Open workflows" }),
        ).toBeNull();
    });

    it("does not submit on Enter when canSend is false", () => {
        const onSubmit = renderInput(false);
        const textarea = screen.getByRole("combobox");

        fireEvent.keyDown(textarea, { key: "Enter" });
        expect(onSubmit).not.toHaveBeenCalled();
    });

    it("ignores window file drops when canSend is false", () => {
        renderInput(false);

        const file = new File(["x"], "dropped.pdf", {
            type: "application/pdf",
        });
        const dataTransfer = {
            types: ["Files"],
            files: [file],
        } as unknown as DataTransfer;
        fireEvent.drop(window, { dataTransfer });

        expect(uploadProjectDocument).not.toHaveBeenCalled();
    });

    it("stays neutral while the caller's standing is unknown", () => {
        // null is "not known yet", not "not allowed". The composer is closed
        // the same way, but accusing an owner of viewer status for the length
        // of a fetch — which is what every cold load did — is a wrong
        // statement, not a loading state.
        renderInput(null);

        const textarea = screen.getByPlaceholderText("Loading…");
        expect(textarea).toBeDisabled();
        expect(
            screen.queryByPlaceholderText(
                "Viewing only — sending needs edit access",
            ),
        ).toBeNull();
        expect(
            screen.getByRole("button", { name: "Send message" }),
        ).toBeDisabled();
    });

    it("does not submit on Enter while the standing is unknown", () => {
        const onSubmit = renderInput(null);
        const textarea = screen.getByRole("combobox");

        fireEvent.keyDown(textarea, { key: "Enter" });
        expect(onSubmit).not.toHaveBeenCalled();
    });

    it("keeps the default composer when canSend is omitted", () => {
        render(
            <ChatInput
                onSubmit={vi.fn()}
                onCancel={vi.fn()}
                isLoading={false}
                projectId="p1"
            />,
        );

        expect(
            screen.getByPlaceholderText("How can I help?"),
        ).not.toBeDisabled();
        expect(
            screen.getByRole("button", { name: "Add documents" }),
        ).toBeInTheDocument();
    });
});
