import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    fireEvent,
    render,
    screen,
    waitFor,
    within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
    MikeApiError,
    createProject,
    grantProjectAccess,
    listOrgMembers,
    listOrgs,
    lookupUserByEmail,
    uploadProjectDocuments,
} from "@/app/lib/mikeApi";
import { NewProjectModal } from "./NewProjectModal";

const { useUserProfile } = vi.hoisted(() => ({
    useUserProfile: vi.fn(),
}));

// `importOriginal` keeps the real `MikeApiError`, which `userFacingApiError`
// recognises with `instanceof` — a stand-in would make the failure case pass
// for the wrong reason.
vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
    createProject: vi.fn(),
    grantProjectAccess: vi.fn(),
    addDocumentToProject: vi.fn(),
    uploadProjectDocument: vi.fn(),
    uploadProjectDocuments: vi.fn(),
    listOrgs: vi.fn(),
    listOrgMembers: vi.fn(),
    lookupUserByEmail: vi.fn(),
}));
vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({ user: { id: "me", email: "me@firm.test" } }),
}));
vi.mock("@/app/contexts/UserProfileContext", () => ({
    useUserProfile,
}));
vi.mock("../shared/FileDirectory", () => ({ FileDirectory: () => null }));
vi.mock("./ProjectPracticeField", () => ({
    ProjectPracticeField: ({ id, value }: { id: string; value: string }) => (
        <button id={id} type="button">
            {value || "None"}
        </button>
    ),
}));

const CREATED = {
    id: "p1",
    name: "Matter",
    user_id: "me",
    cm_number: null,
    practice: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
};

