import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock only the two module-internal seams that would otherwise require a live
// MCP server and Supabase: the SDK's `auth()` driver and `loadConnector`. Their
// vi.fn()s are created via vi.hoisted so the (hoisted) vi.mock factories below
// can reference them without a temporal-dead-zone error.
const { authMock, loadConnectorMock, guardedFetchMock } = vi.hoisted(() => ({
    authMock: vi.fn(),
    loadConnectorMock: vi.fn(),
    // Default: every discovery probe misses (404), so
    // seedResourceMetadataUrl resolves to undefined without touching the
    // network. Individual tests override this to simulate specific servers.
    guardedFetchMock: vi.fn(async () => new Response("{}", { status: 404 })),
}));

vi.mock("@modelcontextprotocol/sdk/client/auth.js", () => ({
    auth: (...args: unknown[]) => authMock(...args),
}));

vi.mock("./client", async (importOriginal) => {
    const actual = await importOriginal<typeof import("./client")>();
    return {
        ...actual,
        loadConnector: (...args: unknown[]) => loadConnectorMock(...args),
        guardedFetch: (...args: unknown[]) => guardedFetchMock(...args),
    };
});

import {
    DbMcpOAuthProvider,
    McpOAuthRequiredError,
    providerAuthorizationParams,
    startUserMcpConnectorOAuth,
} from "./oauth";
import type { ConnectorRow, Db } from "./types";

// The provider methods exercised here only read connector.server_url and the
// mode, and never touch the database, so an empty stub satisfies the type.
const stubDb = {} as Db;

function makeConnector(serverUrl: string): ConnectorRow {
    return {
        id: "00000000-0000-0000-0000-000000000000",
        user_id: "user-1",
        name: "Test connector",
        transport: "streamable_http",
        server_url: serverUrl,
        auth_type: "oauth",
        enabled: true,
        tool_policy: {},
        encrypted_auth_config: null,
        auth_config_iv: null,
        auth_config_tag: null,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
    };
}

// A representative authorization URL as the MCP SDK would hand it to the
// provider, already carrying the standard OAuth params.
const AUTH_URL =
    "https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=abc&code_challenge=xyz";

describe("providerAuthorizationParams", () => {
    it("requests offline access + consent for Google hosts", () => {
        expect(
            providerAuthorizationParams(
                "https://drivemcp.googleapis.com/mcp/v1",
            ),
        ).toEqual({ access_type: "offline", prompt: "consent" });
    });

    it("adds nothing for non-Google hosts", () => {
        expect(
            providerAuthorizationParams("https://mcp.example.com/mcp"),
        ).toEqual({});
    });

    it("adds nothing for Slack hosts", () => {
        // Slack needs no proprietary parameters: its MCP authorization
        // endpoint takes user scopes via the standard `scope` parameter and
        // refresh-token issuance is governed by the app's token-rotation
        // setting, not by request flags.
        expect(
            providerAuthorizationParams("https://mcp.slack.com/mcp"),
        ).toEqual({});
    });
});

describe("DbMcpOAuthProvider.redirectToAuthorization", () => {
    it("requests offline access + consent for Google hosts when initiating", async () => {
        const provider = new DbMcpOAuthProvider(
            stubDb,
            makeConnector("https://drivemcp.googleapis.com/mcp/v1"),
            "user-1",
            "initiate",
            "https://app.test/callback",
        );

        await provider.redirectToAuthorization(new URL(AUTH_URL));

        const url = provider.lastAuthorizeUrl;
        expect(url).not.toBeNull();
        if (!url) throw new Error("expected an authorization URL");
        // Without these Google never returns a refresh token, so the connector
        // would break as soon as the first access token expires.
        expect(url.searchParams.get("access_type")).toBe("offline");
        expect(url.searchParams.get("prompt")).toBe("consent");
        // The SDK-provided params must be preserved.
        expect(url.searchParams.get("response_type")).toBe("code");
        expect(url.searchParams.get("client_id")).toBe("abc");
    });

    it("leaves non-Google authorization URLs untouched", async () => {
        const provider = new DbMcpOAuthProvider(
            stubDb,
            makeConnector("https://mcp.example.com/mcp"),
            "user-1",
            "initiate",
            "https://app.test/callback",
        );

        await provider.redirectToAuthorization(new URL(AUTH_URL));

        const url = provider.lastAuthorizeUrl;
        expect(url).not.toBeNull();
        if (!url) throw new Error("expected an authorization URL");
        expect(url.searchParams.get("access_type")).toBeNull();
        expect(url.searchParams.get("prompt")).toBeNull();
    });

    it("refuses to redirect (and captures nothing) in 'use' mode", async () => {
        const provider = new DbMcpOAuthProvider(
            stubDb,
            makeConnector("https://drivemcp.googleapis.com/mcp/v1"),
            "user-1",
            "use",
            "https://app.test/callback",
        );

        await expect(
            provider.redirectToAuthorization(new URL(AUTH_URL)),
        ).rejects.toBeInstanceOf(McpOAuthRequiredError);
        expect(provider.lastAuthorizeUrl).toBeNull();
    });
});

