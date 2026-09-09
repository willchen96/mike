# Manual and production deployment

Use this path when connecting Mike to managed Supabase and S3-compatible
storage instead of the infrastructure bundled with Docker Compose.

## Prerequisites

- Node.js 22 or newer
- npm and Git
- A Supabase project
- A Cloudflare R2, MinIO, or other S3-compatible bucket
- At least one supported model-provider API key, or an accessible Ollama server
- Optional: a CourtListener API token for case-law tools
- LibreOffice when DOC/DOCX-to-PDF conversion is required

## Database setup

For a fresh Supabase database, run the contents of `backend/schema.sql` in the
Supabase SQL editor. The schema file contains the complete current database
shape.

For an existing deployment, do not run the complete schema over production
data. Back up the database first, identify the last migration already applied,
then apply each newer file in `backend/migrations/` in filename order.
Migration filenames follow `YYYYMMDD_NN_<name>.sql`.

Keep the last applied migration filename with your deployment records. Do not
blindly replay the directory against production: migrations are written for an
expected starting schema, and a successful fresh install from `schema.sql` is
not evidence that an older database has completed every upgrade step. The
repository's schema-drift CI separately checks that its pinned historical
baseline converges with the fresh schema after all later migrations run.

Apply the workflow catalog migration before deploying the matching backend
release, then run the dedicated ingestion job from the built backend artifact:

```bash
cd backend
npm run sync:workflows
```

The job resolves `MIKE_WORKFLOWS_REF`, downloads and validates the raw
`Open-Legal-Products/mike-workflows` archive, uploads reference assets to the
configured S3-compatible storage, and transactionally replaces the active
`mike_workflows` catalog. Temporary archive and JSON files are deleted when the
job exits. Run this as a release job before directing traffic to the new
backend; backend startup itself only reads the database. Docker Compose runs
this sequence automatically for local/self-hosted deployments.

## Environment

Copy the maintained examples:

```bash
cp backend/.env.example backend/.env
cp frontend/.env.local.example frontend/.env.local
```

Edit both files with the credentials and URLs for your deployment. At runtime,
the frontend server needs only `API_BASE_URL`; browsers call the same-origin
`/api` gateway and receive no Supabase URL, key, or session token. The variable
is not needed while building the frontend.

Use:

- `NODE_ENV=production` so startup enforces HTTPS and secure-cookie invariants;
- the Supabase project URL for backend `SUPABASE_URL`;
- the anon/publishable key for backend `SUPABASE_PUBLISHABLE_KEY`;
- the service-role key for backend `SUPABASE_SECRET_KEY`; and
- the internal Mike backend origin for frontend `API_BASE_URL`.

Set backend `API_PUBLIC_URL` to the browser-reachable frontend gateway, including
its `/api` prefix (for example, `https://app.example.com/api`). OAuth providers,
including MCP connectors, must return through that public gateway; never use an
internal container hostname such as `http://backend:3001` for callbacks.

Never expose Supabase session tokens, the service-role key, model-provider
keys, or storage secrets in frontend JavaScript.

Production web auth cookies are `Secure`, `HttpOnly`, `SameSite=Lax`, path `/`,
and use the `__Host-` prefix. Word task-pane cookies additionally use
`SameSite=None` and `Partitioned` so an HTTPS pane embedded in Word on the web
can authenticate without exposing tokens to JavaScript. The add-in serves and
proxies `/api` from one origin; the backend still validates the original
`Origin` header. Terminate TLS at both public origins, and set `FRONTEND_URL`
plus `WORD_ADDIN_URL` to their exact values.

When `WORD_ADDIN_URL` is configured, also set a dedicated, high-entropy
`AUTH_HANDOFF_ENCRYPTION_SECRET`. Google OAuth transfers from its Office dialog
to the task pane using a request-bound, encrypted, single-use database ticket
that expires after two minutes. Apply
`20260825_01_auth_handoff_tickets.sql` before enabling this flow.

The first deployment intentionally signs out sessions created by older builds:
the web app deletes legacy Supabase local/session-storage entries and the Word
add-in deletes legacy OfficeRuntime access/refresh tokens. Users authenticate
once to establish the new cookie; tokens are not copied through JavaScript.