async function fillAndAdd(
    user: ReturnType<typeof userEvent.setup>,
    email: string,
    role: string,
) {
    await user.type(screen.getByPlaceholderText("Add project name"), "Matter");
    expect(
        screen.queryByPlaceholderText("Add by email..."),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next" }));
    if (role !== "editor") {
        await user.click(
            screen.getByRole("button", { name: /Role for the new recipient/ }),
        );
        await user.click(
            screen.getByRole("menuitem", {
                name: role[0].toUpperCase() + role.slice(1),
            }),
        );
    }
    await user.type(screen.getByPlaceholderText("Add by email..."), email);
    await user.click(screen.getByRole("button", { name: "Add" }));
}

async function submit(user: ReturnType<typeof userEvent.setup>) {
    if (!screen.queryByRole("button", { name: "Create project" })) {
        const detailsNext = screen.getByRole("button", { name: "Next" });
        await waitFor(() => expect(detailsNext).toBeEnabled());
        await user.click(detailsNext);
    }
    if (!screen.queryByRole("button", { name: "Create project" })) {
        await waitFor(() =>
            expect(
                screen.getByRole("dialog", { name: "Access" }),
            ).toBeVisible(),
        );
        expect(screen.getByText("Share Access")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Next" }));
    }
    await user.click(
        await screen.findByRole("button", { name: "Create project" }),
    );
}

function renderModal(onCreated = vi.fn()) {
    render(<NewProjectModal open onClose={vi.fn()} onCreated={onCreated} />);
    return onCreated;
}

describe("NewProjectModal sharing", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(listOrgs).mockResolvedValue([]);
        vi.mocked(listOrgMembers).mockResolvedValue([]);
        vi.mocked(createProject).mockResolvedValue(CREATED as never);
        vi.mocked(grantProjectAccess).mockResolvedValue({} as never);
        vi.mocked(uploadProjectDocuments).mockResolvedValue([]);
        vi.mocked(lookupUserByEmail).mockImplementation(async (email) => ({
            exists: true,
            email,
            display_name: "Existing user",
        }));
        useUserProfile.mockReturnValue({ profile: { practiceAreas: [] } });
    });

    it("starts with the user's first preset practice area", async () => {
        useUserProfile.mockReturnValue({
            profile: { practiceAreas: ["Corporate and M&A", "Litigation"] },
        });
        renderModal();

        expect(await screen.findByLabelText("Practice")).toHaveTextContent(
            "Corporate and M&A",
        );
    });

    it("shares with an existing user at the chosen role", async () => {
        const user = userEvent.setup({ delay: null });
        const onCreated = renderModal();

        await fillAndAdd(user, "outside@counsel.test", "viewer");
        await submit(user);

        await waitFor(() =>
            expect(grantProjectAccess).toHaveBeenCalledWith(
                "p1",
                "outside@counsel.test",
                "viewer",
            ),
        );
        expect(lookupUserByEmail).toHaveBeenCalledWith("outside@counsel.test");
        expect(onCreated).toHaveBeenCalled();
    });

    it("does not add an email that has no Mike account", async () => {
        vi.mocked(lookupUserByEmail).mockResolvedValueOnce({
            exists: false,
            email: "future@firm.test",
            display_name: null,
        });
        const user = userEvent.setup({ delay: null });
        renderModal();

        await fillAndAdd(user, "future@firm.test", "viewer");

        expect(
            await screen.findByText(
                "future@firm.test does not belong to a Mike user.",
            ),
        ).toBeInTheDocument();
        expect(grantProjectAccess).not.toHaveBeenCalled();
        expect(
            screen.queryByRole("button", { name: "Role for future@firm.test" }),
        ).not.toBeInTheDocument();
    });

    it("hands the list a row that says the creator is its owner", async () => {
        // POST /projects returns a bare row with no role fields, and the
        // list's fail-closed roleFrom() reads that as viewer — so the
        // creator had no row menu, no Edit details and no Delete on the
        // project they just made until a refetch. The optimistic row must
        // say what the server will serve for it on every future load.
        const user = userEvent.setup({ delay: null });
        const onCreated = renderModal();
        await user.type(screen.getByPlaceholderText("Add project name"), "P");
        await submit(user);

        await waitFor(() => expect(onCreated).toHaveBeenCalled());
        expect(onCreated).toHaveBeenCalledWith(
            expect.objectContaining({
                is_owner: true,
                access_role: "owner",
                access_scope: "private",
            }),
        );
    });

    it("does not create or redirect until document selection is finished", async () => {
        const user = userEvent.setup({ delay: null });
        const onCreated = renderModal();

        await user.type(
            screen.getByPlaceholderText("Add project name"),
            "Matter",
        );
        await user.click(screen.getByRole("button", { name: "Next" }));
        expect(screen.getByRole("dialog", { name: "Access" })).toBeVisible();
        expect(createProject).not.toHaveBeenCalled();
        expect(onCreated).not.toHaveBeenCalled();

        const accessNext = screen.getByRole("button", { name: "Next" });
        expect(accessNext).toHaveAttribute("type", "button");
        await user.click(accessNext);
        expect(
            screen.getByRole("dialog", { name: "Add Documents" }),
        ).toBeVisible();
        expect(createProject).not.toHaveBeenCalled();
        expect(onCreated).not.toHaveBeenCalled();

        const form = document.getElementById("new-project-modal-form");
        expect(form).not.toBeNull();
        fireEvent.submit(form!);
        expect(createProject).not.toHaveBeenCalled();

        const create = screen.getByRole("button", { name: "Create project" });
        expect(create).toHaveAttribute("type", "button");
        await user.click(create);
        await waitFor(() => expect(createProject).toHaveBeenCalledTimes(1));
        expect(onCreated).toHaveBeenCalled();
    });

    it("creates grants through the role-aware endpoint", async () => {
        const user = userEvent.setup({ delay: null });
        const onCreated = renderModal();

        await fillAndAdd(user, "counsel@firm.test", "owner");
        await submit(user);

        await waitFor(() => expect(createProject).toHaveBeenCalled());
        await waitFor(() =>
            expect(grantProjectAccess).toHaveBeenCalledWith(
                "p1",
                "counsel@firm.test",
                "owner",
            ),
        );
        expect(onCreated).toHaveBeenCalledWith(
            expect.objectContaining({
                access_scope: "shared",
                direct_grant_count: 1,
            }),
        );
    });

    it("gives each recipient their own role", { timeout: 15000 }, async () => {
        const user = userEvent.setup({ delay: null });
        renderModal();

        await fillAndAdd(user, "one@firm.test", "owner");
        await user.click(
            screen.getByRole("button", { name: /Role for the new recipient/ }),
        );
        await user.click(screen.getByRole("menuitem", { name: "Viewer" }));
        await user.type(
            screen.getByPlaceholderText("Add by email..."),
            "two@firm.test",
        );
        await user.click(screen.getByRole("button", { name: "Add" }));

        // Each row carries its own picker, and changing one leaves the other.
        await user.click(
            screen.getByRole("button", { name: "Role for one@firm.test" }),
        );
        await user.click(screen.getByRole("menuitem", { name: "Editor" }));
        expect(
            screen.getByRole("button", { name: "Role for two@firm.test" }),
        ).toHaveTextContent("Viewer");

        await submit(user);

        await waitFor(() =>
            expect(grantProjectAccess).toHaveBeenCalledWith(
                "p1",
                "one@firm.test",
                "editor",
            ),
        );
        expect(grantProjectAccess).toHaveBeenCalledWith(
            "p1",
            "two@firm.test",
            "viewer",
        );
    });

    it("reports a refused grant and does not create a second project on retry", async () => {
        const user = userEvent.setup({ delay: null });
        const onCreated = renderModal();
        vi.mocked(grantProjectAccess).mockRejectedValueOnce(
            new MikeApiError({
                status: 400,
                message: "The project creator already has owner access",
            }),
        );

        await fillAndAdd(user, "counsel@firm.test", "editor");
        await submit(user);

        expect(
            await screen.findByText(
                /Project created, but access was not granted to counsel@firm.test: The project creator already has owner access/,
            ),
        ).toBeInTheDocument();
        // The dialog stays open on the only screen that knows sharing failed.
        expect(onCreated).not.toHaveBeenCalled();

        // Retry: the project already exists, so it must not be created twice.
        await user.click(
            screen.getByRole("button", { name: "Create project" }),
        );
        await waitFor(() => expect(onCreated).toHaveBeenCalled());
        expect(createProject).toHaveBeenCalledTimes(1);
        expect(grantProjectAccess).toHaveBeenCalledTimes(2);
    });

    it("shows direct sharing only on step two with Owner, Editor and Viewer", async () => {
        const user = userEvent.setup({ delay: null });
        renderModal();
        await user.type(
            screen.getByPlaceholderText("Add project name"),
            "Matter",
        );
        expect(
            screen.queryByPlaceholderText("Add by email..."),
        ).not.toBeInTheDocument();
        const next = screen.getByRole("button", { name: "Next" });
        await waitFor(() => expect(next).toBeEnabled());
        await user.click(next);
        const skip = screen.getByRole("button", { name: "Skip" });
        const accessNext = screen.getByRole("button", { name: "Next" });
        expect(skip.parentElement).toBe(accessNext.parentElement);
        expect(skip).toHaveClass("text-gray-500");
        expect(screen.getByRole("button", { name: "Back" })).toHaveClass(
            "bg-blue-600/90",
        );
        const trigger = await screen.findByRole("button", {
            name: /Role for the new recipient/,
        });
        expect(trigger).toHaveTextContent("Editor");
        await user.click(trigger);
        expect(
            screen.getAllByRole("menuitem").map((item) => item.textContent),
        ).toEqual(["Owner", "Editor", "Viewer"]);
    });

    it("adds organization Owners and denied members through typeahead fields", async () => {
        const user = userEvent.setup({ delay: null });
        vi.mocked(listOrgs).mockResolvedValue([
            { id: "org-1", name: "Elite Law LLP" } as never,
        ]);
        vi.mocked(listOrgMembers).mockResolvedValue([
            {
                user_id: "me",
                email: "me@firm.test",
                display_name: "Project Creator",
                role: "member",
                created_at: "2026-01-01T00:00:00Z",
            },
            {
                user_id: "member-owner",
                email: "lead@elite.test",
                display_name: "Project Lead",
                role: "member",
                created_at: "2026-01-01T00:00:00Z",
            },
            {
                user_id: "member-denied",
                email: "blocked@elite.test",
                display_name: "Blocked Member",
                role: "member",
                created_at: "2026-01-01T00:00:00Z",
            },
            {
                user_id: "org-admin",
                email: "admin@elite.test",
                display_name: "Organization Admin",
                role: "admin",
                created_at: "2026-01-01T00:00:00Z",
            },
        ] as never);
        renderModal();
        await user.click(screen.getByLabelText("Share across Organisation"));
        await user.click(
            await screen.findByRole("menuitem", { name: "Elite Law LLP" }),
        );
        await user.type(
            screen.getByPlaceholderText("Add project name"),
            "Matter",
        );
        await user.click(screen.getByRole("button", { name: "Next" }));
        expect(
            screen.getByRole("dialog", { name: "Organisational Access" }),
        ).toBeVisible();
        await screen.findByRole("searchbox", { name: "Project owners" });
        expect(
            screen.getByText(
                "Add Elite Law LLP members as owners with rights to manage access, settings and delete the project.",
            ),
        ).not.toHaveClass("pl-3");
        expect(screen.queryByText("Project Lead")).not.toBeInTheDocument();
        expect(screen.queryByText("Blocked Member")).not.toBeInTheDocument();

        const ownerPicker = screen.getByRole("searchbox", {
            name: "Project owners",
        });
        const denyToggle = screen.getByRole("button", { name: "Deny list" });
        expect(denyToggle).toHaveAttribute("aria-expanded", "false");
        expect(
            screen.queryByRole("searchbox", { name: "Deny list" }),
        ).not.toBeInTheDocument();
        await user.click(denyToggle);
        const denyPicker = screen.getByRole("searchbox", {
            name: "Deny list",
        });
        expect(
            screen.getByText(
                "Deny Elite Law LLP members from accessing this project.",
            ),
        ).not.toHaveClass("pl-3");
        await user.type(ownerPicker, "Organization Admin");
        expect(
            screen.queryByRole("option", { name: /Organization Admin/ }),
        ).not.toBeInTheDocument();
        await user.clear(ownerPicker);
        await user.type(denyPicker, "Organization Admin");
        expect(
            screen.queryByRole("option", { name: /Organization Admin/ }),
        ).not.toBeInTheDocument();
        await user.clear(denyPicker);

        await user.type(ownerPicker, "lead");
        await user.click(
            await screen.findByRole("option", { name: /Project Lead/ }),
        );
        await user.type(denyPicker, "blocked");
        await user.click(
            await screen.findByRole("option", { name: /Blocked Member/ }),
        );

        const ownerList = screen.getByRole("list", {
            name: "Project owners list",
        });
        const denyList = screen.getByRole("list", {
            name: "Deny list entries",
        });
        expect(within(ownerList).getByText("Project Lead")).toBeInTheDocument();
        expect(
            within(ownerList).getByText("Project Creator"),
        ).toBeInTheDocument();
        expect(within(ownerList).getByText("lead@elite.test")).toHaveClass(
            "justify-self-end",
        );
        expect(
            within(ownerList).queryByRole("button", {
                name: "Remove me@firm.test",
            }),
        ).not.toBeInTheDocument();
        expect(
            within(denyList).getByText("Blocked Member"),
        ).toBeInTheDocument();
        expect(ownerList.parentElement).toHaveClass("h-28", "overflow-y-auto");
        expect(denyList.parentElement).toHaveClass("h-28", "overflow-y-auto");
        expect(
            ownerList.closest('[data-slot="organization-access-editor"]'),
        ).not.toHaveClass("overflow-y-auto");
        await submit(user);
        await waitFor(() =>
            expect(grantProjectAccess).toHaveBeenCalledWith(
                "p1",
                "lead@elite.test",
                "owner",
            ),
        );
        expect(grantProjectAccess).toHaveBeenCalledWith(
            "p1",
            "blocked@elite.test",
            "deny",
        );
    });

    async function attachPendingFile(filename: string) {
        const fileInput = document.querySelector(
            'input[type="file"]',
        ) as HTMLInputElement;
        expect(fileInput).not.toBeNull();
        fireEvent.change(fileInput, {
            target: { files: [new File(["contents"], filename)] },
        });
        await screen.findByRole("button", { name: /Upload \(1\)/ });
    }

    it("uploads an attached file once when a refused grant is retried", async () => {
        // The grant refusal used to return with the pending files still
        // queued, so the retry — which correctly skipped creation — re-ran the
        // upload and the project ended up with the same document twice.
        const user = userEvent.setup({ delay: null });
        const onCreated = vi.fn();
        render(
            <NewProjectModal open onClose={vi.fn()} onCreated={onCreated} />,
        );
        vi.mocked(grantProjectAccess).mockRejectedValueOnce(
            new MikeApiError({ status: 403, message: "Not allowed" }),
        );
        vi.mocked(uploadProjectDocuments).mockResolvedValue([
            {
                clientId: "c1",
                filename: "brief.pdf",
                status: "completed",
                result: null,
                errorCode: null,
            },
        ]);

        await fillAndAdd(user, "counsel@firm.test", "editor");
        await user.click(screen.getByRole("button", { name: "Next" }));
        await attachPendingFile("brief.pdf");

        await user.click(
            screen.getByRole("button", { name: "Create project" }),
        );
        expect(
            await screen.findByText(
                /Project created, but access was not granted to counsel@firm\.test/,
            ),
        ).toBeInTheDocument();
        // Grants run first, so a refusal leaves no upload to redo.
        expect(uploadProjectDocuments).not.toHaveBeenCalled();

        await user.click(
            screen.getByRole("button", { name: "Create project" }),
        );
        await waitFor(() => expect(onCreated).toHaveBeenCalled());
        expect(createProject).toHaveBeenCalledTimes(1);
        expect(uploadProjectDocuments).toHaveBeenCalledTimes(1);
    });

    it("tells the caller to refetch when a created project is never handed over", async () => {
        const user = userEvent.setup({ delay: null });
        const onClose = vi.fn();
        const onCreated = vi.fn();
        render(<NewProjectModal open onClose={onClose} onCreated={onCreated} />);
        vi.mocked(grantProjectAccess).mockRejectedValue(
            new MikeApiError({ status: 403, message: "Not allowed" }),
        );

        await fillAndAdd(user, "counsel@firm.test", "editor");
        await submit(user);
        await screen.findByText(/Project created, but access was not granted/);

        await user.click(screen.getByRole("button", { name: "Close" }));
        expect(onCreated).not.toHaveBeenCalled();
        expect(onClose).toHaveBeenCalledWith(true);
    });

    it("cannot be dismissed while the project is being created", async () => {
        const user = userEvent.setup({ delay: null });
        const onClose = vi.fn();
        // Never settles: the create is still in flight when the user tries to
        // leave, and dismissing then would strand the outcome.
        vi.mocked(createProject).mockReturnValue(new Promise(() => {}) as never);
        render(<NewProjectModal open onClose={onClose} onCreated={vi.fn()} />);

        await user.type(screen.getByPlaceholderText("Add project name"), "P");
        await submit(user);
        await waitFor(() => expect(createProject).toHaveBeenCalled());

        await user.click(screen.getByRole("button", { name: "Close" }));
        fireEvent.keyDown(document, { key: "Escape" });
        expect(onClose).not.toHaveBeenCalled();
    });

    it("keeps two files that happen to share a name", async () => {
        // The picker deduplicated by NAME, so the second `contract.pdf` — a
        // normal thing to attach from two different folders — was dropped
        // without a word.
        const user = userEvent.setup({ delay: null });
        renderModal();

        await user.type(screen.getByPlaceholderText("Add project name"), "P");
        await user.click(screen.getByRole("button", { name: "Next" }));
        await user.click(screen.getByRole("button", { name: "Next" }));

        const input = document.querySelector(
            'input[type="file"]',
        ) as HTMLInputElement;
        // Two separate picks, as a user attaching from two folders makes
        // them: the name test compared each new file against the ones
        // already staged, so the second one never arrived.
        fireEvent.change(input, {
            target: { files: [new File(["a"], "contract.pdf")] },
        });
        fireEvent.change(input, {
            target: { files: [new File(["b"], "contract.pdf")] },
        });

        expect(
            await screen.findByRole("button", { name: /Upload \(2\)/ }),
        ).toBeInTheDocument();

        await user.click(
            screen.getByRole("button", { name: "Create project" }),
        );

        await waitFor(() => expect(uploadProjectDocuments).toHaveBeenCalled());
        const [, sentFiles] = vi.mocked(uploadProjectDocuments).mock.calls[0];
        expect(sentFiles).toHaveLength(2);
        // Each carries its own id, so an outcome can be traced back to the
        // File that produced it rather than to a name they share.
        expect(sentFiles[0].clientId).toBeTruthy();
        expect(sentFiles[0].clientId).not.toBe(sentFiles[1].clientId);
    });

    it("says the attached files are still pending when a grant is refused", async () => {
        // Grants run before the attachments, so a refusal there means nothing
        // the user picked has been sent — an error that mentions only the
        // sharing reads as though the files went in.
        const user = userEvent.setup({ delay: null });
        renderModal();
        vi.mocked(grantProjectAccess).mockRejectedValue(
            new MikeApiError({ status: 403, message: "Not allowed" }),
        );

        await fillAndAdd(user, "counsel@firm.test", "editor");
        await user.click(screen.getByRole("button", { name: "Next" }));
        const input = document.querySelector(
            'input[type="file"]',
        ) as HTMLInputElement;
        fireEvent.change(input, {
            target: { files: [new File(["a"], "a.pdf"), new File(["b"], "b.pdf")] },
        });
        await user.click(
            await screen.findByRole("button", { name: "Create project" }),
        );

        expect(
            await screen.findByText(
                /The 2 selected files are still pending and will be attached when you try again\./,
            ),
        ).toBeInTheDocument();
        expect(uploadProjectDocuments).not.toHaveBeenCalled();
    });

    it("retires Back once the project exists", async () => {
        // The retry reuses the created project, so a Personal → organization
        // switch on the second attempt left the project where it was and
        // applied the new organization's overrides to it.
        const user = userEvent.setup({ delay: null });
        renderModal();
        vi.mocked(grantProjectAccess).mockRejectedValue(
            new MikeApiError({ status: 403, message: "Not allowed" }),
        );

        await fillAndAdd(user, "counsel@firm.test", "editor");
        await user.click(screen.getByRole("button", { name: "Next" }));
        expect(screen.getByRole("button", { name: "Back" })).toBeEnabled();

        await user.click(
            await screen.findByRole("button", { name: "Create project" }),
        );
        await screen.findByText(/Project created, but access was not granted/);

        expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();
    });

    it("says so when the organization list cannot be loaded", async () => {
        vi.mocked(listOrgs).mockRejectedValue(
            new MikeApiError({ status: 500, message: "boom" }),
        );
        render(<NewProjectModal open onClose={vi.fn()} onCreated={vi.fn()} />);

        expect(
            await screen.findByText("Your organizations could not be loaded."),
        ).toBeInTheDocument();
    });
});