// Records every `.from(table).delete().eq(column, value)` and
// `.from(table).update(patch).eq(column, value)` chain so a test can assert
// exactly which rows the provider invalidated (and how), without a real
// database.
type RecordedDelete = { table: string; column: string; value: unknown };
type RecordedUpdate = {
    table: string;
    patch: Record<string, unknown>;
    column: string;
    value: unknown;
};

function makeRecordingDb(
    deletes: RecordedDelete[],
    updates: RecordedUpdate[] = [],
): Db {
    return {
        from(table: string) {
            return {
                delete() {
                    return {
                        eq(column: string, value: unknown) {
                            deletes.push({ table, column, value });
                            return Promise.resolve({ error: null });
                        },
                    };
                },
                update(patch: Record<string, unknown>) {
                    return {
                        eq(column: string, value: unknown) {
                            updates.push({ table, patch, column, value });
                            return Promise.resolve({ error: null });
                        },
                    };
                },
            };
        },
    } as unknown as Db;
}

// Minimal in-memory stand-in for the single `user_mcp_oauth_tokens` row a
// connector owns, supporting the exact query chains DbMcpOAuthProvider uses.
// Lets tests observe how a full save → invalidate → read sequence composes,
// which the pure recording db above cannot.
function makeRowStoreDb() {
    const store: { row: Record<string, unknown> | null } = { row: null };
    const db = {
        from(table: string) {
            return {
                select() {
                    return {
                        eq() {
                            return {
                                maybeSingle: async () => ({
                                    data:
                                        table === "user_mcp_oauth_tokens"
                                            ? store.row
                                            : null,
                                    error: null,
                                }),
                            };
                        },
                    };
                },
                upsert(values: Record<string, unknown>) {
                    if (table === "user_mcp_oauth_tokens") {
                        store.row = { ...(store.row ?? {}), ...values };
                    }
                    return Promise.resolve({ error: null });
                },
                update(patch: Record<string, unknown>) {
                    return {
                        eq: () => {
                            if (
                                table === "user_mcp_oauth_tokens" &&
                                store.row
                            ) {
                                store.row = { ...store.row, ...patch };
                            }
                            return Promise.resolve({ error: null });
                        },
                    };
                },
                delete() {
                    return {
                        eq: () => {
                            if (table === "user_mcp_oauth_tokens") {
                                store.row = null;
                            }
                            return Promise.resolve({ error: null });
                        },
                    };
                },
            };
        },
    } as unknown as Db;
    return { db, store };
}

