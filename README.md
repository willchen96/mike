# Mike

![Mike](docs/assets/link-image.jpg)

Mike (MikeOSS) is an open-source legal AI platform for document review,
drafting, and legal research.

It combines a Next.js frontend, an Express backend, Supabase Auth/Postgres,
and Cloudflare R2-compatible object storage.

Website: [mikeoss.com](https://mikeoss.com)

![Mike assistant home screen](docs/assets/mike-home.png)

## Features

- Chat with legal documents and open matters
- Review documents and apply suggested edits
- Run reusable assistant and tabular-review workflows
- Organize projects, folders, and a document library
- Verify citations and research US case law with CourtListener
- Work from Microsoft Word with the beta task-pane add-in
- Run supported language models locally through Ollama

## Quick start

The included Docker Compose stack runs Mike, Supabase, RustFS object storage,
and local email capture without requiring managed infrastructure.

1. Copy the local environment templates:

   ```bash
   cp .env.example .env
   cp backend/.env.example backend/.env
   ```

2. In `backend/.env`, set `DOWNLOAD_SIGNING_SECRET` and
   `USER_API_KEYS_ENCRYPTION_SECRET` to separate values generated with:

   ```bash
   openssl rand -hex 32
   ```

3. Add an Anthropic, Gemini, or OpenAI API key to `backend/.env`, unless you
   plan to use Ollama exclusively.

4. Start the stack:

   ```bash
   docker compose up --build
   ```

5. Open [http://localhost:3000](http://localhost:3000) and create an account.

The bundled credentials and infrastructure are intended for local development
only. See [Local development](docs/local-development.md) for service endpoints,
authentication behavior, Ollama setup, and first-run guidance.

## Repository

| Path | Purpose |
| --- | --- |
| `frontend/` | Next.js web application |
| `backend/` | Express API, document processing, and database access |
| `word-addin/` | Microsoft Word task-pane add-in (beta) |
| `backend/schema.sql` | Complete schema for fresh databases |
| `backend/migrations/` | Dated migrations for existing deployments |
| `docker-compose.yml` | Local application and infrastructure stack |
| `docs/` | Development, deployment, testing, and feature guides |

## Documentation

- [Documentation index](docs/README.md)
- [Local development](docs/local-development.md)
- [Manual and production deployment](docs/deployment.md)
- [Troubleshooting](docs/troubleshooting.md)
- [CourtListener integration](docs/courtlistener.md)
- [Microsoft Word add-in](word-addin/README.md)
- [Tamper-evident exports](docs/tamper-evident-exports.md)
- [Safe local testing](docs/safe-local-testing.md)
- [End-to-end testing and CI](docs/e2e-ci.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)

## Connectors

Mike connects to the systems a legal team already works in — Slack, Google
Drive, and any remote [MCP](https://modelcontextprotocol.io) server — from
**Settings > Connectors**. There are two setup pathways, and every connector
uses one of them:

**Zero-setup (the server registers itself).** Most hosted MCP servers support
OAuth dynamic client registration (RFC 7591). For these, nothing is configured
on the Mike server at all: a user clicks **Add**, pastes the server URL (or
picks a preset), and completes the provider's consent screen in a popup. Servers
that use a bearer token or custom headers instead of OAuth also fall in this
pathway — the credentials are entered in the same modal and stored encrypted.

**Bring-your-own OAuth app (you register a client once).** Some providers do
not implement dynamic client registration, so the person hosting Mike creates
an OAuth client with that provider once, puts its credentials in
`backend/.env`, and every user of the deployment can then connect their own
account with one click:

- **Google Drive** — first-party integration, see
  [Google Drive Integration](#google-drive-integration) below.
- **Google-hosted MCP servers** (`*.googleapis.com`) — create a Google Cloud
  OAuth client and set `GOOGLE_MCP_OAUTH_CLIENT_ID` / `_SECRET`
  (see `backend/.env.example`).
- **Slack** — see [Slack](#slack) below.

If a user starts an OAuth connect before the deployment is configured, the
error message contains the exact provider-console steps and the redirect URI
to paste — nothing fails silently.

**Redirect URIs.** Every callback below is derived from the backend's
`API_PUBLIC_URL`, which is the browser-reachable frontend gateway *including
its `/api` prefix* (the frontend proxies `/api/*` to the backend, so the
backend's own port never appears in a redirect URI):

| Deployment | `API_PUBLIC_URL` | Register with the provider |
| --- | --- | --- |
| Local development | `http://localhost:3000/api` | `http://localhost:3000/api/user/…/oauth/callback` |
| Production | `https://<your-mike-host>/api` | `https://<your-mike-host>/api/user/…/oauth/callback` |

The path is `/user/mcp-connectors/oauth/callback` for MCP connectors and
`/user/integrations/google-drive/oauth/callback` for Google Drive. The
Connectors page shows the Drive URI while the client is unconfigured, and a
Connect attempt on an unconfigured Slack/Google MCP connector shows the MCP
one, so you can copy them rather than assemble them. A value that does not
byte-match what the provider has on file fails as `redirect_uri_mismatch`.

### Slack

Slack's hosted MCP server (`https://mcp.slack.com/mcp`) gives the assistant
access to the channels and DMs the connecting user can see. The requested
scopes are mostly read/search, plus a few write scopes (`chat:write`,
`reactions:write`, `canvases:write`) — a user approving the consent screen is
granting those too. Slack does not support dynamic client registration, so
the deployment needs a Slack app (created once, by someone with app-creation
rights in the workspace):

1. Create an app at [api.slack.com/apps](https://api.slack.com/apps) — the
   fastest path is **From an app manifest**, pasting
   `docs/slack-mcp-app-manifest.example.json` and replacing the redirect URL
   placeholder. The manifest configures the bot user, the agent feature
   (`features.assistant_view`), and the OAuth scopes. (Building by hand
   instead: add the bot user and agent feature yourself.)
2. Two settings the manifest cannot express, required on **either** path:
   turn on the **Slack MCP Server** toggle under the app's *Agents* settings,
   and enable **PKCE** under *OAuth & Permissions*.
3. Add the callback,
   `https://<your-mike-host>/api/user/mcp-connectors/oauth/callback`, as a
   redirect URL. Slack requires HTTPS, so local development needs an HTTPS
   tunnel pointed at the **frontend** (port 3000, which proxies `/api` to the
   backend) — for example `cloudflared tunnel --url http://localhost:3000` —
   with `API_PUBLIC_URL=https://<tunnel-host>/api` in `backend/.env` and the
   matching `https://<tunnel-host>/api/user/mcp-connectors/oauth/callback`
   registered on the Slack app. Quick tunnels get a new hostname on every
   start, so update both when the tunnel restarts.
4. Set `SLACK_MCP_OAUTH_CLIENT_ID` and `SLACK_MCP_OAUTH_CLIENT_SECRET` in
   `backend/.env` and restart the backend.

Each user then clicks **Add** on **Settings > Connectors**, picks the
**Slack** preset, and approves Slack's consent screen. On workspaces with
app approval enabled, a Workspace Owner/Admin must approve the app before
members can authorize it. Tokens are encrypted at rest, and individual tools
can be toggled per connector.

## Google Drive Integration

Mike can search and read a user's Google Drive files directly from chat — ask
*"Search my Google Drive for the consulting agreement and summarize it"* and
the assistant uses its `google_drive_search` / `google_drive_read_file` /
`google_drive_list_recent` tools (read-only; Google Docs/Sheets/Slides are
exported as text, PDF and Word files are converted). Each user connects their
own Google account with one click from **Settings > Connectors > Google
Drive**; tokens are encrypted at rest and access is limited to the
`drive.readonly` scope.

This is a first-party integration over the GA Google Drive REST API. It does
**not** use Google's hosted Drive MCP server, which is gated behind the
Google Workspace Developer Preview Program — no preview enrollment is needed.

### Setup (one-time, per deployment)

These steps apply to every deployment — a firm self-hosting its own fork and
an operator hosting Mike for others alike. The one decision that differs is
step 3, because `drive.readonly` is a Google *restricted* scope and Google's
verification rules depend on **who connects**, not on who wrote the code.

1. In [Google Cloud Console](https://console.cloud.google.com), pick or
   create a project.
2. **APIs & Services > Library**: enable the **Google Drive API**
   (`drive.googleapis.com`).
3. **APIs & Services > OAuth consent screen** — pick the user type for your
   audience:

   - **Self-hosting for your own organization** (everyone who will connect
     is in your Google Workspace org — the typical law firm): choose
     **Internal**. No user cap, no Google verification, no security
     assessment, no token expiry — at any firm size. The Cloud project must
     be owned by that Workspace organization.
   - **Hosting for users outside your organization** (consumer Gmail
     accounts, multiple firms, a public instance): choose **External** and
     plan for Google's verification. In *Testing* mode, only 100 listed
     test users can connect **and their refresh tokens expire every
     7 days** — each user must reconnect weekly, so Testing is for pilots,
     not steady state. Published but unverified, the app has a *lifetime*
     cap of 100 users (Google does not reset it) behind an "unverified
     app" warning. Growing past that requires Google's restricted-scope
     verification, including an annual third-party security assessment
     (CASA). That cost lands once, on the operator of the deployment — one
     verified client covers every user of the instance; individual users
     never deal with it.
4. **APIs & Services > Credentials > Create credentials > OAuth client ID >
   Web application**, and add the callback as an authorized redirect URI:

       https://<your-mike-host>/api/user/integrations/google-drive/oauth/callback

   (local development: `http://localhost:3000/api/user/integrations/google-drive/oauth/callback`
   — Google accepts plain-HTTP `localhost` redirect URIs, so no tunnel is
   needed for Drive). The Connectors page shows this exact URI while the
   client is unconfigured; it is derived from `API_PUBLIC_URL`.
5. Set the client in `backend/.env` and restart the backend:

       GOOGLE_DRIVE_OAUTH_CLIENT_ID=...apps.googleusercontent.com
       GOOGLE_DRIVE_OAUTH_CLIENT_SECRET=...

   If you already configured `GOOGLE_MCP_OAUTH_CLIENT_ID`/`_SECRET` for MCP
   connectors, the Drive integration reuses them automatically — just add
   the extra redirect URI from step 4 to the same OAuth client.

Fresh databases created from `backend/schema.sql` already include the Drive
token tables. Existing deployments should apply
`backend/migrations/20260906_01_google_drive_integration.sql`.

Each user then clicks **Connect** on **Settings > Connectors**, approves the
Google consent screen once, and the assistant's Drive tools activate for
their chats. Disconnecting revokes the grant and deletes the stored tokens.

## System workflows

Mike's system assistant and tabular-review workflows are maintained in the
[`Open-Legal-Products/mike-workflows`](https://github.com/Open-Legal-Products/mike-workflows)
repository. See [Contributing](CONTRIBUTING.md#system-workflows) for how they are
packaged and synchronized with this application.

## License

Mike is available under the [GNU Affero General Public License v3.0](LICENSE).
