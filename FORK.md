# Fork Relationship

## Overview

**GordonOSS** is a **hard fork** of [willchen96/mike](https://github.com/willchen96/mike),
purpose-built for the finance industry. It is developed and maintained independently at
[Archibald312/GordonOSS](https://github.com/Archibald312/GordonOSS).

| | |
|---|---|
| **Upstream (do not touch)** | https://github.com/willchen96/mike |
| **This fork** | https://github.com/Archibald312/GordonOSS |
| **Fork type** | Hard fork — no planned upstream sync |
| **License** | AGPL-3.0-only (inherited from upstream; see [LICENSE](./LICENSE)) |

---

## ⚠️  DO NOT OPEN PULL REQUESTS AGAINST UPSTREAM

GitHub's default PR target is the **upstream repo** (`willchen96/mike`).
If you click the "Compare & pull request" banner that appears after a push,
GitHub will pre-select `willchen96/mike` as the base — **not this repo**.
Merging there would expose proprietary finance-industry work to the upstream
project's contributors and the public under AGPL-3.0.

### How to open a PR safely (within this fork only)

1. Push your branch to `Archibald312/GordonOSS`.
2. Go to **https://github.com/Archibald312/GordonOSS/pulls** (bookmark this).
3. Click **New pull request**.
4. Confirm both dropdowns show `Archibald312/GordonOSS` — base and compare.
5. **Never** change the base repository to `willchen96/mike`.

Do **not** use the "Compare & pull request" banner that appears on
`github.com/Archibald312/GordonOSS` after a push — it sometimes defaults to
the upstream. Always navigate to the Pulls tab manually.

---

## Branch conventions

| Branch | Purpose |
|---|---|
| `main` | Protected production branch. Requires CI to pass before merge. |
| `finance-fork` | Primary development branch for finance-industry features. |
| `feature/*` | Short-lived feature branches; PR into `finance-fork` or `main`. |

---

## Hard fork strategy

This is a **hard fork**, meaning:

- We do **not** pull upstream changes from `willchen96/mike`.
- We do **not** intend to contribute changes back to upstream.
- The fork started from a specific upstream commit and diverges from there.
- All net-new code (CI pipeline, finance-industry features, test suite) is
  original work developed within this repo.

If an upstream security fix is ever worth cherry-picking, do so explicitly and
document it — do not merge entire upstream branches.

---

## AGPL-3.0 obligations

GordonOSS is licensed under **AGPL-3.0-only**, inherited from the upstream project.

Key obligations:
- Any modified version made available over a network **must** make its complete
  corresponding source code available to users of that network service.
- If you distribute a compiled or packaged version, you must include or offer the
  full source.
- You may **not** sublicense or relicense the code under a more restrictive license.

If you are unsure whether a planned change is AGPL-compliant, consult legal counsel
before shipping it.

---

## Quick sanity check before any `git push`

```bash
# Confirm you are pushing to the fork, not upstream.
git remote -v
# You should see:
#   origin  https://github.com/Archibald312/GordonOSS.git (fetch)
#   origin  https://github.com/Archibald312/GordonOSS.git (push)
# If 'origin' points to willchen96/mike, stop and fix your remotes.
```
