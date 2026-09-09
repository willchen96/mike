// Regression tests for the FAIL-CLOSED contract of scripts/audit-gate.mjs.
//
// Run: node --test scripts/audit-gate.test.mjs
//
// The gate's only job is to refuse. Every bug it has had was the same bug —
// some path where "we could not check" printed the same "audit gate passed"
// as "we checked and it is clean" — so these tests assert the exit code for
// the ways that has happened, not the advisory parsing.

import { deepStrictEqual, notStrictEqual, strictEqual } from "node:assert";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const gatePath = join(dirname(fileURLToPath(import.meta.url)), "audit-gate.mjs");

const NPM_BULK_PATH = "/-/npm/v1/security/advisories/bulk";
/** The canary the gate smuggles into every npm batch. */
const CANARY_ADVISORY = {
    id: 1123686,
    url: "https://github.com/advisories/GHSA-xcpc-8h2w-3j85",
    title: "adm-zip: Crafted ZIP file triggers 4GB memory allocation",
    severity: "high",
};

/**
 * One stub standing in for BOTH advisory services; each test installs the
 * responses it needs. `requests` records (url, body) so a test can prove what
 * the gate did and did not consult.
 */
const requests = [];
let respond = () => ({ status: 200, body: { error: "nope" } });

const stub = createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
        let parsed = null;
        try {
            parsed = raw ? JSON.parse(raw) : null;
        } catch {
            parsed = null;
        }
        requests.push({ url: req.url, body: parsed });
        const { status = 200, body } = respond(req.url, parsed) ?? {};
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body ?? {}));
    });
});
await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
const stubUrl = `http://127.0.0.1:${stub.address().port}`;
after(() => stub.close());

// spawn, never spawnSync: the stub registry runs on THIS process's event
// loop, and a synchronous child would block it — the child's requests would
// go unanswered until they timed out, turning a 0.2s test into a 100s one.
function runGate(lockfile) {
    const dir = mkdtempSync(join(tmpdir(), "audit-gate-"));
    writeFileSync(join(dir, "package-lock.json"), JSON.stringify(lockfile));
    const child = spawn(process.execPath, [gatePath], {
        cwd: dir,
        env: {
            ...process.env,
            npm_config_registry: stubUrl,
            OSV_API_BASE_URL: stubUrl,
        },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (c) => (stdout += c));
    child.stderr.setEncoding("utf8").on("data", (c) => (stderr += c));
    return new Promise((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (status) => resolve({ status, stdout, stderr }));
    });
}

const LOCKFILE_WITH_PACKAGES = {
    lockfileVersion: 3,
    packages: {
        "": { name: "fixture", version: "1.0.0" },
        "node_modules/left-pad": { version: "1.3.0" },
    },
};

test("fails when the advisory services answer 200 with an error payload", async () => {
    // Both services are the stub, so npm fails validation and the OSV fallback
    // fails too. Passing here would mean shipping unaudited dependencies every
    // time a proxy or a captive network sat in front of the registry.
    requests.length = 0;
    respond = () => ({ status: 200, body: { error: "nope" } });
    const result = await runGate(LOCKFILE_WITH_PACKAGES);
    notStrictEqual(result.status, 0, `expected non-zero exit\n${result.stderr}`);
    strictEqual(result.stdout.includes("audit gate passed"), false);
});

test("fails when the lockfile declares no packages, without calling out", async () => {
    // An npm 6 lockfile (or a truncated one) yields zero queries, so every loop
    // in the gate is skipped and it used to report a clean audit having made no
    // network call at all.
    requests.length = 0;
    respond = () => ({ status: 200, body: {} });
    const result = await runGate({ lockfileVersion: 1, dependencies: {} });
    notStrictEqual(result.status, 0, `expected non-zero exit\n${result.stderr}`);
    strictEqual(result.stdout.includes("audit gate passed"), false);
    strictEqual(result.stderr.includes("no resolved packages"), true);
    // Nothing was consulted — which is exactly why it must not pass.
    deepStrictEqual(requests, []);
});

// THE `{}` PROBLEM. An empty object is npm's legitimate answer for a clean
// tree, so no shape check can separate it from an endpoint that does not
// implement the route (a proxy, a mirror, the endpoint's retirement). The
// canary is what separates them: the gate asks about a package it KNOWS is
// vulnerable, and silence about that package is silence about everything.
test("treats an empty npm answer as unsupported and falls through to OSV", async () => {
    requests.length = 0;
    respond = (url) => {
        if (url === NPM_BULK_PATH) return { status: 200, body: {} };
        if (url === "/querybatch")
            // One query: the fixture has one package at one version.
            return { status: 200, body: { results: [{}] } };
        return { status: 200, body: {} };
    };

    const result = await runGate(LOCKFILE_WITH_PACKAGES);

    strictEqual(result.status, 0, `expected a pass via OSV\n${result.stderr}`);
    strictEqual(result.stdout.includes("audit gate passed"), true);
    // It did not believe npm...
    strictEqual(result.stderr.includes("canary"), true);
    // ...and it actually asked the fallback instead.
    strictEqual(
        requests.some((request) => request.url === "/querybatch"),
        true,
    );
});

