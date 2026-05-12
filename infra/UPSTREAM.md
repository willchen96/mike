# Upstream Synchronization Guide

This fork diverges from the open-source upstream `mikeoss/mike` repository on infrastructure and deployment decisions.

## Upstream vs. Fork

The upstream project (`mikeoss/mike`) uses:
- **Frontend**: Next.js deployed to Cloudflare Pages via `@opennextjs/cloudflare`
- **Backend**: Supabase (Auth + Postgres)
- **Storage**: Cloudflare R2 (S3-compatible)
- **Payments/Extensions**: Stripe integration
- **Email**: Resend

This fork uses:
- **Frontend**: Next.js deployed to AWS via `@opennextjs/aws` (adapter swap in a later stage)
- **Backend**: Express on AWS ECS Fargate
- **Database**: AWS RDS Postgres (Aurora Serverless v2) with RDS Proxy
- **Storage**: AWS S3
- **Auth**: Clerk (vs. Supabase Auth)
- **Email**: AWS SES (vs. Resend)
- **Infrastructure**: SST v3 (Pulumi-based IaC)

## Merge Protocol

To pull upstream changes:

```bash
git remote add upstream https://github.com/mikeoss/mike.git
git fetch upstream main
git merge upstream/main
```

### Expected Conflicts

Conflicts typically occur in:
- `backend/src/routes/*` — backend routes differ (Supabase auth vs. Clerk)
- `backend/src/middleware/auth.ts` — authentication middleware
- `frontend/src/lib/supabase*.ts` — Supabase client initialization (replaced by Clerk)
- `frontend/src/app/login` — authentication flow
- `frontend/src/app/signup` — registration flow

### Safe Merge Areas

No conflicts expected:
- `infra/` — AWS infrastructure files (new in fork)
- `backend/Dockerfile` — containerization (new in fork)
- `sst.config.ts` — SST infrastructure (new in fork)
- `backend/nixpacks.toml` — Railway deployment config (upstream only)
- `frontend/open-next.config.ts` — adapter configuration (will differ by design)

## Workflow for Upstream Merges

1. Fetch upstream: `git fetch upstream main`
2. Create a merge branch: `git checkout -b merge/upstream-<date>`
3. Attempt merge: `git merge upstream/main`
4. Resolve conflicts in auth, Supabase references, and frontend routes
5. Retain fork's infrastructure files (SST, Dockerfile, etc.)
6. Test thoroughly (model routing, document processing, auth flow)
7. Commit and push
