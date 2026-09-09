import { expect, test, type Page } from "@playwright/test";

/**
 * The one place the "New project" wizard is driven from.
 *
 * The wizard has grown a step at a time — Details, then Access, then Add
 * Documents — and each time three specs had to be edited in lockstep.
 * Twice they were not: critical-path and chat-management still clicked a
 * single "Next" and then looked for controls that only exist on the final
 * step, so both failed in CI the moment the Access step landed. Creation now
 * lives here, so a fourth step is a one-file change and cannot be missed.
 *
 * Steps, and the controls that identify each:
 *
 *   Details          — "Project name" input, primary "Next"
 *   Access           — Back / Skip / "Next"  (breadcrumb "Access", or
 *                      "Organisational Access" outside the personal
 *                      workspace; the substring locator matches both)
 *   Add Documents    — secondary "Upload" (label gains "(n)" once files are
 *                      attached) and the primary "Create project", which is
 *                      a type="button", NOT a form submit.
 *
 * Pass `filePath` to also attach a document on the final step.
 */
export async function createProject(
    page: Page,
    projectName: string,
    filePath?: string,
): Promise<void> {
    /* Creation is a navigation + a three-step wizard + (optionally) a file
       upload; the per-test `{ timeout }` option passed to test() is silently
       ignored by Playwright (that object only accepts tag/annotation), so
       raise the budget here, where the slow work happens.

       Only ever raise it: callers such as critical-path already set a larger
       budget for a flow that continues into a live LLM turn, and lowering it
       here would cut that flow short. `timeout: 0` means "no timeout" and is
       left alone. */
    const budget = filePath ? 90_000 : 60_000;
    /* `test.info()` throws outside a running test — a fixture, a global
       setup, or any helper reused from a plain script — and this helper's
       whole point is being callable from anywhere. A missing timeout budget
       is not worth taking the caller down for. */
    try {
        const current = test.info().timeout;
        if (current !== 0 && current < budget) test.setTimeout(budget);
    } catch {
        // Not inside a test: the caller owns its own timeout.
    }

    await page.goto("/projects");
    await expect(page).toHaveURL(/\/projects/, { timeout: 10_000 });

    /* The Plus icon button in the header has aria-label="New project" */
    const createBtn = page.getByRole("button", { name: "New project" });
    await expect(createBtn).toBeVisible({ timeout: 10_000 });
    await createBtn.click();

    const nameInput = page.getByPlaceholder("Project name");
    await expect(nameInput).toBeVisible({ timeout: 5_000 });
    await nameInput.fill(projectName);

    /* Details → Access */
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Access" })).toBeVisible();

    /* Access → Add Documents. "Next" keeps whatever the step defaulted to;
       "Skip" would clear it. Nothing is entered here, so either works and
       "Next" is the primary. */
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await expect(
        page.getByRole("dialog", { name: "Add Documents" }),
    ).toBeVisible();

    if (filePath) {
        /* On the documents step the footer "Upload" button opens a hidden
           file input, and its label gains a "(n)" count once files are
           attached. */
        const fileChooserPromise = page.waitForEvent("filechooser");
        await page.getByRole("button", { name: /^Upload/ }).click();
        (await fileChooserPromise).setFiles(filePath);
        await expect(
            page.getByRole("button", { name: /^Upload \(1\)/ }),
        ).toBeVisible({ timeout: 5_000 });
    }

    /* Create — NewProjectModal's onCreated calls router.push(`/projects/${id}`).
       Any attached upload runs (awaited) inside that handler before onCreated
       fires, so allow extra time for the navigation when a file is attached.

       (The modal's FileDirectory used to fan out a getProject() request per
       existing project on open, which could overwhelm the local Supabase
       gateway and required settle-waits plus a submit-retry loop here. The
       directory now loads via one batched listProjects?include=documents
       request, so a single submit is reliable.)

       The documents step's primary action is a button whose label flips to
       "Creating…" while in flight. */
    const navTimeout = filePath ? 30_000 : 15_000;
    await page.getByRole("button", { name: "Create project" }).click();
    await page.waitForURL(/\/projects\/.+/, { timeout: navTimeout });
}
