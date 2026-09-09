# Error tracking with Sentry

Every Mike runtime can report unexpected failures to [Sentry](https://sentry.io)
(or any Sentry-compatible endpoint, including a self-hosted instance):

| Runtime | SDK | Enabled by |
| --- | --- | --- |
| Backend API process | `@sentry/node` | `SENTRY_DSN` in `backend/.env` |
| Backend worker thread / standalone worker / one-shot jobs | `@sentry/node` | same `SENTRY_DSN` (one project for the whole backend) |
| Web app, in the browser | `@sentry/nextjs` | `NEXT_PUBLIC_SENTRY_DSN` at **build** time |
| Web app, Next.js server (the `/api` gateway) | `@sentry/nextjs` | `SENTRY_DSN` in the frontend's runtime environment |
| Word add-in (task pane, ribbon commands, OAuth dialog) | `@sentry/react` | `REACT_APP_SENTRY_DSN` at **build** time |

Nothing is sent, and nothing is instrumented, until a DSN is configured. An
install that never sets one behaves exactly as before.

## What gets reported

The goal is that a bug shows up as a Sentry issue the first time it happens,
with enough context to reproduce it, and that the same bug groups as one issue
however many users hit it.

**Backend**

- Every unexpected 5xx. All route handlers answer server failures through
  `sendInternalError`, which reports the original error with the Express route
  pattern (`/projects/:projectId`, so one bug is one issue), the HTTP method,
  the status, and the `request_id` that the client receives in the response
  body. A handler that writes its own 5xx body is caught by the response
  sanitizer and reported as a message.
- Model streams that fail after the response has started (the 500 path never
  sees these). Deliberate, explained refusals (`UserFacingError`: missing API
  key, disallowed model) are not bugs and are not reported.
- Background jobs: every failed attempt of a `db_jobs` job (warning while
  retries remain, error when exhausted), failure-hook crashes, unknown job
  kinds, claim/tick/retention failures, BullMQ conversion/extraction/delivery
  failures, upload-session processing and conversion failures, worker
  heartbeat and loop failures, and the maintenance sweeps.
- Process lifecycle: boot configuration failures, worker-thread crashes and
  respawns, graceful-shutdown errors, workflow-sync job failures.
- Everything else that reaches `console.error`, via Sentry's console bridge.
  Errors already reported explicitly are recognised and not sent twice.

Each event is tagged with `service=mike-backend`, `role` (`api`, `worker`,
`worker-thread`, or `job`), `component`, and, for requests, the user id.

**Web app**

- Uncaught exceptions and unhandled promise rejections in the browser (SDK
  default), the route error boundary (`error.tsx`), and the root boundary
  (`global-error.tsx`).
- Every backend 5xx seen by the API client, as `API <status> on <METHOD>
  <route>` with the backend's `request_id` — search `request_id:<id>` in Sentry
  to see both halves of one failure.
- Assistant chat streams that fail for a reason other than the user stopping
  them.
- Server side: gateway failures to reach the backend, and render/route-handler
  errors through Next's `onRequestError` hook.
- Everything else that reaches `console.error`, deduplicated as above.

**Word add-in**

- Uncaught errors in the pane, plus a React error boundary around the whole
  pane that shows a "Try again" fallback instead of a blank pane.
- Backend 5xx (with `request_id`), transport failures that never reached the
  server (warning level, grouped per endpoint: the most common failure users
  see in Word and the hardest to diagnose), mid-stream chat failures, and
  tool-result delivery failures.
- Office host tags (`office_host`, `office_platform`, `office_version`) so a
  bug that only reproduces in Word on Mac 16.x or Word on the web is
  identifiable.

## What never gets reported

Mike handles privileged legal documents, so the SDKs run with
`sendDefaultPii: false` and a `beforeSend` hook (`backend/src/lib/observability/sentry.ts`,
`frontend/src/shared/lib/sentryEvent.ts`) that:

- removes request bodies and cookies and the `Authorization`, `Cookie`,
  `Set-Cookie`, and API-key headers (the backend also disables body capture in
  the HTTP integration, so bodies never sit on an event in memory);
- reduces the user to their id — the email address is never attached;
- replaces the value of any key that looks like a secret (`token`, `secret`,
  `password`, `api_key`, `authorization`, `cookie`, `credential`, ...) anywhere
  in the event's extra data, contexts, or breadcrumbs with `[Filtered]`.

Session replay is not enabled anywhere and should not be: it would record the
document open next to the pane.

Performance tracing is off (`tracesSampleRate` 0) unless you opt in with the
`*_TRACES_SAMPLE_RATE` variables; error tracking is the point of this
integration and traces cost quota.

## Configuration

Backend (`backend/.env`, read at process start):

```
SENTRY_DSN=https://<key>@<org>.ingest.sentry.io/<project>
SENTRY_ENVIRONMENT=production          # defaults to NODE_ENV
SENTRY_RELEASE=mike@1.4.0              # optional; pin to a git SHA in CI
SENTRY_TRACES_SAMPLE_RATE=0            # optional, 0..1
SENTRY_ENABLE_TEST_ROUTE=false         # see "Verifying" below
```

Do not add `SENTRY_DSN` to the `environment:` block of the backend service in
`docker-compose.yml`: that block overrides `env_file`, and an unset host
variable would blank the value from `.env`. Put it in `backend/.env` or the
compose-root `.env`.

Web app. The browser DSN is inlined by `next build`, so for the Docker image it
is a build argument; the Next server reads its own DSN at runtime:

```
# root .env (Docker Compose)
FRONTEND_SENTRY_DSN=https://<key>@<org>.ingest.sentry.io/<project>
SENTRY_ENVIRONMENT=production
SENTRY_RELEASE=mike@1.4.0

# or, building the frontend directly
NEXT_PUBLIC_SENTRY_DSN=...             # browser (build time)
NEXT_PUBLIC_SENTRY_ENVIRONMENT=...     # optional
NEXT_PUBLIC_SENTRY_RELEASE=...         # optional
SENTRY_DSN=...                         # Next server (runtime)
```

Use a separate Sentry project for the web app and the backend: separate issue
streams, separate source maps, and the frontend DSN is public in the bundle.

Word add-in (build time, `word-addin/.env` or the Docker build arguments):

```
REACT_APP_SENTRY_DSN=...
REACT_APP_SENTRY_ENVIRONMENT=...       # optional
REACT_APP_SENTRY_RELEASE=...           # optional
```

### Readable stack traces (source maps)

Production bundles are minified. To see real file and line numbers in Sentry,
provide upload credentials at build time; the build then uploads source maps
and deletes them from the output so they never ship:

```
SENTRY_AUTH_TOKEN=...   # an org auth token with project:releases scope
SENTRY_ORG=...
SENTRY_PROJECT=...
```

Applies to `next build` (frontend) and `webpack --mode production` (add-in).
Without all three variables the build is unchanged and nothing is uploaded.
The backend runs from TypeScript-compiled JavaScript with inline stack traces
already, so it needs no upload.

## Verifying a deployment

1. Set the DSN(s) and restart. The backend logs `[sentry] enabled for api
   (environment ...)` at boot; without a DSN it logs `[sentry] disabled`.
2. Backend: set `SENTRY_ENABLE_TEST_ROUTE=true`, restart, and run

   ```bash
   curl -i http://localhost:3001/observability/sentry-test
   ```

   You get a 500 with a `request_id`; the Sentry issue "Sentry backend test
   error" carries the same `request_id` tag. Turn the flag off again: the
   route is unauthenticated and exists only to prove the pipeline.
3. Web app: open the app, and in the browser console run
   `setTimeout(() => { throw new Error("Sentry web test") })`. The error
   arrives tagged `service=mike-frontend runtime=browser`. To see the
   request-id correlation, stop the backend and click anything that loads
   data: the browser reports `API 502 on GET /...` and the Next server reports
   the gateway failure.
4. Word add-in: with the DSN baked in, open the pane and stop the backend; the
   next action reports a transport-failure warning with the Office host tags.

### Without a Sentry account

`scripts/sentry-sink.mjs` is a dependency-free local stand-in for Sentry's
ingest endpoint. It accepts the same envelope protocol the SDKs speak, prints
each event, and serves them at `http://localhost:9999/`:

```bash
node scripts/sentry-sink.mjs
# then, in the runtime you want to check:
SENTRY_DSN=http://mike@localhost:9999/1              # backend
NEXT_PUBLIC_SENTRY_DSN=http://mike@localhost:9999/2  # web app (browser)
REACT_APP_SENTRY_DSN=http://mike@localhost:9999/3    # add-in
```

The project number is arbitrary; it only appears in the ingest path. This is
also how the Word add-in's Playwright suite tests reporting
(`word-addin/e2e/error-reporting.spec.ts`): the e2e bundle carries a DSN for a
host that does not exist and the tests intercept the envelope.

## Adding reporting to new code

- Backend: throw, or call `sendInternalError(res, err)` — both paths report.
  For background work that must not throw, call `reportError(err, { tags:
  { component: "...", ... }, extra: {...} })` from
  `backend/src/lib/observability/sentry.ts` **before** the accompanying
  `console.error`, so the console bridge recognises it as already sent. Use
  `level: "warning"` for failures that will be retried automatically.
- Web app: `reportError` / `reportApiFailure` from
  `frontend/src/app/lib/errorReporting.ts`. Do not import `@sentry/nextjs`
  in feature code.
- Word add-in: the same helpers from `word-addin/src/taskpane/lib/errorReporting.ts`.
- Tags are indexed and filterable; keep them low-cardinality (a component
  name, a job kind, a status). Ids go in `extra`.
- Never put document text, prompts, file names from user uploads, or email
  addresses on an event. The scrubber catches obvious keys; it cannot know
  that `extra.note` is a contract clause.
