# Tech Debt & Follow-ups

Living list of issues surfaced during the CI / test-suite work that are
worth addressing but were not blocking the initial green build. Tighten
these one by one; check items off as they land.

When you fix an item, also remove the corresponding `eslint-disable` /
permissive rule / workaround it references.

---

## High priority

### Login page redirect race condition
**File:** `frontend/src/app/login/page.tsx`

After `supabase.auth.signInWithPassword` resolves, the handler calls
`router.push("/assistant")` immediately. AuthContext's
`onAuthStateChange` listener fires asynchronously, so `/assistant`
sometimes renders before `isAuthenticated` flips to `true` and the auth
guard bounces the user back to `/login`. Signup hides this by chance —
it shows a 2-second "Account created!" success screen first, which gives
the context time to update.

Real impact: users on slow connections or under React concurrent renders
can experience a "login → bounce back to login" loop on first try.

Suggested fix:
- After `signInWithPassword` succeeds, `await supabase.auth.getSession()`
  to confirm the session is fully persisted before pushing.
- Or use `useAuth()`'s `authLoading` / `isAuthenticated` in a small
  `useEffect` instead of an imperative `router.push`.

When fixed, remove the `waitForFunction(localStorage)` workaround in
`e2e/helpers/auth.ts::logInExistingUser`.

---

## Medium priority

### Frontend ESLint warnings (95)
**File:** `frontend/eslint.config.mjs`

The frontend config has day-one permissive overrides so CI doesn't block
on existing upstream code. Tighten these as the team cleans up:

| Rule | Current | Target | Notes |
|---|---|---|---|
| `react-hooks/set-state-in-effect` | warn | error | ~15 occurrences; real perf anti-pattern |
| `react-hooks/refs` | warn | error | 2 in `ChatView.tsx` |
| `react-hooks/immutability` | warn | error | 1 in `DocView.tsx` (`scrollToHighlightOnPage` accessed before declared) |
| `react-hooks/static-components` | warn | error | 1 in `WFColumnViewModal.tsx` (`const FormatIcon = formatIcon(...)`) |
| `react/no-unescaped-entities` | warn | error | 3 occurrences; trivial fix (`'` → `&apos;`) |
| `@typescript-eslint/no-explicit-any` | off | warn | Many occurrences across both backend and frontend |
| `@typescript-eslint/no-require-imports` | off | warn | Only used in `src/scripts/` and a few conditional loads |

### Backend ESLint warnings (7)
**File:** `backend/eslint.config.js`

Unused-vars warnings in `chatTools.ts`, `docxTrackedChanges.ts`,
`projects.ts`, `tabular.ts`. Either delete the dead code or prefix the
identifiers with `_` to silence the rule properly. Once cleaned up,
consider promoting `@typescript-eslint/no-unused-vars` from `warn` to
`error`.

### `@anthropic-ai/sdk` moderate vuln
**Source:** `npm audit` in `backend/`

`@anthropic-ai/sdk` 0.79.0–0.91.0 has a moderate insecure-file-perm
issue in the Local Filesystem Memory Tool. Fix requires `npm audit fix
--force`, which upgrades to 0.96.0 (breaking change). Schedule a
maintenance window to do the upgrade, smoke-test the LLM paths, and
ship. Below the `--audit-level=high` CI threshold so it does not block.

### Frontend `postcss` moderate vulns (4)
**Source:** `npm audit` in `frontend/`

`postcss` <8.5.10 has an XSS-via-unescaped-`</style>` issue. The only
`npm audit fix --force` available downgrades `next` to 9.3.3 — not
viable. Wait for Next.js to bump its transitive dependency, then
re-audit. Below the `--audit-level=high` CI threshold.

---

## Low priority / housekeeping

### Local Node version
**Symptom:** `npm warn EBADENGINE` on `eslint-visitor-keys@5.0.1` —
requires Node `^20.19 || ^22.13 || >=24`, local is `v23.9.0`.

CI uses Node 22 (LTS) and is unaffected. For local development, either:
- Switch local Node to a supported version (22 LTS recommended), or
- Add a `.nvmrc` / `.node-version` pinning Node 22 so contributors
  auto-switch.

### `frontend/src/scripts/convert-courts-to-ts.js`
One-off CJS conversion script. Currently in `globalIgnores` of the
frontend ESLint config. If the script is no longer needed, delete it
and remove the ignore entry. If it stays, port it to ESM so
`@typescript-eslint/no-require-imports` can be re-enabled.

### Branch protection on `main`
Once CI has run green at least once, lock `main` down:
**Settings → Branches → Branch protection rules → `main` →
Require status checks: `lint`, `test-unit`, `test-e2e`, `audit`**.

### Rotate exposed test secrets
During earlier debugging the Supabase test service-role key and the
Gemini test key were quoted in a transcript. Rotate both in the
respective dashboards and update the corresponding GitHub Actions
secrets when convenient — risk is low (test project only) but hygiene
matters.

---

## Done

<!-- Move items here as they're fixed. Include the commit SHA. -->
