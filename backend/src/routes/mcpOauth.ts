// Unauthenticated OAuth callback for MCP connectors.
//
// The user is bounced here from the connector's authorization server with
// `?code=...&state=...` after consenting in the popup. We don't have an
// auth header here (different origin / popup context), so the route is
// public — the HMAC-signed `state` token carries the user_id + server_id
// we need to find the row.

import { Router } from "express";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { createServerSupabase } from "../lib/supabase";
import { DbOAuthProvider, verifyOAuthState } from "../lib/mcp/oauth";

export const mcpOauthRouter = Router();

const RESULT_HTML = (success: boolean, message?: string) => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${success ? "Connector connected" : "Connector failed"}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
           padding: 2rem; max-width: 500px; margin: 0 auto; color: #1f2937; }
    h1 { font-size: 1.25rem; margin: 0 0 0.5rem; }
    p { color: #6b7280; line-height: 1.5; }
    .ok { color: #047857; }
    .err { color: #b91c1c; }
  </style>
</head>
<body>
  <h1 class="${success ? "ok" : "err"}">${
      success ? "✓ Connector connected" : "✗ Connection failed"
  }</h1>
  <p>${
      success
          ? "You can close this window and return to Mike."
          : (message ?? "Something went wrong. Close this window and try again.")
  }</p>
  <script>
    // Tell the opener to refresh its connector list, then close ourselves.
    try { window.opener && window.opener.postMessage({ type: "mcp_oauth_done", success: ${success} }, "*"); } catch (e) {}
    setTimeout(function () { window.close(); }, ${success ? 600 : 2500});
  </script>
</body>
</html>`;

mcpOauthRouter.get("/callback", async (req, res) => {
    const code = (req.query.code as string | undefined)?.trim();
    const state = (req.query.state as string | undefined)?.trim();
    const error = (req.query.error as string | undefined)?.trim();

    if (error) {
        return void res
            .status(400)
            .type("html")
            .send(RESULT_HTML(false, `Authorization server returned: ${error}`));
    }
    if (!code || !state) {
        return void res
            .status(400)
            .type("html")
            .send(RESULT_HTML(false, "Missing code or state."));
    }

    const decoded = verifyOAuthState(state);
    if (!decoded) {
        return void res
            .status(400)
            .type("html")
            .send(RESULT_HTML(false, "Invalid or expired state — restart sign-in."));
    }

    const db = createServerSupabase();
    const { data: row, error: fetchErr } = await db
        .from("user_mcp_servers")
        .select("id, user_id, url, auth_type")
        .eq("id", decoded.server_id)
        .eq("user_id", decoded.user_id)
        .single();
    if (fetchErr || !row) {
        return void res
            .status(404)
            .type("html")
            .send(RESULT_HTML(false, "Connector not found."));
    }
    if (row.auth_type !== "oauth") {
        return void res
            .status(400)
            .type("html")
            .send(RESULT_HTML(false, "Connector is not configured for OAuth."));
    }

    const provider = new DbOAuthProvider(db, row.id, row.user_id, "initiate");
    try {
        const result = await auth(provider, {
            serverUrl: row.url,
            authorizationCode: code,
        });
        if (result !== "AUTHORIZED") {
            throw new Error(`Token exchange returned ${result}`);
        }
        // saveTokens() ran inside auth() and cleared last_error.
        return void res.type("html").send(RESULT_HTML(true));
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await db
            .from("user_mcp_servers")
            .update({ last_error: message.slice(0, 1000) })
            .eq("id", row.id);
        return void res
            .status(500)
            .type("html")
            .send(RESULT_HTML(false, message));
    }
});
