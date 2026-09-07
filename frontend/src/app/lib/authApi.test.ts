import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    AuthApiError,
    challengeAndVerifyMfa,
    challengeMfa,
    clearLegacyBrowserAuthStorage,
    enrollMfa,
    exchangeAuthCode,
    getAuthSession,
    getAuthConfiguration,
    getMfaAssurance,
    listMfaFactors,
    login,
    logout,
    requestPasswordReset,
    signup,
    startGoogleOAuth,
    startSso,
    unenrollMfa,
    updateAuthEmail,
    updateAuthPassword,
    verifyMfa,
} from "./authApi";

const fetchMock = vi.fn();
const user = {
    id: "user-1",
    email: "lawyer@example.test",
    pendingEmail: null,
    createdWithGoogle: false,
};

describe("cookie auth client", () => {
    beforeEach(() => {
        fetchMock.mockReset();
        vi.stubGlobal("fetch", fetchMock);
        window.localStorage.clear();
        window.sessionStorage.clear();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("logs in through the same-origin gateway without an Authorization header", async () => {
        fetchMock.mockResolvedValue(
            new Response(JSON.stringify({ user }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            }),
        );

        await expect(login(user.email, "correct horse")).resolves.toEqual({
            user,
        });
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/auth/login",
            expect.objectContaining({
                method: "POST",
                credentials: "include",
                cache: "no-store",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    email: user.email,
                    password: "correct horse",
                }),
            }),
        );
        expect(
            (fetchMock.mock.calls[0][1] as RequestInit).headers,
        ).not.toHaveProperty("Authorization");
    });

    it("maps an expired cookie session to a signed-out state", async () => {
        fetchMock.mockResolvedValue(
            new Response(JSON.stringify({ detail: "expired" }), {
                status: 401,
                headers: { "Content-Type": "application/json" },
            }),
        );

        await expect(getAuthSession()).resolves.toBeNull();
    });

    it("returns the current cookie-authenticated user", async () => {
        fetchMock.mockResolvedValue(
            new Response(JSON.stringify({ user }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            }),
        );

        await expect(getAuthSession()).resolves.toEqual(user);
    });

    it("does not hide non-401 session errors", async () => {
        fetchMock.mockResolvedValue(
            new Response(JSON.stringify({ detail: "Unavailable" }), {
                status: 503,
                headers: { "Content-Type": "application/json" },
            }),
        );

        await expect(getAuthSession()).rejects.toMatchObject({
            status: 503,
            message: "Unavailable",
        });
    });

    it("preserves structured server auth failures", async () => {
        fetchMock.mockResolvedValue(
            new Response(
                JSON.stringify({
                    code: "invalid_credentials",
                    detail: "Invalid login credentials",
                }),
                {
                    status: 400,
                    headers: { "Content-Type": "application/json" },
                },
            ),
        );

        const error = await login(user.email, "wrong").catch(
            (caught) => caught,
        );
        expect(error).toBeInstanceOf(AuthApiError);
        expect(error).toMatchObject({
            status: 400,
            code: "invalid_credentials",
            message: "Invalid login credentials",
        });
    });

    it("handles a bodyless logout response", async () => {
        fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

        await expect(logout()).resolves.toBeUndefined();
    });

    it("loads public auth configuration without caching", async () => {
        const config = {
            ssoEnabled: true,
            ssoButtonLabel: "Company login",
            ssoDomainRequired: true,
        };
        fetchMock.mockResolvedValue(
            new Response(JSON.stringify(config), { status: 200 }),
        );
        await expect(getAuthConfiguration()).resolves.toEqual(config);
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/auth/config",
            expect.objectContaining({ credentials: "include", cache: "no-store" }),
        );
    });

    it.each([
        [
            "SSO with domain",
            () => startSso("/onboarding", "example.com"),
            "/api/auth/oauth",
            "POST",
            { provider: "sso", next: "/onboarding", domain: "example.com" },
        ],
        [
            "SSO with deployment default",
            () => startSso("/onboarding"),
            "/api/auth/oauth",
            "POST",
            { provider: "sso", next: "/onboarding" },
        ],
        [
            "signup",
            () => signup("new@example.test", "long-password", "/onboarding"),
            "/api/auth/signup",
            "POST",
            {
                email: "new@example.test",
                password: "long-password",
                next: "/onboarding",
            },
        ],
        [
            "Google OAuth",
            () => startGoogleOAuth("/onboarding"),
            "/api/auth/oauth",
            "POST",
            { provider: "google", next: "/onboarding" },
        ],
        [
            "code exchange",
            () => exchangeAuthCode("oauth-code"),
            "/api/auth/exchange",
            "POST",
            { code: "oauth-code" },
        ],
        [
            "email update",
            () => updateAuthEmail("next@example.test", "/settings"),
            "/api/auth/email",
            "PATCH",
            { email: "next@example.test", next: "/settings" },
        ],
        [
            "password update",
            () => updateAuthPassword("new-password", true),
            "/api/auth/password",
            "PATCH",
            { password: "new-password", signOut: true },
        ],
        [
            "factor enrollment",
            () => enrollMfa("Work phone"),
            "/api/auth/mfa/enroll",
            "POST",
            { friendlyName: "Work phone" },
        ],
        [
            "factor challenge",
            () => challengeMfa("factor-1"),
            "/api/auth/mfa/challenge",
            "POST",
            { factorId: "factor-1" },
        ],
        [
            "factor verification",
            () => verifyMfa("factor-1", "challenge-1", "123456"),
            "/api/auth/mfa/verify",
            "POST",
            {
                factorId: "factor-1",
                challengeId: "challenge-1",
                code: "123456",
            },
        ],
        [
            "combined factor verification",
            () => challengeAndVerifyMfa("factor-1", "123456"),
            "/api/auth/mfa/challenge-and-verify",
            "POST",
            { factorId: "factor-1", code: "123456" },
        ],
        [
            "factor removal",
            () => unenrollMfa("factor/with slash"),
            "/api/auth/mfa/factors/factor%2Fwith%20slash",
            "DELETE",
            undefined,
        ],
        [
            "factor listing",
            () => listMfaFactors(),
            "/api/auth/mfa/factors",
            undefined,
            undefined,
        ],
        [
            "assurance lookup",
            () => getMfaAssurance(),
            "/api/auth/mfa/assurance",
            undefined,
            undefined,
        ],
    ] as const)(
        "sends the %s request through the auth gateway",
        async (_name, invoke, path, method, body) => {
            fetchMock.mockResolvedValue(
                new Response(JSON.stringify({ user }), {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                }),
            );

            await invoke();

            expect(fetchMock).toHaveBeenCalledWith(
                path,
                expect.objectContaining({
                    ...(method ? { method } : {}),
                    ...(body ? { body: JSON.stringify(body) } : {}),
                    credentials: "include",
                    cache: "no-store",
                }),
            );
        },
    );

    it("requests password reset and global logout without reading a response body", async () => {
        fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

        await requestPasswordReset("lawyer@example.test");
        await logout("global");

        expect(fetchMock).toHaveBeenNthCalledWith(
            1,
            "/api/auth/password-reset",
            expect.objectContaining({
                method: "POST",
                body: JSON.stringify({ email: "lawyer@example.test" }),
            }),
        );
        expect(fetchMock).toHaveBeenNthCalledWith(
            2,
            "/api/auth/logout",
            expect.objectContaining({
                method: "POST",
                body: JSON.stringify({ scope: "global" }),
            }),
        );
    });

    it("uses a safe fallback for malformed auth error responses", async () => {
        fetchMock.mockResolvedValue(new Response("not-json", { status: 500 }));

        await expect(login(user.email, "wrong")).rejects.toMatchObject({
            status: 500,
            code: null,
            message: "Authentication could not be completed.",
        });
    });

    it("removes legacy Supabase sessions without touching unrelated settings", () => {
        window.localStorage.setItem("sb-project-auth-token", "access-token");
        window.sessionStorage.setItem("supabase.auth.session", "refresh-token");
        window.localStorage.setItem("sidebarOpen", "true");

        clearLegacyBrowserAuthStorage();

        expect(window.localStorage.getItem("sb-project-auth-token")).toBeNull();
        expect(
            window.sessionStorage.getItem("supabase.auth.session"),
        ).toBeNull();
        expect(window.localStorage.getItem("sidebarOpen")).toBe("true");
    });

    it("is a no-op during server rendering", () => {
        vi.stubGlobal("window", undefined);
        expect(() => clearLegacyBrowserAuthStorage()).not.toThrow();
    });
});
