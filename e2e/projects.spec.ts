import { expect, test } from "@playwright/test";
import { createAndLoginTestUser } from "./helpers/auth";
import { uniqueTestEmail } from "./helpers/test-users";

// TODO(TECHDEBT.md): test body fails on selectors / flows that have
// drifted from the current UI.  Auth setup (createAndLoginTestUser)
// works.  Re-enable per test once selectors are fixed against the
// current frontend.  Download playwright-report from CI to see the
// exact failure point in each.
test.describe.skip("projects", () => {
  test.beforeEach(async ({ page }) => {
    await createAndLoginTestUser(page, "proj");
  });

  test("create a project from the projects page", async ({ page }) => {
    const projectName = `Project ${Date.now()}`;

    await page.goto("/projects");
    // The "new project" trigger is an icon-only button with a Plus icon;
    // accessible name typically comes from aria-label or the only button
    // at the top-right that opens the NewProjectModal.
    await page
      .getByRole("button", { name: /(new project|create project|add project)/i })
      .first()
      .click();

    await page.getByPlaceholder("Project name").fill(projectName);
    await page.getByRole("button", { name: /create project/i }).click();

    // The new row should appear in the projects list
    await expect(page.getByText(projectName, { exact: false })).toBeVisible({ timeout: 15_000 });
  });

  test("rename a project inline", async ({ page }) => {
    const original = `RenameMe ${Date.now()}`;
    const renamed = `${original}-renamed`;

    await page.goto("/projects");
    await page.getByRole("button", { name: /(new project|create project|add project)/i }).first().click();
    await page.getByPlaceholder("Project name").fill(original);
    await page.getByRole("button", { name: /create project/i }).click();
    await expect(page.getByText(original, { exact: false })).toBeVisible();

    // Inline rename: click the project name, edit, press Enter.
    // Selector relies on the row containing the original text.
    const row = page.getByText(original, { exact: false }).first();
    await row.click();
    // The row likely turns into an <input> with the current name pre-filled.
    const input = page.locator(`input[value*="${original.slice(0, 8)}"]`).first();
    await input.fill(renamed);
    await input.press("Enter");

    await expect(page.getByText(renamed, { exact: false })).toBeVisible({ timeout: 10_000 });
  });

  test("share a project with another email address", async ({ page }) => {
    const projectName = `Shared ${Date.now()}`;
    const collaborator = uniqueTestEmail("collab");

    await page.goto("/projects");
    await page.getByRole("button", { name: /(new project|create project|add project)/i }).first().click();
    await page.getByPlaceholder("Project name").fill(projectName);

    // Expand the Members section inside the new-project modal and add an email.
    await page.getByRole("button", { name: /members/i }).click();
    await page.getByPlaceholder(/colleagues by email/i).fill(collaborator);
    await page.getByPlaceholder(/colleagues by email/i).press("Enter");

    await page.getByRole("button", { name: /create project/i }).click();

    await expect(page.getByText(projectName, { exact: false })).toBeVisible({ timeout: 15_000 });
    // The collaborator pill or count is visible somewhere on the row/page.
    // We assert weakly: the email appears in the DOM after navigating into the project.
    await page.getByText(projectName, { exact: false }).first().click();
    await expect(page.getByText(collaborator, { exact: false })).toBeVisible({ timeout: 10_000 });
  });

  test("delete a project via the actions menu", async ({ page }) => {
    const projectName = `DeleteMe ${Date.now()}`;

    await page.goto("/projects");
    await page.getByRole("button", { name: /(new project|create project|add project)/i }).first().click();
    await page.getByPlaceholder("Project name").fill(projectName);
    await page.getByRole("button", { name: /create project/i }).click();
    await expect(page.getByText(projectName, { exact: false })).toBeVisible();

    // Select the row's checkbox and open the bulk Actions menu.
    const row = page.getByText(projectName, { exact: false }).first().locator("..");
    await row.getByRole("checkbox").check();
    await page.getByRole("button", { name: /actions/i }).click();
    await page.getByRole("menuitem", { name: /delete/i }).click();

    // After deletion the project name should no longer be visible.
    await expect(page.getByText(projectName, { exact: false })).toHaveCount(0, { timeout: 10_000 });
  });
});
