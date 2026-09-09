import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MikeApiError } from "@/app/lib/mikeApi";
import { OrganizationsOverview } from "./OrganizationsOverview";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  listOrgs: vi.fn(),
  listMyOrgInvitations: vi.fn(),
  createOrg: vi.fn(),
  createOrgInvitation: vi.fn(),
  acceptOrgInvitation: vi.fn(),
  declineOrgInvitation: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push }),
}));
// Spread the real module: userFacingApiError resolves MikeApiError from this
// same module, so a bare object mock leaves its `instanceof` check with an
// undefined right-hand side.
vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
  listOrgs: mocks.listOrgs,
  listMyOrgInvitations: mocks.listMyOrgInvitations,
  createOrg: mocks.createOrg,
  createOrgInvitation: mocks.createOrgInvitation,
  acceptOrgInvitation: mocks.acceptOrgInvitation,
  declineOrgInvitation: mocks.declineOrgInvitation,
}));

const ORG = {
  id: "org-1",
  name: "Elite Law LLP",
  created_by: "me",
  created_at: "2026-09-01T00:00:00.000Z",
  role: "admin" as const,
  member_count: 3,
};

const JOINED_ORG = {
  ...ORG,
  id: "org-joined",
  name: "Community Legal",
  role: "member" as const,
  member_count: 8,
};

const INVITATION = {
  id: "invite-1",
  org_id: "org-invited",
  org_name: "Inviting Chambers",
  email: "me@example.com",
  role: "member" as const,
  invited_by: "inviter-1",
  status: "pending" as const,
  expires_at: "2026-09-10T00:00:00.000Z",
  created_at: "2026-09-01T00:00:00.000Z",
  accepted_at: null,
  declined_at: null,
  cancelled_at: null,
};

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
  mocks.listOrgs.mockResolvedValue([ORG]);
  mocks.listMyOrgInvitations.mockResolvedValue([]);
});

/**
 * ModalUI settles focus on the frame after the dialog opens: the control
 * React auto-focused keeps it, otherwise the first focusable control gets it.
 * Typing before that handoff lands the tail of the text on whichever control
 * wins, so wait until focus has left <body> and sits inside the dialog.
 */
async function settleModalFocus() {
  await waitFor(() => {
    const dialog = screen.getByRole("dialog");
    expect(document.activeElement).not.toBe(document.body);
    expect(dialog.contains(document.activeElement)).toBe(true);
  });
}

