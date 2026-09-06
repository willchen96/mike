import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MikeApiError } from "@/app/lib/mikeApi";
import { OrganizationWorkspace } from "./OrganizationWorkspace";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  role: "admin" as "admin" | "member",
  getOrg: vi.fn(),
  listOrgMembers: vi.fn(),
  listOrgResources: vi.fn(),
  listOrgInvitations: vi.fn(),
  updateOrgMember: vi.fn(),
  removeOrgMember: vi.fn(),
  updateOrg: vi.fn(),
  deleteOrg: vi.fn(),
  createOrgInvitation: vi.fn(),
  cancelOrgInvitation: vi.fn(),
  resendOrgInvitation: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push }),
}));
vi.mock("@/app/contexts/AuthContext", () => ({
  useAuth: () => ({ user: { id: "me", email: "me@firm.example" } }),
}));
vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
  getOrg: mocks.getOrg,
  listOrgMembers: mocks.listOrgMembers,
  listOrgResources: mocks.listOrgResources,
  listOrgInvitations: mocks.listOrgInvitations,
  updateOrgMember: mocks.updateOrgMember,
  removeOrgMember: mocks.removeOrgMember,
  updateOrg: mocks.updateOrg,
  deleteOrg: mocks.deleteOrg,
  createOrgInvitation: mocks.createOrgInvitation,
  cancelOrgInvitation: mocks.cancelOrgInvitation,
  resendOrgInvitation: mocks.resendOrgInvitation,
}));

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
  mocks.role = "admin";
  mocks.getOrg.mockImplementation(async () => ({
    id: "org-1",
    name: "Elite Law LLP",
    created_by: "me",
    role: mocks.role,
  }));
  mocks.listOrgMembers.mockResolvedValue([
    {
      id: "m1",
      user_id: "me",
      display_name: "William Chen",
      email: "me@firm.example",
      role: "admin",
      created_at: "2026-08-30T00:00:00Z",
    },
    {
      id: "m2",
      user_id: "u2",
      display_name: "Jane Lee",
      email: "jane@firm.example",
      role: "member",
      created_at: "2026-09-01T00:00:00Z",
    },
  ]);
  mocks.listOrgResources.mockResolvedValue({
    projects: [
      {
        id: "project-1",
        user_id: "me",
        org_id: "org-1",
        name: "Apollo",
        practice: "Corporate",
        created_at: "2026-09-01T00:00:00Z",
      },
    ],
    workflows: [
      {
        id: "workflow-1",
        user_id: "u2",
        org_id: "org-1",
        title: "Disclosure workflow",
        type: "tabular",
        practice: "Corporate",
        created_at: "2026-09-01T00:00:00Z",
      },
    ],
  });
  mocks.listOrgInvitations.mockResolvedValue([]);
});

