// OAuth 2.1 client glue for MCP connectors.
//
// The MCP SDK does almost all of the heavy lifting via its `auth()` helper —
// RFC 9728 discovery, dynamic client registration (RFC 7591), PKCE (S256),
// authorization-code exchange, and token refresh. We only have to plug in an
// `OAuthClientProvider` whose getters/setters read and write the row's
// oauth_* columns, plus a thin HMAC-signed state token so the callback can
// look the row up without a server-side session.

import crypto from "crypto";
import type {
    OAuthClientInformationFull,
    OAuthClientInformationMixed,
    OAuthClientMetadata,
    OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { createServerSupabase } from "../supabase";

const STATE_TTL_SECONDS = 5 * 60; // 5 minutes
const CLIENT_NAME = "Mike";
const CLIENT_URI = "https://github.com/willchen96/mike";

function backendPublicUrl(): string {
    const url = process.env.BACKEND_PUBLIC_URL?.trim();
    if (url) return url.replace(/\/+$/, "");
    const port = process.env.PORT ?? "3001";
    return `http://localhost:${port}`;
}

export function oauthCallbackUrl(): string {
    return `${backendPublicUrl()}/mcp/oauth/callback`;
}

// ---------------------------------------------------------------------------
// State token (CSRF + flow continuation across the popup hop).
// HMAC-signed, no DB round-trip; encodes { user_id, server_id, exp }.
// Reuses DOWNLOAD_SIGNING_SECRET — the same secret already gates download
// tokens and would already have to be rotated on compromise.
// ---------------------------------------------------------------------------

function getSecret(): string {
    return (
        process.env.DOWNLOAD_SIGNING_SECRET ??
        process.env.SUPABASE_SECRET_KEY ??
        "dev-secret"
    );
}

function b64url(buf: Buffer): string {
    return buf
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/g, "");
}

function b64urlDecode(s: string): Buffer {
    let t = s.replace(/-/g, "+").replace(/_/g, "/");
    while (t.length % 4) t += "=";
    return Buffer.from(t, "base64");
}

export function signOAuthState(payload: {
    user_id: string;
    server_id: string;
}): string {
    const body = {
        ...payload,
        exp: Math.floor(Date.now() / 1000) + STATE_TTL_SECONDS,
    };
    const enc = b64url(Buffer.from(JSON.stringify(body), "utf8"));
    const sig = crypto.createHmac("sha256", getSecret()).update(enc).digest();
    return `${enc}.${b64url(sig)}`;
}

