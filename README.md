# Mike

Mike is a legal document assistant with a Next.js frontend, an Express backend, Supabase Auth/Postgres, S3-compatible document storage, and LLM-powered chat, review, and document editing workflows.

This repository is licensed under AGPL-3.0-only. If you run a modified network service, make the corresponding source available to users as required by the license.

## What Is Included

- `frontend/` - Next.js app with authentication, projects, documents, assistant chat, workflows, tabular reviews, and account settings.
- `backend/` - Express API for auth-aware data access, document upload/conversion, chat/tool execution, model routing, workflows, tabular review generation, downloads, and account lifecycle operations.
- `backend/migrations/` - `node-pg-migrate` migrations for Supabase/Postgres.
- `backend/migrations/000_one_shot_schema.sql` - one-shot SQL schema for fresh Supabase databases.
- `backend/tests/` - Vitest coverage for auth hardening, cross-tenant access, document processing, chat/tool streams, account deletion, storage, and integration flows.
- `supabase/` - local Supabase CLI configuration.

## Notable Changes In This Version

- Replaced the single `backend/schema.sql` setup path with migration-based database management.
- Added RLS policy migrations, auth lookup RPCs, workflow sharing checks, encrypted API key storage, soft-delete user profiles, and account deletion jobs.
- Split backend chat tooling into focused modules for citations, document context, tool schemas, tool running, streaming, workflow loading, and individual tools.
- Added account deletion and restore token support, backend request logging, LLM rate limiting, PDF queue helpers, validation helpers, and a models endpoint.
- Hardened auth, storage, upload, project, document, tabular, workflow, user, and LLM integration code.
- Updated frontend account, project, document, assistant, workflow, and tabular review flows.
- Moved shared frontend providers, contexts, logo, Supabase client, and utilities under the app tree.
- Added backend test suites and DOCX CI workflow coverage.

## Requirements

- Node.js 20 or newer
- npm
- Supabase project with Auth and Postgres
- S3-compatible object storage, such as Cloudflare R2 or MinIO
- LibreOffice available on the backend host for DOC/DOCX to PDF conversion
- At least one supported model provider key:
  - Anthropic
  - Google Gemini
  - OpenRouter

## Install

Install backend and frontend dependencies:

```bash
npm install --prefix backend
npm install --prefix frontend
```

Create local environment files:

```bash
cp backend/.env.example backend/.env
cp frontend/.env.local.example frontend/.env.local
```

## Backend Configuration

Edit `backend/.env`:

```bash
PORT=3001
FRONTEND_URL=http://localhost:3000

SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SECRET_KEY=your-supabase-service-role-key
SUPABASE_ANON_KEY=your-supabase-anon-key

DATABASE_URL=postgresql://postgres:<password>@db.<project-ref>.supabase.co:5432/postgres

DOWNLOAD_SIGNING_SECRET=replace-with-a-random-secret-min-32-chars

R2_ENDPOINT_URL=https://your-account-id.r2.cloudflarestorage.com
R2_ACCESS_KEY_ID=your-r2-access-key
R2_SECRET_ACCESS_KEY=your-r2-secret-key
R2_BUCKET_NAME=mike

ANTHROPIC_API_KEY=your-anthropic-key
GEMINI_API_KEY=your-gemini-key
OPENROUTER_API_KEY=your-openrouter-key

RESEND_API_KEY=your-resend-key
HUGO_MASTER_KEY=hex-encoded-32-byte-key
HUGO_RESTORE_TOKEN_SECRET=random-restore-token-secret
```

Notes:

- `SUPABASE_SECRET_KEY` must be the service role key.
- `SUPABASE_ANON_KEY` is optional at runtime but required by the cross-tenant test suite.
- `DATABASE_URL` should use the direct Supabase Postgres connection, not the pooler.
- `HUGO_MASTER_KEY` encrypts user-supplied model API keys at rest. Generate one with `openssl rand -hex 32`.
- `HUGO_RESTORE_TOKEN_SECRET` signs account restore tokens. Generate one with `openssl rand -base64 48`.
- Provider keys can be configured globally in `.env`; user-managed keys are stored encrypted when enabled.

## Frontend Configuration

Edit `frontend/.env.local`:

```bash
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY=your-supabase-anon-key
SUPABASE_SECRET_KEY=your-supabase-service-role-key
NEXT_PUBLIC_API_BASE_URL=http://localhost:3001
```

The frontend uses Supabase Auth directly and calls the backend through `NEXT_PUBLIC_API_BASE_URL`.

## Database Setup

For a fresh Supabase project, run the one-shot schema in the Supabase SQL editor:

```sql
-- copy and run backend/migrations/000_one_shot_schema.sql
```

For an existing deployment, use migrations from the backend package:

```bash
npm run db:migrate --prefix backend
```

Rollback the most recent migration:

```bash
npm run db:migrate-down --prefix backend
```

Create a new migration:

```bash
npm run db:migrate-create --prefix backend -- <migration-name>
```

## Run Locally

Start the backend:

```bash
npm run dev --prefix backend
```

Start the frontend:

```bash
npm run dev --prefix frontend
```

Open `http://localhost:3000`.

First local run:

1. Sign up in the frontend.
2. If Supabase email confirmation is enabled, confirm the account or disable confirmation for local development.
3. Create a project.
4. Upload documents.
5. Open assistant chat, workflows, or tabular reviews.

## Available Features

- Project workspaces with document lists and project-specific assistant chat.
- Document upload, conversion, viewing, versioning, quote highlighting, and signed downloads.
- Assistant chat with document-aware tools for reading, finding, editing, replicating, and generating DOCX output.
- Built-in workflow execution and workflow sharing checks.
- Tabular review creation, generation, regeneration, and export support.
- User model settings with encrypted API key storage.
- Soft-delete account flow with restore token support and asynchronous deletion jobs.
- LLM request rate limiting and backend request logging.

## Test And Verification Commands

Backend build:

```bash
npm run build --prefix backend
```

Frontend build and lint:

```bash
npm run build --prefix frontend
npm run lint --prefix frontend
```

Backend test suites:

```bash
npm run test:no-db --prefix backend
npm run test:docx --prefix backend
npm run test:golden-log --prefix backend
npm run test:auth-hardening --prefix backend
npm run test:saga --prefix backend
npm run test:cross-tenant --prefix backend
```

`test:cross-tenant` needs a Supabase test project and valid `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, and `SUPABASE_ANON_KEY`.

## Deployment Notes

- The backend `start` script runs migrations before starting the compiled server.
- Build the backend before production start:

```bash
npm run build --prefix backend
npm run start --prefix backend
```

- The frontend includes OpenNext Cloudflare scripts:

```bash
npm run preview --prefix frontend
npm run deploy --prefix frontend
```

- Configure CORS with `FRONTEND_URL`.
- Ensure LibreOffice is installed on the backend runtime if document conversion is required.
- Use private buckets for document storage and expose files through the backend download routes.

## Troubleshooting

- `DOCX conversion failed`: install LibreOffice and restart the backend.
- `Missing provider key`: configure a global provider key in `backend/.env` or add a user key in account settings.
- `Database migration failed`: verify `DATABASE_URL` uses the direct Supabase database host on port `5432`.
- `Cross-tenant tests fail during sign-in`: set `SUPABASE_ANON_KEY` and use a disposable Supabase test project.
- `Frontend cannot reach backend`: verify `NEXT_PUBLIC_API_BASE_URL` and backend CORS `FRONTEND_URL`.

## License

AGPL-3.0-only. See `LICENSE`.