describe("OrganizationsOverview", () => {
  it("renders organizations through the shared table columns and opens a row", async () => {
    const user = userEvent.setup();
    render(<OrganizationsOverview />);

    expect(await screen.findByText("Elite Law LLP")).toBeInTheDocument();
    expect(screen.getByText("3 members")).toBeInTheDocument();
    expect(screen.getByText("Created")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Sort by organization name" }),
    ).toBeInTheDocument();

    const organizationRow = screen.getByRole("link", {
      name: "Open Elite Law LLP",
    });

    await user.click(organizationRow);
    expect(mocks.push).toHaveBeenCalledWith("/organizations/org-1");
  });

  it("creates an organization from the page-header plus action", async () => {
    const user = userEvent.setup();
    mocks.createOrg.mockResolvedValue({
      ...ORG,
      id: "org-2",
      name: "New Chambers",
    });
    render(<OrganizationsOverview />);
    await screen.findByText("Elite Law LLP");

    await user.click(screen.getByRole("button", { name: "New organization" }));
    expect(
      await screen.findByText(/You can also add people later/),
    ).toBeInTheDocument();
    await settleModalFocus();
    await user.type(screen.getByLabelText("Organization name"), "New Chambers");
    await user.type(
      screen.getByPlaceholderText("Add member by email…"),
      "jane@firm.example",
    );
    await user.click(screen.getByRole("button", { name: "Add" }));
    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() =>
      expect(mocks.createOrg).toHaveBeenCalledWith("New Chambers"),
    );
    expect(mocks.createOrgInvitation).toHaveBeenCalledWith(
      "org-2",
      "jane@firm.example",
      "member",
    );
    expect(mocks.push).toHaveBeenCalledWith("/organizations/org-2");
  });

  it("separates organizations into Managing and Joined tabs", async () => {
    const user = userEvent.setup();
    mocks.listOrgs.mockResolvedValue([ORG, JOINED_ORG]);
    render(<OrganizationsOverview />);

    expect(await screen.findByText("Elite Law LLP")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Managing" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Invites" })).toBeInTheDocument();
    expect(screen.queryByText("Community Legal")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Joined" }));
    expect(screen.getByText("Community Legal")).toBeInTheDocument();
    expect(screen.queryByText("Elite Law LLP")).not.toBeInTheDocument();
  });

  it("shows active invitations and their count under the Invites pill", async () => {
    const user = userEvent.setup();
    mocks.listMyOrgInvitations.mockResolvedValueOnce([INVITATION]);
    render(<OrganizationsOverview />);

    const invites = await screen.findByRole("button", {
      name: "Invites (1)",
    });
    expect(screen.queryByText("Inviting Chambers")).not.toBeInTheDocument();

    await user.click(invites);
    expect(screen.getByText("Inviting Chambers")).toBeInTheDocument();
    expect(screen.getByText(/invited you as Member/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Accept" }));
    await waitFor(() =>
      expect(mocks.acceptOrgInvitation).toHaveBeenCalledWith("invite-1"),
    );
    expect(
      await screen.findByRole("button", { name: "Invites" }),
    ).toBeInTheDocument();
  });

  it("reports a failed invitations fetch instead of claiming there are none", async () => {
    const user = userEvent.setup();
    mocks.listMyOrgInvitations
      .mockRejectedValueOnce(
        new MikeApiError({ status: 503, message: "upstream down" }),
      )
      .mockResolvedValue([INVITATION]);
    render(<OrganizationsOverview />);
    await screen.findByText("Elite Law LLP");

    // The tab itself has to say so: an unopened "Invites" looked identical
    // whether the inbox was empty or the fetch had failed, and only one of
    // those is worth a click.
    await user.click(
      screen.getByRole("button", { name: "Invites (unavailable)" }),
    );
    expect(
      screen.getByText("Could not load your invitations."),
    ).toBeInTheDocument();
    // The old swallowed catch rendered this instead, which reads as "nobody
    // invited you" rather than "we could not check".
    expect(
      screen.queryByText("You have no active organization invitations."),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Inviting Chambers")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Invites (1)" }),
    ).toBeInTheDocument();
  });

  it("shows the server's own wording when the organizations fetch is refused", async () => {
    // The invitations half of the same load already did this; the orgs half
    // threw the server's sentence away for a hardcoded one.
    mocks.listOrgs.mockRejectedValue(
      new MikeApiError({
        status: 403,
        message: "Your account is not permitted to list organizations",
      }),
    );
    render(<OrganizationsOverview />);

    expect(
      await screen.findByText(
        "Your account is not permitted to list organizations",
      ),
    ).toBeInTheDocument();
  });

  it("keeps a failing reload from being reported as a failed answer", async () => {
    // The re-read is bookkeeping that runs after the server has already
    // accepted, so it sits outside the try: a failure there must not become
    // "Could not answer that invitation" about an invitation that was taken.
    const user = userEvent.setup();
    mocks.listMyOrgInvitations.mockResolvedValueOnce([INVITATION]);
    mocks.acceptOrgInvitation.mockResolvedValue(undefined);
    render(<OrganizationsOverview />);

    await user.click(
      await screen.findByRole("button", { name: "Invites (1)" }),
    );
    mocks.listOrgs.mockRejectedValue(new Error("network"));
    mocks.listMyOrgInvitations.mockRejectedValue(new Error("network"));
    await user.click(screen.getByRole("button", { name: "Accept" }));

    await waitFor(() =>
      expect(mocks.acceptOrgInvitation).toHaveBeenCalledWith("invite-1"),
    );
    expect(
      screen.queryByText("Could not answer that invitation."),
    ).not.toBeInTheDocument();
  });

  it("keeps a partly failed creation from vanishing when the modal is closed", async () => {
    const user = userEvent.setup();
    const created = { ...ORG, id: "org-2", name: "New Chambers" };
    mocks.createOrg.mockResolvedValue(created);
    mocks.createOrgInvitation.mockRejectedValue(new Error("invite failed"));
    render(<OrganizationsOverview />);
    await screen.findByText("Elite Law LLP");

    await user.click(screen.getByRole("button", { name: "New organization" }));
    await settleModalFocus();
    await user.type(screen.getByLabelText("Organization name"), "New Chambers");
    await user.type(
      screen.getByPlaceholderText("Add member by email…"),
      "jane@firm.example",
    );
    await user.click(screen.getByRole("button", { name: "Add" }));
    await user.click(screen.getByRole("button", { name: "Create" }));

    expect(
      await screen.findByText("Some invitations were not sent"),
    ).toBeInTheDocument();
    expect(mocks.push).not.toHaveBeenCalled();

    // The organization exists on the server but never reached onCreated, so
    // dismissal has to refetch or the row stays invisible until a reload.
    mocks.listOrgs.mockResolvedValue([ORG, created]);
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(await screen.findByText("New Chambers")).toBeInTheDocument();
  });

  it("refuses to dismiss the create modal while the request is in flight", async () => {
    const user = userEvent.setup();
    mocks.createOrg.mockReturnValue(new Promise(() => {}));
    render(<OrganizationsOverview />);
    await screen.findByText("Elite Law LLP");

    await user.click(screen.getByRole("button", { name: "New organization" }));
    await settleModalFocus();
    await user.type(screen.getByLabelText("Organization name"), "New Chambers");
    await user.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(mocks.createOrg).toHaveBeenCalled());

    await user.keyboard("{Escape}");
    expect(
      screen.getByRole("dialog", { name: "New organization" }),
    ).toBeInTheDocument();
  });
});
