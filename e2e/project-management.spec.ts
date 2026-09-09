/**
 * Project management E2E tests:
 *   1. Rename a project inline
 *   2. Delete a project
 *   3. Create a folder inside a project
 *   4. File upload type validation (wrong type rejected)
 *
 * Prerequisite: auth.setup.ts has already saved the session to e2e/.auth/user.json.
 * All tests run with the authenticated storageState configured in playwright.config.ts —
 * no test.use override is needed here.
 *
 * Each test creates its own uniquely-named project so tests are fully isolated.
 */
import { test, expect } from "@playwright/test";
import path from "path";
import { createProject } from "./projects";

const PDF_FIXTURE = path.join(__dirname, "fixtures/test.pdf");

/**
 * Navigate to the projects list and return the table row for `projectName`.
 * Rows are <div class="group">; the sidebar "Recent Projects" renders the same
 * name as a <button>, so scoping to div.group avoids a strict-mode double match.
 */
async function gotoProjectRow(
    page: import("@playwright/test").Page,
    projectName: string,
) {
    const row = page.locator("div.group").filter({ hasText: projectName });
    await page.goto("/projects");
    await expect(row.first()).toBeVisible({ timeout: 12_000 });
    return row;
}

/**
 * After creating a project we land on /projects/<id>, whose ProjectPage fetches
 * getProject() once on mount. Wait until `anchor` — a control that only renders
 * once the project has loaded — becomes visible.
 */
async function waitForProjectLoaded(
    page: import("@playwright/test").Page,
    anchor: import("@playwright/test").Locator,
) {
    await expect(anchor).toBeVisible({ timeout: 15_000 });
}

// ─── Test 1: Rename a project inline ─────────────────────────────────────────

test("rename a project via Edit details", async ({ page }) => {
    const projectName = `E2E Proj ${Date.now()}`;
    await createProject(page, projectName);

    /* Navigate to the projects list (where the rename UI lives) and grab the
       row. Each project row is a <div class="group">. The sidebar "Recent
       Projects" list renders the same name as a <button> (not div.group), so
       scoping to div.group keeps the lookup to the table row. */
    const row = await gotoProjectRow(page, projectName);

    /* The ··· button (middle-dot U+00B7 × 3) is inside the last cell of the row */
    const ellipsisBtn = row.locator("button").filter({ hasText: "···" });
    await ellipsisBtn.click();

    /*
     * The row menu (RowActions) offers "Edit details" and "Delete" — the old
     * inline "Rename" affordance is gone; renaming now happens in
     * ProjectDetailsModal, which also carries the CM number and practice fields.
     */
    await page.getByRole("button", { name: "Edit details", exact: true }).click();

    /* ProjectDetailsModal's name field is pre-filled with the current name;
       fill() clears it first, platform-independently. */
    const newName = `E2E Proj Renamed ${Date.now()}`;
    const renameInput = page.locator("#project-details-name");
    await expect(renameInput).toBeVisible({ timeout: 10_000 });
    await renameInput.fill(newName);

    // REGRESSION: fails if ProjectDetailsModal's onSave (updateProject) is removed
    await page.getByRole("button", { name: "Update", exact: true }).click();

    /* handleRenameSubmit optimistically updates the projects list state.
       Scope to table rows (div.group) so the sidebar's stale copy of the old
       name does not interfere with the negative assertion below. */
    // REGRESSION: fails if rename input or submit handler is removed
    await expect(
        page.locator("div.group").filter({ hasText: newName }),
    ).toBeVisible({ timeout: 5_000 });
    await expect(
        page.locator("div.group").filter({ hasText: projectName }),
    ).toHaveCount(0);
});

// ─── Test 2: Delete a project ─────────────────────────────────────────────────

