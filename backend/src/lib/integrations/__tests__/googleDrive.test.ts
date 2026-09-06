import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    GOOGLE_DRIVE_SCOPE,
    buildGoogleDriveTools,
    executeGoogleDriveToolCall,
    getGoogleDriveStatus,
    startGoogleDriveOAuth,
} from "../googleDrive";
import { ConnectorSetupError } from "../../mcp/errors";
import { encryptString } from "../../mcp/client";
import type { Db } from "../../mcp/types";

/**
 * A minimal configurable Supabase stub: routes per-table responses and
 * records writes. Only the chains the module uses are implemented.
 */
function makeDb(options: {
    tokenRow?: Record<string, unknown> | null;
    onInsert?: (table: string, row: Record<string, unknown>) => void;
    onDelete?: (table: string) => void;
}): Db {
    return {
        from(table: string) {
            return {
                select() {
                    return {
                        eq() {
                            return {
                                maybeSingle: () =>
                                    Promise.resolve({
                                        data:
                                            table === "user_google_drive_tokens"
                                                ? (options.tokenRow ?? null)
                                                : null,
                                        error: null,
                                    }),
                            };
                        },
                    };
                },
                insert(row: Record<string, unknown>) {
                    options.onInsert?.(table, row);
                    return Promise.resolve({ error: null });
                },
                upsert(row: Record<string, unknown>) {
                    options.onInsert?.(table, row);
                    return Promise.resolve({ error: null });
                },
                delete() {
                    return {
                        eq() {
                            options.onDelete?.(table);
                            return Promise.resolve({ error: null });
                        },
                    };
                },
            };
        },
    } as unknown as Db;
}

function encryptedTokenRow(overrides: Partial<Record<string, unknown>> = {}) {
    const access = encryptString("access-token-1");
    const refresh = encryptString("refresh-token-1");
    return {
        user_id: "user-1",
        encrypted_access_token: access.encrypted,
        access_token_iv: access.iv,
        access_token_tag: access.tag,
        encrypted_refresh_token: refresh.encrypted,
        refresh_token_iv: refresh.iv,
        refresh_token_tag: refresh.tag,
        scope: GOOGLE_DRIVE_SCOPE,
        // Fresh by default so calls use the stored token without refreshing.
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
        ...overrides,
    };
}

const PRIOR_ENV = {
    driveId: process.env.GOOGLE_DRIVE_OAUTH_CLIENT_ID,
    driveSecret: process.env.GOOGLE_DRIVE_OAUTH_CLIENT_SECRET,
    mcpId: process.env.GOOGLE_MCP_OAUTH_CLIENT_ID,
    mcpSecret: process.env.GOOGLE_MCP_OAUTH_CLIENT_SECRET,
};

beforeEach(() => {
    process.env.GOOGLE_DRIVE_OAUTH_CLIENT_ID = "drive-client-id";
    process.env.GOOGLE_DRIVE_OAUTH_CLIENT_SECRET = "drive-client-secret";
    delete process.env.GOOGLE_MCP_OAUTH_CLIENT_ID;
    delete process.env.GOOGLE_MCP_OAUTH_CLIENT_SECRET;
    // encryptString/decryptString derive their AES key from this secret.
    process.env.MCP_CONNECTORS_ENCRYPTION_SECRET ??= "test-encryption-secret";
});

afterEach(() => {
    vi.unstubAllGlobals();
    const restore = (key: string, value: string | undefined) => {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    };
    restore("GOOGLE_DRIVE_OAUTH_CLIENT_ID", PRIOR_ENV.driveId);
    restore("GOOGLE_DRIVE_OAUTH_CLIENT_SECRET", PRIOR_ENV.driveSecret);
    restore("GOOGLE_MCP_OAUTH_CLIENT_ID", PRIOR_ENV.mcpId);
    restore("GOOGLE_MCP_OAUTH_CLIENT_SECRET", PRIOR_ENV.mcpSecret);
});

describe("startGoogleDriveOAuth", () => {
    it("fails fast with setup instructions when no OAuth client is configured", async () => {
        delete process.env.GOOGLE_DRIVE_OAUTH_CLIENT_ID;
        delete process.env.GOOGLE_DRIVE_OAUTH_CLIENT_SECRET;
        const db = makeDb({});
        await expect(
            startGoogleDriveOAuth("user-1", "https://app.test/cb", db),
        ).rejects.toThrow(/GOOGLE_DRIVE_OAUTH_CLIENT_ID/);
        await expect(
            startGoogleDriveOAuth("user-1", "https://app.test/cb", db),
        ).rejects.toThrow(/https:\/\/app\.test\/cb/);
        // The typed class is what lets the route return this text to the
        // browser; a plain Error would be sanitized into a fixed string.
        await expect(
            startGoogleDriveOAuth("user-1", "https://app.test/cb", db),
        ).rejects.toBeInstanceOf(ConnectorSetupError);
    });

    it("builds a PKCE + offline-access authorization URL and stores state", async () => {
        const inserts: { table: string; row: Record<string, unknown> }[] = [];
        const db = makeDb({
            onInsert: (table, row) => inserts.push({ table, row }),
        });
        const { authorizationUrl } = await startGoogleDriveOAuth(
            "user-1",
            "https://app.test/cb",
            db,
        );
        const url = new URL(authorizationUrl);
        expect(url.hostname).toBe("accounts.google.com");
        expect(url.searchParams.get("client_id")).toBe("drive-client-id");
        expect(url.searchParams.get("scope")).toBe(GOOGLE_DRIVE_SCOPE);
        expect(url.searchParams.get("code_challenge_method")).toBe("S256");
        // Without these two params Google never issues a refresh token and the
        // connection silently dies when the first access token expires.
        expect(url.searchParams.get("access_type")).toBe("offline");
        expect(url.searchParams.get("prompt")).toBe("consent");
        expect(inserts).toHaveLength(1);
        expect(inserts[0].table).toBe("google_drive_oauth_states");
    });
});

