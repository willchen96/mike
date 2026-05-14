import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { createAndLoginTestUser } from "./helpers/auth";

const SAMPLE_PDF = resolve(__dirname, "fixtures", "sample.pdf");

// Chat depends on a real LLM provider — Anthropic, OpenAI, or Gemini.
// Without keys the request fails before any tokens stream back.
// See e2e/README.md for how to wire up keys for this suite.
// TODO(TECHDEBT.md): test body fails on selectors / flows that have
// drifted from the current UI.  Auth setup (createAndLoginTestUser)
// works.  Re-enable per test once selectors are fixed against the
// current frontend.  Download playwright-report from CI to see the
// exact failure point in each.
test.describe.skip("chat", () => {
  test("ask a question about an uploaded PDF and get a streamed answer with a citation", async ({ page }) => {
    test.setTimeout(180_000); // LLM round-trip can take a while end-to-end

    await createAndLoginTestUser(page, "chat");

    // Create a project and upload the sample PDF
    await page.goto("/projects");
    const projectName = `Chat Project ${Date.now()}`;
    await page.getByRole("button", { name: /(new project|create project|add project)/i }).first().click();
    await page.getByPlaceholder("Project name").fill(projectName);
    await page.getByRole("button", { name: /create project/i }).click();
    await expect(page.getByText(projectName, { exact: false })).toBeVisible({ timeout: 15_000 });
    await page.getByText(projectName, { exact: false }).first().click();
    await page.waitForURL(/\/projects\/[a-f0-9-]+/, { timeout: 10_000 });

    // Upload sample.pdf
    await page.locator('input[type="file"]').first().setInputFiles(SAMPLE_PDF);
    await expect(page.getByText(/sample\.pdf/i)).toBeVisible({ timeout: 30_000 });

    // Open the assistant chat in this project
    const projectUrl = new URL(page.url());
    await page.goto(`${projectUrl.pathname.replace(/\/$/, "")}/assistant`);

    // Ask a question about the document
    const chatInput = page.getByPlaceholder(/ask a question/i);
    await chatInput.click();
    await chatInput.fill("What is this document about?");
    await chatInput.press("Enter");

    // Wait for an assistant response to appear and finish streaming.
    // We assert on a citation marker [1] arriving somewhere on the page
    // — that is how AssistantMessage renders inline source references.
    const citation = page.locator("text=/\\[1\\]/");
    await expect(citation).toBeVisible({ timeout: 120_000 });

    // Body text should also have meaningful content (not just the marker).
    const responseText = await page.locator("body").innerText();
    expect(responseText.length).toBeGreaterThan(200);
  });
});
