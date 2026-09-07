import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SignupPage from "./page";

const { signup, startGoogleOAuth, refreshSession, replace, push } = vi.hoisted(() => ({
    signup: vi.fn(),
    startGoogleOAuth: vi.fn(),
    refreshSession: vi.fn(),
    replace: vi.fn(),
    push: vi.fn(),
}));

vi.mock("next/navigation", () => ({
    useRouter: () => ({ replace, push }),
    useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/app/lib/authApi", () => ({
    signup,
    startGoogleOAuth,
    getAuthConfiguration: vi.fn().mockResolvedValue({ ssoEnabled: false }),
}));

vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({
        isAuthenticated: false,
        authLoading: false,
        refreshSession,
    }),
}));

vi.mock("@/app/components/site-logo", () => ({
    SiteLogo: () => <div>Mike</div>,
}));

describe("SignupPage", () => {
    beforeEach(() => {
        signup.mockReset();
        startGoogleOAuth.mockReset();
        refreshSession.mockReset();
        replace.mockReset();
        push.mockReset();
    });

    it("creates credentials and waits for email confirmation", async () => {
        signup.mockResolvedValue({
            user: { id: "user-1" },
            requiresEmailConfirmation: true,
        });
        const user = userEvent.setup();
        render(<SignupPage />);

        expect(screen.getByLabelText("Password")).toHaveAttribute(
            "placeholder",
            "Min. 10 Characters",
        );

        await user.type(
            screen.getByRole("textbox", { name: "Email" }),
            "alex@example.com",
        );
        await user.type(screen.getByLabelText("Password"), "secret1234");
        await user.type(
            screen.getByLabelText("Confirm Password"),
            "secret1234",
        );
        await user.click(screen.getByRole("button", { name: "Sign up" }));

        expect(signup).toHaveBeenCalledWith(
            "alex@example.com",
            "secret1234",
            "/onboarding/profile",
        );
        expect(push).toHaveBeenCalledWith("/signup/check-email");
    });

    it("places Google signup after the primary signup action", () => {
        render(<SignupPage />);

        const signup = screen.getByRole("button", { name: "Sign up" });
        const google = screen.getByRole("button", {
            name: "Continue with Google",
        });
        expect(
            signup.compareDocumentPosition(google) &
                Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
    });
});
