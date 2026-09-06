import crypto from "crypto";
import {
    auth as runMcpOAuth,
    type OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
    OAuthClientInformationMixed,
    OAuthClientMetadata,
    OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { createServerSupabase } from "../supabase";
import {
    authConfigPatch,
    base64Url,
    decryptAuthConfig,
    decryptString,
    encryptString,
    guardedFetch,
    loadConnector,
    stateHash,
    validateRemoteMcpUrl,
} from "./client";
import { ConnectorSetupError } from "./errors";
import { mcpOAuthProviderFor } from "./providers";
import {
    CLIENT_INFO,
    OAUTH_STATE_TTL_MS,
    type ConnectorRow,
    type Db,
    type OAuthMetadata,
    type OAuthStateConfig,
    type OAuthTokenRow,
} from "./types";

export class McpOAuthRequiredError extends Error {
    code = "oauth_required";
    /**
     * Whether re-running the same refresh could ever succeed. False only when
     * the authorization server had a transport-level or 5xx/429 hiccup; true
     * (the default, and every pre-existing throw site) when the grant itself
     * is dead — invalid_grant, invalid_client, a revoked or absent refresh
     * token — and nothing short of the user reconnecting will fix it.
     *
     * Nothing on the request path reads this: it exists so the background
     * mcp.refresh_token job can tell "retry me" from "stop retrying", instead
     * of burning its whole attempt budget replaying a rejected grant.
     */
    readonly permanent: boolean;
    /** The RFC 6749 `error` code from the token endpoint, when it sent one. */
    readonly oauthErrorCode: string | null;
    constructor(
        message = "OAuth authorization is required for this MCP server.",
        options: { permanent?: boolean; oauthErrorCode?: string | null } = {},
    ) {
        super(message);
        this.name = "McpOAuthRequiredError";
        this.permanent = options.permanent ?? true;
        this.oauthErrorCode = options.oauthErrorCode ?? null;
    }
}

function parseWwwAuthenticate(value: string | null): string | null {
    if (!value) return null;
    const match = value.match(/resource_metadata=(?:"([^"]+)"|([^,\s]+))/i);
    return match?.[1] ?? match?.[2] ?? null;
}

async function fetchJson(url: string, init?: RequestInit) {
    // Route through the shared guarded egress helper so this call gets the same
    // HTTPS-only / private-IP / connect-time-pinned / no-redirect protections as
    // the connector transport (closes the raw-fetch SSRF gap in OAuth discovery).
    const response = await guardedFetch(url, init);
    if (!response.ok) {
        throw new Error(`Failed to fetch OAuth metadata (${response.status}).`);
    }
    const parsed = await response.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("OAuth metadata response was not an object.");
    }
    return parsed as Record<string, unknown>;
}

async function discoverProtectedResourceMetadataUrl(serverUrl: string) {
    // The MCP server URL is attacker-influenced, so both discovery probes go
    // through the shared guarded egress helper rather than raw fetch (previously
    // an unvalidated SSRF sink).
    const attempts: Array<() => Promise<Response>> = [
        () => guardedFetch(serverUrl, { method: "GET" }),
        () =>
            guardedFetch(serverUrl, {
                method: "POST",
                headers: {
                    Accept: "application/json, text/event-stream",
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    jsonrpc: "2.0",
                    id: "oauth-discovery",
                    method: "initialize",
                    params: {
                        protocolVersion: "2025-06-18",
                        capabilities: {},
                        clientInfo: CLIENT_INFO,
                    },
                }),
            }),
    ];
    for (const attempt of attempts) {
        const response = await attempt();
        if (response.status === 401) {
            const metadataUrl = parseWwwAuthenticate(
                response.headers.get("www-authenticate"),
            );
            if (metadataUrl) return new URL(metadataUrl, serverUrl).toString();
        }
    }

    const url = new URL(serverUrl);
    const candidates = [
        `${url.origin}/.well-known/oauth-protected-resource${url.pathname}`,
        `${url.origin}/.well-known/oauth-protected-resource`,
    ];
    for (const candidate of candidates) {
        try {
            await fetchJson(candidate);
            return candidate;
        } catch {
            // Try the next well-known form.
        }
    }
    throw new McpOAuthRequiredError();
}

