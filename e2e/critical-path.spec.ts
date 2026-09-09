/**
 * Critical path E2E tests:
 *   1. Authenticated landing — /assistant loads correctly
 *   2. Projects — create a project, upload a PDF, open the project assistant,
 *      send a message and verify a response begins streaming
 *
 * Prerequisite: auth.setup.ts has already saved the session to e2e/.auth/user.json
 */
import { test, expect, type Page } from "@playwright/test";
import { hasLlmKey, LLM_SKIP_REASON } from "./llm";
import { createProject } from "./projects";
import path from "path";

const PDF_FIXTURE = path.join(__dirname, "fixtures/test.pdf");

/**
 * Select a Claude model in the chat input's ModelToggle.
 *
 * This spec runs only when ANTHROPIC_API_KEY is set in the Playwright
 * environment (test.skip(!hasLlmKey, ...) — e2e/llm.ts). The CI stack exports
 * the same secret to the backend, whose key resolution (userApiKeys.ts
 * envApiKey()) falls back to the ANTHROPIC_API_KEY env var, so the "claude"
 * provider reports as configured and ModelToggle shows the Anthropic models as
 * available. The default model (Gemini) has no key configured in CI, so a
 * submit with it would be blocked by the ApiKeyMissingModal. We pick
 * "Claude Sonnet 4.6" (the cheapest Anthropic entry in ModelToggle.MODELS) so
 * the request streams a real response. The Radix DropdownMenu trigger's title
 * is "Choose model" (current model available) or "API key missing for selected
 * model" (default-Gemini case).
 */
const CLAUDE_MODEL_LABEL = "Claude Sonnet 4.6";

async function selectClaudeModel(page: Page) {
    const trigger = page
        .locator(
            'button[title="Choose model"], button[title="API key missing for selected model"]',
        )
        .first();
    await expect(trigger).toBeVisible({ timeout: 10_000 });
    await trigger.click();
    await page.getByRole("menuitem", { name: CLAUDE_MODEL_LABEL }).click();
    // After selection the trigger label reflects the chosen model.
    await expect(
        page.getByRole("button", { name: CLAUDE_MODEL_LABEL }),
    ).toBeVisible({ timeout: 5_000 });
}

/* ─── Test 1: authenticated landing ─────────────────────────────────────── */

test("authenticated user lands on the assistant page", async ({ page }) => {
    await page.goto("/assistant");
    await expect(page).toHaveURL(/\/assistant/);
    /* The InitialView renders a greeting heading */
    await expect(page.locator("h1, h2").first()).toBeVisible({ timeout: 10_000 });
});

/* ─── Test 2: create project → upload PDF → chat ─────────────────────────── */

test("create project, upload PDF, ask a question and receive a response", async ({
    page,
}) => {
    test.skip(!hasLlmKey, LLM_SKIP_REASON);
    /* This end-to-end flow (create + upload + navigate + chat) needs more than
       the 30s default. The per-test `{ timeout }` option that test() accepts is
       silently ignored by Playwright (that object only takes tag/annotation),
       so set it here. */
    test.setTimeout(120_000);

    /* ── Steps 1-5: create a project with the PDF attached ────────────────── */
    /* The wizard (Details → Access → Add Documents) is driven from one shared
       helper, e2e/projects.ts, so a new step cannot be added to the modal
       without this spec picking it up. This spec used to walk the modal
       itself, clicking a single "Next" and then a `button[type="submit"]`;
       the Access step stranded it on step two and the final primary is a
       type="button", so both halves were wrong. */
    const projectName = `E2E Test Project ${Date.now()}`;
    await createProject(page, projectName, PDF_FIXTURE);
    await expect(page).toHaveURL(/\/projects\/[^/]+$/);

    /* ── Step 6: open the project assistant ───────────────────────────────── */
    /* We're already on /projects/[id] (Documents tab by default). The project
       assistant is now a nested route, /projects/[id]/assistant. Navigate there
       directly rather than clicking through the tab bar to avoid ambiguity with
       the "Assistant" item in the sidebar nav. (The olp UI replaced the old
       "+ Create New" text link with a PillButton reading "Create" —
       ProjectAssistantTable empty state.) */
    const projectUrl = page.url().split("?")[0];
    const createNew = page.getByRole("button", { name: "Create", exact: true });
    await page.goto(`${projectUrl}/assistant`);

    /* The assistant tab shows a chat list. Click "Create" to open the chat
       interface where the text input appears. */
    await expect(createNew).toBeVisible({ timeout: 20_000 });
    await createNew.click();
    /* Navigates to /projects/{id}/assistant (new chat UI) */
    await page.waitForURL(/\/projects\/.+\/assistant/, { timeout: 10_000 });
    await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});

    /* ── Step 7: select a Claude model, type a question, submit ───────────── */
    const chatInput = page.getByPlaceholder("How can I help?");
    await expect(chatInput).toBeVisible({ timeout: 10_000 });

    /* The default Gemini model has no key configured, so submitting it would be
       blocked by the ApiKeyMissingModal. Select a Claude model (backed by the
       ANTHROPIC_API_KEY the backend reads from its environment) so the request
       actually streams a response. */
    await selectClaudeModel(page);
    await chatInput.fill("What is this document about?");
    /* This ChatInput submits on Enter (Shift+Enter inserts a newline). */
    await chatInput.press("Enter");

    /* ── Step 8: verify the assistant streams a response ─────────────────── */
    /* With a real Claude model the reply content is nondeterministic, so assert
       presence + nonempty rather than matching text. The assistant's answer
       renders through MarkdownContent (message/MarkdownContent.tsx), whose
       wrapper div carries "text-gray-900 … prose … font-serif" — a combination
       unique to assistant answer content on this page (user messages render a
       plain <p>, and the gray pre-response EventBlocks prose uses
       text-gray-400). Its appearance with nonempty text proves the message was
       sent, streamed, and rendered end-to-end.

       The reply is preceded by a POST that persists the chat, a client-side
       route change to /assistant/chat/<id>, and a real LLM round-trip; under
       local-Supabase load that can outlast a 30s budget, so allow the same
       headroom the rest of this flow gets. */
    const assistantAnswer = page
        .locator("div.prose.font-serif.text-gray-900")
        .first();
    await expect(assistantAnswer).toBeVisible({ timeout: 60_000 });
    /* Nonempty streamed text (any non-whitespace character). */
    await expect(assistantAnswer).toContainText(/\S/);
});

/* ─── Test 3: login-page redirect for unauthenticated users ──────────────── */

/* describe-scoped test.use so only this test runs without a stored session.
   File-level test.use would wipe the storageState for all tests in this file. */
test.describe("unauthenticated", () => {
    test.use({ storageState: { cookies: [], origins: [] } });

    test("unauthenticated request to /assistant redirects to login", async ({
        page,
    }) => {
        await page.goto("/assistant");
        /* Auth check is client-side (Supabase getSession) — allow time for the
           async check to resolve and for Next.js router.push to fire. */
        await expect(page).toHaveURL(/\/login/, { timeout: 15_000 });
    });
});
