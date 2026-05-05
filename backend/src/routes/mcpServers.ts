// CRUD for user-configurable MCP (Model Context Protocol) servers.
//
// Mounted at `/user/mcp-servers`. The backend uses Supabase's service role
// (bypassing RLS), so every handler MUST filter by `user_id = userId`.

import { Router } from "express";
import { auth as runOAuth } from "@modelcontextprotocol/sdk/client/auth.js";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import { McpHttpClient } from "../lib/mcp/client";
import { DbOAuthProvider } from "../lib/mcp/oauth";

export const mcpServersRouter = Router();

const SLUG_RE = /^[a-z0-9_-]{1,24}$/;
const NAME_MAX = 80;
const URL_MAX = 500;
const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/;
const MAX_HEADERS = 20;
const MAX_HEADER_VALUE_LEN = 4096;

type Body = {
    name?: unknown;
    slug?: unknown;
    url?: unknown;
    headers?: unknown;
    enabled?: unknown;
    auth_type?: unknown;
};

function deriveSlug(name: string): string {
    const base = name
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^[-_]+|[-_]+$/g, "")
        .slice(0, 24);
    return base || "mcp";
}

function validateUrl(raw: string): { ok: true } | { ok: false; error: string } {
    let parsed: URL;
    try {
        parsed = new URL(raw);
    } catch {
        return { ok: false, error: "url is not a valid URL" };
    }
    if (parsed.protocol === "https:") return { ok: true };
    if (
        parsed.protocol === "http:" &&
        (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")
    ) {
        return { ok: true };
    }
    return { ok: false, error: "url must use https (or http://localhost)" };
}

function validateHeaders(
    raw: unknown,
): { ok: true; value: Record<string, string> } | { ok: false; error: string } {
    if (raw === undefined || raw === null) return { ok: true, value: {} };
    if (typeof raw !== "object" || Array.isArray(raw)) {
        return { ok: false, error: "headers must be an object of string→string" };
    }
    const entries = Object.entries(raw as Record<string, unknown>);
    if (entries.length > MAX_HEADERS) {
        return { ok: false, error: `headers may not have more than ${MAX_HEADERS} entries` };
    }
    const out: Record<string, string> = {};
    for (const [k, v] of entries) {
        if (!HEADER_NAME_RE.test(k)) {
            return { ok: false, error: `invalid header name: ${k}` };
        }
        if (typeof v !== "string" || v.length > MAX_HEADER_VALUE_LEN) {
            return { ok: false, error: `header '${k}' value must be a string of ≤${MAX_HEADER_VALUE_LEN} chars` };
        }
        out[k] = v;
    }
    return { ok: true, value: out };
}

function publicShape<T extends Record<string, unknown>>(row: T) {
    const {
        headers,
        oauth_metadata: _md,
        oauth_tokens: tokens,
        oauth_code_verifier: _cv,
        ...rest
    } = row as T & {
        headers?: Record<string, string>;
        oauth_metadata?: unknown;
        oauth_tokens?: unknown;
        oauth_code_verifier?: unknown;
    };
    return {
        ...rest,
        header_keys: headers ? Object.keys(headers) : [],
        // Boolean only — never round-trip the actual access token to the
        // browser, even to the row's owner.
        oauth_authorized: !!tokens,
    };
}

// GET /user/mcp-servers — list (header values redacted, only keys returned)
mcpServersRouter.get("/", requireAuth, async (_req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    const { data, error } = await db
        .from("user_mcp_servers")
        .select("id, slug, name, url, headers, enabled, last_error, auth_type, oauth_tokens, created_at, updated_at")
        .eq("user_id", userId)
        .order("created_at", { ascending: true });
    if (error) return void res.status(500).json({ detail: error.message });
    res.json((data ?? []).map(publicShape));
});

// POST /user/mcp-servers — create
mcpServersRouter.post("/", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const body = (req.body ?? {}) as Body;

    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > NAME_MAX) {
        return void res.status(400).json({ detail: `name is required (≤${NAME_MAX} chars)` });
    }
    const url = typeof body.url === "string" ? body.url.trim() : "";
    if (!url || url.length > URL_MAX) {
        return void res.status(400).json({ detail: `url is required (≤${URL_MAX} chars)` });
    }
    const urlOk = validateUrl(url);
    if (!urlOk.ok) return void res.status(400).json({ detail: urlOk.error });

    let slug = typeof body.slug === "string" && body.slug.trim()
        ? body.slug.trim().toLowerCase()
        : deriveSlug(name);
    if (!SLUG_RE.test(slug)) {
        return void res.status(400).json({ detail: "slug must match /^[a-z0-9_-]{1,24}$/" });
    }

    const headersOk = validateHeaders(body.headers);
    if (!headersOk.ok) return void res.status(400).json({ detail: headersOk.error });

    const auth_type =
        body.auth_type === "oauth" ? "oauth" : "headers";

    const enabled = body.enabled === false ? false : true;

    const db = createServerSupabase();
    const { data, error } = await db
        .from("user_mcp_servers")
        .insert({
            user_id: userId,
            slug,
            name,
            url,
            headers: auth_type === "oauth" ? {} : headersOk.value,
            enabled,
            auth_type,
        })
        .select("id, slug, name, url, headers, enabled, last_error, auth_type, oauth_tokens, created_at, updated_at")
        .single();
    if (error) {
        const status = error.code === "23505" ? 409 : 500;
        return void res.status(status).json({ detail: error.message });
    }
    res.json(publicShape(data));
});

