#!/usr/bin/env node
// Blocking npm advisory gate with an explicit, documented allowlist.
//
// `npm audit --audit-level=high` alone can't express "this advisory is known,
// unfixable without breaking changes, and tracked" — the job either fails or
// gets demoted to report-only, which hides *new* advisories too. This gate
// keeps the audit blocking: high/critical advisories fail the build unless
// their GHSA id is listed in scripts/audit-allowlist.json, where each entry
// must carry a reason. Allowlisted advisories are printed on every run so
// they stay visible until they can be removed.
//
// npm's legacy quick-audit endpoint is being retired and now rejects valid
// lockfiles after npm CLI's preferred bulk request fails. Read the lockfile and
// call the supported bulk endpoint directly. If npm's advisory service is
// unavailable, use OSV's exact-version batch API as an independent fail-closed
// source instead of silently falling back to the obsolete endpoint.
//
// Usage: node ../scripts/audit-gate.mjs   (cwd = the workspace to audit)

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const allowlistPath = join(dirname(fileURLToPath(import.meta.url)), "audit-allowlist.json");
const allowlist = JSON.parse(readFileSync(allowlistPath, "utf8"));
const allowed = new Map(allowlist.map((e) => [e.ghsa, e.reason]));

const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
const packages = {};
for (const [packagePath, entry] of Object.entries(lock.packages ?? {})) {
  if (!packagePath || !entry.version) continue;
  const normalizedPath = packagePath.replaceAll("\\", "/");
  const markerIndex = normalizedPath.lastIndexOf("node_modules/");
  if (markerIndex < 0) continue;
  const installedPath = normalizedPath.slice(markerIndex + "node_modules/".length);
  const pathParts = installedPath.split("/");
  const packageName = entry.name ?? (
    pathParts[0]?.startsWith("@")
      ? pathParts.slice(0, 2).join("/")
      : pathParts[0]
  );
  if (!packageName) continue;
  packages[packageName] ??= [];
  if (!packages[packageName].includes(entry.version)) {
    packages[packageName].push(entry.version);
  }
}

const packageEntries = Object.entries(packages);

// FAIL CLOSED ON AN EMPTY LOCKFILE. A lockfile with no `packages` map (an
// npm 6 lockfile, a truncated write, a wrong cwd) produces zero queries, so
// every loop below is skipped, `advisories` is empty and the gate prints
// "passed" having checked nothing at all — a gate that answers "clean" for a
// tree it never looked at is worse than no gate.
if (packageEntries.length === 0) {
  console.error(
    "package-lock.json declared no resolved packages — refusing to pass the gate.",
  );
  console.error(
    "  (npm 6 lockfiles have no `packages` map; run `npm install` with npm 7+ to regenerate it.)",
  );
  process.exit(1);
}

const osvBaseUrl = process.env.OSV_API_BASE_URL ?? "https://api.osv.dev/v1";

/**
 * CANARY. `{}` is a perfectly valid npm bulk response — it is what the
 * registry sends for a clean tree — which means NO shape check can tell
 * "we looked and found nothing" apart from "this endpoint does not answer
 * this question". A proxy, a captive portal, an internal mirror that
 * implements the route as a stub, or the endpoint's eventual retirement all
 * produce 200 `{}`, and the gate happily printed "0 advisories, passed".
 *
 * So every batch carries a package+version we KNOW carries a high-severity
 * advisory. If the answer does not mention it, the endpoint is not answering
 * advisory questions and we fall through to OSV. The canary is stripped
 * before the report is evaluated, so it never appears as a finding.
 *
 * adm-zip 0.5.12 is the choice because it is already a real, allowlisted
 * dependency of the word-addin workspace: whatever retires it from the
 * advisory database will also break that allowlist entry, so the two cannot
 * drift apart unnoticed.
 */
const CANARY_PACKAGE = "adm-zip";
const CANARY_VERSION = "0.5.12";

/**
 * How many advisory batches were actually answered by a service. Checked
 * before the pass line: a run that never got an answer has not audited
 * anything, and must not be allowed to report success.
 */
let batchesAnswered = 0;

async function fetchJson(url, init, { attempts = 3, timeoutMs = 30_000 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        throw new Error(`advisory service returned HTTP ${response.status}`);
      }
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
      }
    }
  }
  throw lastError;
}