/**
 * Best-effort variant of {@link discoverProtectedResourceMetadataUrl} for
 * seeding the MCP SDK's discovery.
 *
 * The SDK's own RFC 9728 lookup tries the path-aware well-known form first
 * (`/.well-known/oauth-protected-resource/mcp`) and only falls back to the
 * root form on a 4xx. Slack answers the path-aware form with a 302 (an HTML
 * page), so the SDK never reaches the root document that actually exists —
 * it silently proceeds with no resource metadata, which drops both the
 * `scope` (resolved from the metadata's scopes_supported) and the RFC 8707
 * `resource` parameter from the authorization request. Slack then rejects
 * the scopeless request outright ("No scopes requested").
 *
 * Our own prober handles that server shape: it prefers the URL advertised in
 * the 401 WWW-Authenticate challenge and otherwise tries BOTH well-known
 * forms. Handing the resulting URL to the SDK via `resourceMetadataUrl`
 * makes its discovery deterministic. Returns undefined when the server has
 * no discoverable metadata — the SDK then behaves exactly as before.
 */
async function seedResourceMetadataUrl(
    serverUrl: string,
): Promise<URL | undefined> {
    try {
        return new URL(await discoverProtectedResourceMetadataUrl(serverUrl));
    } catch {
        return undefined;
    }
}

async function fetchAuthorizationServerMetadata(
    authorizationServer: string,
): Promise<Record<string, unknown>> {
    const trimmed = authorizationServer.replace(/\/+$/, "");
    const candidates = authorizationServer.includes("/.well-known/")
        ? [authorizationServer]
        : [
              `${trimmed}/.well-known/oauth-authorization-server`,
              `${trimmed}/.well-known/openid-configuration`,
              authorizationServer,
          ];
    let lastError: unknown = null;
    for (const candidate of candidates) {
        try {
            return await fetchJson(candidate);
        } catch (err) {
            lastError = err;
        }
    }
    throw lastError instanceof Error
        ? lastError
        : new Error("Failed to discover OAuth authorization server metadata.");
}

export async function discoverOAuthMetadata(serverUrl: string): Promise<OAuthMetadata> {
    const metadataUrl = await discoverProtectedResourceMetadataUrl(serverUrl);
    const resourceMetadata = await fetchJson(metadataUrl);
    const authServers = resourceMetadata.authorization_servers;
    const authorizationServer =
        Array.isArray(authServers) && typeof authServers[0] === "string"
            ? authServers[0]
            : null;
    if (!authorizationServer) {
        throw new Error("MCP server did not advertise an OAuth authorization server.");
    }
    const authMetadata = await fetchAuthorizationServerMetadata(authorizationServer);
    const authorizationEndpoint = authMetadata.authorization_endpoint;
    const tokenEndpoint = authMetadata.token_endpoint;
    if (
        typeof authorizationEndpoint !== "string" ||
        typeof tokenEndpoint !== "string"
    ) {
        throw new Error("OAuth authorization server metadata is missing endpoints.");
    }
    return {
        authorizationServer,
        authorizationEndpoint,
        tokenEndpoint,
        registrationEndpoint:
            typeof authMetadata.registration_endpoint === "string"
                ? authMetadata.registration_endpoint
                : undefined,
        scopesSupported: Array.isArray(authMetadata.scopes_supported)
            ? authMetadata.scopes_supported.filter(
                  (scope): scope is string => typeof scope === "string",
              )
            : undefined,
    };
}

/**
 * Non-standard authorization-request parameters a given provider requires
 * (from the provider registry in providers.ts).
 *
 * The MCP SDK builds a spec-compliant authorization URL and exposes no hook for
 * adding provider-specific query parameters, so these are applied in
 * {@link DbMcpOAuthProvider.redirectToAuthorization} — the one point at which
 * the provider is handed the fully-built URL before the user is sent to it.
 */
export function providerAuthorizationParams(
    serverUrl: string,
): Record<string, string> {
    return mcpOAuthProviderFor(serverUrl)?.authorizationParams ?? {};
}

function oauthClientEnvFor(serverUrl: string) {
    const prefix = mcpOAuthProviderFor(serverUrl)?.envPrefix ?? "MCP_OAUTH";
    return {
        clientId:
            process.env[`${prefix}_CLIENT_ID`] ||
            process.env.MCP_OAUTH_CLIENT_ID,
        clientSecret:
            process.env[`${prefix}_CLIENT_SECRET`] ||
            process.env.MCP_OAUTH_CLIENT_SECRET,
        scope:
            process.env[`${prefix}_SCOPE`] ||
            process.env.MCP_OAUTH_DEFAULT_SCOPE,
    };
}