test("delete a project", async ({ page }) => {
    const projectName = `E2E Proj ${Date.now()}`;
    await createProject(page, projectName);

    /*
     * Back to the projects list.
     * Rows are scoped to div.group — the sidebar "Recent Projects" list also
     * shows the name as a <button>, so an unscoped getByText would match two
     * elements.
     *
     * The row checkbox is wrapped in a div with onClick={e.stopPropagation()}
     * to prevent accidental row navigation. Clicking the checkbox alone is safe.
     */
    const row = await gotoProjectRow(page, projectName);
    const checkbox = row.locator('input[type="checkbox"]');
    await checkbox.click();

    /*
     * The "Actions" button is conditionally rendered only when selectedIds.length > 0.
     * It opens a small dropdown containing a "Delete" option.
     */
    /* Exact name, not a /^Actions/ prefix: the sidebar's chat rows carry
       "Actions for <title>" buttons, so the prefix matched more than one
       element and Playwright's strict mode failed the click outright. The
       toolbar's own button is named exactly "Actions". */
    const actionsBtn = page.getByRole("button", { name: "Actions", exact: true });
    await expect(actionsBtn).toBeVisible({ timeout: 3_000 });
    await actionsBtn.click();

    /* exact:true so the substring match can't pick up any other button whose
       accessible name merely contains "Delete". */
    const deleteBtn = page.getByRole("button", { name: "Delete", exact: true });
    await expect(deleteBtn).toBeVisible({ timeout: 3_000 });

    // REGRESSION: fails if `handleDeleteSelected` is removed
    await deleteBtn.click();

    /* handleDeleteSelected removes the project from local state immediately.
       Scope to table rows so a stale sidebar entry can't keep this truthy. */
    await expect(
        page.locator("div.group").filter({ hasText: projectName }),
    ).toHaveCount(0, { timeout: 10_000 });
});

// ─── Test 3: Create a folder inside a project ────────────────────────────────

test("create a folder inside a project", async ({ page }) => {
    const projectName = `E2E Proj ${Date.now()}`;
    /* Folder creation must work before the project has any documents. */
    await createProject(page, projectName);

    /*
     * After createProject we are on the new project page (Documents tab). The
     * documents toolbar (which hosts the folder-create button) only appears
     * once the project has loaded.
     */
    /* The olp UI renamed the documents-toolbar folder-create button from
       "Add Subfolder" to "Folder" (a TabPillButton wired to the root
       createFolderAction — ProjectDocumentsView). Clicking it still renders the
       autofocused "Folder name" input at root level (creatingIn === null). */
    const addSubfolderBtn = page.getByRole("button", {
        name: "Folder",
        exact: true,
    });
    await waitForProjectLoaded(page, addSubfolderBtn);

    /* Clicking "Add Subfolder" sets creatingFolderIn = null (root level). */
    await addSubfolderBtn.click();

    /*
     * renderFolderInput renders an <input> with placeholder "Folder name"
     * that is autoFocused. Pressing Enter calls handleCreateFolder(null)
     * which creates a folder at the root level.
     */
    const folderInput = page.getByPlaceholder("Folder name");
    await expect(folderInput).toBeVisible({ timeout: 3_000 });

    const folderName = `Test Folder ${Date.now()}`;
    await folderInput.fill(folderName);
    await folderInput.press("Enter");

    /*
     * handleCreateFolder optimistically inserts the folder into local state,
     * then replaces the temp entry with the real folder from the API.
     */
    // REGRESSION: fails if folder creation button or API call is removed
    await expect(page.getByText(folderName)).toBeVisible({ timeout: 10_000 });

    const folderRow = page.locator("div.group").filter({
        hasText: folderName,
    });
    await expect(folderRow.locator('input[type="checkbox"]')).toBeVisible();
    await expect(
        folderRow.locator(
            "svg.lucide-chevron-right, svg.lucide-chevron-down",
        ),
    ).toBeVisible();
});

// ─── Test 4: File upload type validation (wrong type rejected) ────────────────