describe("getGoogleDriveStatus", () => {
    it("reports the schema as ready and the client as configured", async () => {
        const status = await getGoogleDriveStatus("user-1", makeDb({}));
        expect(status).toEqual({
            connected: false,
            scope: null,
            configured: true,
            schemaReady: true,
        });
    });

    it("reports a missing Drive migration instead of failing the status call", async () => {
        // PostgREST's "table not in schema cache" — what a deployment that
        // set the env vars but never applied the migration actually gets.
        // Before this flag the route answered 500 and the card blamed the
        // OAuth client, which was configured perfectly well.
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
                                            error: {
                                                code: "PGRST205",
                                                message:
                                                    "Could not find the table 'public.user_google_drive_tokens' in the schema cache",
                                            },
                                        }),
                                };
                            },
                        };
                    },
                };
            },
        } as unknown as Db;
        const status = await getGoogleDriveStatus("user-1", db);
        expect(status).toEqual({
            connected: false,
            scope: null,
            configured: true,
            schemaReady: false,
        });
    });

    it("still surfaces unrelated database errors", async () => {
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
                                            error: { code: "57P01", message: "terminating connection" },
                                        }),
                                };
                            },
                        };
                    },
                };
            },
        } as unknown as Db;
        await expect(getGoogleDriveStatus("user-1", db)).rejects.toMatchObject({
            code: "57P01",
        });
    });
});

describe("buildGoogleDriveTools", () => {
    it("offers no tools when the user has not connected Drive", async () => {
        const tools = await buildGoogleDriveTools("user-1", makeDb({}));
        expect(tools).toEqual([]);
    });

    it("offers the three read-only tools once connected", async () => {
        const tools = (await buildGoogleDriveTools(
            "user-1",
            makeDb({ tokenRow: encryptedTokenRow() }),
        )) as { function: { name: string } }[];
        expect(tools.map((t) => t.function.name)).toEqual([
            "google_drive_search",
            "google_drive_read_file",
            "google_drive_list_recent",
        ]);
    });
});

describe("executeGoogleDriveToolCall", () => {
    it("returns an auth-required error when Drive is not connected", async () => {
        const { content, event } = await executeGoogleDriveToolCall(
            "user-1",
            "google_drive_search",
            { query: "contract" },
            makeDb({}),
        );
        expect(JSON.parse(content).ok).toBe(false);
        expect(event.status).toBe("error");
        expect(event.connector_name).toBe("Google Drive");
    });

    it("searches with an escaped query and returns files", async () => {
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = new URL(String(input));
            expect(url.pathname).toBe("/drive/v3/files");
            const q = url.searchParams.get("q") ?? "";
            // The user's single quote must not terminate the q literal.
            expect(q).toContain("name contains 'I485 \\'summary\\''");
            expect(q).toContain("trashed = false");
            return new Response(
                JSON.stringify({
                    files: [{ id: "f1", name: "I485.pdf", mimeType: "application/pdf" }],
                }),
                { status: 200 },
            );
        });
        vi.stubGlobal("fetch", fetchMock);
        const { content, event } = await executeGoogleDriveToolCall(
            "user-1",
            "google_drive_search",
            { query: "I485 'summary'" },
            makeDb({ tokenRow: encryptedTokenRow() }),
        );
        const parsed = JSON.parse(content);
        expect(parsed.ok).toBe(true);
        expect(parsed.files[0].id).toBe("f1");
        // External file data must carry the untrusted-context framing.
        expect(parsed.note).toContain("untrusted");
        expect(event.status).toBe("ok");
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("reads a Google Doc via export as plain text", async () => {
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = new URL(String(input));
            if (url.pathname.endsWith("/export")) {
                expect(url.searchParams.get("mimeType")).toBe("text/plain");
                return new Response("Exported doc body", { status: 200 });
            }
            return new Response(
                JSON.stringify({
                    id: "doc1",
                    name: "Agreement",
                    mimeType: "application/vnd.google-apps.document",
                }),
                { status: 200 },
            );
        });
        vi.stubGlobal("fetch", fetchMock);
        const { content } = await executeGoogleDriveToolCall(
            "user-1",
            "google_drive_read_file",
            { file_id: "doc1" },
            makeDb({ tokenRow: encryptedTokenRow() }),
        );
        const parsed = JSON.parse(content);
        expect(parsed.ok).toBe(true);
        expect(parsed.text).toBe("Exported doc body");
    });

    it("drops the token row and reports reconnect when the refresh grant is revoked", async () => {
        const deletes: string[] = [];
        const db = makeDb({
            tokenRow: encryptedTokenRow({
                // Expired, forcing a refresh attempt.
                expires_at: new Date(Date.now() - 1000).toISOString(),
            }),
            onDelete: (table) => deletes.push(table),
        });
        vi.stubGlobal(
            "fetch",
            vi.fn(async () =>
                new Response(JSON.stringify({ error: "invalid_grant" }), {
                    status: 400,
                }),
            ),
        );
        const { content, event } = await executeGoogleDriveToolCall(
            "user-1",
            "google_drive_list_recent",
            {},
            db,
        );
        expect(JSON.parse(content).ok).toBe(false);
        expect(event.error).toMatch(/Reconnect Google Drive/);
        expect(deletes).toContain("user_google_drive_tokens");
    });
});