async function registerOAuthClient(
    metadata: OAuthMetadata,
    redirectUri: string,
) {
    if (!metadata.registrationEndpoint) return null;
    const response = await guardedFetch(metadata.registrationEndpoint, {
        method: "POST",
        headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            client_name: "Mike",
            redirect_uris: [redirectUri],
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            token_endpoint_auth_method: "client_secret_post",
        }),
    });
    if (!response.ok) return null;
    const parsed = (await response.json()) as Record<string, unknown>;
    return typeof parsed.client_id === "string"
        ? {
              clientId: parsed.client_id,
              clientSecret:
                  typeof parsed.client_secret === "string"
                      ? parsed.client_secret
                      : undefined,
          }
        : null;
}

function scopeForOAuth(serverUrl: string, metadata: OAuthMetadata) {
    const configured = oauthClientEnvFor(serverUrl).scope;
    if (configured) return configured;
    return metadata.scopesSupported?.length
        ? metadata.scopesSupported.join(" ")
        : undefined;
}

export async function loadOAuthToken(connectorId: string, db: Db) {
    const { data, error } = await db
        .from("user_mcp_oauth_tokens")
        .select("*")
        .eq("connector_id", connectorId)
        .maybeSingle();
    if (error) throw error;
    return (data as OAuthTokenRow | null) ?? null;
}

function tokenSecretPatch(prefix: string, value?: string | null) {
    if (!value) {
        return {
            [`encrypted_${prefix}`]: null,
            [`${prefix}_iv`]: null,
            [`${prefix}_tag`]: null,
        };
    }
    const encrypted = encryptString(value);
    return {
        [`encrypted_${prefix}`]: encrypted.encrypted,
        [`${prefix}_iv`]: encrypted.iv,
        [`${prefix}_tag`]: encrypted.tag,
    };
}

async function storeOAuthToken(
    connectorId: string,
    config: Omit<OAuthStateConfig, "codeVerifier" | "redirectUri">,
    token: Record<string, unknown>,
    db: Db,
) {
    const expiresIn =
        typeof token.expires_in === "number" ? token.expires_in : null;
    const accessToken =
        typeof token.access_token === "string" ? token.access_token : null;
    if (!accessToken) throw new Error("OAuth token response did not include an access token.");
    const refreshToken =
        typeof token.refresh_token === "string" ? token.refresh_token : undefined;
    const existing = await loadOAuthToken(connectorId, db);
    const existingRefresh = existing
        ? decryptString(
              existing.encrypted_refresh_token,
              existing.refresh_token_iv,
              existing.refresh_token_tag,
          )
        : null;
    const clientSecret = config.clientSecret;
    const row = {
        connector_id: connectorId,
        ...tokenSecretPatch("access_token", accessToken),
        ...tokenSecretPatch("refresh_token", refreshToken ?? existingRefresh),
        token_type:
            typeof token.token_type === "string" ? token.token_type : "Bearer",
        scope: typeof token.scope === "string" ? token.scope : config.scope ?? null,
        expires_at: expiresIn
            ? new Date(Date.now() + expiresIn * 1000).toISOString()
            : null,
        authorization_server: config.authorizationServer,
        token_endpoint: config.tokenEndpoint,
        client_id: config.clientId,
        ...tokenSecretPatch("client_secret", clientSecret),
        resource: config.resource,
        updated_at: new Date().toISOString(),
    };
    const { error } = await db
        .from("user_mcp_oauth_tokens")
        .upsert(row, { onConflict: "connector_id" });
    if (error) throw error;
    const { error: connectorError } = await db
        .from("user_mcp_connectors")
        .update({
            auth_type: "oauth",
            encrypted_auth_config: null,
            auth_config_iv: null,
            auth_config_tag: null,
            updated_at: new Date().toISOString(),
        })
        .eq("id", connectorId);
    if (connectorError) throw connectorError;
}

/**
 * Pull the RFC 6749 `error` code out of a token-endpoint error response. The
 * spec puts it in a JSON body ({"error":"invalid_grant"}); anything else is
 * treated as "no code", and the HTTP status decides on its own.
 */