test("file upload type validation — .txt file is rejected", async ({ page }) => {
    const projectName = `E2E Proj ${Date.now()}`;
    await createProject(page, projectName);

    /*
     * After createProject we are on the project's Documents tab.
     * The "Add Documents" button opens AddDocumentsModal which has a
     * hidden file input with accept=".pdf,.docx,.doc".
     *
     * Validation is now two layers, and this test covers both:
     *   (a) UI: AddDocumentsModal filters unsupported files client-side
     *       (partitionSupportedDocumentFiles) and shows a visible warning —
     *       no request is sent, so we assert the warning + absence of the file.
     *   (b) Server: the upload-session endpoint must still 400 unsupported
     *       extensions (defense in depth for API/SDK callers that bypass the
     *       web UI). The retired multipart endpoint is checked separately for
     *       its intentional 410 response.
     */

    /* The project header now exposes document actions from an Upload menu.
       Its icon-only trigger contains the upload SVG, unlike the empty-state
       Upload button, which keeps this selector unambiguous. */
    const uploadMenuBtn = page
        .getByRole("button", { name: "Upload", exact: true })
        .filter({ has: page.locator("svg.lucide-upload") })
        .first();
    await waitForProjectLoaded(page, uploadMenuBtn);

    /* (b) Server-side rejection on the active protocol — REGRESSION: fails if
       type validation is removed from upload-session manifest parsing. */
    const projectId = page.url().match(/\/projects\/([0-9a-f-]{36})/)?.[1];
    expect(projectId, "expected to be on a /projects/<id> page").toBeTruthy();
    const uploadResponses = await page.evaluate(async (id) => {
        const sessionResponse = await fetch("/api/upload-sessions", {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                purpose: "document_create",
                destination: {
                    scope: "project",
                    project_id: id,
                },
                files: [
                    {
                        client_id: "unsupported-text-file",
                        filename: "test.txt",
                        size_bytes: 52,
                    },
                ],
            }),
        });
        const sessionBody = await sessionResponse.json();

        const body = new FormData();
        body.append(
            "file",
            new Blob(
                ["This is a plain text file that should be rejected."],
                { type: "text/plain" },
            ),
            "test.txt",
        );
        const legacyResponse = await fetch(`/api/projects/${id}/documents`, {
            method: "POST",
            credentials: "include",
            body,
        });
        return {
            session: {
                status: sessionResponse.status,
                body: sessionBody,
            },
            legacy: {
                status: legacyResponse.status,
                body: await legacyResponse.json(),
            },
        };
    }, projectId);
    expect(uploadResponses.session.status).toBe(400);
    expect(uploadResponses.session.body).toMatchObject({
        code: "invalid_upload_session",
    });
    expect(uploadResponses.session.body.detail).toContain(
        "Unsupported file type: txt",
    );
    expect(uploadResponses.legacy).toEqual({
        status: 410,
        body: {
            code: "upload_session_required",
            detail: "This upload endpoint has been replaced by /upload-sessions.",
        },
    });

    /* (a) UI-side filtering with a visible warning. */
    await uploadMenuBtn.click();
    await page.getByRole("menuitem", { name: "Saved files" }).click();

    const fileChooserPromise = page.waitForEvent("filechooser");
    /* The Upload button label is "Upload" (not "Uploading…") when idle */
    await page
        .getByRole("dialog", { name: "Add Documents" })
        .getByRole("button", { name: "Upload" })
        .click();
    const fileChooser = await fileChooserPromise;

    /*
     * Playwright's setFiles accepts an in-memory file descriptor, bypassing
     * the browser's accept-attribute filter so the client-side partition
     * logic (not the accept attribute) is what's under test.
     */
    await fileChooser.setFiles({
        name: "test.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("This is a plain text file that should be rejected."),
    });

    // REGRESSION: fails if the visible unsupported-type warning is removed
    // (UNSUPPORTED_DOCUMENT_WARNING_MESSAGE in documentUploadValidation.ts).
    await expect(
        page.getByText(
            "Unsupported file type. Only PDF, Word, Excel, and PowerPoint files can be uploaded.",
        ),
    ).toBeVisible({ timeout: 10_000 });

    /* The .txt file must not appear in the modal's document list */
    await expect(page.getByText("test.txt")).not.toBeVisible();
});
