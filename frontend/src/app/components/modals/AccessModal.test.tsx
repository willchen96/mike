import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getOrg, lookupUserByEmail, MikeApiError } from "@/app/lib/mikeApi";
import { AccessModal } from "./AccessModal";
import { OrganizationAccessEditor } from "./AccessEditor";

// `importOriginal` keeps the real `MikeApiError` class: `userFacingApiError`
// decides with `instanceof`, so a stand-in class would make every 4xx look
// like an unexpected failure and the tests below would pass vacuously.
vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
    getOrg: vi.fn(),
    lookupUserByEmail: vi.fn().mockResolvedValue({
        exists: true,
        email: "known@firm.example",
        display_name: "Known",
    }),
}));

const PROJECT = {
    id: "p1",
    owner_email: "creator@firm.example",
    owner_display_name: "Creator",
};

function accessResponse() {
    return Promise.resolve({
        owner: {
            user_id: "u1",
            email: "creator@firm.example",
            display_name: "Creator",
            role: "owner" as const,
        },
        members: [
            {
                email: "counsel@outside.example",
                display_name: null,
                role: "viewer" as const,
            },
        ],
    });
}

function renderRoleAware(overrides?: {
    canManage?: boolean;
    orgId?: string | null;
    onGrant?: (email: string, role: string) => Promise<void>;
    onRevoke?: (email: string) => Promise<void>;
}) {
    const onGrant = overrides?.onGrant ?? vi.fn().mockResolvedValue(undefined);
    const onRevoke =
        overrides?.onRevoke ?? vi.fn().mockResolvedValue(undefined);
    render(
        <AccessModal
            open
            onClose={vi.fn()}
            resource={PROJECT}
            fetchAccess={accessResponse}
            currentUserEmail="me@firm.example"
            breadcrumb={["Projects", "Matter", "Access"]}
            access={{
                grants: [
                    { email: "counsel@outside.example", role: "viewer" },
                ],
                orgId: overrides?.orgId ?? null,
                canManage: overrides?.canManage ?? true,
                onGrant: onGrant as never,
                onRevoke,
            }}
        />,
    );
    return { onGrant, onRevoke };
}