function oauthErrorCodeFrom(body: string): string | null {
    try {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        return typeof parsed.error === "string" ? parsed.error : null;
    } catch {
        return null;
    }
}

/**
 * Codes that mean the grant is gone for good. `invalid_grant` is the one the
 * spec reserves for an expired/revoked/rejected refresh token, and the rest
 * describe a client registration that no longer works — replaying the request
 * gets the identical rejection every time.
 */
const PERMANENT_OAUTH_ERROR_CODES = new Set([
    "invalid_grant",
    "invalid_client",
    "unauthorized_client",
    "invalid_request",
    "invalid_scope",
    "unsupported_grant_type",
]);

export async function refreshOAuthAccessToken(row: OAuthTokenRow, db: Db) {
    const refreshToken = decryptString(
        row.encrypted_refresh_token,
        row.refresh_token_iv,
        row.refresh_token_tag,
    );
    if (!refreshToken || !row.token_endpoint || !row.client_id) {
        throw new McpOAuthRequiredError("OAuth reconnect is required for this MCP server.");
    }
    const clientSecret = decryptString(
        row.encrypted_client_secret,
        row.client_secret_iv,
        row.client_secret_tag,
    );
    const body = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: row.client_id,
    });
    if (clientSecret) body.set("client_secret", clientSecret);
    if (row.resource) body.set("resource", row.resource);
    const response = await guardedFetch(row.token_endpoint, {
        method: "POST",
        headers: {
            Accept: "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
    });
    if (!response.ok) {
        // Same error class and same user-facing message as before — only the
        // retryability metadata is new. A 5xx/429 is the authorization server
        // having a bad minute, so the background refresh job may try again;
        // any other status (or an explicit invalid_grant-family code) means
        // the grant is dead and retrying just replays the rejection.
        const detail = await response.text().catch(() => "");
        const oauthErrorCode = oauthErrorCodeFrom(detail);
        const transient =
            (response.status >= 500 || response.status === 429) &&
            !(oauthErrorCode && PERMANENT_OAUTH_ERROR_CODES.has(oauthErrorCode));
        throw new McpOAuthRequiredError(
            "OAuth token refresh failed. Please reconnect.",
            { permanent: !transient, oauthErrorCode },
        );
    }
    const token = (await response.json()) as Record<string, unknown>;
    await storeOAuthToken(
        row.connector_id,
        {
            authorizationServer: row.authorization_server ?? "",
            tokenEndpoint: row.token_endpoint,
            clientId: row.client_id,
            clientSecret: clientSecret ?? undefined,
            resource: row.resource ?? "",
            scope: row.scope ?? undefined,
        },
        token,
        db,
    );
    const updated = await loadOAuthToken(row.connector_id, db);
    if (!updated) throw new McpOAuthRequiredError();
    return updated;
}

async function oauthBearerToken(connector: ConnectorRow, db: Db) {
    let token = await loadOAuthToken(connector.id, db);
    if (!token?.encrypted_access_token) {
        throw new McpOAuthRequiredError();
    }
    const expiresAt = token.expires_at ? Date.parse(token.expires_at) : null;
    if (expiresAt && expiresAt < Date.now() + 60_000) {
        token = await refreshOAuthAccessToken(token, db);
    }
    const accessToken = decryptString(
        token.encrypted_access_token,
        token.access_token_iv,
        token.access_token_tag,
    );
    if (!accessToken) throw new McpOAuthRequiredError();
    return accessToken;
}

export class DbMcpOAuthProvider implements OAuthClientProvider {
    public lastAuthorizeUrl: URL | null = null;

    constructor(
        private readonly db: Db,
        private readonly connector: ConnectorRow,
        private readonly userId: string,
        private readonly mode: "initiate" | "use",
        private readonly redirectUri: string,
        private readonly stateToken = base64Url(crypto.randomBytes(32)),
    ) {}

    get redirectUrl() {
        return this.redirectUri;
    }

    get clientMetadata(): OAuthClientMetadata {
        const env = oauthClientEnvFor(this.connector.server_url);
        return {
            client_name: "Mike",
            redirect_uris: [this.redirectUri],
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            token_endpoint_auth_method: env.clientSecret
                ? "client_secret_post"
                : "none",
            ...(env.scope ? { scope: env.scope } : {}),
        };
    }

    state() {
        return this.stateToken;
    }

