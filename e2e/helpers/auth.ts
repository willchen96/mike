import type { Page } from "@playwright/test";
import { DEFAULT_TEST_PASSWORD, uniqueTestEmail } from "./test-users";

export interface TestUser {
  email: string;
  password: string;
  name: string;
}

/**
 * Signs up a fresh user via the /signup form and waits for the post-signup
 * redirect to /assistant.  Returns the credentials so tests can re-use
 * them for log-in / log-out flows.
 *
 * Tests that need an authenticated session before exercising a feature
 * (projects, documents, chat, tabular) should call this in a beforeEach.
 */
export async function signUpNewUser(page: Page, prefix = "user"): Promise<TestUser> {
  const user: TestUser = {
    email: uniqueTestEmail(prefix),
    password: DEFAULT_TEST_PASSWORD,
    name: `Test ${prefix}`,
  };

  await page.goto("/signup");
  await page.locator("#name").fill(user.name);
  await page.locator("#email").fill(user.email);
  await page.locator("#password").fill(user.password);
  await page.locator("#confirmPassword").fill(user.password);
  await page.getByRole("button", { name: /sign up/i }).click();

  // Signup shows a success message for ~2s then redirects to /assistant
  await page.waitForURL(/\/assistant/, { timeout: 15_000 });
  return user;
}

export async function logInExistingUser(page: Page, user: Pick<TestUser, "email" | "password">): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(user.email);
  await page.locator("#password").fill(user.password);
  await page.getByRole("button", { name: /log in/i }).click();
  await page.waitForURL(/\/assistant/, { timeout: 15_000 });
}

export async function logOut(page: Page): Promise<void> {
  await page.goto("/account");
  await page.getByRole("button", { name: /sign out/i }).click();
  await page.waitForURL(/^https?:\/\/[^/]+\/?$/, { timeout: 10_000 });
}
