# End-to-End Tests

Playwright suite that exercises the full stack — frontend (Next.js, port 3000) and backend (Express, port 3001) — through a real browser.

## Quick start

```bash
# Install root deps + Chromium (only needed once)
npm install
npm run test:e2e:install

# Run everything
npm run test:e2e

# Interactive runner (Playwright UI)
npm run test:e2e:ui

# Run a single spec
npx playwright test e2e/auth.spec.ts
```

The first run will take a minute or two — Playwright spins up both dev servers (`npm run dev` in `frontend/` and `backend/`) before any test executes. The servers are reused between runs locally; CI builds always start fresh ones.

## ⚠️ Use a test Supabase project — never production or the dev DB

These tests **create real users, projects, documents, chat threads, and tabular reviews** on whichever Supabase project the backend is pointed at. They never clean up after themselves automatically.

The Playwright config loads `backend/.env.test` and injects every variable from it into both webServer processes, so the dev servers always point at the test project regardless of what's in `frontend/.env.local` or `backend/.env`.

Setup steps (one-time):

1. Create a new Supabase project (e.g. `GordonOSS-test`). Free-tier is fine.
2. Apply the production schema to it — run the migrations from `supabase/` against the test project.
3. Disable email confirmation under **Authentication → Providers → Email** so sign-ups complete without an inbox.
4. Copy these from the Supabase dashboard → Project Settings → API and paste into `backend/.env.test`:
   - **Project URL** → `SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `TEST_SUPABASE_URL`
   - **`service_role` key** → `SUPABASE_SECRET_KEY`, `TEST_SUPABASE_SECRET_KEY`
   - **`anon` key** → `NEXT_PUBLIC_SUPABASE_ANON_KEY`

Playwright performs a placeholder check on startup: if any of `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, or `GEMINI_API_KEY` still contain the literal `CHANGEME`, it refuses to start with a clear error.

## Sample fixture

The tests upload `e2e/fixtures/sample.pdf`. It is a small (~4 KB) four-page PDF containing original prose written for this repository. Regenerate it with:

```bash
npm run fixtures:generate
```

The generator script is at `scripts/generate-sample-pdf.mjs`.

## Specs

| Spec | What it covers | Notes |
|---|---|---|
| [`auth.spec.ts`](./auth.spec.ts) | sign-up, log-in, log-out, bad-password rejection | Each test creates a fresh user via `uniqueTestEmail()` |
| [`projects.spec.ts`](./projects.spec.ts) | create / rename / share / delete a project | `share` invites a second fake email, doesn't verify their inbox |
| [`documents.spec.ts`](./documents.spec.ts) | upload `sample.pdf`, download it back, delete it | Upload sets files directly on the hidden `<input type="file">` |
| [`chat.spec.ts`](./chat.spec.ts) | ask a question about an uploaded PDF and verify a streamed answer with a `[1]` citation marker arrives | **Requires real LLM API keys** — see below |
| [`tabular.spec.ts`](./tabular.spec.ts) | create a 2-column review (Topic / Number of pages), add `sample.pdf`, click Generate, verify cells populate with citations | **Requires real LLM API keys** — see below |

## LLM-dependent specs (`chat`, `tabular`) — free-tier Gemini only

`chat.spec.ts` and `tabular.spec.ts` need a real LLM call. We use **Gemini's free tier with Flash-Lite** (`gemini-2.5-flash-lite`), and only against the committed public-domain fixture `sample.pdf`. Free-tier providers may log or train on inputs, so they must **never** see customer documents.

### Safety guard

The backend (`src/lib/llm/freeTierGuard.ts`) refuses to call any free-tier model unless:

1. `ALLOW_FREE_TIER_LLM=true` is explicitly set, and
2. `FREE_TIER_FIXTURE_ALLOWLIST` lists the fixture filenames that may be processed, and
3. every document filename passed to the LLM call appears in that allowlist.

Production and the dev DB **must** leave `ALLOW_FREE_TIER_LLM` unset (or set to anything other than `true`). With that, any accidental free-tier call throws immediately.

### Setup

1. Grab a free Gemini API key at <https://aistudio.google.com/app/apikey>.
2. Paste it into `backend/.env.test` under `GEMINI_API_KEY`.
3. Leave `ALLOW_FREE_TIER_LLM=true` and `FREE_TIER_FIXTURE_ALLOWLIST=sample.pdf,test-cim.pdf` as configured.

Free-tier limits (as of writing): 15 requests/min for Flash-Lite, well within what the e2e suite needs. Each `chat` run does ~1 LLM call; `tabular` does ~3 (one per cell × 2 columns × 1 row, with retries).

## Known fragilities

The frontend currently has few `data-testid` attributes, so selectors rely on:

- IDs (`#email`, `#password`, `#name`, `#confirmPassword`) — stable
- Placeholder text (`"Project name"`, `"Ask a question about your documents…"`) — breaks if copy changes
- Visible button text (`"Sign up"`, `"Create project"`, `"Delete"`) — breaks if copy changes

If a spec starts failing after a UI copy change, add a `data-testid` to the offending element and update the selector here. Don't paper over with sleeps.

## Configuration knobs

Override via env vars at run time:

| Env var | Default | Effect |
|---|---|---|
| `E2E_FRONTEND_PORT` | `3000` | Where Playwright expects the Next.js dev server |
| `E2E_BACKEND_PORT` | `3001` | Where Playwright expects the Express server |
| `E2E_BASE_URL` | `http://localhost:3000` | Overrides both `baseURL` and the frontend port check |
| `E2E_TEST_EMAIL_DOMAIN` | `e2e.gordonoss.test` | Domain used for generated unique e-mails |

## CI

In CI set `CI=true` so Playwright:

- starts fresh dev servers (instead of reusing whatever's already running);
- retries failing tests twice;
- writes an HTML report to `playwright-report/`.