    async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
        const token = await loadOAuthToken(this.connector.id, this.db);
        if (token?.client_id) {
            const clientSecret = decryptString(
                token.encrypted_client_secret,
                token.client_secret_iv,
                token.client_secret_tag,
            );
            return {
                client_id: token.client_id,
                ...(clientSecret ? { client_secret: clientSecret } : {}),
            };
        }
        const env = oauthClientEnvFor(this.connector.server_url);
        if (!env.clientId) return undefined;
        return {
            client_id: env.clientId,
            ...(env.clientSecret ? { client_secret: env.clientSecret } : {}),
        };
    }

    async saveClientInformation(info: OAuthClientInformationMixed) {
        const clientSecret =
            "client_secret" in info && typeof info.client_secret === "string"
                ? info.client_secret
                : undefined;
        const row = {
            connector_id: this.connector.id,
            client_id: info.client_id,
            ...tokenSecretPatch("client_secret", clientSecret),
            updated_at: new Date().toISOString(),
        };
        const { error } = await this.db
            .from("user_mcp_oauth_tokens")
            .upsert(row, { onConflict: "connector_id" });
        if (error) throw error;
    }

    async tokens(): Promise<OAuthTokens | undefined> {
        const row = await loadOAuthToken(this.connector.id, this.db);
        if (!row?.encrypted_access_token) return undefined;
        const accessToken = decryptString(
            row.encrypted_access_token,
            row.access_token_iv,
            row.access_token_tag,
        );
        if (!accessToken) return undefined;
        const refreshToken = decryptString(
            row.encrypted_refresh_token,
            row.refresh_token_iv,
            row.refresh_token_tag,
        );
        const expiresAt = row.expires_at ? Date.parse(row.expires_at) : null;
        const expiresIn = expiresAt
            ? Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))
            : undefined;
        return {
            access_token: accessToken,
            token_type: row.token_type ?? "Bearer",
            ...(refreshToken ? { refresh_token: refreshToken } : {}),
            ...(row.scope ? { scope: row.scope } : {}),
            ...(expiresIn !== undefined ? { expires_in: expiresIn } : {}),
        };
    }

    async saveTokens(tokens: OAuthTokens) {
        const existing = await loadOAuthToken(this.connector.id, this.db);
        const existingRefresh = existing
            ? decryptString(
                  existing.encrypted_refresh_token,
                  existing.refresh_token_iv,
                  existing.refresh_token_tag,
              )
            : null;
        const env = oauthClientEnvFor(this.connector.server_url);
        const clientInfo = await this.clientInformation();
        const expiresIn =
            typeof tokens.expires_in === "number" ? tokens.expires_in : null;
        const row = {
            connector_id: this.connector.id,
            ...tokenSecretPatch("access_token", tokens.access_token),
            ...tokenSecretPatch(
                "refresh_token",
                tokens.refresh_token ?? existingRefresh,
            ),
            token_type: tokens.token_type ?? "Bearer",
            scope: tokens.scope ?? env.scope ?? null,
            expires_at: expiresIn
                ? new Date(Date.now() + expiresIn * 1000).toISOString()
                : null,
            client_id: clientInfo?.client_id ?? null,
            ...tokenSecretPatch(
                "client_secret",
                "client_secret" in (clientInfo ?? {}) &&
                    typeof clientInfo?.client_secret === "string"
                    ? clientInfo.client_secret
                    : undefined,
            ),
            resource: new URL(this.connector.server_url).toString(),
            updated_at: new Date().toISOString(),
        };
        const { error } = await this.db
            .from("user_mcp_oauth_tokens")
            .upsert(row, { onConflict: "connector_id" });
        if (error) throw error;
        const authConfig = decryptAuthConfig(this.connector);
        const { error: connectorError } = await this.db
            .from("user_mcp_connectors")
            .update({
                auth_type: "oauth",
                ...authConfigPatch({ headers: authConfig.headers }),
                updated_at: new Date().toISOString(),
            })
            .eq("id", this.connector.id)
            .eq("user_id", this.userId);
        if (connectorError) throw connectorError;
    }

    async redirectToAuthorization(authorizationUrl: URL) {
        if (this.mode !== "initiate") {
            throw new McpOAuthRequiredError();
        }
        // Apply any provider-specific authorization parameters the SDK cannot
        // express on its own (e.g. Google's offline-access flags). Using `set`
        // keeps the SDK's own parameters intact and avoids duplicates.
        for (const [key, value] of Object.entries(
            providerAuthorizationParams(this.connector.server_url),
        )) {
            authorizationUrl.searchParams.set(key, value);
        }
        this.lastAuthorizeUrl = authorizationUrl;
    }

    async saveCodeVerifier(codeVerifier: string) {
        const encrypted = encryptString(
            JSON.stringify({
                codeVerifier,
                redirectUri: this.redirectUri,
            } satisfies OAuthStateConfig),
        );
        await this.db.from("user_mcp_oauth_states").delete().eq(
            "state_hash",
            stateHash(this.stateToken),
        );
        const { error } = await this.db.from("user_mcp_oauth_states").insert({
            user_id: this.userId,
            connector_id: this.connector.id,
            state_hash: stateHash(this.stateToken),
            encrypted_state_config: encrypted.encrypted,
            state_config_iv: encrypted.iv,
            state_config_tag: encrypted.tag,
            expires_at: new Date(Date.now() + OAUTH_STATE_TTL_MS).toISOString(),
        });
        if (error) throw error;
    }

    async codeVerifier() {
        const { data, error } = await this.db
            .from("user_mcp_oauth_states")
            .select("encrypted_state_config, state_config_iv, state_config_tag")
            .eq("state_hash", stateHash(this.stateToken))
            .gt("expires_at", new Date().toISOString())
            .maybeSingle();
        if (error) throw error;
        if (!data) throw new Error("OAuth state is invalid or expired.");
        const decrypted = decryptString(
            String(data.encrypted_state_config),
            String(data.state_config_iv),
            String(data.state_config_tag),
        );
        if (!decrypted) throw new Error("OAuth state could not be decrypted.");
        const parsed = JSON.parse(decrypted) as OAuthStateConfig;
        return parsed.codeVerifier;
    }

    async validateResourceURL(serverUrl: string | URL, resource?: string) {
        await validateRemoteMcpUrl(String(serverUrl));
        if (!resource) return undefined;
        await validateRemoteMcpUrl(resource);
        return new URL(resource);
    }

    async invalidateCredentials(
        scope: "all" | "client" | "tokens" | "verifier" | "discovery",
    ) {
        if (scope === "verifier") {
            await this.db
                .from("user_mcp_oauth_states")
                .delete()
                .eq("state_hash", stateHash(this.stateToken));
            return;
        }
        if (scope === "all") {
            await this.db
                .from("user_mcp_oauth_tokens")
                .delete()
                .eq("connector_id", this.connector.id);
            return;
        }
        if (scope === "tokens") {
            // Null only the token columns instead of deleting the row. The row
            // does double duty: besides tokens it stores the client_id /
            // client_secret that `saveClientInformation` persisted after RFC
            // 7591 dynamic client registration. Deleting the whole row here
            // (mid-auth, right before the interactive redirect) would make
            // `clientInformation()` come back empty on the OAuth callback leg,
            // and the SDK refuses to exchange the authorization code without
            // the registered client — permanently breaking DCR-based servers.
            // `oauthConnected` only checks `encrypted_access_token`, so nulling
            // the token columns is exactly enough to keep it honest.
            await this.db
                .from("user_mcp_oauth_tokens")
                .update({
                    ...tokenSecretPatch("access_token"),
                    ...tokenSecretPatch("refresh_token"),
                    token_type: null,
                    scope: null,
                    expires_at: null,
                    updated_at: new Date().toISOString(),
                })
                .eq("connector_id", this.connector.id);
        }
    }
}

