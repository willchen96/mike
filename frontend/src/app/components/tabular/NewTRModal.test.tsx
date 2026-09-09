import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    uploadProjectDocuments,
    uploadStandaloneDocuments,
} from "@/app/lib/mikeApi";
import { UPLOAD_LIMIT_MESSAGES } from "@/shared/api/uploadSessionClient";
import type { Document } from "../shared/types";
import { NewTRModal } from "./NewTRModal";

vi.mock("@/app/lib/mikeApi", async () => {
    // The upload error copy is real shared code; only the network calls are
    // stubbed, so the modal's failure messages are the ones users would see.
    const uploads = await vi.importActual<
        typeof import("@/shared/api/uploadSessionClient")
    >("@/shared/api/uploadSessionClient");
    class MikeApiError extends Error {
        status = 500;
    }
    return {
        MikeApiError,
        UploadBatchError: uploads.UploadBatchError,
        failedUploadMessage: uploads.failedUploadMessage,
        getProject: vi.fn(),
        listOrgMembers: vi.fn(async () => []),
        listWorkflows: vi.fn(async () => []),
        uploadProjectDocuments: vi.fn(),
        uploadStandaloneDocuments: vi.fn(),
    };
});

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

vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({ user: { id: "me", email: "me@firm.test" } }),
}));

vi.mock("@/app/hooks/useOllamaModels", () => ({
    useOllamaModels: () => [],
}));

vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("../shared/FileDirectory", () => ({
    FileDirectory: ({ tabs }: { tabs?: string[] }) => (
        <div>
            Document directory
            <span data-testid="directory-tabs">{tabs?.join(",")}</span>
        </div>
    ),
}));

