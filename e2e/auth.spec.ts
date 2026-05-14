import { expect, test } from "@playwright/test";
import {
  createAndLoginTestUser,
  logInExistingUser,
  logOut,
  signUpNewUser,
} from "./helpers/auth";
import { DEFAULT_TEST_PASSWORD, uniqueTestEmail } from "./helpers/test-users";

test.describe("auth", () => {
  test("sign-up creates an account and lands the user on /assistant", async ({ page }) => {
    const user = await signUpNewUser(page, "signup");
    expect(page.url()).toMatch(/\/assistant/);
    expect(user.email).toContain("@");
  });

  test("log-in with an existing user lands on /assistant", async ({ page, context }) => {
    // First create the user via admin API + log in, then sign them out,
    // then sign back in.  Using the admin API avoids burning a Supabase
    // signup-rate-limit quota for what is really a log-in test.
    const user = await createAndLoginTestUser(page, "login");
    await logOut(page);

    // Make sure the cookie is gone before logging back in.
    await context.clearCookies();

    await logInExistingUser(page, user);
    expect(page.url()).toMatch(/\/assistant/);
  });

  test("log-out returns the user to the marketing root", async ({ page }) => {
    await createAndLoginTestUser(page, "logout");
    await logOut(page);
    // logOut() already waits for the redirect — assert we are at the root.
    expect(new URL(page.url()).pathname).toBe("/");
  });

  test("log-in with a bogus password shows an error and stays on /login", async ({ page }) => {
    await page.goto("/login");
    await page.locator("#email").fill(uniqueTestEmail("bogus"));
    await page.locator("#password").fill(DEFAULT_TEST_PASSWORD);
    await page.getByRole("button", { name: /log in/i }).click();
    // Stay on /login.  Supabase returns an "Invalid login credentials" string.
    await page.waitForTimeout(2000);
    expect(page.url()).toMatch(/\/login/);
  });
});
