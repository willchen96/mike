import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MikeApiError, type Org } from "@/app/lib/mikeApi";
import {
  InviteOrganizationMemberModal,
  OrganizationSettingsModal,
} from "./OrganizationModals";

// What this file pins:
//
//   1. A success notice that is quietly contradicted by the list beside it.
//      The invitation was sent; the follow-up refresh failed into a console
//      line; the pending list stayed as it was — so "Invitation sent" read as
//      "…and nothing happened".
//   2. The delete confirmation was reset on FAILURE and not on success, so
//      after a delete that worked it stayed open over a page navigating away,
//      with a live Delete button aimed at an organization that is now gone.
//   3. A refused delete announced itself as "Organization settings not saved",
//      which describes the rename this modal also does.

const mocks = vi.hoisted(() => ({
  createOrgInvitation: vi.fn(),
  cancelOrgInvitation: vi.fn(),
  resendOrgInvitation: vi.fn(),
  updateOrg: vi.fn(),
  deleteOrg: vi.fn(),
  createOrg: vi.fn(),
}));

vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
  createOrgInvitation: mocks.createOrgInvitation,
  cancelOrgInvitation: mocks.cancelOrgInvitation,
  resendOrgInvitation: mocks.resendOrgInvitation,
  updateOrg: mocks.updateOrg,
  deleteOrg: mocks.deleteOrg,
  createOrg: mocks.createOrg,
}));

const org: Org = {
  id: "org-1",
  name: "Elite Law LLP",
  created_by: "me",
  role: "admin",
} as Org;

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
  mocks.createOrgInvitation.mockResolvedValue({});
  mocks.cancelOrgInvitation.mockResolvedValue(undefined);
  mocks.resendOrgInvitation.mockResolvedValue(undefined);
  mocks.deleteOrg.mockResolvedValue(undefined);
});

async function typeInvitation(user: ReturnType<typeof userEvent.setup>) {
  await waitFor(() => {
    const dialog = screen.getByRole("dialog");
    expect(dialog.contains(document.activeElement)).toBe(true);
  });
  await user.type(
    screen.getByPlaceholderText("Invite by email…"),
    "new@firm.example",
  );
  await user.click(screen.getByRole("button", { name: "Add" }));
}

describe("InviteOrganizationMemberModal", () => {
  it("keeps the success notice and admits the list is stale", async () => {
    const user = userEvent.setup();
    render(
      <InviteOrganizationMemberModal
        open
        org={org}
        invitations={[]}
        onClose={vi.fn()}
        onChanged={() => Promise.reject(new Error("refresh failed"))}
      />,
    );

    await typeInvitation(user);

    await waitFor(() => expect(mocks.createOrgInvitation).toHaveBeenCalled());
    expect(
      await screen.findByText(
        "Invitation sent to new@firm.example. The list below may be out of date — reload to see the current one.",
      ),
    ).toBeInTheDocument();
    // The mutation succeeded, so it is still not reported as a failure.
    expect(
      screen.queryByText("Invitation action failed"),
    ).not.toBeInTheDocument();
  });

  it("says only that the invitation was sent when the refresh lands", async () => {
    const user = userEvent.setup();
    render(
      <InviteOrganizationMemberModal
        open
        org={org}
        invitations={[]}
        onClose={vi.fn()}
        onChanged={vi.fn()}
      />,
    );

    await typeInvitation(user);

    expect(
      await screen.findByText("Invitation sent to new@firm.example."),
    ).toBeInTheDocument();
  });
});

describe("OrganizationSettingsModal", () => {
  it("closes the confirmation once the delete succeeds", async () => {
    const user = userEvent.setup();
    const onDeleted = vi.fn();
    render(
      <OrganizationSettingsModal
        open
        org={org}
        onClose={vi.fn()}
        onUpdated={vi.fn()}
        onDeleted={onDeleted}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Delete organization" }),
    );
    expect(screen.getByText("Delete Elite Law LLP?")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("Delete Elite Law LLP?")).not.toBeInTheDocument();
    expect(mocks.deleteOrg).toHaveBeenCalledTimes(1);
  });

  it("names the failure a failed delete, not unsaved settings", async () => {
    const user = userEvent.setup();
    mocks.deleteOrg.mockRejectedValue(
      new MikeApiError({
        message: "Move or delete this organization's projects first",
        status: 409,
      }),
    );
    render(
      <OrganizationSettingsModal
        open
        org={org}
        onClose={vi.fn()}
        onUpdated={vi.fn()}
        onDeleted={vi.fn()}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Delete organization" }),
    );
    await user.click(screen.getByRole("button", { name: "Delete" }));

    expect(
      await screen.findByText("Organization not deleted"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Move or delete this organization's projects first"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Organization settings not saved"),
    ).not.toBeInTheDocument();
  });
});