describe("AccessModal — per-recipient roles", () => {
    beforeEach(() => {
        vi.mocked(getOrg).mockResolvedValue({
            id: "org-1",
            name: "Elite Law LLP",
            created_by: "u1",
            role: "admin",
        });
        vi.mocked(lookupUserByEmail).mockImplementation(async (email) => ({
            exists: true,
            email,
            display_name: "Known",
        }));
    });

    it("presents the roster as Name, Email and Role columns", async () => {
        renderRoleAware();

        expect(screen.getByRole("dialog", { name: "Access" })).toBeVisible();
        expect(screen.getByText("Share Access")).toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: "About access roles" }),
        ).toBeInTheDocument();
        const roleTooltip = screen.getByRole("tooltip", { hidden: true });
        expect(roleTooltip).toHaveClass(
            "peer-hover:visible",
            "peer-focus-visible:visible",
        );
        expect(
            within(roleTooltip).getByText("Roles and rights"),
        ).toBeInTheDocument();
        expect(within(roleTooltip).getByText("Owner")).toBeInTheDocument();
        expect(within(roleTooltip).getByText("Editor")).toBeInTheDocument();
        expect(within(roleTooltip).getByText("Viewer")).toBeInTheDocument();
        expect(within(roleTooltip).getByText("Read-only.")).toBeInTheDocument();
        expect(
            screen.getByRole("button", {
                name: /Role for the new recipient/,
            }),
        ).not.toHaveAttribute("title");
        expect(await screen.findByText("Name")).toBeInTheDocument();
        expect(screen.getByText("Email")).toHaveClass(
            "justify-self-start",
            "text-left",
        );
        expect(screen.getByText("Role")).toHaveClass(
            "justify-self-start",
            "text-left",
        );
        expect(screen.queryByText("People with Access")).not.toBeInTheDocument();

        const creatorRow = screen
            .getByText("Creator")
            .closest<HTMLElement>('[role="listitem"]');
        expect(creatorRow).not.toBeNull();
        expect(creatorRow?.tagName).toBe("DIV");
        expect(creatorRow?.parentElement?.tagName).toBe("DIV");
        expect(creatorRow).toHaveClass(
            "grid-cols-[minmax(0,1fr)_minmax(8rem,12rem)_5rem_1.5rem]",
        );
        expect(creatorRow).not.toHaveClass(
            "grid-cols-[minmax(0,1fr)_minmax(10rem,16rem)_5rem_1.5rem]",
        );
        expect(
            within(creatorRow!).getByText("creator@firm.example"),
        ).toHaveClass("justify-self-start", "text-left");
        const ownerPill = within(creatorRow!).getByText("Owner");
        expect(ownerPill).toHaveClass(
            "h-6",
            "bg-blue-100",
            "text-blue-700",
        );
        expect(ownerPill).not.toHaveClass("min-w-20");
        expect(ownerPill.className).not.toMatch(/(?:^|\s)(?:min-|max-)?w-/);
        expect(ownerPill).toHaveClass("justify-self-start", "text-left");
        expect(ownerPill.parentElement).not.toHaveClass("justify-self-end");

        expect(screen.getAllByText("Read-only.")).toHaveLength(1);
    });

    it("groups the email, role picker and Add action in that order", async () => {
        const user = userEvent.setup();
        renderRoleAware();

        const roleToggle = await screen.findByRole("button", {
            name: /Role for the new recipient/,
        });
        const emailInput = screen.getByPlaceholderText("Add by email...");
        const inputGroup = emailInput.closest(
            '[data-slot="add-user-input-group"]',
        );
        const addButton = screen.getByRole("button", { name: "Add" });

        expect(inputGroup).toContainElement(roleToggle);
        expect(inputGroup).toContainElement(addButton);
        expect(
            emailInput.compareDocumentPosition(roleToggle) &
                Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
        expect(
            roleToggle.compareDocumentPosition(addButton) &
                Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
        expect(roleToggle).toHaveAttribute("data-slot", "dropdown-menu-trigger");
        expect(roleToggle).not.toHaveClass("border-l");
        expect(roleToggle).toHaveClass("bg-transparent", "text-violet-700");
        expect(roleToggle).not.toHaveClass("bg-violet-100");
        expect(roleToggle.querySelector("svg")).toHaveClass("text-gray-300");
        expect(addButton).toHaveClass(
            "self-stretch",
            "pr-4",
        );
        expect(addButton).not.toHaveClass("border-l");
        expect(addButton).toBeDisabled();
        const roleInfo = screen.getByRole("button", {
            name: "About access roles",
        });
        expect(roleInfo).toHaveAttribute(
            "aria-describedby",
            "access-role-rights",
        );
        expect(
            screen.getByText(/Edit content, upload documents/).closest(
                '[role="tooltip"]',
            ),
        ).toHaveClass("invisible");

        await user.click(roleToggle);
        expect(screen.getByRole("menu")).toHaveClass(
            "z-[250]",
            "w-32",
            "space-y-1",
        );
        expect(screen.getByRole("menu")).not.toHaveClass("w-36");
        const editorOption = screen.getByRole("menuitem", { name: "Editor" });
        expect(editorOption).toHaveAttribute("data-selected", "true");
        expect(editorOption).toHaveClass(
            "text-violet-700",
            "hover:!bg-violet-100",
            "data-[selected=true]:!bg-violet-100",
        );
    });

    it("matches the new-recipient role toggle color to its selected role", async () => {
        const user = userEvent.setup();
        renderRoleAware();

        const roleToggle = await screen.findByRole("button", {
            name: /Role for the new recipient/,
        });
        expect(roleToggle).toHaveClass("bg-transparent", "text-violet-700");
        expect(roleToggle).not.toHaveClass("bg-violet-100");

        await user.click(roleToggle);
        await user.click(screen.getByRole("menuitem", { name: "Owner" }));
        expect(roleToggle).toHaveClass("bg-transparent", "text-blue-700");
        expect(roleToggle).not.toHaveClass("bg-blue-100");

        await user.click(roleToggle);
        await user.click(screen.getByRole("menuitem", { name: "Viewer" }));
        expect(roleToggle).toHaveClass("bg-transparent", "text-gray-600");
        expect(roleToggle).not.toHaveClass("bg-gray-100");
    });

    it("offers Owner, Editor and Viewer for each direct recipient", async () => {
        const user = userEvent.setup();
        renderRoleAware();
        const rolePill = await screen.findByRole("button", {
            name: "Role for counsel@outside.example",
        });
        expect(rolePill).toHaveClass(
            "h-6",
            "bg-gray-100",
            "text-gray-600",
        );
        expect(rolePill).not.toHaveClass("min-w-20");
        expect(rolePill.className).not.toMatch(/(?:^|\s)(?:min-|max-)?w-/);
        expect(rolePill).toHaveClass("justify-self-start", "text-left");

        await user.click(rolePill);
        expect(screen.getByRole("menu")).toHaveClass(
            "z-[250]",
            "w-32",
            "space-y-1",
        );
        const viewerOption = screen.getByRole("menuitem", { name: "Viewer" });
        expect(viewerOption).toHaveAttribute("data-selected", "true");
        expect(viewerOption).toHaveClass(
            "text-gray-600",
            "hover:!bg-gray-100",
            "data-[selected=true]:!bg-gray-100",
        );
        expect(screen.getByRole("menuitem", { name: "Owner" })).toHaveClass(
            "text-blue-700",
            "hover:!bg-blue-100",
        );
        expect(
            screen.getAllByRole("menuitem").map((item) => item.textContent),
        ).toEqual(["Owner", "Editor", "Viewer"]);
    });

    it("re-roles a recipient through the grants API", async () => {
        const user = userEvent.setup();
        const { onGrant } = renderRoleAware();
        await user.click(
            await screen.findByRole("button", {
                name: "Role for counsel@outside.example",
            }),
        );
        await user.click(screen.getByRole("menuitem", { name: "Owner" }));
        await waitFor(() =>
            expect(onGrant).toHaveBeenCalledWith(
                "counsel@outside.example",
                "owner",
            ),
        );
    });

    it("refuses an address that does not belong to an existing user", async () => {
        const user = userEvent.setup();
        const { onGrant } = renderRoleAware();
        vi.mocked(lookupUserByEmail).mockResolvedValueOnce({
            exists: false,
            email: "newcounsel@outside.example",
            display_name: null,
        });
        await user.click(
            await screen.findByRole("button", {
                name: /Role for the new recipient/,
            }),
        );
        await user.click(screen.getByRole("menuitem", { name: "Viewer" }));
        await user.click(
            screen.getByPlaceholderText("Add by email..."),
        );
        // paste, not per-key typing: one input event cannot be cut off
        // mid-word by a slow re-render on a loaded machine.
        await user.paste("newcounsel@outside.example");
        await user.click(screen.getByRole("button", { name: "Add" }));
        expect(
            await screen.findByText(
                "newcounsel@outside.example does not belong to a Mike user.",
            ),
        ).toBeInTheDocument();
        expect(onGrant).not.toHaveBeenCalled();
        expect(lookupUserByEmail).toHaveBeenCalledWith(
            "newcounsel@outside.example",
        );
    });

    it("shows the server's own refusal instead of a fixed retry line", async () => {
        // The grants endpoint writes its 400s to be read by a person — "The
        // project creator already has owner access", "role must be owner,
        // editor or viewer". `handleAdd` caught them and threw
        // `new Error("Couldn't add the member. Try again.")`, so by the time
        // AddUserInput's own `userFacingApiError` saw it there was no status
        // left to read, and the user was advised to repeat something that
        // would fail identically.
        const user = userEvent.setup();
        renderRoleAware({
            onGrant: () =>
                Promise.reject(
                    new MikeApiError({
                        status: 400,
                        message:
                            "The project creator already has owner access",
                    }),
                ),
        });
        await screen.findByRole("button", {
            name: /Role for the new recipient/,
        });
        await user.click(
            screen.getByPlaceholderText("Add by email..."),
        );
        // paste, not per-key typing: one input event cannot be cut off
        // mid-word by a slow re-render on a loaded machine.
        await user.paste("creator@firm.example2");
        await user.click(screen.getByRole("button", { name: "Add" }));

        expect(
            await screen.findByText(
                "The project creator already has owner access",
            ),
        ).toBeInTheDocument();
    });

    it("keeps the generic fallback for errors that are not intentional 4xx", async () => {
        // A 500, or a thrown DB message, must not reach the dialog.
        const user = userEvent.setup();
        renderRoleAware({
            onGrant: () =>
                Promise.reject(
                    new MikeApiError({
                        status: 500,
                        message:
                            'duplicate key value violates unique constraint "grants_pkey"',
                    }),
                ),
        });
        await screen.findByRole("button", {
            name: /Role for the new recipient/,
        });
        await user.click(
            screen.getByPlaceholderText("Add by email..."),
        );
        // paste, not per-key typing: one input event cannot be cut off
        // mid-word by a slow re-render on a loaded machine.
        await user.paste("someone@firm.example");
        await user.click(screen.getByRole("button", { name: "Add" }));

        expect(
            await screen.findByText("Could not add this user. Try again."),
        ).toBeInTheDocument();
        expect(screen.queryByText(/grants_pkey/)).not.toBeInTheDocument();
    });

    it("surfaces the server's message when a re-role is refused", async () => {
        const user = userEvent.setup();
        renderRoleAware({
            onGrant: () =>
                Promise.reject(
                    new MikeApiError({
                        status: 403,
                        message:
                            "Only a project owner can change who has access.",
                    }),
                ),
        });
        await user.click(
            await screen.findByRole("button", {
                name: "Role for counsel@outside.example",
            }),
        );
        await user.click(screen.getByRole("menuitem", { name: "Owner" }));
        expect(
            await screen.findByText(
                "Only a project owner can change who has access.",
            ),
        ).toBeInTheDocument();
    });

    it("revokes a grant", async () => {
        const user = userEvent.setup();
        const { onRevoke } = renderRoleAware();
        await screen.findByLabelText("Role for counsel@outside.example");
        const actionsButton = screen.getByRole("button", {
            name: "Actions for counsel@outside.example",
        });
        expect(actionsButton).toHaveClass("h-6", "w-6");
        expect(actionsButton).not.toHaveClass("w-0", "opacity-0");
        expect(
            actionsButton.closest<HTMLElement>('[role="listitem"]')?.className,
        ).toContain("_1.5rem");
        await user.click(actionsButton);
        await user.click(
            screen.getByRole("menuitem", { name: "Remove" }),
        );
        await waitFor(() =>
            expect(onRevoke).toHaveBeenCalledWith("counsel@outside.example"),
        );
    });

    it("shows roles read-only to somebody who cannot manage access", async () => {
        renderRoleAware({ canManage: false });
        expect(await screen.findByText("Viewer")).toBeInTheDocument();
        expect(
            screen.queryByLabelText("Role for counsel@outside.example"),
        ).not.toBeInTheDocument();
        expect(
            screen.queryByPlaceholderText("Add by email..."),
        ).not.toBeInTheDocument();
    });

    it("keeps the organization Deny list collapsed below the Owner field", async () => {
        const user = userEvent.setup();
        renderRoleAware({ orgId: "org-1" });
        expect(
            screen.getByRole("dialog", { name: "Organisational Access" }),
        ).toBeVisible();
        const ownerPicker = await screen.findByRole("searchbox", {
            name: "Project owners",
        });
        const ownerLabel = screen.getByText("Project owners", {
            selector: "label",
        });
        const ownerDescription = await screen.findByText(
            "Add Elite Law LLP members as owners with rights to manage access, settings and delete the project.",
        );
        expect(
            screen.getByRole("button", { name: "About Project owners" }),
        ).toHaveAttribute("aria-describedby", "organization-owner-picker-description");
        expect(ownerDescription.closest('[role="tooltip"]')).toHaveClass(
            "peer-hover:visible",
            "peer-focus-visible:visible",
        );
        expect(ownerDescription).not.toHaveClass("pl-3");
        expect(
            ownerLabel.compareDocumentPosition(ownerDescription) &
                Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
        expect(
            ownerDescription.compareDocumentPosition(ownerPicker) &
                Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
        const denyToggle = screen.getByRole("button", { name: "Deny list" });
        expect(denyToggle).toHaveAttribute("aria-expanded", "false");
        expect(denyToggle.closest("section")).toHaveClass("mt-auto");
        expect(denyToggle).not.toHaveClass("px-2", "py-2");
        expect(denyToggle).not.toHaveClass("liquid-glass-hover");
        expect(
            screen.queryByRole("searchbox", { name: "Deny list" }),
        ).not.toBeInTheDocument();
        expect(screen.queryByText(/Firewall deny list/)).not.toBeInTheDocument();
        await user.click(denyToggle);
        expect(denyToggle).toHaveAttribute("aria-expanded", "true");
        expect(
            screen.getByRole("searchbox", { name: "Deny list" }),
        ).toBeInTheDocument();
        const denyDescription = screen.getByText(
            "Deny Elite Law LLP members from accessing this project.",
        );
        expect(
            screen.getByRole("button", { name: "About the Deny list" }),
        ).toHaveAttribute("aria-describedby", "organization-deny-description");
        expect(denyDescription.closest('[role="tooltip"]')).toHaveClass(
            "peer-hover:visible",
            "peer-focus-visible:visible",
        );
        const denyPicker = screen.getByRole("searchbox", {
            name: "Deny list",
        });
        expect(denyDescription).not.toHaveClass("pl-3");
        expect(
            denyToggle.compareDocumentPosition(denyDescription) &
                Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
        expect(
            denyDescription.compareDocumentPosition(denyPicker) &
                Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
        expect(
            screen.queryByText(/You can assign additional Owners/),
        ).not.toBeInTheDocument();
        expect(screen.queryByText(/Organization Admins are Owners/)).not.toBeInTheDocument();
        expect(
            screen.queryByText("counsel@outside.example"),
        ).not.toBeInTheDocument();
        const ownerList = screen.getByRole("list", {
            name: "Project owners list",
        });
        expect(within(ownerList).getByText("Creator")).toBeInTheDocument();
        expect(
            within(ownerList).queryByRole("button", {
                name: "Remove creator@firm.example",
            }),
        ).not.toBeInTheDocument();
    });

    it("labels the creator Owner", async () => {
        renderRoleAware();
        const creatorRow = (
            await screen.findByText("Creator")
        ).closest<HTMLElement>('[role="listitem"]');
        expect(creatorRow).not.toBeNull();
        expect(within(creatorRow!).getByText("Owner")).toBeInTheDocument();
    });

    it("gives the signed-in manager no way to remove or re-role themselves", async () => {
        // The viewer's own grant row offered a Remove action — one click,
        // no confirmation, instant self-lockout — and a role picker whose
        // every option the server refuses.
        render(
            <AccessModal
                open
                onClose={vi.fn()}
                resource={PROJECT}
                fetchAccess={() =>
                    Promise.resolve({
                        owner: {
                            user_id: "u1",
                            email: "creator@firm.example",
                            display_name: "Creator",
                            role: "owner" as const,
                        },
                        members: [
                            {
                                email: "me@firm.example",
                                display_name: "Me",
                                role: "owner" as const,
                            },
                            {
                                email: "counsel@outside.example",
                                display_name: null,
                                role: "viewer" as const,
                            },
                        ],
                    })
                }
                currentUserEmail="me@firm.example"
                breadcrumb={["Projects", "Matter", "Access"]}
                access={{
                    grants: [
                        { email: "me@firm.example", role: "owner" },
                        { email: "counsel@outside.example", role: "viewer" },
                    ],
                    orgId: null,
                    canManage: true,
                    onGrant: vi.fn() as never,
                    onRevoke: vi.fn(),
                }}
            />,
        );

        const ownRow = (await screen.findByText("You")).closest<HTMLElement>(
            '[role="listitem"]',
        );
        expect(ownRow).not.toBeNull();
        expect(
            within(ownRow!).queryByRole("button", {
                name: "Actions for me@firm.example",
            }),
        ).not.toBeInTheDocument();
        expect(
            within(ownRow!).queryByRole("button", {
                name: "Role for me@firm.example",
            }),
        ).not.toBeInTheDocument();
        expect(within(ownRow!).getByText("Owner")).toBeInTheDocument();

        expect(
            screen.getByRole("button", {
                name: "Actions for counsel@outside.example",
            }),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("button", {
                name: "Role for counsel@outside.example",
            }),
        ).toBeInTheDocument();
    });
});

describe("OrganizationAccessEditor — row actions", () => {
    it("uses a Remove action menu for Owner and Deny rows", async () => {
        const user = userEvent.setup();
        const onRemove = vi.fn();

        render(
            <OrganizationAccessEditor
                members={[]}
                assignments={[
                    {
                        key: "owner",
                        user_id: "owner-id",
                        email: "owner@firm.example",
                        display_name: "Owner Member",
                        role: "owner",
                    },
                    {
                        key: "denied",
                        user_id: "denied-id",
                        email: "denied@firm.example",
                        display_name: "Denied Member",
                        role: "deny",
                    },
                ]}
                onAssign={vi.fn()}
                onRemove={onRemove}
            />,
        );

        const ownerList = screen.getByRole("list", {
            name: "Project owners list",
        });
        await user.click(
            within(ownerList).getByRole("button", {
                name: "Actions for owner@firm.example",
            }),
        );
        await user.click(screen.getByRole("menuitem", { name: "Remove" }));
        expect(onRemove).toHaveBeenCalledWith(
            expect.objectContaining({ email: "owner@firm.example" }),
        );

        // The deny list opens itself because it has an entry, and says so.
        expect(
            screen.getByRole("button", { name: "Deny list (1)" }),
        ).toHaveAttribute("aria-expanded", "true");
        const denyList = screen.getByRole("list", {
            name: "Deny list entries",
        });
        await user.click(
            within(denyList).getByRole("button", {
                name: "Actions for denied@firm.example",
            }),
        );
        await user.click(screen.getByRole("menuitem", { name: "Remove" }));
        expect(onRemove).toHaveBeenCalledWith(
            expect.objectContaining({ email: "denied@firm.example" }),
        );
    });
});

describe("AccessModal — canonical roster", () => {
    it("shows the /people roster to a member who cannot manage access", async () => {
        // Below access.manage the grant list is never fetched — GET /access
        // is admin-only — so the roster must come from /people, which every
        // viewer of the project may read and which carries each person's
        // effective role. The old behavior rendered only the creator.
        render(
            <AccessModal
                open
                onClose={vi.fn()}
                resource={PROJECT}
                fetchAccess={accessResponse}
                currentUserEmail="me@firm.example"
                breadcrumb={["Projects", "Matter", "Access"]}
                access={{
                    grants: [],
                    orgId: null,
                    canManage: false,
                    onGrant: vi.fn() as never,
                    onRevoke: vi.fn(),
                }}
            />,
        );
        expect(
            await screen.findByText(/counsel@outside\.example/),
        ).toBeInTheDocument();
        expect(screen.getByText("Viewer")).toBeInTheDocument();
        expect(
            screen.queryByLabelText("Role for counsel@outside.example"),
        ).not.toBeInTheDocument();
    });
});