test("sends the canary in every npm batch and keeps it out of the findings", async () => {
    requests.length = 0;
    respond = (url) => {
        if (url === NPM_BULK_PATH)
            return { status: 200, body: { "adm-zip": [CANARY_ADVISORY] } };
        return { status: 200, body: {} };
    };

    const result = await runGate(LOCKFILE_WITH_PACKAGES);

    const bulk = requests.find((request) => request.url === NPM_BULK_PATH);
    // The canary rides along with the workspace's real packages...
    deepStrictEqual(bulk.body["adm-zip"], ["0.5.12"]);
    deepStrictEqual(bulk.body["left-pad"], ["1.3.0"]);
    // ...the answer is accepted, so OSV is never consulted...
    strictEqual(
        requests.some((request) => request.url === "/querybatch"),
        false,
    );
    // ...and the canary's own high-severity advisory is stripped before the
    // report is judged, so it is not reported against a tree that does not
    // contain adm-zip at all.
    strictEqual(result.status, 0, `expected a pass\n${result.stderr}`);
    strictEqual(
        result.stdout.includes("audit gate passed (0 high/critical advisories"),
        true,
    );
});

test("keeps the canary's advisory when the workspace really depends on it", async () => {
    // Stripping unconditionally would blind the gate to the one package it
    // uses as its probe — and word-addin genuinely ships adm-zip in its dev
    // tree, which is why it has an allowlist entry.
    requests.length = 0;
    respond = (url) => {
        if (url === NPM_BULK_PATH)
            return { status: 200, body: { "adm-zip": [CANARY_ADVISORY] } };
        return { status: 200, body: {} };
    };

    const result = await runGate({
        lockfileVersion: 3,
        packages: {
            "": { name: "fixture", version: "1.0.0" },
            "node_modules/adm-zip": { version: "0.5.12" },
        },
    });

    strictEqual(result.status, 0, `expected a pass\n${result.stderr}`);
    strictEqual(
        result.stdout.includes("ALLOWLISTED high: GHSA-xcpc-8h2w-3j85"),
        true,
    );
});

test("fails when OSV answers fewer results than it was asked about", async () => {
    // OSV's querybatch is positional. A short array used to be read as "the
    // rest are clean", quietly dropping packages from the audit.
    requests.length = 0;
    respond = (url) => {
        if (url === NPM_BULK_PATH) return { status: 200, body: {} };
        if (url === "/querybatch") return { status: 200, body: { results: [] } };
        return { status: 200, body: {} };
    };

    const result = await runGate(LOCKFILE_WITH_PACKAGES);

    notStrictEqual(result.status, 0, `expected non-zero exit\n${result.stdout}`);
    strictEqual(result.stdout.includes("audit gate passed"), false);
    strictEqual(result.stderr.includes("OSV answered 0 of 1"), true);
});

test("fails on an advisory the FALLBACK found after npm went silent", async () => {
    // The other half of the `{}` path. Falling through to OSV is only worth
    // anything if the fallback's findings are then judged: a run that
    // switched services and then printed "passed" over a real high-severity
    // advisory would be the same silent pass in a new disguise.
    requests.length = 0;
    const advisoryId = "GHSA-1111-2222-3333";
    respond = (url) => {
        if (url === NPM_BULK_PATH) return { status: 200, body: {} };
        if (url === "/querybatch")
            return {
                status: 200,
                body: { results: [{ vulns: [{ id: advisoryId }] }] },
            };
        if (url === `/vulns/${advisoryId}`)
            return {
                status: 200,
                body: {
                    id: advisoryId,
                    summary: "left-pad: pads left too enthusiastically",
                    database_specific: { severity: "HIGH" },
                },
            };
        return { status: 200, body: {} };
    };

    const result = await runGate(LOCKFILE_WITH_PACKAGES);

    notStrictEqual(result.status, 0, `expected non-zero exit\n${result.stdout}`);
    strictEqual(result.stdout.includes("audit gate passed"), false);
    // Named, so the failure is actionable rather than just red.
    strictEqual(result.stderr.includes(advisoryId), true);
});
