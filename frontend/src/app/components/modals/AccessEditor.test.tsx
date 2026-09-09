import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import {
    AccessEditor,
    OrganizationAccessEditor,
    type AccessRow,
} from "./AccessEditor";

const ROWS: AccessRow[] = [
    {
        key: "me",
        user_id: "user-me",
        email: "me@firm.example",
        display_name: "Me",
        role: "owner",
    },
    {
        key: "other",
        user_id: "user-other",
        email: "other@firm.example",
        display_name: "Other Counsel",
        role: "viewer",
    },
];

function renderEditor(
    overrides: Partial<ComponentProps<typeof AccessEditor>> = {},
) {
    return render(
        <AccessEditor
            scope="direct"
            rows={ROWS}
            canManage
            newRole="editor"
            onNewRoleChange={vi.fn()}
            onAdd={vi.fn()}
            onRoleChange={vi.fn()}
            onRemove={vi.fn()}
            {...overrides}
        />,
    );
}

describe("AccessEditor — the viewer's own grant", () => {
    it("renders your own row read-only while leaving other rows editable", () => {
        // Removing yourself is one unconfirmed click away from locking
        // yourself out, and re-roling yourself is refused by the server.
        renderEditor({ currentUserEmail: "  Me@Firm.Example  " });

        expect(screen.getByText("You")).toBeInTheDocument();
        expect(
            screen.queryByRole("button", { name: "Role for me@firm.example" }),
        ).not.toBeInTheDocument();
        expect(
            screen.queryByRole("button", {
                name: "Actions for me@firm.example",
            }),
        ).not.toBeInTheDocument();

        const ownRow = screen
            .getByText("me@firm.example")
            .closest<HTMLElement>('[role="listitem"]');
        expect(within(ownRow!).getByText("Owner")).toBeInTheDocument();

        expect(
            screen.getByRole("button", { name: "Role for other@firm.example" }),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("button", {
                name: "Actions for other@firm.example",
            }),
        ).toBeInTheDocument();
    });

    it("recognises your row by user id when no email is threaded through", () => {
        renderEditor({ currentUserId: "user-me" });

        expect(screen.getByText("You")).toBeInTheDocument();
        expect(
            screen.queryByRole("button", { name: "Role for me@firm.example" }),
        ).not.toBeInTheDocument();
        expect(
            screen.queryByRole("button", {
                name: "Actions for me@firm.example",
            }),
        ).not.toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: "Role for other@firm.example" }),
        ).toBeInTheDocument();
    });

    it("leaves every row interactive when the viewer cannot be identified", () => {
        renderEditor();

        expect(screen.queryByText("You")).not.toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: "Role for me@firm.example" }),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: "Actions for me@firm.example" }),
        ).toBeInTheDocument();
    });
});

describe("AccessEditor — failures and empty states", () => {
    it("shows the error to somebody who cannot manage access", () => {
        // The message used to live inside the add form, which is only
        // rendered to a manager in the direct scope, so a failed revoke or
        // re-role anywhere else was silent.
        renderEditor({
            canManage: false,
            onAdd: undefined,
            error: "Could not remove access.",
        });

        expect(screen.getByRole("alert")).toHaveTextContent(
            "Could not remove access.",
        );
    });

    it("does not claim nobody has access when access is inherited", () => {
        renderEditor({ scope: "project", rows: [], canManage: false });

        expect(
            screen.getByText(/Access is inherited from the project/),
        ).toBeInTheDocument();
        expect(
            screen.queryByText("No one has access yet."),
        ).not.toBeInTheDocument();
    });
});