async function loadNpmReport() {
  const registry = execFileSync("npm", ["config", "get", "registry"], {
    encoding: "utf8",
  }).trim().replace(/\/$/, "");
  const endpoint = `${registry}/-/npm/v1/security/advisories/bulk`;
  const report = {};
  // Use one bounded attempt before the OSV fallback. Retrying a retired npm
  // fallback was the source of the previous five-minute CI failures.
  for (let offset = 0; offset < packageEntries.length; offset += 500) {
    const batch = Object.fromEntries(packageEntries.slice(offset, offset + 500));
    // Only strip the canary back out if it was not already part of this
    // workspace's tree. When it IS a real dependency its advisories are a
    // real finding and must survive.
    const canaryIsReal = Object.hasOwn(batch, CANARY_PACKAGE);
    batch[CANARY_PACKAGE] = [
      ...new Set([...(batch[CANARY_PACKAGE] ?? []), CANARY_VERSION]),
    ];
    const batchReport = await fetchJson(endpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "user-agent": "mike-audit-gate/1.0",
      },
      body: JSON.stringify(batch),
    }, { attempts: 1, timeoutMs: 15_000 });

    // VALIDATE, don't coerce. A registry (or a proxy, or a captive network)
    // that answers 200 with `{"error":"..."}` used to sail through here: the
    // payload is an object, its one value is not an array, the old code
    // coerced it to `[]`, and the gate reported "0 advisories, passed". An
    // advisory service that did not answer the question must send us to OSV,
    // and if OSV fails too the gate fails — never passes by default.
    if (!batchReport || Array.isArray(batchReport) || typeof batchReport !== "object") {
      throw new Error("npm returned an invalid advisory report");
    }
    for (const key of ["error", "message", "code"]) {
      if (Object.hasOwn(batchReport, key)) {
        throw new Error(
          `npm advisory service returned an error payload (${key}: ${JSON.stringify(batchReport[key])})`,
        );
      }
    }
    for (const [packageName, packageAdvisories] of Object.entries(batchReport)) {
      if (!Array.isArray(packageAdvisories)) {
        throw new Error(
          `npm returned a non-array advisory list for ${packageName}`,
        );
      }
    }
    // The canary must come back. An empty or missing entry means this
    // endpoint did not answer the question we asked, however well-formed its
    // 200 was — send the run to OSV rather than pass on silence.
    if (
      !Array.isArray(batchReport[CANARY_PACKAGE]) ||
      batchReport[CANARY_PACKAGE].length === 0
    ) {
      throw new Error(
        `npm returned no advisory for the canary ${CANARY_PACKAGE}@${CANARY_VERSION} — the endpoint is not answering advisory queries`,
      );
    }
    if (!canaryIsReal) delete batchReport[CANARY_PACKAGE];

    batchesAnswered += 1;
    for (const [packageName, packageAdvisories] of Object.entries(batchReport)) {
      report[packageName] = [
        ...(report[packageName] ?? []),
        ...packageAdvisories,
      ];
    }
  }
  if (batchesAnswered === 0) {
    throw new Error("npm answered no advisory batches");
  }
  return report;
}