### Object-storage CORS for direct uploads

Mike's upload-session API gives an authenticated browser a short-lived signed
`PUT` URL for one specific staging object. The bucket must therefore allow
browser `PUT` requests from each deployed frontend origin. Configure the
equivalent of this CORS policy in Cloudflare R2, MinIO, RustFS, or the selected
S3-compatible provider:

```json
[
  {
    "AllowedOrigins": ["https://your-mike.example"],
    "AllowedMethods": ["PUT", "HEAD"],
    "AllowedHeaders": ["Content-Type", "x-amz-*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

List exact trusted origins; do not use `*` for a production deployment. The
signed URL authorizes only its generated object key and expires independently
of the CORS cache. The backend still verifies the uploaded byte count and
copies accepted bytes to a non-signed, sealed key before queuing processing.
Each file is verified and queued as soon as its individual `PUT` completes;
the remaining files in the same session may continue uploading while the
worker creates documents or document versions from earlier files. Success and
definite transfer failure are both reported through the file's idempotent
completion endpoint. The client retries that control request and then polls the
session, whose status is derived from its file rows; there is no separate
session-wide completion request.

Upload sessions accept at most 50 supported files, 100 MB per file, and 2 GB
in total. Users may run multiple independent upload sessions concurrently and,
by default, may create at most 50 sessions per hour. Upload-session mutation,
polling, and hourly creation limits can be overridden with the
`RATE_LIMIT_UPLOAD_SESSION_*` environment variables documented in
`backend/.env.example`; missing or invalid values use the documented defaults.
Sessions that update the same mutable document version remain mutually
exclusive. Sessions
expire after 30 minutes, extended by a further 30 minutes each time a file
completes so a slow batch is not destroyed mid-upload, up to four hours from
creation; individual signed URLs expire after 15 minutes and can
be refreshed while the session is pending. These limits are enforced atomically
in PostgreSQL, not only in the browser.

The Express process also runs a durable upload-processing pool. By default,
each backend replica claims up to 8 jobs concurrently while PostgreSQL limits
each user to two active jobs across all replicas. Override these defaults with
`UPLOAD_PROCESSING_CONCURRENCY` (capped at 64) and
`UPLOAD_PROCESSING_MAX_RUNNING_PER_USER`; every claim loop polls the database,
so raising the pool raises idle query load in proportion. Workers claim jobs
with database leases, retry a failed file up to three times, and clean expired,
cancelled, and terminally failed temporary objects. A single document
conversion is killed after `UPLOAD_CONVERT_TIMEOUT_MS` (default 120000, clamped
to 10000-600000) and a worker stops renewing its lease after
`UPLOAD_JOB_WALL_CLOCK_MS` (default 900000, clamped to 60000-3600000) so a
wedged job is recovered by another worker instead of holding its slot. Terminal session metadata is retained
for seven days so clients can inspect outcomes, then deleted in bounded cleanup
batches.
Deployments must therefore run `backend/src/index.ts`
(the normal `npm start` entry point), rather than importing the Express app
without starting its worker.

Model-provider keys and the CourtListener token can be configured globally in
`backend/.env` or per user under **Settings > API Keys**. When a key is
configured globally, its matching field is read-only.

### Error tracking

Set `SENTRY_DSN` (backend) and `FRONTEND_SENTRY_DSN` (web app) to report
unexpected failures to Sentry; both are optional and nothing is sent without
them. What is reported, what is scrubbed, and how to verify a DSN are in
[observability.md](observability.md).

## Authentication email

Supabase Auth sends signup, email-change, and password-recovery messages.
Configure production SMTP in the Supabase dashboard; Mike does not require a
Resend API key for these messages.

In **Authentication > URL Configuration**, set the Site URL to the deployed
frontend origin and add that origin's `/auth/callback` URL to the redirect
allow list. For example:

```text
https://your-mike.example/auth/callback
```

Enable email confirmation for production signups. Keep secure email change
enabled so Supabase requires confirmation from both the current and proposed
addresses. Set the minimum password length to 10; this applies when passwords
are created or changed and does not invalidate existing shorter passwords. The
same callback handles signup confirmation, confirmed email
changes, and password-recovery links before sending the user to the appropriate
Mike page.

Review the Supabase email templates after changing the public Site URL, and
test every link against the deployed frontend before inviting users. Existing
deployments must also apply the latest migration so confirmed email changes are
mirrored into `user_profiles`.

## Google authentication

Create a **Web application** OAuth client in Google Auth Platform. Its
authorized redirect URI is the Supabase Auth callback shown on the Google
provider page, not Mike's frontend callback. For hosted Supabase it normally
has this form:

```text
https://<project-ref>.supabase.co/auth/v1/callback
```

Enable Google under **Supabase > Authentication > Providers**, then enter the
Google client ID and secret. In **Authentication > URL Configuration**, allow
both deployed Mike clients:

```text
https://your-mike.example/auth/callback
https://your-word-addin.example/oauth-dialog.html
```

The Word add-in completes authentication in an Office Dialog. The dialog gives
the task pane only an opaque, short-lived, single-use handoff ticket. The task
pane redeems it through the same-origin add-in proxy, and the backend writes its
HttpOnly cookie. No Supabase access or refresh token enters add-in JavaScript or
OfficeRuntime storage. The add-in also does not retain Google's provider access
token or request Google Drive or Gmail access.

## Install and run

Install dependencies:

```bash
npm install --prefix backend
npm install --prefix frontend
npm install --prefix word-addin
```

For development, start the packages in separate terminals:

```bash
npm run dev --prefix backend
```

```bash
npm run dev --prefix frontend
```

For production, build both packages and run their `start` scripts through your
process manager or deployment platform:

```bash
npm run build --prefix backend
npm run build --prefix frontend
```

The repository includes Dockerfiles for the backend, frontend, and Word add-in.
Build and run the production add-in host with its public URLs baked into the
static bundle and its private backend origin supplied only at runtime:

```bash
docker build -t mike-word-addin \
  --build-arg REACT_APP_WEB_APP_URL=https://app.example.com \
  --build-arg WORD_ADDIN_PUBLIC_URL=https://word.example.com \
  word-addin
