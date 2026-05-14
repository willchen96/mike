import { defineConfig, devices } from "@playwright/test";
import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

/**
 * Playwright config for the GordonOSS end-to-end suite.
 *
 * Starts both the Next.js frontend (port 3000) and the Express backend
 * (port 3001) before tests run.  Tests live in ./e2e and target the
 * frontend's base URL.
 *
 * Test env is loaded from backend/.env.test so a single file feeds both
 * vitest (backend unit tests) and these e2e tests.  All vars in that
 * file — Supabase keys, NEXT_PUBLIC_* for the frontend, Gemini key,
 * ALLOW_FREE_TIER_LLM, FREE_TIER_FIXTURE_ALLOWLIST — are passed into
 * each webServer process so the dev servers point at the test Supabase
 * project instead of dev.
 *
 * See e2e/README.md for setup details.
 */

const TEST_ENV_FILE = resolve(__dirname, "backend", ".env.test");
if (!existsSync(TEST_ENV_FILE)) {
  throw new Error(
    `Missing ${TEST_ENV_FILE}. See e2e/README.md for how to set it up.`,
  );
}
const TEST_ENV = (loadEnv({ path: TEST_ENV_FILE }).parsed ?? {}) as Record<string, string>;

// Fail fast if the user hasn't replaced the CHANGEME placeholders.  This is
// the most common failure mode and the error message Playwright would give
// otherwise (Supabase 401 deep inside a test) is hard to diagnose.
const requiredVars = [
  "SUPABASE_URL",
  "SUPABASE_SECRET_KEY",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  // Supabase renamed the anon key in newer projects — the frontend reads
  // this name.  Set it to the same value as NEXT_PUBLIC_SUPABASE_ANON_KEY.
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY",
  "GEMINI_API_KEY",
];
const missing = requiredVars.filter(
  (k) => !TEST_ENV[k] || /CHANGEME/.test(TEST_ENV[k]),
);
if (missing.length > 0) {
  throw new Error(
    `backend/.env.test has unset placeholders for: ${missing.join(", ")}. ` +
      `Fill these in before running e2e tests (see e2e/README.md).`,
  );
}

const FRONTEND_PORT = Number(process.env.E2E_FRONTEND_PORT ?? 3000);
const BACKEND_PORT = Number(process.env.E2E_BACKEND_PORT ?? TEST_ENV.PORT ?? 3001);
const BASE_URL = process.env.E2E_BASE_URL ?? `http://localhost:${FRONTEND_PORT}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false, // Auth tests mutate global state (sign-up)
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1, // Single worker so dev DB state stays predictable
  reporter: process.env.CI ? [["list"], ["html"]] : "list",
  timeout: 60_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  webServer: [
    {
      // In CI: serve the pre-built output with `next start` (boots in ~2s,
      // no cold-compile during tests).  The CI workflow runs `next build`
      // before Playwright so the .next/ directory is already present.
      // Locally: use `next dev` for hot-reload convenience.
      command: process.env.CI ? "npm start" : "npm run dev",
      cwd: "./frontend",
      port: FRONTEND_PORT,
      reuseExistingServer: !process.env.CI,
      timeout: process.env.CI ? 30_000 : 180_000,
      stdout: "ignore",
      stderr: "pipe",
      // Inject TEST_ENV so the frontend's NEXT_PUBLIC_SUPABASE_* point at the
      // test project instead of whatever is in frontend/.env.local.
      // Override PORT so Next.js binds to FRONTEND_PORT (3000), not the
      // backend's PORT (3001) from .env.test.
      env: { ...TEST_ENV, PORT: String(FRONTEND_PORT) },
    },
    {
      command: "npm run dev",
      cwd: "./backend",
      port: BACKEND_PORT,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      stdout: "ignore",
      stderr: "pipe",
      env: TEST_ENV,
    },
  ],
});
