import { describe, expect, it } from "vitest";
import { mcpOAuthProviderFor } from "./providers";

describe("mcpOAuthProviderFor", () => {
    it("resolves Slack for slack.com and its subdomains", () => {
        expect(mcpOAuthProviderFor("https://mcp.slack.com/mcp")?.id).toBe(
            "slack",
        );
        expect(mcpOAuthProviderFor("https://slack.com/mcp")?.id).toBe("slack");
    });

    it("resolves Slack for the absolute (trailing-dot) host form", () => {
        // `mcp.slack.com.` is the fully-qualified DNS spelling of the same
        // host; URL preserves the dot, and without normalization the quirks
        // (env prefix, setup instructions) would be silently skipped.
        expect(mcpOAuthProviderFor("https://mcp.slack.com./mcp")?.id).toBe(
            "slack",
        );
    });

    it("rejects look-alike hosts", () => {
        // Suffix-only string matches must not pass: neither a domain that
        // merely ends in the text "slack.com" nor an attacker subdomain
        // carrying it as a prefix is a Slack host.
        expect(mcpOAuthProviderFor("https://notslack.com/mcp")).toBeNull();
        expect(
            mcpOAuthProviderFor("https://slack.com.evil.test/mcp"),
        ).toBeNull();
        expect(mcpOAuthProviderFor("not a url")).toBeNull();
    });

    it("keeps Google resolution intact", () => {
        expect(
            mcpOAuthProviderFor("https://drivemcp.googleapis.com/mcp/v1")?.id,
        ).toBe("google");
        expect(
            mcpOAuthProviderFor("https://gmailmcp.googleapis.com/mcp")?.id,
        ).toBe("google");
        expect(mcpOAuthProviderFor("https://googleapis.com/x")?.id).toBe(
            "google",
        );
        expect(mcpOAuthProviderFor("https://mcp.example.com/mcp")).toBeNull();
    });

    it("rejects Google look-alike hosts", () => {
        // Suffix-only string matches must not pass: this is NOT a google host.
        expect(mcpOAuthProviderFor("https://notgoogleapis.com/x")).toBeNull();
        // A subdomain of an attacker domain that merely contains the string.
        expect(
            mcpOAuthProviderFor("https://googleapis.com.evil.test/mcp"),
        ).toBeNull();
    });

    it("resolves Google for the absolute (trailing-dot) host form", () => {
        // `https://googleapis.com./x` names the same host as `googleapis.com`;
        // `URL` keeps the trailing dot, so without stripping it the
        // offline-access params would be silently skipped.
        expect(mcpOAuthProviderFor("https://googleapis.com./x")?.id).toBe(
            "google",
        );
        expect(
            mcpOAuthProviderFor("https://drivemcp.googleapis.com./mcp")?.id,
        ).toBe("google");
    });

    it("still rejects a look-alike host that carries a trailing dot", () => {
        expect(mcpOAuthProviderFor("https://notgoogleapis.com./x")).toBeNull();
    });
});

describe("Slack provider quirks", () => {
    const slack = mcpOAuthProviderFor("https://mcp.slack.com/mcp");

    it("declares no extra authorization parameters", () => {
        // Slack's MCP authorization endpoint takes user scopes in the
        // standard `scope` parameter (unlike classic Slack OAuth's
        // `user_scope`), so the SDK-built URL needs no additions.
        expect(slack?.authorizationParams).toBeUndefined();
    });

    it("names the env vars and the redirect URI in its setup instructions", () => {
        const instructions = slack?.setupInstructions?.(
            "https://app.test/callback",
        );
        expect(instructions).toMatch(/SLACK_MCP_OAUTH_CLIENT_ID/);
        expect(instructions).toMatch(/SLACK_MCP_OAUTH_CLIENT_SECRET/);
        // Operators must be able to paste the exact redirect URL into the
        // Slack app's OAuth settings form.
        expect(instructions).toContain("https://app.test/callback");
        // The two non-obvious app requirements the flow dies without.
        expect(instructions).toMatch(/Slack MCP Server/);
        expect(instructions).toMatch(/PKCE/);
    });

    it("hints at the real endpoint when a wrong Slack path redirects", () => {
        // Wrong slack.com paths answer with 302 redirects or HTML pages, so
        // the SDK fails with an opaque non-2xx status.
        const hint = slack?.endpointHint?.(
            new URL("https://slack.com/api/mcp"),
            302,
        );
        expect(hint).toMatch(/https:\/\/mcp\.slack\.com\/mcp/);
    });

    it("stays quiet on the real endpoint and on plain auth failures", () => {
        // The real endpoint 404/500-ing is a server problem, not a URL typo.
        expect(
            slack?.endpointHint?.(new URL("https://mcp.slack.com/mcp"), 404),
        ).toBeNull();
        // 401/403 mean auth, not a wrong URL — even on a non-canonical path
        // the hint would mislead (the OAuth flow handles these).
        expect(
            slack?.endpointHint?.(new URL("https://slack.com/api/mcp"), 401),
        ).toBeNull();
    });
});