describe("OrganizationAccessEditor — deny list", () => {
    it("opens the deny list, with its count, once the roster loads", () => {
        const props = {
            members: [],
            organizationName: "Elite Law LLP",
            onAssign: vi.fn(),
            onRemove: vi.fn(),
        };
        const { rerender } = render(
            <OrganizationAccessEditor {...props} assignments={[]} loading />,
        );

        expect(
            screen.getByRole("button", { name: "Deny list" }),
        ).toHaveAttribute("aria-expanded", "false");

        // Assignments arrive with the roster, after mount, so a plain
        // useState initialiser would never see them.
        rerender(
            <OrganizationAccessEditor
                {...props}
                loading={false}
                assignments={[
                    {
                        key: "denied-1",
                        user_id: "denied-1",
                        email: "walled@firm.example",
                        display_name: "Walled Off",
                        role: "deny",
                    },
                    {
                        key: "denied-2",
                        user_id: "denied-2",
                        email: "conflicted@firm.example",
                        display_name: "Conflicted",
                        role: "deny",
                    },
                ]}
            />,
        );

        const toggle = screen.getByRole("button", { name: "Deny list (2)" });
        expect(toggle).toHaveAttribute("aria-expanded", "true");
        const denyList = screen.getByRole("list", { name: "Deny list entries" });
        expect(
            within(denyList).getByText("walled@firm.example"),
        ).toBeInTheDocument();
        expect(
            within(denyList).getByText("conflicted@firm.example"),
        ).toBeInTheDocument();
    });

    it("stays collapsed after the reader closes it and the roster reloads", () => {
        // Every grant and revoke re-reads the roster, and each re-read used to
        // re-run the auto-expand: a deny list the reader had deliberately
        // collapsed sprang open again after their next change.
        const assignments = [
            {
                key: "denied-1",
                user_id: "denied-1",
                email: "walled@firm.example",
                display_name: "Walled Off",
                role: "deny" as const,
            },
        ];
        const props = {
            members: [],
            assignments,
            organizationName: "Elite Law LLP",
            onAssign: vi.fn(),
            onRemove: vi.fn(),
        };
        const { rerender } = render(
            <OrganizationAccessEditor {...props} loading />,
        );
        rerender(<OrganizationAccessEditor {...props} loading={false} />);

        const toggle = screen.getByRole("button", { name: "Deny list (1)" });
        expect(toggle).toHaveAttribute("aria-expanded", "true");
        fireEvent.click(toggle);
        expect(
            screen.getByRole("button", { name: "Deny list (1)" }),
        ).toHaveAttribute("aria-expanded", "false");

        // A refetch: loading goes back up and settles again.
        rerender(<OrganizationAccessEditor {...props} loading />);
        rerender(<OrganizationAccessEditor {...props} loading={false} />);

        expect(
            screen.getByRole("button", { name: "Deny list (1)" }),
        ).toHaveAttribute("aria-expanded", "false");
    });

    it("keeps the caller out of the owner and deny pickers", () => {
        // The server refuses either override aimed at the caller ("You cannot
        // share a project with yourself"), so their own name in these pickers
        // was an action that could only fail.
        render(
            <OrganizationAccessEditor
                members={[
                    {
                        key: "me",
                        user_id: "user-me",
                        email: "me@firm.example",
                        display_name: "Me",
                        role: "editor",
                    },
                    {
                        key: "other",
                        user_id: "user-other",
                        email: "other@firm.example",
                        display_name: "Other Counsel",
                        role: "editor",
                    },
                ]}
                assignments={[]}
                currentUserId="user-me"
                currentUserEmail="me@firm.example"
                onAssign={vi.fn()}
                onRemove={vi.fn()}
            />,
        );

        const ownerSearch = screen.getByRole("searchbox", {
            name: "Project owners",
        });
        fireEvent.focus(ownerSearch);
        fireEvent.change(ownerSearch, { target: { value: "firm.example" } });
        const ownerMatches = screen.getByRole("listbox", {
            name: "Project owners matches",
        });
        expect(
            within(ownerMatches).getByText("Other Counsel"),
        ).toBeInTheDocument();
        expect(within(ownerMatches).queryByText("Me")).not.toBeInTheDocument();
    });

    it("leaves an empty deny list collapsed and uncounted", () => {
        render(
            <OrganizationAccessEditor
                members={[]}
                assignments={[]}
                onAssign={vi.fn()}
                onRemove={vi.fn()}
            />,
        );

        expect(
            screen.getByRole("button", { name: "Deny list" }),
        ).toHaveAttribute("aria-expanded", "false");
    });
});