export async function startUserMcpConnectorOAuth(
    userId: string,
    connectorId: string,
    redirectUri: string,
    db: Db = createServerSupabase(),
): Promise<{ authorizationUrl: string | null; alreadyAuthorized: boolean }> {
    const connector = await loadConnector(userId, connectorId, db);
    const provider = new DbMcpOAuthProvider(
        db,
        connector,
        userId,
        "initiate",
        redirectUri,
    );
    const env = oauthClientEnvFor(connector.server_url);
    // Some providers (Google, Slack) do not implement RFC 7591 dynamic client
    // registration, so without a pre-configured OAuth client the SDK's normal
    // "no client? register one" fallback dead-ends deep inside the flow with a
    // message no operator can act on. Fail here instead, with the provider's
    // exact setup instructions — including the redirect URI this deployment
    // needs, so it can be copy-pasted into the provider's console form.
    const providerQuirks = mcpOAuthProviderFor(connector.server_url);
    if (!env.clientId && providerQuirks?.setupInstructions) {
        const stored = await loadOAuthToken(connector.id, db);
        if (!stored?.client_id) {
            throw new ConnectorSetupError(
                providerQuirks.setupInstructions(redirectUri),
            );
        }
    }
    // Scope is intentionally left to the SDK when not explicitly configured: it
    // resolves it as `scope || resourceMetadata.scopes_supported ||
    // clientMetadata.scope`, i.e. it already falls back to the scopes the MCP
    // server advertises in its protected-resource metadata. Passing a scope
    // derived from the *authorization server* metadata here would wrongly take
    // priority over that and request the wrong scopes (e.g. Google's generic
    // OIDC scopes instead of the Drive/Gmail scopes the connector needs).
    // For that fallback to actually fire, the SDK must FIND the resource
    // metadata — which its own discovery can miss (see
    // seedResourceMetadataUrl), so seed it with the URL we discover ourselves.
    const resourceMetadataUrl = await seedResourceMetadataUrl(
        connector.server_url,
    );
    const result = await runMcpOAuth(provider, {
        serverUrl: connector.server_url,
        ...(env.scope ? { scope: env.scope } : {}),
        ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}),
        fetchFn: guardedFetch,
    });
    if (result === "AUTHORIZED") {
        return { authorizationUrl: null, alreadyAuthorized: true };
    }
    if (!provider.lastAuthorizeUrl) {
        throw new Error("OAuth authorization URL was not returned by the MCP SDK.");
    }
    // We are about to send the user through an interactive authorization
    // redirect, which means the SDK did not (and could not) complete the flow
    // from stored credentials — typically because the only token row is an
    // expired access token with no usable refresh token. That stale row must
    // not survive: `oauthConnected` (client.ts) is `!!encrypted_access_token`
    // with no expiry check, so leaving the row in place makes the frontend
    // completion poll resolve immediately on a token that is already dead,
    // closing the consent popup mid-flow and looping the connector forever.
    // Invalidating "tokens" here makes `oauthConnected` an honest "this
    // authorization attempt has completed" signal: it flips to true only once a
    // fresh token is persisted by the OAuth callback.
    await provider.invalidateCredentials("tokens");
    return {
        authorizationUrl: provider.lastAuthorizeUrl.toString(),
        alreadyAuthorized: false,
    };
}

