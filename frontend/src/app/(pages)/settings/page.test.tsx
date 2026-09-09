import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MikeApiError } from "@/app/lib/mikeApi";
import SettingsPage from "./page";

const state = vi.hoisted(() => ({
    push: vi.fn(),
    signOut: vi.fn(),
    deleteAccount: vi.fn(),
    updateEmail: vi.fn(),
    updateDisplayName: vi.fn(),
    updateOrganisation: vi.fn(),
    passwordSet: false,
    profile: {
        displayName: "Alex",
        organisation: "Example LLP",
    },
    user: {
        id: "user-1",
        email: "alex@example.com",
        pendingEmail: null,
        createdWithGoogle: true,
    },
}));

vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: state.push }),
}));

vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({
        user: state.user,
        signOut: state.signOut,
        updateEmail: state.updateEmail,
    }),
}));

vi.mock("@/app/contexts/UserProfileContext", () => ({
    useUserProfile: () => ({
        profile: {
            ...state.profile,
            passwordSet: state.passwordSet,
            tier: "Free",
        },
        updateDisplayName: state.updateDisplayName,
        updateOrganisation: state.updateOrganisation,
    }),
}));

// The real module is spread back in because userFacingApiError resolves
// MikeApiError from it; a bare object mock leaves that `instanceof` check
// comparing against undefined.
vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
    deleteAccount: state.deleteAccount,
    isMfaRequiredError: vi.fn(() => false),
}));

vi.mock("@/app/components/popups/MfaVerificationPopup", () => ({
    MfaVerificationPopup: () => null,
    needsMfaVerification: vi.fn(async () => false),
}));

describe("SettingsPage Google email changes", () => {
    beforeEach(() => {
        state.push.mockReset();
        state.signOut.mockReset();
        state.deleteAccount.mockReset();
        state.deleteAccount.mockResolvedValue(undefined);
        state.updateEmail.mockReset();
        state.updateDisplayName.mockReset();
        state.updateDisplayName.mockResolvedValue(true);
        state.updateOrganisation.mockReset();
        state.updateOrganisation.mockResolvedValue(true);
        state.updateEmail.mockResolvedValue({
            ...state.user,
            email: "alex@example.com",
            pendingEmail: "new@example.com",
        });
        state.passwordSet = false;
        state.profile = {
            displayName: "Alex",
            organisation: "Example LLP",
        };
    });

    it("keeps in-progress organisation text when the name autosave lands", async () => {
        const user = userEvent.setup();
        // The save must still be IN FLIGHT while the user types in the
        // sibling field — an immediately-resolved mock closes the race
        // window inside user.click()'s microtask flush and the test then
        // passes even against the unfixed combined hydration effect.
        let resolveNameSave!: () => void;
        state.updateDisplayName.mockImplementation(
            (name: string) =>
                new Promise<boolean>((resolve) => {
                    resolveNameSave = () => {
                        // Mirror the real context: a successful save
                        // refreshes the whole profile object.
                        state.profile = {
                            ...state.profile,
                            displayName: name,
                        };
                        resolve(true);
                    };
                }),
        );
        render(<SettingsPage />);

        const name = screen.getByPlaceholderText("Enter your name");
        const organisation = screen.getByPlaceholderText(
            "Enter your organisation",
        );
        await user.clear(name);
        await user.type(name, "Alexandra");
        await user.click(organisation); // blurs the name field -> autosave
        await user.type(organisation, " & Partners");

        expect(state.updateDisplayName).toHaveBeenCalledWith("Alexandra");
        resolveNameSave(); // profile refresh lands mid-typing
        await waitFor(() =>
            expect(screen.getByText("Saved")).toBeInTheDocument(),
        );
        expect(organisation).toHaveValue("Example LLP & Partners");
        expect(name).toHaveValue("Alexandra");
    });

    it("directs Google-created accounts without a password to Security", async () => {
        const user = userEvent.setup();
        render(<SettingsPage />);

        const email = screen.getByPlaceholderText("Enter your email");
        expect(email).toBeDisabled();
        await user.click(
            screen.getByRole("button", { name: "Update" }),
        );

        const dialog = screen.getByRole("dialog", { name: "Change email" });
        expect(dialog).toHaveTextContent(
            "Your account was created with Google. To change your email, first add a password in Settings > Security > Password.",
        );
        expect(state.updateEmail).not.toHaveBeenCalled();

        await user.click(
            screen.getByRole("button", { name: "Go to Security" }),
        );
        expect(state.push).toHaveBeenCalledWith("/settings/security");
    });

    it("allows the email change after a password has been added", async () => {
        state.passwordSet = true;
        const user = userEvent.setup();
        render(<SettingsPage />);

        const email = screen.getByPlaceholderText("Enter your email");
        await user.clear(email);
        await user.type(email, "new@example.com");
        const emailSection = screen.getByRole("heading", { name: "Email" })
            .parentElement!;
        await user.click(
            emailSection.querySelector<HTMLButtonElement>("button")!,
        );

        await waitFor(() =>
            expect(state.updateEmail).toHaveBeenCalledWith("new@example.com"),
        );
        expect(
            screen.queryByRole("dialog", { name: "Change email" }),
        ).not.toBeInTheDocument();
    });

    it("auto-saves name and organisation when their fields lose focus", async () => {
        const user = userEvent.setup();
        render(<SettingsPage />);

        const name = screen.getByPlaceholderText("Enter your name");
        await user.clear(name);
        await user.type(name, "Alex Chen");
        await user.tab();
        await waitFor(() =>
            expect(state.updateDisplayName).toHaveBeenCalledWith("Alex Chen"),
        );

        const organisation = screen.getByPlaceholderText(
            "Enter your organisation",
        );
        await user.clear(organisation);
        await user.type(organisation, "New LLP");
        await user.tab();
        await waitFor(() =>
            expect(state.updateOrganisation).toHaveBeenCalledWith("New LLP"),
        );
    });

    it("keeps the session and shows the reason when deletion is refused", async () => {
        const user = userEvent.setup();
        const detail =
            "You are the only admin of Elite Law LLP. Make another member an admin, or delete the organization, before deleting your account.";
        state.deleteAccount.mockRejectedValue(
            new MikeApiError({
                status: 409,
                code: "org_successor_required",
                message: detail,
            }),
        );
        render(<SettingsPage />);

        await user.click(
            screen.getByRole("button", { name: "Delete account" }),
        );
        await user.click(screen.getByRole("button", { name: "Delete" }));

        // The 409 detail names the blocking organization; a generic "Failed to
        // delete account" would leave the user with no way to unblock it.
        expect(await screen.findByText(detail)).toBeInTheDocument();
        expect(screen.getByText("Account not deleted")).toBeInTheDocument();
        expect(state.signOut).not.toHaveBeenCalled();
        expect(state.push).not.toHaveBeenCalled();
    });

    it("allows an existing display name to be cleared", async () => {
        const user = userEvent.setup();
        render(<SettingsPage />);

        const name = screen.getByPlaceholderText("Enter your name");
        await user.clear(name);
        await user.tab();

        await waitFor(() =>
            expect(state.updateDisplayName).toHaveBeenCalledWith(""),
        );
        expect(screen.queryByText("Name is required.")).not.toBeInTheDocument();
    });
});