describe("startUserMcpConnectorOAuth", () => {
    // Any real deployment that reaches these flows has a Google OAuth client
    // configured (Google offers no dynamic registration); mirror that here so
    // the suite exercises the flow rather than the missing-client guard. The
    // guard itself is tested explicitly below.
    //
    // Every env var a test in this block mutates is snapshotted here and
    // restored in afterEach — never inline at the end of a test body, where a
    // failed assertion would skip the restoration and (because
    // vi.clearAllMocks() resets calls, not implementations) cascade into
    // unrelated failures. The guardedFetch implementation is reset the same
    // way for the same reason.
    const ENV_KEYS = [
        "GOOGLE_MCP_OAUTH_CLIENT_ID",
        "SLACK_MCP_OAUTH_CLIENT_ID",
        "MCP_OAUTH_CLIENT_ID",
    ] as const;
    const PRIOR_ENV = Object.fromEntries(
        ENV_KEYS.map((key) => [key, process.env[key]]),
    );
    beforeEach(() => {
        vi.clearAllMocks();
        process.env.GOOGLE_MCP_OAUTH_CLIENT_ID =
            "test-client.apps.googleusercontent.com";
    });
    afterEach(() => {
        for (const key of ENV_KEYS) {
            const prior = PRIOR_ENV[key];
            if (prior === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = prior;
            }
        }
        guardedFetchMock.mockImplementation(
            async () => new Response("{}", { status: 404 }),
        );
    });

    it("fails fast with setup instructions when no Google OAuth client is configured", async () => {
        delete process.env.GOOGLE_MCP_OAUTH_CLIENT_ID;
        const connector = makeConnector(
            "https://drivemcp.googleapis.com/mcp/v1",
        );
        loadConnectorMock.mockResolvedValue(connector);
        // No stored token row either — the true first-run state.
        const db = {
            from() {
                return {
                    select() {
                        return {
                            eq() {
                                return {
                                    maybeSingle: () =>
                                        Promise.resolve({
                                            data: null,
                                            error: null,
                                        }),
                                };
                            },
                        };
                    },
                };
            },
        } as unknown as Db;

        await expect(
            startUserMcpConnectorOAuth(
                "user-1",
                connector.id,
                "https://app.test/callback",
                db,
            ),
        ).rejects.toThrow(/GOOGLE_MCP_OAUTH_CLIENT_ID/);
        // The message must carry the deployment's actual redirect URI so the
        // operator can paste it straight into the Google Cloud Console form.
        await expect(
            startUserMcpConnectorOAuth(
                "user-1",
                connector.id,
                "https://app.test/callback",
                db,
            ),
        ).rejects.toThrow(/https:\/\/app\.test\/callback/);
        expect(authMock).not.toHaveBeenCalled();
    });

    it("fails fast with setup instructions when no Slack OAuth client is configured", async () => {
        // Slack, like Google, has no RFC 7591 dynamic client registration:
        // without a pre-created Slack app the SDK's register-a-client fallback
        // dead-ends mid-flow, so the guard must fire first with actionable
        // instructions.
        delete process.env.SLACK_MCP_OAUTH_CLIENT_ID;
        delete process.env.MCP_OAUTH_CLIENT_ID;
        const connector = makeConnector("https://mcp.slack.com/mcp");
        loadConnectorMock.mockResolvedValue(connector);
        const db = {
            from() {
                return {
                    select() {
                        return {
                            eq() {
                                return {
                                    maybeSingle: () =>
                                        Promise.resolve({
                                            data: null,
                                            error: null,
                                        }),
                                };
                            },
                        };
                    },
                };
            },
        } as unknown as Db;

        await expect(
            startUserMcpConnectorOAuth(
                "user-1",
                connector.id,
                "https://app.test/callback",
                db,
            ),
        ).rejects.toThrow(/SLACK_MCP_OAUTH_CLIENT_ID/);
        // Typed so the route can allowlist it: this is repo-authored text
        // with our own redirect URI in it, not SDK output, so it may reach
        // the browser verbatim while every other failure stays sanitized.
        await expect(
            startUserMcpConnectorOAuth(
                "user-1",
                connector.id,
                "https://app.test/callback",
                db,
            ),
        ).rejects.toMatchObject({
            name: "ConnectorSetupError",
            code: "connector_setup_required",
            message: expect.stringContaining("https://app.test/callback"),
        });
        expect(authMock).not.toHaveBeenCalled();
    });

    it("seeds the SDK with the resource-metadata URL advertised via WWW-Authenticate", async () => {
        // The SDK's own RFC 9728 discovery tries the path-aware well-known
        // form first and only falls back to the root form on a 4xx. Slack
        // 302s the path-aware form, so unseeded discovery finds nothing and
        // the authorization request goes out with NO scope — which Slack
        // rejects ("No scopes requested"). The server's 401 challenge names
        // the real metadata URL; assert we hand it to the SDK.
        process.env.SLACK_MCP_OAUTH_CLIENT_ID = "slack-client-id";
        const metadataUrl =
            "https://mcp.slack.com/.well-known/oauth-protected-resource";
        guardedFetchMock.mockImplementation(
            async () =>
                new Response(
                    JSON.stringify({
                        jsonrpc: "2.0",
                        id: null,
                        error: { code: -32001, message: "missing_token" },
                    }),
                    {
                        status: 401,
                        headers: {
                            "www-authenticate": `Bearer resource_metadata="${metadataUrl}"`,
                        },
                    },
                ),
        );
        const connector = makeConnector("https://mcp.slack.com/mcp");
        loadConnectorMock.mockResolvedValue(connector);
        authMock.mockResolvedValue("AUTHORIZED");
        const deletes: RecordedDelete[] = [];
        const db = makeRecordingDb(deletes);

        await startUserMcpConnectorOAuth(
            "user-1",
            connector.id,
            "https://app.test/callback",
            db,
        );

        expect(authMock).toHaveBeenCalledTimes(1);
        const options = authMock.mock.calls[0][1] as {
            resourceMetadataUrl?: URL;
        };
        expect(options.resourceMetadataUrl?.toString()).toBe(metadataUrl);
        // Env and guardedFetch restoration happens in afterEach, so a failing
        // assertion above cannot leak this test's setup into later tests.
    });

    it("clears stale token columns (but not the row) when an interactive redirect is required", async () => {
        // The exact broken-fleet state this PR targets: the SDK cannot complete
        // from stored credentials (expired access token, no usable refresh
        // token), so it reaches the authorization-redirect branch.
        const connector = makeConnector(
            "https://drivemcp.googleapis.com/mcp/v1",
        );
        loadConnectorMock.mockResolvedValue(connector);
        authMock.mockImplementation(async (provider: DbMcpOAuthProvider) => {
            await provider.redirectToAuthorization(new URL(AUTH_URL));
            return "REDIRECT";
        });
        const deletes: RecordedDelete[] = [];
        const updates: RecordedUpdate[] = [];
        const db = makeRecordingDb(deletes, updates);

        const result = await startUserMcpConnectorOAuth(
            "user-1",
            connector.id,
            "https://app.test/callback",
            db,
        );

        expect(result.alreadyAuthorized).toBe(false);
        expect(result.authorizationUrl).toContain("access_type=offline");
        // Without nulling the token columns, `oauthConnected`
        // (!!encrypted_access_token) would stay true on a dead token and the
        // frontend poll would resolve on a phantom success, closing the consent
        // popup mid-flow.
        const tokenUpdates = updates.filter(
            (update) =>
                update.table === "user_mcp_oauth_tokens" &&
                update.column === "connector_id" &&
                update.value === connector.id,
        );
        expect(tokenUpdates).toHaveLength(1);
        expect(tokenUpdates[0].patch).toMatchObject({
            encrypted_access_token: null,
            access_token_iv: null,
            access_token_tag: null,
            encrypted_refresh_token: null,
            refresh_token_iv: null,
            refresh_token_tag: null,
            expires_at: null,
        });
        // But the row itself must survive: it also carries the client_id /
        // client_secret persisted after RFC 7591 dynamic client registration,
        // which the OAuth callback leg needs to exchange the code. A whole-row
        // delete here would strand every DCR-based server mid-flow.
        expect(tokenUpdates[0].patch).not.toHaveProperty("client_id");
        expect(tokenUpdates[0].patch).not.toHaveProperty(
            "encrypted_client_secret",
        );
        expect(
            deletes.filter((item) => item.table === "user_mcp_oauth_tokens"),
        ).toHaveLength(0);
    });

    it("still returns dynamically-registered client information after a redirect-triggered invalidation", async () => {
        // Regression test for the DCR-breaking whole-row delete: a server with
        // no env-configured OAuth client relies on RFC 7591 dynamic client
        // registration. During auth() the SDK registers a client (persisted via
        // saveClientInformation) and then asks for the interactive redirect —
        // after which we invalidate stale tokens. The callback leg then builds
        // a fresh provider and calls clientInformation(); if the registered
        // client is gone, the SDK throws "Existing OAuth client information is
        // required when exchanging an authorization code" and the flow can
        // never complete.
        // No env-configured fallback client: this connector must rely purely
        // on dynamic registration (afterEach restores the variable).
        delete process.env.MCP_OAUTH_CLIENT_ID;
        const connector = makeConnector("https://mcp.example.com/mcp");
        loadConnectorMock.mockResolvedValue(connector);
        authMock.mockImplementation(async (provider: DbMcpOAuthProvider) => {
            // The SDK's DCR step, followed by the redirect request.
            await provider.saveClientInformation({
                client_id: "dcr-client-id",
            });
            await provider.redirectToAuthorization(new URL(AUTH_URL));
            return "REDIRECT";
        });
        const { db, store } = makeRowStoreDb();

        const result = await startUserMcpConnectorOAuth(
            "user-1",
            connector.id,
            "https://app.test/callback",
            db,
        );
        expect(result.alreadyAuthorized).toBe(false);

        // The row survived the invalidation with the registered client
        // intact (and no resurrected token material).
        expect(store.row).not.toBeNull();
        expect(store.row?.client_id).toBe("dcr-client-id");
        expect(store.row?.encrypted_access_token ?? null).toBeNull();

        // The OAuth callback leg constructs a fresh provider from the
        // stored state; it must still see the registered client.
        const callbackProvider = new DbMcpOAuthProvider(
            db,
            connector,
            "user-1",
            "initiate",
            "https://app.test/callback",
            "state-token",
        );
        await expect(callbackProvider.clientInformation()).resolves.toEqual({
            client_id: "dcr-client-id",
        });
    });

    it("does not touch stored tokens when the connector is already authorized", async () => {
        const connector = makeConnector("https://mcp.example.com/mcp");
        loadConnectorMock.mockResolvedValue(connector);
        authMock.mockResolvedValue("AUTHORIZED");
        const deletes: RecordedDelete[] = [];
        const updates: RecordedUpdate[] = [];
        const db = makeRecordingDb(deletes, updates);

        const result = await startUserMcpConnectorOAuth(
            "user-1",
            connector.id,
            "https://app.test/callback",
            db,
        );

        expect(result).toEqual({
            authorizationUrl: null,
            alreadyAuthorized: true,
        });
        expect(deletes).toHaveLength(0);
        expect(updates).toHaveLength(0);
    });
});
