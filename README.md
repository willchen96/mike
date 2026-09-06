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

Mike connects to the systems a legal team already works in — Slack and any
remote [MCP](https://modelcontextprotocol.io) server — from
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

The path is `/user/mcp-connectors/oauth/callback` for MCP connectors. A
Connect attempt on an unconfigured Slack/Google MCP connector shows the exact
URI, so you can copy it rather than assemble it. A value that does not
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

## System workflows

Mike's system assistant and tabular-review workflows are maintained in the
[`Open-Legal-Products/mike-workflows`](https://github.com/Open-Legal-Products/mike-workflows)
repository. See [Contributing](CONTRIBUTING.md#system-workflows) for how they are
packaged and synchronized with this application.

## License

Mike is available under the [GNU Affero General Public License v3.0](LICENSE).