export async function completeMcpConnectorOAuthAuthorization(
    state: string,
    code: string,
    db: Db = createServerSupabase(),
): Promise<{ userId: string; connectorId: string }> {
    const { data, error } = await db
        .from("user_mcp_oauth_states")
        .select("*")
        .eq("state_hash", stateHash(state))
        .gt("expires_at", new Date().toISOString())
        .maybeSingle();
    if (error) throw error;
    if (!data) throw new Error("OAuth state is invalid or expired.");
    const row = data as {
        id: string;
        user_id: string;
        connector_id: string;
        encrypted_state_config: string;
        state_config_iv: string;
        state_config_tag: string;
    };
    const decrypted = decryptString(
        row.encrypted_state_config,
        row.state_config_iv,
        row.state_config_tag,
    );
    if (!decrypted) throw new Error("OAuth state could not be decrypted.");
    const config = JSON.parse(decrypted) as OAuthStateConfig;
    const connector = await loadConnector(row.user_id, row.connector_id, db);
    const provider = new DbMcpOAuthProvider(
        db,
        connector,
        row.user_id,
        "initiate",
        config.redirectUri,
        state,
    );
    // Seed discovery on the code-exchange leg too: RFC 8707 wants the same
    // `resource` indicator in the token request as in the authorization
    // request, and without the metadata the SDK would omit it here even
    // though the authorization leg (seeded above) included it.
    const resourceMetadataUrl = await seedResourceMetadataUrl(
        connector.server_url,
    );
    const result = await runMcpOAuth(provider, {
        serverUrl: connector.server_url,
        authorizationCode: code,
        ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}),
        fetchFn: guardedFetch,
    });
    if (result !== "AUTHORIZED") {
        throw new Error("OAuth authorization did not complete.");
    }
    await db.from("user_mcp_oauth_states").delete().eq("id", row.id);
    return { userId: row.user_id, connectorId: row.connector_id };
}
