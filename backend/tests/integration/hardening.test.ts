/**
 * Hardening integration tests — Phase 6 CLEAN-04, CLEAN-18, CLEAN-42, CLEAN-43
 *
 * Tests body limit (413), zod validation (400), and rate limiting (429).
 * Does NOT require a live Supabase instance — uses vi.doMock to inject userId.
 *
 * Run: npm run test:no-db
 */
import { describe, it, expect, vi } from "vitest";
import request from "supertest";

// Body limit and validation tests — no auth needed (rejected before auth middleware)
describe("CLEAN-18: 1mb body limit", () => {
  it("POST /chat with 2MB JSON body → 413", async () => {
    // Dynamic import AFTER env is set by vitest config
    const { app } = await import("../../src/app");

    // Generate a 2MB string payload
    const largeContent = "x".repeat(2 * 1024 * 1024); // 2 MB
    const body = JSON.stringify({ messages: [{ role: "user", content: largeContent }] });

    const res = await request(app)
      .post("/chat")
      .set("Content-Type", "application/json")
      .send(body);

    expect(res.status).toBe(413);
  });

  it("POST /chat with 500KB JSON body → does not reject at body parser", async () => {
    const { app } = await import("../../src/app");

    // 500KB body — should pass body parser (rejected later by auth, not body limit)
    const content = "x".repeat(500 * 1024); // 500 KB
    const body = JSON.stringify({ messages: [{ role: "user", content }] });

    const res = await request(app)
      .post("/chat")
      .set("Content-Type", "application/json")
      .send(body);

    // Should be 401 (auth failure) not 413 (body too large)
    expect(res.status).toBe(401);
    expect(res.status).not.toBe(413);
  });
});

describe("CLEAN-42: zod body validation", () => {
  it("POST /chat with missing messages field → 401 (auth runs first)", async () => {
    const { app } = await import("../../src/app");

    // Note: auth middleware (requireAuth) runs before parseBody in the chat route.
    // Unauthenticated request → 401 regardless of body validity.
    const res = await request(app)
      .post("/chat")
      .set("Content-Type", "application/json")
      .send({ wrong_field: "value" });

    expect(res.status).toBe(401);
  });

  it("POST /tabular-review with missing document_ids → 401 (auth first)", async () => {
    const { app } = await import("../../src/app");

    const res = await request(app)
      .post("/tabular-review")
      .set("Content-Type", "application/json")
      .send({ title: "test" }); // missing document_ids

    expect(res.status).toBe(401);
  });

  it("POST /workflows with missing title → 401 (auth first)", async () => {
    const { app } = await import("../../src/app");

    const res = await request(app)
      .post("/workflows")
      .set("Content-Type", "application/json")
      .send({ type: "assistant" }); // missing title

    expect(res.status).toBe(401);
  });
});

describe("CLEAN-42: authenticated parseBody returns 400 + fields", () => {
  it("POST /chat with mocked auth and empty body → 400 with fields", async () => {
    vi.resetModules();
    vi.doMock("../../src/middleware/auth", () => ({
      requireAuth: (_req: any, res: any, next: any) => {
        res.locals.userId = "test-user-clean42";
        res.locals.userEmail = "test-clean42@example.com";
        next();
      },
    }));

    const { app } = await import("../../src/app");

    const res = await request(app)
      .post("/chat")
      .set("Content-Type", "application/json")
      .send({}); // missing required messages field

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("fields");
    expect(typeof res.body.fields).toBe("object");

    vi.doUnmock("../../src/middleware/auth");
  });
});

describe("CLEAN-04: rate limiter actually returns 429", () => {
  it("llmRateLimiter is exported as middleware function", async () => {
    const { llmRateLimiter } = await import("../../src/lib/rateLimiter");
    expect(typeof llmRateLimiter).toBe("function");
    expect(llmRateLimiter.length).toBeGreaterThanOrEqual(2);
  });

  it("POST /chat without Authorization → 401, not 429", async () => {
    vi.resetModules();
    const { app } = await import("../../src/app");
    const res = await request(app)
      .post("/chat")
      .set("Content-Type", "application/json")
      .send({ messages: [{ role: "user", content: "test" }] });
    expect(res.status).toBe(401);
    expect(res.status).not.toBe(429);
  });

  it("RATE_LIMIT_MAX+1 authenticated requests → final request 429 with Retry-After", async () => {
    const RATE_LIMIT_MAX = 3;
    process.env.RATE_LIMIT_MAX = String(RATE_LIMIT_MAX);
    process.env.RATE_LIMIT_WINDOW_MS = "60000";

    vi.resetModules();
    vi.doMock("../../src/middleware/auth", () => ({
      requireAuth: (_req: any, res: any, next: any) => {
        res.locals.userId = "test-user-rate-limit";
        res.locals.userEmail = "test-rl@example.com";
        next();
      },
    }));

    const { app } = await import("../../src/app");

    // Send RATE_LIMIT_MAX + 1 requests. Body fails downstream validation/handlers,
    // but the rate limiter runs BEFORE the handler — so the limiter sees them all
    // and the (MAX+1)-th request must return 429 regardless of body content.
    const responses: Array<{ status: number; retryAfter: string | undefined }> = [];
    for (let i = 0; i < RATE_LIMIT_MAX + 1; i++) {
      const r = await request(app)
        .post("/chat")
        .set("Content-Type", "application/json")
        .send({ messages: [{ role: "user", content: "ping" }] });
      responses.push({
        status: r.status,
        retryAfter: r.headers["retry-after"],
      });
    }

    const last = responses[responses.length - 1];
    expect(last.status).toBe(429);
    expect(last.retryAfter).toBeDefined();

    vi.doUnmock("../../src/middleware/auth");
    delete process.env.RATE_LIMIT_MAX;
    delete process.env.RATE_LIMIT_WINDOW_MS;
  });
});
