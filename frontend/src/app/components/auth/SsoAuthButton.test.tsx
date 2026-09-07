import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SsoAuthButton } from "./SsoAuthButton";

const { getAuthConfiguration, startSso } = vi.hoisted(() => ({
    getAuthConfiguration: vi.fn(),
    startSso: vi.fn(),
}));
vi.mock("@/app/lib/authApi", () => ({ getAuthConfiguration, startSso }));

describe("SsoAuthButton", () => {
    beforeEach(() => {
        vi.resetAllMocks();
        getAuthConfiguration.mockResolvedValue({
            ssoEnabled: true,
            ssoButtonLabel: "Single sign-on",
            ssoDomainRequired: false,
        });
        startSso.mockResolvedValue({ url: "https://idp.example/saml" });
    });

    it("stays hidden while settings load and when disabled", async () => {
        getAuthConfiguration.mockResolvedValue({ ssoEnabled: false });
        const { container } = render(<SsoAuthButton onError={vi.fn()} />);
        expect(container).toBeEmptyDOMElement();
        await waitFor(() => expect(getAuthConfiguration).toHaveBeenCalled());
        expect(container).toBeEmptyDOMElement();
    });

    it("stays hidden if settings cannot load", async () => {
        getAuthConfiguration.mockRejectedValue(new Error("offline"));
        const { container } = render(<SsoAuthButton onError={vi.fn()} />);
        await waitFor(() => expect(getAuthConfiguration).toHaveBeenCalled());
        expect(container).toBeEmptyDOMElement();
    });

    it("uses the deployment label and default domain without an input", async () => {
        getAuthConfiguration.mockResolvedValue({
            ssoEnabled: true,
            ssoButtonLabel: "Company login",
            ssoDomainRequired: false,
        });
        const onLoadingChange = vi.fn();
        render(
            <SsoAuthButton
                onError={vi.fn()}
                onLoadingChange={onLoadingChange}
            />,
        );
        const button = await screen.findByRole("button", {
            name: "Company login",
        });
        expect(button).toHaveAttribute("type", "button");
        expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
        await userEvent.click(button);
        expect(startSso).toHaveBeenCalledWith("/onboarding/profile", undefined);
        expect(onLoadingChange).toHaveBeenCalledWith(true);
        expect(
            screen.getByRole("button", { name: "Continuing…" }),
        ).toBeDisabled();
    });

    it("requires a domain and handles Enter without submitting the password form", async () => {
        getAuthConfiguration.mockResolvedValue({
            ssoEnabled: true,
            ssoButtonLabel: "Single sign-on",
            ssoDomainRequired: true,
        });
        const onSubmit = vi.fn((event) => event.preventDefault());
        render(
            <form onSubmit={onSubmit}>
                <SsoAuthButton onError={vi.fn()} />
            </form>,
        );
        const input = await screen.findByRole("textbox", {
            name: "Organization domain",
        });
        expect(screen.getByRole("button")).toBeDisabled();
        await userEvent.type(input, " example.com {Enter}");
        expect(startSso).toHaveBeenCalledWith(
            "/onboarding/profile",
            "example.com",
        );
        expect(onSubmit).not.toHaveBeenCalled();
    });

    it("respects the parent loading state", async () => {
        render(<SsoAuthButton onError={vi.fn()} disabled />);
        expect(await screen.findByRole("button")).toBeDisabled();
    });

    it.each([
        [
            new Error("private diagnostics"),
            "Unable to start single sign-on. Please try again.",
        ],
        [
            { code: "sso_domain_not_allowed", message: "private diagnostics" },
            "Single sign-on is not available for this domain.",
        ],
    ])("shows intentional errors and permits retry", async (error, message) => {
        startSso.mockRejectedValue(error);
        const onError = vi.fn();
        const onLoadingChange = vi.fn();
        render(
            <SsoAuthButton
                onError={onError}
                onLoadingChange={onLoadingChange}
            />,
        );
        await userEvent.click(await screen.findByRole("button"));
        expect(onError).toHaveBeenLastCalledWith(message);
        expect(onLoadingChange).toHaveBeenLastCalledWith(false);
        expect(screen.getByRole("button")).toBeEnabled();
    });
});
