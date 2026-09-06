import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";

// The connector OAuth start routes sit behind main's error posture: SDK errors
// embed entire upstream response bodies, so the browser normally gets a fixed
// sanitized string and the operator reads the real message in the log. These
// tests pin the ONE deliberate exception — ConnectorSetupError, repo-authored
// setup text with our own redirect URI in it — and prove that everything
// else stays sanitized.

const startUserMcpConnectorOAuth = vi.fn();
const refreshUserMcpConnectorTools = vi.fn();

vi.mock("../../lib/supabase", () => ({
    createServerSupabase: vi.fn(() => ({})),
}));

vi.mock("../../middleware/auth", () => ({
    requireAuth: (
        _req: unknown,
        res: { locals: Record<string, unknown> },
        next: () => void,
    ) => {
        res.locals.userId = "u1";
        res.locals.userEmail = "u1@test.local";
        next();
    },
    requireMfaIfEnrolled: (_req: unknown, _res: unknown, next: () => void) =>
        next(),
}));

vi.mock("../../lib/mcpConnectors", async (importOriginal) => {
    const actual =
        await importOriginal<typeof import("../../lib/mcpConnectors")>();
    return {
        ...actual,
        startUserMcpConnectorOAuth: (...args: unknown[]) =>
            startUserMcpConnectorOAuth(...args),
        refreshUserMcpConnectorTools: (...args: unknown[]) =>
            refreshUserMcpConnectorTools(...args),
    };
});

import { app } from "../../app";
import { ConnectorSetupError } from "../../lib/mcp/errors";
import { McpOAuthRequiredError } from "../../lib/mcp/oauth";

const ORIGINAL_API_PUBLIC_URL = process.env.API_PUBLIC_URL;

beforeEach(() => {
    vi.clearAllMocks();
    process.env.API_PUBLIC_URL = "http://localhost:3000/api";
    vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
    if (ORIGINAL_API_PUBLIC_URL === undefined) delete process.env.API_PUBLIC_URL;
    else process.env.API_PUBLIC_URL = ORIGINAL_API_PUBLIC_URL;
});

describe("POST /user/mcp-connectors/:id/oauth/start", () => {
    it("returns the setup instructions verbatim, with the deployment's redirect URI, when the provider needs a pre-registered client", async () => {
        startUserMcpConnectorOAuth.mockImplementation(
            async (_userId: string, _id: string, redirectUri: string) => {
                throw new ConnectorSetupError(
                    `Slack needs a pre-configured OAuth client — add ${redirectUri} as a redirect URL and set SLACK_MCP_OAUTH_CLIENT_ID.`,
                );
            },
        );

        const res = await request(app).post("/user/mcp-connectors/c1/oauth/start");

        expect(res.status).toBe(400);
        expect(res.body.code).toBe("connector_setup_required");
        expect(res.body.detail).toContain("SLACK_MCP_OAUTH_CLIENT_ID");
        // The redirect URI is derived from API_PUBLIC_URL — the frontend
        // gateway, /api prefix included — never from the backend's own port.
        expect(res.body.detail).toContain(
            "http://localhost:3000/api/user/mcp-connectors/oauth/callback",
        );
    });

    it("keeps every other failure sanitized", async () => {
        startUserMcpConnectorOAuth.mockRejectedValue(
            new Error(
                "HTTP 400 <html><body>Error 400 (Bad Request)!!1</body></html>",
            ),
        );

        const res = await request(app).post("/user/mcp-connectors/c1/oauth/start");

        expect(res.status).toBe(400);
        expect(res.body).toEqual({
            detail: "Connector authorization could not be started.",
        });
    });
});

describe("POST /user/mcp-connectors/:id/refresh-tools", () => {
    it("signals 'authorize this connector' without a 401, so the browser keeps its session", async () => {
        // Regression: this answered 401 { code: "oauth_required" }. Since
        // authentication moved to HttpOnly cookies, the frontend's
        // authenticatedFetch treats ANY 401 from the API as an expired Mike
        // session and logs the user out — so every OAuth connector's first
        // refresh (the step that opens the consent popup) bounced the user
        // to the login page instead. The client keys on `code`, not status.
        refreshUserMcpConnectorTools.mockRejectedValue(
            new McpOAuthRequiredError(),
        );

        const res = await request(app).post(
            "/user/mcp-connectors/c1/refresh-tools",
        );

        expect(res.status).not.toBe(401);
        expect(res.status).toBe(409);
        expect(res.body).toEqual({
            code: "oauth_required",
            detail: "This connector needs to be authorized again.",
        });
    });
});
