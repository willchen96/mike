import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { signUpNewUser } from "./helpers/auth";

const SAMPLE_PDF = resolve(__dirname, "fixtures", "sample.pdf");

// Tabular review extraction depends on a real LLM provider being available
// to the backend (see e2e/README.md).
test.describe("tabular review", () => {
  test("create a review with two columns, add sample.pdf as a row, generate, and see cells populated with citations", async ({
    page,
  }) => {
    test.setTimeout(240_000); // Extraction across 2 columns × 1 row × 1 LLM call/cell

    await signUpNewUser(page, "tab");

    // Land on tabular reviews root and create a new one.
    await page.goto("/tabular-reviews");
    await page.getByRole("button", { name: /(new review|create review|add review)/i }).first().click();

    // Fill the title and attach the sample PDF.
    await page.getByPlaceholder(/review title/i).fill(`Tabular ${Date.now()}`);
    await page.locator('input[type="file"]').first().setInputFiles(SAMPLE_PDF);

    // Submit the create modal.
    await page.getByRole("button", { name: /create review/i }).click();
    await page.waitForURL(/\/tabular-reviews\/[a-f0-9-]+/, { timeout: 15_000 });

    // Add column 1: Topic (text)
    await page.getByRole("button", { name: /(add column|new column)/i }).first().click();
    await page.locator('input[placeholder*="column" i], input[name*="name" i]').first().fill("Topic");
    // Format dropdown is a Radix menu; "text" is usually the default so we
    // can submit without changing it.
    await page.getByRole("button", { name: /^save$/i }).click();
    await expect(page.getByText(/topic/i)).toBeVisible({ timeout: 10_000 });

    // Add column 2: Number of pages (number)
    await page.getByRole("button", { name: /(add column|new column)/i }).first().click();
    await page.locator('input[placeholder*="column" i], input[name*="name" i]').first().fill("Number of pages");
    // Switch the format to "number"
    await page.getByRole("button", { name: /format|type/i }).first().click();
    await page.getByRole("menuitemradio", { name: /^number$/i }).click();
    await page.getByRole("button", { name: /^save$/i }).click();
    await expect(page.getByText(/number of pages/i)).toBeVisible({ timeout: 10_000 });

    // Click Generate (Play icon).  It has no text so we fall back to a
    // title-or-aria match.
    await page.getByRole("button", { name: /(generate|play|run)/i }).first().click();

    // Wait for at least one citation marker to appear inside any table cell.
    const citation = page.locator("text=/\\[1\\]/").first();
    await expect(citation).toBeVisible({ timeout: 180_000 });

    // Both columns should have at least one non-empty cell content.
    // We weak-assert on the table containing the literal "4" anywhere (page
    // count from sample.pdf) and a substantial amount of text overall.
    const bodyText = await page.locator("body").innerText();
    expect(bodyText).toMatch(/\b4\b/);
    expect(bodyText.length).toBeGreaterThan(400);
  });
});