describe("NewTRModal", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("shows folder grouping on the first screen and excludes Templates", () => {
        const onAdd = vi.fn();
        render(<NewTRModal open onClose={vi.fn()} onAdd={onAdd} />);

        expect(screen.getByText("Document grouping")).toBeInTheDocument();
        expect(screen.queryByLabelText("Organization")).not.toBeInTheDocument();
        expect(
            screen.getByText(
                "Treat documents in the same folder as one review row",
            ),
        ).toBeInTheDocument();

        const reviewNameInput = screen.getByLabelText("Review name");
        const modelSelect = screen.getByRole("button", {
            name: "Choose model",
        });
        expect(
            reviewNameInput.compareDocumentPosition(modelSelect) &
                Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
        expect(modelSelect).toHaveClass(
            "h-10",
            "w-full",
            "rounded-xl",
            "liquid-glass-subtle",
        );

        fireEvent.change(reviewNameInput, {
            target: { value: "Closing review" },
        });
        const groupingSwitch = screen.getByRole("switch", {
            name: "Treat documents in the same folder as one review row",
        });
        expect(groupingSwitch).toHaveAttribute("aria-checked", "false");
        fireEvent.click(groupingSwitch);
        expect(groupingSwitch).toHaveAttribute("aria-checked", "true");
        fireEvent.click(screen.getByRole("button", { name: "Next" }));

        expect(screen.queryByText("Document directory")).not.toBeInTheDocument();
        expect(screen.getByRole("dialog", { name: "Access" })).toBeVisible();
        expect(screen.getByText("Share Access")).toBeInTheDocument();
        const skip = screen.getByRole("button", { name: "Skip" });
        const accessNext = screen.getByRole("button", { name: "Next" });
        expect(skip.parentElement).toBe(accessNext.parentElement);
        expect(skip).toHaveClass("text-gray-500");
        expect(screen.getByRole("button", { name: "Back" })).toHaveClass(
            "bg-blue-600/90",
        );
        fireEvent.click(skip);
        expect(screen.getByText("Document directory")).toBeInTheDocument();
        expect(screen.getByTestId("directory-tabs")).toHaveTextContent(
            "files,projects",
        );
        expect(screen.queryByText("Document grouping")).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "Create" }));
        expect(onAdd).toHaveBeenCalledWith(
            "Closing review",
            undefined,
            undefined,
            undefined,
            "folder",
            "gemini-3-flash-preview",
            [],
        );
    });

    it("prevents duplicate review creation while submission is pending", async () => {
        let finishAdd: (() => void) | undefined;
        const onAdd = vi.fn(
            () =>
                new Promise<void>((resolve) => {
                    finishAdd = resolve;
                }),
        );
        const onClose = vi.fn();
        render(<NewTRModal open onClose={onClose} onAdd={onAdd} />);

        fireEvent.change(screen.getByLabelText("Review name"), {
            target: { value: "Single review" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Next" }));
        fireEvent.click(screen.getByRole("button", { name: "Next" }));

        expect(onAdd).not.toHaveBeenCalled();
        const create = screen.getByRole("button", { name: "Create" });
        fireEvent.click(create);
        fireEvent.click(create);

        expect(onAdd).toHaveBeenCalledTimes(1);
        expect(
            screen.getByRole("button", { name: "Creating..." }),
        ).toBeDisabled();

        finishAdd?.();
        await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    });

    it("stays open on a partial failure and lets Create retry it", async () => {
        // onAdd resolving with a message means the review exists but part of
        // the request did not happen. Closing here would hide the only account
        // of it, and reporting the generic create failure would be a lie.
        const onAdd = vi
            .fn()
            .mockResolvedValueOnce(
                "Review created, but access was not granted to colleague@firm.test: That address is not in your organization.",
            )
            .mockResolvedValueOnce(undefined);
        const onClose = vi.fn();
        render(<NewTRModal open onClose={onClose} onAdd={onAdd} />);

        fireEvent.change(screen.getByLabelText("Review name"), {
            target: { value: "Shared review" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Next" }));
        fireEvent.click(screen.getByRole("button", { name: "Next" }));
        fireEvent.click(screen.getByRole("button", { name: "Create" }));

        expect(await screen.findByRole("alert")).toHaveTextContent(
            "Review created, but access was not granted to colleague@firm.test: That address is not in your organization.",
        );
        expect(onClose).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole("button", { name: "Create" }));
        await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
        expect(onAdd).toHaveBeenCalledTimes(2);
    });

    it("retires Back once the review exists", async () => {
        // The retry reuses the created review, so the earlier steps no longer
        // describe anything that can still change: a Personal → project switch
        // between attempts left the review where it was first created while
        // applying the new scope's assignments to it.
        const onAdd = vi
            .fn()
            .mockResolvedValue(
                "Review created, but access was not granted to colleague@firm.test: That address is not in your organization.",
            );
        render(<NewTRModal open onClose={vi.fn()} onAdd={onAdd} />);

        fireEvent.change(screen.getByLabelText("Review name"), {
            target: { value: "Shared review" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Next" }));
        fireEvent.click(screen.getByRole("button", { name: "Next" }));
        expect(screen.getByRole("button", { name: "Back" })).toBeEnabled();

        fireEvent.click(screen.getByRole("button", { name: "Create" }));
        await screen.findByRole("alert");

        expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();
    });

    it("stores uploads from a project review in that project", async () => {
        const uploadedDocument = {
            id: "uploaded-document",
            project_id: "project-1",
            filename: "New agreement.pdf",
            file_type: "pdf",
        };
        vi.mocked(uploadProjectDocuments).mockResolvedValue([
            {
                clientId: "client-1",
                filename: "New agreement.pdf",
                status: "completed",
                result: uploadedDocument as Document,
                errorCode: null,
            },
        ]);

        render(
            <NewTRModal
                open
                onClose={vi.fn()}
                onAdd={vi.fn()}
                projectId="project-1"
                projectDocs={[]}
                projectFolders={[]}
                projectName="Acquisition"
            />,
        );

        fireEvent.change(screen.getByLabelText("Review name"), {
            target: { value: "Project review" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Next" }));
        fireEvent.click(screen.getByRole("button", { name: "Next" }));

        const file = new File(["agreement"], "New agreement.pdf", {
            type: "application/pdf",
        });
        const input =
            document.querySelector<HTMLInputElement>('input[type="file"]');
        fireEvent.change(input!, { target: { files: [file] } });

        await waitFor(() =>
            expect(uploadProjectDocuments).toHaveBeenCalledWith("project-1", [
                { file },
            ]),
        );
        expect(uploadStandaloneDocuments).not.toHaveBeenCalled();
    });

    async function attachFileOnDocumentsStep(filename: string) {
        render(
            <NewTRModal
                open
                onClose={vi.fn()}
                onAdd={vi.fn()}
                projectId="project-1"
                projectDocs={[]}
                projectFolders={[]}
                projectName="Acquisition"
            />,
        );
        fireEvent.change(screen.getByLabelText("Review name"), {
            target: { value: "Project review" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Next" }));
        fireEvent.click(screen.getByRole("button", { name: "Next" }));
        const input =
            document.querySelector<HTMLInputElement>('input[type="file"]');
        fireEvent.change(input!, {
            target: {
                files: [new File(["body"], filename, { type: "application/pdf" })],
            },
        });
    }

    it("reports files that came back as failed outcomes", async () => {
        vi.mocked(uploadProjectDocuments).mockResolvedValue([
            {
                clientId: "client-1",
                filename: "Too big.pdf",
                status: "error",
                result: null,
                errorCode: "upload_file_too_large",
            },
        ]);

        await attachFileOnDocumentsStep("Too big.pdf");

        await waitFor(() =>
            expect(screen.getByRole("alert")).toHaveTextContent(
                UPLOAD_LIMIT_MESSAGES.upload_file_too_large,
            ),
        );
    });

    it("reports a thrown upload batch failure", async () => {
        const { UploadBatchError } = await import("@/app/lib/mikeApi");
        vi.mocked(uploadProjectDocuments).mockRejectedValue(
            new UploadBatchError("batch failed", [
                {
                    clientId: "client-1",
                    filename: "Rejected.pdf",
                    status: "error",
                    result: null,
                    errorCode: null,
                },
            ]),
        );

        await attachFileOnDocumentsStep("Rejected.pdf");

        await waitFor(() =>
            expect(screen.getByRole("alert")).toHaveTextContent(
                "Rejected.pdf could not be uploaded. Please try again.",
            ),
        );
    });

    it("reports a transport failure without leaking the raw error", async () => {
        vi.mocked(uploadProjectDocuments).mockRejectedValue(
            new TypeError("Failed to fetch"),
        );

        await attachFileOnDocumentsStep("Dropped.pdf");

        await waitFor(() =>
            expect(screen.getByRole("alert")).toHaveTextContent(
                "The selected files could not be uploaded. Please try again.",
            ),
        );
        expect(screen.queryByText(/Failed to fetch/)).not.toBeInTheDocument();
    });
});