async function loadOsvReport() {
  const queries = packageEntries.flatMap(([packageName, versions]) =>
    versions.map((version) => ({
      package: { ecosystem: "npm", name: packageName },
      version,
    })),
  );
  const vulnerabilityIds = new Set();
  const vulnerabilityMatches = new Map();
  for (let offset = 0; offset < queries.length; offset += 500) {
    const batchQueries = queries.slice(offset, offset + 500);
    const response = await fetchJson(`${osvBaseUrl}/querybatch`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "user-agent": "mike-audit-gate/1.0",
      },
      body: JSON.stringify({ queries: batchQueries }),
    });
    if (!Array.isArray(response?.results)) {
      throw new Error("OSV returned an invalid advisory report");
    }
    // OSV answers positionally: one result per query, in order. A short array
    // means some queries went unanswered, and reading the rest as "clean"
    // would silently drop packages from the audit.
    if (response.results.length !== batchQueries.length) {
      throw new Error(
        `OSV answered ${response.results.length} of ${batchQueries.length} queries`,
      );
    }
    batchesAnswered += 1;
    for (const [resultIndex, result] of response.results.entries()) {
      const query = batchQueries[resultIndex];
      for (const vulnerability of result.vulns ?? []) {
        if (!vulnerability?.id || !query) continue;
        vulnerabilityIds.add(vulnerability.id);
        vulnerabilityMatches.set(
          vulnerability.id,
          [
            ...(vulnerabilityMatches.get(vulnerability.id) ?? []),
            { name: query.package.name, version: query.version },
          ],
        );
      }
    }
  }

  const details = await Promise.all(
    [...vulnerabilityIds].map((id) =>
      fetchJson(`${osvBaseUrl}/vulns/${encodeURIComponent(id)}`, {
        headers: { accept: "application/json", "user-agent": "mike-audit-gate/1.0" },
      }),
    ),
  );
  return {
    osv: details.flatMap((detail) => {
      // Some SheetJS advisories have an open-ended OSV range because patched
      // releases are distributed outside npm. GitHub records the upper bound
      // in last_known_affected_version_range; honor that bound so a patched
      // vendor release such as xlsx 0.20.3 is not treated as vulnerable.
      const matches = vulnerabilityMatches.get(detail.id) ?? [];
      const allMatchesKnownSafe = matches.length > 0 && matches.every((match) => {
        const affected = detail.affected?.find(
          (entry) => entry.package?.ecosystem === "npm" && entry.package?.name === match.name,
        );
        const lastKnownRange = affected?.database_specific?.last_known_affected_version_range;
        const rangeMatch = /^<\s*(=?)\s*(\d+(?:\.\d+){1,2})$/.exec(lastKnownRange ?? "");
        if (!rangeMatch || !/^\d+(?:\.\d+){1,2}$/.test(match.version)) return false;
        const left = match.version.split(".").map((part) => Number.parseInt(part, 10));
        const right = rangeMatch[2].split(".").map((part) => Number.parseInt(part, 10));
        if ([...left, ...right].some(Number.isNaN)) return false;
        const comparison = [0, 1, 2]
          .map((index) => (left[index] ?? 0) - (right[index] ?? 0))
          .find((difference) => difference !== 0) ?? 0;
        return rangeMatch[1] === "=" ? comparison > 0 : comparison >= 0;
      });
      if (allMatchesKnownSafe) return [];

      const severity = detail?.database_specific?.severity?.toLowerCase();
      if (!severity) {
        throw new Error(`OSV advisory ${detail?.id ?? "unknown"} has no severity`);
      }
      const id = detail.id;
      return [{
        url: id.startsWith("GHSA-")
          ? `https://github.com/advisories/${id}`
          : `https://osv.dev/vulnerability/${id}`,
        title: detail.summary ?? id,
        severity,
      }];
    }),
  };
}

let report;
try {
  report = await loadNpmReport();
} catch (npmError) {
  // Each loader counts only its OWN answered batches; a partially answered
  // npm run must not lend its credit to the OSV attempt.
  batchesAnswered = 0;
  console.warn(
    `npm advisory service unavailable; checking OSV instead (${npmError instanceof Error ? npmError.message : String(npmError)})`,
  );
  try {
    report = await loadOsvReport();
  } catch (osvError) {
    console.error("Both advisory services failed — refusing to pass the gate:");
    console.error(osvError instanceof Error ? osvError.message : String(osvError));
    process.exit(1);
  }
}

const advisories = new Map(); // ghsa -> { severity, title, url }
for (const packageAdvisories of Object.values(report)) {
  if (!Array.isArray(packageAdvisories)) continue;
  for (const advisory of packageAdvisories) {
    if (!advisory?.url) continue;
    if (advisory.severity !== "high" && advisory.severity !== "critical") continue;
    const ghsa = advisory.url.split("/").pop();
    advisories.set(ghsa, {
      severity: advisory.severity,
      title: advisory.title,
      url: advisory.url,
    });
  }
}

const blocking = [];
for (const [ghsa, adv] of advisories) {
  if (allowed.has(ghsa)) {
    console.log(`ALLOWLISTED ${adv.severity}: ${ghsa} — ${adv.title}`);
    console.log(`  reason: ${allowed.get(ghsa)}`);
  } else {
    blocking.push(`${adv.severity}: ${ghsa} — ${adv.title} (${adv.url})`);
  }
}

// The allowlist is shared across workspaces, so an entry unused here may
// still be load-bearing in the other workspace — flag it, don't fail on it.
const unused = allowlist.filter((e) => !advisories.has(e.ghsa));
for (const e of unused) {
  console.log(`note: allowlist entry ${e.ghsa} not reported in this workspace — remove it once no workspace reports it`);
}

if (blocking.length > 0) {
  console.error(`\n${blocking.length} high/critical advisories are not allowlisted:`);
  for (const line of blocking) console.error(`  ${line}`);
  process.exit(1);
}
// Last line of defence: reaching here with nothing answered means the loops
// above ran zero times, which is "no data", not "no advisories".
if (batchesAnswered === 0) {
  console.error(
    "No advisory service answered — refusing to pass the gate.",
  );
  process.exit(1);
}
console.log(`audit gate passed (${advisories.size} high/critical advisories, all allowlisted)`);