// PATCH /user/mcp-servers/:id — update name/url/headers/enabled
mcpServersRouter.patch("/:id", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const { id } = req.params;
    const body = (req.body ?? {}) as Body;
    const update: Record<string, unknown> = { updated_at: new Date().toISOString() };

    if (body.name !== undefined) {
        const name = typeof body.name === "string" ? body.name.trim() : "";
        if (!name || name.length > NAME_MAX) {
            return void res.status(400).json({ detail: `name must be 1–${NAME_MAX} chars` });
        }
        update.name = name;
    }
    if (body.url !== undefined) {
        const url = typeof body.url === "string" ? body.url.trim() : "";
        if (!url) return void res.status(400).json({ detail: "url is required" });
        const urlOk = validateUrl(url);
        if (!urlOk.ok) return void res.status(400).json({ detail: urlOk.error });
        update.url = url;
    }
    if (body.headers !== undefined) {
        const headersOk = validateHeaders(body.headers);
        if (!headersOk.ok) return void res.status(400).json({ detail: headersOk.error });
        update.headers = headersOk.value;
    }
    if (body.enabled !== undefined) {
        update.enabled = body.enabled === true;
    }

    const db = createServerSupabase();
    const { data, error } = await db
        .from("user_mcp_servers")
        .update(update)
        .eq("id", id)
        .eq("user_id", userId)
        .select("id, slug, name, url, headers, enabled, last_error, auth_type, oauth_tokens, created_at, updated_at")
        .single();
    if (error || !data) {
        return void res.status(404).json({ detail: error?.message ?? "Not found" });
    }
    res.json(publicShape(data));
});

// DELETE /user/mcp-servers/:id
mcpServersRouter.delete("/:id", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const { id } = req.params;
    const db = createServerSupabase();
    const { error } = await db
        .from("user_mcp_servers")
        .delete()
        .eq("id", id)
        .eq("user_id", userId);
    if (error) return void res.status(500).json({ detail: error.message });
    res.status(204).send();
});

// POST /user/mcp-servers/:id/test — connect + list_tools, return summary
mcpServersRouter.post("/:id/test", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const { id } = req.params;
    const db = createServerSupabase();
    const { data: row, error } = await db
        .from("user_mcp_servers")
        .select("url, headers, auth_type, oauth_tokens")
        .eq("id", id)
        .eq("user_id", userId)
        .single();
    if (error || !row) {
        return void res.status(404).json({ detail: "Not found" });
    }

    if (row.auth_type === "oauth" && !row.oauth_tokens) {
        return void res.status(200).json({
            ok: false,
            error: "Connector is configured for OAuth but not yet signed in.",
        });
    }

    const provider =
        row.auth_type === "oauth"
            ? new DbOAuthProvider(db, id, userId, "use")
            : undefined;
    const client = new McpHttpClient(
        row.url,
        (row.headers ?? {}) as Record<string, string>,
        provider,
    );
    try {
        await client.connect();
        const tools = await client.listTools();
        await db
            .from("user_mcp_servers")
            .update({ last_error: null })
            .eq("id", id);
        res.json({
            ok: true,
            tool_count: tools.length,
            tools: tools.map((t) => ({ name: t.name, description: t.description ?? "" })),
        });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await db
            .from("user_mcp_servers")
            .update({ last_error: message.slice(0, 1000) })
            .eq("id", id);
        res.status(200).json({ ok: false, error: message });
    } finally {
        await client.close();
    }
});

// POST /user/mcp-servers/:id/oauth/start — discover + DCR + build authorize URL
//
// Returns { authorize_url } so the frontend can open it in a popup. The user
// completes consent at the connector's auth server and is redirected back to
// /mcp/oauth/callback (mounted under mcpOauthRouter), which exchanges the
// code and stores tokens.
mcpServersRouter.post("/:id/oauth/start", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const { id } = req.params;
    const db = createServerSupabase();
    const { data: row, error } = await db
        .from("user_mcp_servers")
        .select("id, user_id, url, auth_type")
        .eq("id", id)
        .eq("user_id", userId)
        .single();
    if (error || !row) return void res.status(404).json({ detail: "Not found" });
    if (row.auth_type !== "oauth") {
        return void res
            .status(400)
            .json({ detail: "Connector is not configured for OAuth" });
    }

    const provider = new DbOAuthProvider(db, row.id, userId, "initiate");
    try {
        const result = await runOAuth(provider, { serverUrl: row.url });
        if (result === "AUTHORIZED") {
            // Already valid (e.g. row had a usable refresh token). Nothing
            // for the user to do.
            return void res.json({
                authorize_url: null,
                already_authorized: true,
            });
        }
        if (!provider.lastAuthorizeUrl) {
            throw new Error("Auth flow returned REDIRECT but no URL");
        }
        await db
            .from("user_mcp_servers")
            .update({ last_error: null })
            .eq("id", id);
        res.json({ authorize_url: provider.lastAuthorizeUrl.toString() });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await db
            .from("user_mcp_servers")
            .update({ last_error: message.slice(0, 1000) })
            .eq("id", id);
        res.status(500).json({ detail: message });
    }
});