describe("OrganizationWorkspace", () => {
  it("shows the breadcrumb, member identity columns, and every resource tab", async () => {
    const user = userEvent.setup();
    render(<OrganizationWorkspace orgId="org-1" />);

    expect(await screen.findByText("William Chen")).toBeInTheDocument();
    expect(screen.getByText("me@firm.example")).toBeInTheDocument();
    expect(screen.getAllByText("Elite Law LLP")).not.toHaveLength(0);
    expect(screen.getByText("Added")).toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", { name: "Select all people" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Filter by role" }),
    ).toBeInTheDocument();
    const peopleRow = screen
      .getByRole("checkbox", { name: "Select Jane Lee" })
      .closest(".group");
    expect(peopleRow).toHaveClass("liquid-glass-hover");
    expect(peopleRow).not.toHaveClass("cursor-pointer");

    await user.click(screen.getByRole("button", { name: "Projects" }));
    expect(screen.getByRole("link", { name: "Open Apollo" })).toHaveClass(
      "liquid-glass-hover",
    );
    await user.click(screen.getByRole("button", { name: "Workflows" }));
    expect(
      screen.getByRole("link", { name: "Open Disclosure workflow" }),
    ).toHaveClass("liquid-glass-hover");
    expect(screen.queryByRole("button", { name: "Chats" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reviews" })).not.toBeInTheDocument();
  });

  it("lets admins change a member's role from the colored role tab", async () => {
    const user = userEvent.setup();
    mocks.updateOrgMember.mockResolvedValue({});
    render(<OrganizationWorkspace orgId="org-1" />);
    await screen.findByText("Jane Lee");

    const roleTab = screen.getByRole("button", {
      name: "Change role for Jane Lee",
    });
    expect(roleTab).toHaveClass("bg-violet-100", "text-violet-700");
    await user.click(roleTab);
    await user.click(screen.getByRole("menuitem", { name: "Admin" }));

    await waitFor(() =>
      expect(mocks.updateOrgMember).toHaveBeenCalledWith(
        "org-1",
        "u2",
        "admin",
      ),
    );
    expect(
      screen.getByRole("button", { name: "Change role for Jane Lee" }),
    ).toHaveClass("bg-blue-100", "text-blue-700");
  });

  it("shows last-admin failures with the warning primitive", async () => {
    const user = userEvent.setup();
    mocks.updateOrgMember.mockRejectedValue(
      new MikeApiError({
        status: 409,
        message: "An organization must keep at least one admin.",
      }),
    );
    render(<OrganizationWorkspace orgId="org-1" />);
    await screen.findByText("William Chen");

    await user.click(
      screen.getByRole("button", { name: "Change role for William Chen" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Member" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(
      await screen.findByText("An organization must keep at least one admin."),
    ).toBeInTheDocument();
    expect(screen.getByText("Organization action failed")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Dismiss warning" }),
    ).toBeInTheDocument();
  });

  it("reveals a toolbar action and removes selected people", async () => {
    const user = userEvent.setup();
    mocks.removeOrgMember.mockResolvedValue(undefined);
    render(<OrganizationWorkspace orgId="org-1" />);
    await screen.findByText("Jane Lee");

    expect(
      screen.queryByRole("button", { name: "Actions" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: "Select Jane Lee" }));
    await user.click(screen.getByRole("button", { name: "Actions" }));
    const removeAction = screen.getByRole("menuitem", {
      name: "Remove all selected",
    });
    expect(removeAction.querySelector("svg")).toHaveClass("text-red-600");
    await user.click(removeAction);

    expect(screen.getByText("Remove selected people?")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() =>
      expect(mocks.removeOrgMember).toHaveBeenCalledWith("org-1", "u2"),
    );
    expect(screen.queryByText("Jane Lee")).not.toBeInTheDocument();
  });

  it("warns an admin who includes themselves in bulk removal", async () => {
    const user = userEvent.setup();
    render(<OrganizationWorkspace orgId="org-1" />);
    await screen.findByText("William Chen");

    await user.click(
      screen.getByRole("checkbox", { name: "Select William Chen" }),
    );
    await user.click(screen.getByRole("button", { name: "Actions" }));
    await user.click(
      screen.getByRole("menuitem", { name: "Remove all selected" }),
    );

    // The refusal is about the route, not about admin arithmetic: leaving is
    // a different action, and saying "must keep at least one admin" was wrong
    // however many admins the organization had.
    expect(
      await screen.findByText("Use Leave organization to remove yourself."),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("An organization must keep at least one admin."),
    ).not.toBeInTheDocument();
    expect(mocks.removeOrgMember).not.toHaveBeenCalled();
  });

  it("offers add-member and settings actions only to admins", async () => {
    const user = userEvent.setup();
    render(<OrganizationWorkspace orgId="org-1" />);
    await screen.findByText("William Chen");

    await user.click(screen.getByRole("button", { name: "Add member" }));
    expect(screen.getByText("Email address")).toBeInTheDocument();
    expect(mocks.listOrgInvitations).toHaveBeenCalledWith("org-1");

    await user.keyboard("{Escape}");
    await user.click(
      screen.getByRole("button", { name: "Organization settings" }),
    );
    await user.click(screen.getByText("Organization settings"));
    expect(screen.getByLabelText("Organization name")).toHaveValue(
      "Elite Law LLP",
    );
  });

  it("drops admin-only controls as soon as an admin demotes themselves", async () => {
    const user = userEvent.setup();
    mocks.updateOrgMember.mockResolvedValue({});
    render(<OrganizationWorkspace orgId="org-1" />);
    await screen.findByText("William Chen");

    await user.click(
      screen.getByRole("button", { name: "Change role for William Chen" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Member" }));

    // Losing your own admin rights is confirmed before it happens.
    expect(screen.getByText("Give up admin access?")).toBeInTheDocument();
    expect(mocks.updateOrgMember).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() =>
      expect(mocks.updateOrgMember).toHaveBeenCalledWith(
        "org-1",
        "me",
        "member",
      ),
    );
    // org.role has to follow the membership row, or the page keeps offering
    // admin actions that now 403 until a reload.
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Organization settings" }),
      ).not.toBeInTheDocument(),
    );
    expect(
      screen.queryByRole("button", { name: "Change role for Jane Lee" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Only organization admins can add members",
      }),
    ).toBeDisabled();
    expect(mocks.getOrg).toHaveBeenCalledTimes(1);
  });

  it("keeps the delete confirmation from outliving its settings modal", async () => {
    const user = userEvent.setup();
    render(<OrganizationWorkspace orgId="org-1" />);
    await screen.findByText("William Chen");

    await user.click(
      screen.getByRole("button", { name: "Organization settings" }),
    );
    await user.click(
      screen.getByRole("menuitem", { name: "Organization settings" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Delete organization" }),
    );
    expect(screen.getByText("Delete Elite Law LLP?")).toBeInTheDocument();

    // Escape dismisses the modal; the confirmation lives in its own portal
    // and would otherwise stay behind with a live Delete button.
    await user.keyboard("{Escape}");

    expect(screen.queryByText("Delete Elite Law LLP?")).not.toBeInTheDocument();
    expect(mocks.deleteOrg).not.toHaveBeenCalled();
  });

  it("does not report a sent invitation as failed when the refresh rejects", async () => {
    const user = userEvent.setup();
    mocks.createOrgInvitation.mockResolvedValue({});
    mocks.listOrgInvitations
      .mockResolvedValueOnce([])
      .mockRejectedValue(new Error("refresh failed"));
    render(<OrganizationWorkspace orgId="org-1" />);
    await screen.findByText("William Chen");

    await user.click(screen.getByRole("button", { name: "Add member" }));
    // ModalUI settles focus a frame after the dialog opens (the auto-focused
    // field keeps it, else the first control); typing across that handoff
    // loses the tail of the address, so wait for focus to land in the dialog.
    await waitFor(() => {
      const dialog = screen.getByRole("dialog");
      expect(document.activeElement).not.toBe(document.body);
      expect(dialog.contains(document.activeElement)).toBe(true);
    });
    await user.type(
      screen.getByPlaceholderText("Invite by email…"),
      "new@firm.example",
    );
    await user.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() =>
      expect(mocks.createOrgInvitation).toHaveBeenCalledWith(
        "org-1",
        "new@firm.example",
        "member",
      ),
    );
    expect(
      await screen.findByText("Invitation sent to new@firm.example."),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Could not send the invitation."),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Invitation action failed"),
    ).not.toBeInTheDocument();
  });

  it("re-reads invitations and the roster when the Add member modal opens", async () => {
    // An invitation is accepted in the recipient's browser, so this page never
    // hears about it. Opening Add member used to redisplay the list loaded at
    // page load, which still called the new colleague "Pending" — and the
    // People table behind it still did not have them at all.
    const user = userEvent.setup();
    const invitation = {
      id: "i1",
      org_id: "org-1",
      email: "newjoiner@firm.example",
      role: "member" as const,
      invited_by: "me",
      expires_at: "2026-09-30T00:00:00Z",
      created_at: "2026-09-01T00:00:00Z",
      accepted_at: null,
      declined_at: null,
      cancelled_at: null,
    };
    const joiner = {
      id: "m3",
      user_id: "u3",
      display_name: "New Joiner",
      email: "newjoiner@firm.example",
      role: "member",
      created_at: "2026-09-02T00:00:00Z",
    };
    mocks.listOrgInvitations
      .mockResolvedValueOnce([{ ...invitation, status: "pending" }])
      .mockResolvedValue([
        {
          ...invitation,
          status: "accepted",
          accepted_at: "2026-09-02T00:00:00Z",
        },
      ]);
    const initialMembers = [
      {
        id: "m1",
        user_id: "me",
        display_name: "William Chen",
        email: "me@firm.example",
        role: "admin",
        created_at: "2026-08-30T00:00:00Z",
      },
    ];
    mocks.listOrgMembers
      .mockResolvedValueOnce(initialMembers)
      .mockResolvedValue([...initialMembers, joiner]);

    render(<OrganizationWorkspace orgId="org-1" />);
    await screen.findByText("William Chen");
    expect(screen.queryByText("New Joiner")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Add member" }));

    await waitFor(() =>
      expect(mocks.listOrgInvitations).toHaveBeenCalledTimes(2),
    );
    // The accepted invitation is no longer pending, so its row is gone...
    await waitFor(() =>
      expect(
        screen.queryByRole("button", {
          name: "Cancel invitation to newjoiner@firm.example",
        }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.queryByText("Pending invitations")).not.toBeInTheDocument();
    // ...and the same person is now on the roster without a reload.
    expect(screen.getByText("New Joiner")).toBeInTheDocument();
  });

  it("lets members browse resources but does not load administrative invitations", async () => {
    mocks.role = "member";
    const user = userEvent.setup();
    render(<OrganizationWorkspace orgId="org-1" />);
    await screen.findByText("William Chen");

    expect(mocks.listOrgInvitations).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", {
        name: "Only organization admins can add members",
      }),
    ).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: "Organization settings" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Workflows" }));
    expect(screen.getByText("Disclosure workflow")).toBeInTheDocument();
  });
});