docker run --rm -p 3200:3200 \
  -e WORD_ADDIN_BACKEND_ORIGIN=http://backend:3001 \
  mike-word-addin
```

Put an HTTPS ingress or reverse proxy in front of port 3200. The included host
serves `dist/` and streams `/api/*` to the backend while preserving cookies,
`Set-Cookie`, `Origin`, request bodies, and SSE responses.

## Background jobs and Redis

Mike runs durable background jobs (document conversion, tabular extraction,
audit recording, account deletion, storage cleanup, export builds) through one
of two interchangeable transports:

- **With Redis** (`REDIS_URL` set): jobs are delivered instantly through
  BullMQ, and tabular reviews stream live progress over Redis pub/sub. The
  bundled Docker Compose stack ships a Redis service and enables this by
  default for new installs.
- **Without Redis**: the same jobs run through a Postgres-backed queue
  (`db_jobs`, created by the schema/migrations) with a polling worker. No
  extra infrastructure is required — an existing deployment that upgrades in
  place keeps working with no configuration changes and no Redis. Progress
  streaming falls back to short database polls.

The transport is selected automatically; `QUEUE_DRIVER=postgres` forces the
database queue even when `REDIS_URL` is set.

By default, workers run in a worker thread inside the backend process, so no
extra process management is needed. To run them on separate hardware, start
`node dist/worker.js` (any number of instances — work is partitioned safely)
and set `WORKERS_MODE=none` on the API process. The compose file contains a
commented `worker` service demonstrating this.

## Deployment safety

- Generate unique, high-entropy signing and encryption secrets.
- Use production Supabase credentials rather than the local demo values.
- Keep backend secrets out of `NEXT_PUBLIC_*` variables.
- Configure spending limits for model-provider keys where supported.
- Confirm LibreOffice is available on the backend process path if document
  conversion is enabled.
- Review storage, logging, retention, and deletion behavior before processing
  confidential documents.

See [Safe local testing](safe-local-testing.md), the [security policy](../SECURITY.md),
and [Troubleshooting](troubleshooting.md) for related guidance.