export function verifyOAuthState(
    token: string,
): { user_id: string; server_id: string } | null {
    const parts = token.split(".");
    if (parts.length !== 2) return null;
    const [enc, sigEnc] = parts;
    const expected = crypto
        .createHmac("sha256", getSecret())
        .update(enc)
        .digest();
    const expectedEnc = b64url(expected);
    if (sigEnc.length !== expectedEnc.length) return null;
    if (
        !crypto.timingSafeEqual(Buffer.from(sigEnc), Buffer.from(expectedEnc))
    ) {
        return null;
    }
    try {
        const body = JSON.parse(b64urlDecode(enc).toString("utf8")) as {
            user_id: string;
            server_id: string;
            exp: number;
        };
        if (!body.user_id || !body.server_id) return null;
        if (Math.floor(Date.now() / 1000) > body.exp) return null;
        return { user_id: body.user_id, server_id: body.server_id };
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// OAuthClientProvider implementation backed by user_mcp_servers row.
//
// Two modes:
//  - "initiate": from POST /oauth/start. The SDK's auth() will discover, DCR
//    if needed, generate PKCE, and call redirectToAuthorization() with the
//    authorize URL. We capture that URL into `lastAuthorizeUrl` and the
//    route returns it to the frontend popup.
//  - "use": from a chat request. If the SDK needs a fresh authorization
//    (refresh failed or never happened), redirectToAuthorization() throws
//    so the caller can mark the row reauth_required and surface to the UI.
// ---------------------------------------------------------------------------

export type OAuthProviderMode = "initiate" | "use";

export class DbOAuthProvider implements OAuthClientProvider {
    private metadataCache: Record<string, unknown> | null = null;
    private tokensCache: OAuthTokens | null = null;
    private codeVerifierCache: string | null = null;
    private mode: OAuthProviderMode;
    private signedState: string;

    /** Set by redirectToAuthorization() in `initiate` mode. */
    public lastAuthorizeUrl: URL | null = null;

    constructor(
        private readonly db: ReturnType<typeof createServerSupabase>,
        private readonly serverId: string,
        private readonly userId: string,
        mode: OAuthProviderMode,
    ) {
        this.mode = mode;
        this.signedState = signOAuthState({
            user_id: userId,
            server_id: serverId,
        });
    }

    get redirectUrl(): string {
        return oauthCallbackUrl();
    }

    get clientMetadata(): OAuthClientMetadata {
        return {
            client_name: CLIENT_NAME,
            client_uri: CLIENT_URI,
            redirect_uris: [oauthCallbackUrl()],
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            // Public client — no client secret stored, PKCE-protected.
            token_endpoint_auth_method: "none",
        };
    }

    state(): string {
        return this.signedState;
    }

    async clientInformation(): Promise<
        OAuthClientInformationMixed | undefined
    > {
        await this.loadMetadata();
        const ci = (this.metadataCache as { client?: OAuthClientInformationFull } | null)
            ?.client;
        return ci ?? undefined;
    }

    async saveClientInformation(
        info: OAuthClientInformationMixed,
    ): Promise<void> {
        await this.loadMetadata();
        const next = { ...(this.metadataCache ?? {}), client: info };
        this.metadataCache = next;
        await this.db
            .from("user_mcp_servers")
            .update({ oauth_metadata: next })
            .eq("id", this.serverId);
    }

    async tokens(): Promise<OAuthTokens | undefined> {
        if (this.tokensCache) return this.tokensCache;
        const { data } = await this.db
            .from("user_mcp_servers")
            .select("oauth_tokens")
            .eq("id", this.serverId)
            .single();
        const t = (data?.oauth_tokens ?? null) as OAuthTokens | null;
        this.tokensCache = t;
        return t ?? undefined;
    }

    async saveTokens(tokens: OAuthTokens): Promise<void> {
        this.tokensCache = tokens;
        // The PKCE verifier is one-shot; no point persisting after token
        // exchange. Clearing also keeps the row tidy on subsequent refreshes.
        this.codeVerifierCache = null;
        await this.db
            .from("user_mcp_servers")
            .update({
                oauth_tokens: tokens,
                oauth_code_verifier: null,
                last_error: null,
            })
            .eq("id", this.serverId);
    }

    async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
        if (this.mode === "initiate") {
            this.lastAuthorizeUrl = authorizationUrl;
            return;
        }
        // In "use" mode (mid-chat), we have nowhere to redirect the user; the
        // caller will catch this and mark the row reauth_required so the UI
        // prompts the user to re-sign in from settings.
        throw new ReauthRequiredError(
            `Connector requires re-sign-in (would redirect to ${authorizationUrl.origin})`,
        );
    }

    async saveCodeVerifier(codeVerifier: string): Promise<void> {
        this.codeVerifierCache = codeVerifier;
        await this.db
            .from("user_mcp_servers")
            .update({ oauth_code_verifier: codeVerifier })
            .eq("id", this.serverId);
    }

    async codeVerifier(): Promise<string> {
        if (this.codeVerifierCache) return this.codeVerifierCache;
        const { data } = await this.db
            .from("user_mcp_servers")
            .select("oauth_code_verifier")
            .eq("id", this.serverId)
            .single();
        if (!data?.oauth_code_verifier) {
            throw new Error("Missing PKCE verifier — start the flow again");
        }
        this.codeVerifierCache = data.oauth_code_verifier;
        return data.oauth_code_verifier;
    }

    async invalidateCredentials(
        scope: "all" | "client" | "tokens" | "verifier" | "discovery",
    ): Promise<void> {
        const update: Record<string, unknown> = {};
        if (scope === "all" || scope === "tokens")
            update.oauth_tokens = null;
        if (scope === "all" || scope === "client" || scope === "discovery")
            update.oauth_metadata = null;
        if (scope === "all" || scope === "verifier")
            update.oauth_code_verifier = null;
        if (Object.keys(update).length === 0) return;
        await this.db
            .from("user_mcp_servers")
            .update(update)
            .eq("id", this.serverId);
        if (update.oauth_tokens === null) this.tokensCache = null;
        if (update.oauth_metadata === null) this.metadataCache = null;
        if (update.oauth_code_verifier === null) this.codeVerifierCache = null;
    }

    private async loadMetadata(): Promise<void> {
        if (this.metadataCache !== null) return;
        const { data } = await this.db
            .from("user_mcp_servers")
            .select("oauth_metadata")
            .eq("id", this.serverId)
            .single();
        this.metadataCache = (data?.oauth_metadata ?? {}) as Record<
            string,
            unknown
        >;
    }
}

export class ReauthRequiredError extends Error {
    constructor(message?: string) {
        super(message ?? "Re-authorization required");
        this.name = "ReauthRequiredError";
    }
}
