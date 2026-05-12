# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

"Mike" is a legal document assistant (homepage: mikeoss.com, app: app.mikeoss.com). It is a two-package monorepo with no workspace tooling — each package has its own `package.json`, lockfile, and `tsconfig.json`. Always run npm commands with `--prefix backend` or `--prefix frontend` (or `cd` into the directory).

- `backend/` — Express + TypeScript API. Talks to Supabase (Auth + Postgres), Cloudflare R2 (S3-compatible object storage), and LLM providers (Anthropic, Google Gemini, OpenAI).
- `frontend/` — Next.js 16 (App Router, React 19, React Compiler enabled) deployed to Cloudflare via `@opennextjs/cloudflare`.
- `backend/schema.sql` — full Supabase schema for a fresh database. Incremental updates live in `backend/migrations/` (currently empty in tree; historical files were folded into `schema.sql`). Never run the full schema against production — apply migration files there.

## Common Commands

```bash
# Install
npm install --prefix backend
npm install --prefix frontend

# Dev (run both in separate terminals)
npm run dev --prefix backend     # tsx watch on PORT (default 3001)
npm run dev --prefix frontend    # next dev on :3000

# Checks before pushing
npm run build --prefix backend   # tsc — no emit-only typecheck; emits to dist/
npm run build --prefix frontend  # next build
npm run lint --prefix frontend   # eslint (flat config in eslint.config.mjs)

# Cloudflare deploy (frontend)
npm run preview --prefix frontend   # local opennext preview
npm run deploy  --prefix frontend   # build + opennext deploy
npm run cf-typegen --prefix frontend # regenerate cloudflare-env.d.ts after wrangler.toml changes
```

There is no test runner configured in either package; do not invent test commands. The README's "Useful Checks" (`backend build`, `frontend build`, `frontend lint`) is the canonical pre-flight.

## Required services

The backend will not function without these — set them in `backend/.env`:

- Supabase project: `SUPABASE_URL`, `SUPABASE_SECRET_KEY` (service role).
- R2-compatible bucket: `R2_ENDPOINT_URL`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`.
- At least one model provider key: `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY`. Any key absent here can instead be supplied per-user via the Account UI (stored encrypted in `user_api_keys`, decrypted with `USER_API_KEYS_ENCRYPTION_SECRET`).
- `DOWNLOAD_SIGNING_SECRET` — 32-byte hex used to HMAC-sign one-shot download tokens.
- `FRONTEND_URL` — used for the CORS allowlist.
- LibreOffice must be on `PATH` for DOC/DOCX → PDF conversion (`nixpacks.toml` installs it for Railway-style deploys).

The frontend only needs `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY`, `NEXT_PUBLIC_API_BASE_URL`, and (for server-side routes) `SUPABASE_SECRET_KEY`. Treat anything not prefixed `NEXT_PUBLIC_` as server-only — see `docs/safe-local-testing.md`.

## Architecture

### Request flow

Browser → Next.js (UI + a few server routes under `frontend/src/app/api/*`) → Express backend (`http://localhost:3001` in dev, `NEXT_PUBLIC_API_BASE_URL` in prod) → Supabase / R2 / LLM provider.

All backend calls are authenticated with a Supabase JWT in `Authorization: Bearer <token>`. `backend/src/middleware/auth.ts` validates the token using the service-role key and sets `res.locals.userId` / `userEmail` / `token`. Mirror auth helper in `frontend/src/lib/auth.ts` for the Next.js API routes.

### Backend routers (mounted in `backend/src/index.ts`)

- `/chat` — single-document and standalone assistant chats.
- `/projects` and `/projects/:projectId/chat` — project-scoped chats and documents.
- `/single-documents` — uploads, versions, and document operations.
- `/tabular-review` — table-style document extraction; uses the mid-tier model.
- `/workflows` — built-in (`backend/src/lib/builtinWorkflows.ts`) and user-defined prompt workflows.
- `/user` (alias `/users`) — profile, API keys, model preferences.
- `/download` — short-lived signed download URLs (HMAC via `DOWNLOAD_SIGNING_SECRET`).

Tiered rate limits are applied in `index.ts`: `generalLimiter` for everything, plus stricter limits on chat (`chatLimiter`), chat creation/title-gen (`chatCreateLimiter`), and uploads (`uploadLimiter`). All windows/maxes are overridable via `RATE_LIMIT_*` env vars.

### LLM provider abstraction (`backend/src/lib/llm/`)

`streamChatWithTools` and `completeText` in `llm/index.ts` dispatch to `claude.ts`, `gemini.ts`, or `openai.ts` based on the model id prefix (`claude`, `gemini`, `gpt-`). Model tiers in `llm/models.ts`:

- **Main** — user-selectable per chat (Opus/Sonnet, Gemini Pro/Flash, GPT-5.5/mini).
- **Mid** — used for tabular review; user picks one in Account settings.
- **Low** — used for chat-title generation and lightweight extractions.

When adding a new model, register it in `CLAUDE_*` / `GEMINI_*` / `OPENAI_*` arrays in `llm/models.ts` so `providerForModel` and `resolveModel` recognise it. The frontend mirrors availability in `frontend/src/app/lib/modelAvailability.ts`.

User-supplied API keys (stored encrypted in `user_api_keys`) override server keys for that user; see `backend/src/lib/userApiKeys.ts` and `lib/userSettings.ts`.

### Document pipeline

`lib/upload.ts` and `lib/convert.ts` handle ingestion. DOC/DOCX inputs run through LibreOffice (`libreoffice-convert`) to PDF for parsing with `pdfjs-dist`; DOCX text/tracked-changes extraction uses `mammoth`. Generated DOCX outputs (e.g. CP Checklists from the built-in workflows) are produced with the `docx` package. Object bytes live in R2 (`lib/storage.ts`); database rows track keys, versions (`lib/documentVersions.ts`), and access (`lib/access.ts`).

### Frontend structure

- `src/app/(pages)/` — App Router routes grouped under a single layout: `assistant` (chat), `projects/[id]`, `workflows/[id]`, `tabular-reviews`, `account`. The root `page.tsx` redirects to `/assistant`.
- `src/app/components/` — feature-specific React components (assistant, projects, workflows, tabular, modals, shared types).
- `src/app/contexts/` — `ChatHistoryContext`, `SidebarContext`.
- `src/app/hooks/` — feature hooks (`useAssistantChat`, `useDocumentVersions`, `useSelectedModel`, etc.).
- `src/app/lib/mikeApi.ts` — single client for backend calls; attaches the Supabase token.
- `src/components/ui/` — generic UI primitives (button, dropdown, badge, cite-button, text-search-widget).
- `src/lib/supabase.ts` / `supabase-server.ts` — browser vs server Supabase clients.

`next.config.ts` enables `reactCompiler: true` and rewrites `/sitemap.xml` (and `/sitemap_<slug>.xml`) to the App-Router `api/sitemap/*` handlers. `open-next.config.ts` uses the default Cloudflare adapter — keep it minimal unless you intentionally need queue/cache overrides.

### Database

`schema.sql` defines Supabase tables with RLS enabled and `auth.uid()`-scoped policies. Key tables: `user_profiles` (auto-created via the `on_auth_user_created` trigger), `user_api_keys`, `projects` (+ `project_subfolders`, `project_documents`), `chats`/`messages`, and tabular-review tables. When changing schema, add an incremental file to `backend/migrations/` AND update `schema.sql` so fresh installs match production.

## Conventions to honour

- Backend uses 2-space indentation; frontend uses 4-space indentation (see existing files — don't reformat across packages).
- Prefer the `streamChatWithTools` / `completeText` entry points over calling provider SDKs directly so model routing and per-user API-key fallback stay consistent.
- Route handlers use `res.locals.userId` (set by `requireAuth`); do not re-read the token or re-query Supabase Auth inside a route.
- R2 keys are user- and project-scoped; never expose them directly to the browser — always go through `/download` for signed URLs.
- The frontend's `NEXT_PUBLIC_*` allow-list is enforced by convention only. Putting a service-role key behind a `NEXT_PUBLIC_*` name will leak it to the browser bundle.
