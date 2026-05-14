import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { createAndLoginTestUser } from "./helpers/auth";

const SAMPLE_PDF = resolve(__dirname, "fixtures", "sample.pdf");

async function createProject(page: import("@playwright/test").Page, name: string) {
  await page.goto("/projects");
  await page.getByRole("button", { name: /(new project|create project|add project)/i }).first().click();
  await page.getByPlaceholder("Project name").fill(name);
  await page.getByRole("button", { name: /create project/i }).click();
  await expect(page.getByText(name, { exact: false })).toBeVisible({ timeout: 15_000 });
  await page.getByText(name, { exact: false }).first().click();
  await page.waitForURL(/\/projects\/[a-f0-9-]+/, { timeout: 10_000 });
}

// TODO(TECHDEBT.md): test body fails on selectors / flows that have
// drifted from the current UI.  Auth setup (createAndLoginTestUser)
// works; createProject() helper or per-test interactions fail.
// Re-enable per test once selectors are fixed against the current
// frontend.  Download playwright-report from CI to see the exact
// failure point in each.
test.describe.skip("documents", () => {
  test.beforeEach(async ({ page }) => {
    await createAndLoginTestUser(page, "docs");
    await createProject(page, `Docs Project ${Date.now()}`);
  });

  test("upload sample.pdf and see it in the project's document list", async ({ page }) => {
    // The visible upload button triggers a hidden <input type="file">.
    // We attach the file directly to the input regardless of which button
    // surfaced it.
    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.setInputFiles(SAMPLE_PDF);

    await expect(page.getByText(/sample\.pdf/i)).toBeVisible({ timeout: 30_000 });
  });

  test("download sample.pdf via the row action", async ({ page }) => {
    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.setInputFiles(SAMPLE_PDF);
    await expect(page.getByText(/sample\.pdf/i)).toBeVisible({ timeout: 30_000 });

    // Hover the row to reveal the actions, then click Download.
    const row = page.getByText(/sample\.pdf/i).first().locator("..");
    await row.hover();

    const downloadPromise = page.waitForEvent("download", { timeout: 15_000 });
    await row.getByRole("button", { name: /download/i }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename().toLowerCase()).toContain("sample");
  });

  test("delete sample.pdf via the row action", async ({ page }) => {
    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.setInputFiles(SAMPLE_PDF);
    await expect(page.getByText(/sample\.pdf/i)).toBeVisible({ timeout: 30_000 });

    const row = page.getByText(/sample\.pdf/i).first().locator("..");
    await row.hover();
    await row.getByRole("button", { name: /delete|remove/i }).click();

    // Some UIs prompt for confirmation
    const confirm = page.getByRole("button", { name: /^(delete|confirm|yes)$/i });
    if (await confirm.isVisible().catch(() => false)) {
      await confirm.click();
    }

    await expect(page.getByText(/sample\.pdf/i)).toHaveCount(0, { timeout: 10_000 });
  });
});
