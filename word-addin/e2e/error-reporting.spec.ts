/**
 * Error reporting from inside the task pane. The e2e bundle is built with a
 * DSN pointing at a host that does not exist (see build:e2e); Playwright
 * intercepts the SDK's envelope POST, so these tests read exactly what Sentry
 * would receive — and prove no request body, cookie, or email is in it.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "./support/fixtures";

const ENVELOPE_GLOB = "**/api/1/envelope/**";

type Envelope = { header: Record<string, unknown>; items: unknown[] };

function parseEnvelope(raw: string): Envelope {
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  const [header, ...rest] = lines.map((line) => JSON.parse(line) as unknown);
  return { header: header as Record<string, unknown>, items: rest };
}

/** Collect every event payload the SDK posts, resolving when one matches. */
function captureEvents(page: Page) {
  const events: Record<string, unknown>[] = [];
  const bodies: string[] = [];
  const waiters: ((event: Record<string, unknown>) => void)[] = [];
  const routePromise = page.route(ENVELOPE_GLOB, (route, request) => {
    const body = request.postData() ?? "";
    bodies.push(body);
    const { items } = parseEnvelope(body);
    for (let i = 0; i + 1 < items.length; i += 2) {
      const itemHeader = items[i] as { type?: string };
      if (itemHeader.type === "event") {
        const event = items[i + 1] as Record<string, unknown>;
        events.push(event);
        for (const waiter of waiters.splice(0)) waiter(event);
      }
    }
    return route.fulfill({ status: 200, body: "{}" });
  });
  return {
    ready: routePromise,
    events,
    bodies,
    next(): Promise<Record<string, unknown>> {
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}

function tagsOf(event: Record<string, unknown>): Record<string, unknown> {
  return (event.tags ?? {}) as Record<string, unknown>;
}

test("a backend 5xx is reported with the route, status, and request id but no body", async ({
  addin,
  page,
}) => {
  const sentry = captureEvents(page);
  await sentry.ready;
  addin.seedToken("seeded-jwt");
  await page.route("**/workflows**", (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      headers: { "x-request-id": "req-e2e-500" },
      body: JSON.stringify({
        code: "internal_error",
        detail: "Something went wrong. Please try again.",
        request_id: "req-e2e-500",
      }),
    }),
  );
  await addin.gotoTaskpane();
  await addin.expectAuthedShell();

  const nextEvent = sentry.next();
  await page.getByRole("button", { name: "Open menu" }).click();
  await page.getByRole("menuitem", { name: "Workflows" }).click();

  const event = await nextEvent;
  expect(event.message).toMatch(/^API 500 on GET \/workflows/);
  expect(event.level).toBe("error");
  expect(tagsOf(event)).toMatchObject({
    service: "mike-word-addin",
    surface: "taskpane",
    component: "mike-api",
    // Tag values keep their JS type in the envelope; Sentry stringifies on
    // ingest.
    http_status: 500,
    request_id: "req-e2e-500",
    error_code: "internal_error",
  });
  // Signed in: the id travels, the email never does.
  expect(event.user).toEqual({ id: expect.any(String) });
  expect(JSON.stringify(event)).not.toContain("e2e@mike.local");
  expect(event).not.toHaveProperty("request.data");
  expect(event).not.toHaveProperty("request.cookies");
});

test("a transport failure is reported as a warning grouped by endpoint", async ({
  addin,
  page,
}) => {
  const sentry = captureEvents(page);
  await sentry.ready;
  addin.seedToken("seeded-jwt");
  await page.route("**/workflows**", (route) => route.abort("failed"));
  await addin.gotoTaskpane();
  await addin.expectAuthedShell();

  const nextEvent = sentry.next();
  await page.getByRole("button", { name: "Open menu" }).click();
  await page.getByRole("menuitem", { name: "Workflows" }).click();

  const event = await nextEvent;
  expect(event.level).toBe("warning");
  expect(tagsOf(event)).toMatchObject({
    component: "mike-api",
    network: true,
    http_method: "GET",
  });
  expect(String(tagsOf(event).http_route)).toContain("/workflows");
  const exception = (event.exception as { values: { type: string }[] }).values[0]!;
  expect(exception.type).toMatch(/TypeError|Error/);
});

test("a rejected 4xx is shown to the user and NOT reported", async ({
  addin,
  page,
}) => {
  const sentry = captureEvents(page);
  await sentry.ready;
  await addin.mockLogin({ error: "Invalid login credentials", status: 400 });
  await addin.gotoTaskpane();

  await page.getByRole("textbox", { name: "Email" }).fill("lawyer@firm.com");
  await page.getByRole("textbox", { name: "Password" }).fill("wrong");
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByRole("alert")).toContainText("Invalid login credentials");

  // Give a would-be envelope time to leave; none should.
  await page.waitForTimeout(500);
  expect(sentry.events).toHaveLength(0);
});

test("a mid-stream chat failure is reported once, tagged as word-chat", async ({
  addin,
  page,
}) => {
  const sentry = captureEvents(page);
  await sentry.ready;
  addin.seedToken("seeded-jwt");
  await addin.gotoTaskpane({ documentText: "Clause 1. The parties agree." });
  await addin.expectAuthedShell();
  await addin.mockChatStream(["partial answer"], {
    errorBefore: "Model provider exploded",
  });

  const nextEvent = sentry.next();
  await page.getByPlaceholder("How can I help?").fill("Summarise this");
  await page.getByRole("button", { name: "Send" }).click();

  const event = await nextEvent;
  expect(tagsOf(event)).toMatchObject({ component: "word-chat" });
  const exception = (event.exception as { values: { value: string }[] }).values[0]!;
  expect(exception.value).toContain("Model provider exploded");
  // The console.error that accompanies the failure is bridged into Sentry
  // too, but recognised as the same error and dropped: exactly one event.
  await page.waitForTimeout(500);
  const chatEvents = sentry.events.filter(
    (candidate) => tagsOf(candidate).component === "word-chat",
  );
  expect(chatEvents).toHaveLength(1);
});
