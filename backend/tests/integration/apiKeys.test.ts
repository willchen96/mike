/**
 * CLEAN-05 — PATCH /user/api-keys and GET /user/api-keys/status endpoints.
 *
 * Asserts that:
 *   - writing a key via PATCH stores ciphertext (never plaintext) in DB
 *   - GET /user/api-keys/status returns booleans only (no ciphertext / plaintext)
 *
 * Strategy: mock requireAuth and createServerSupabase at the module level so no
 * live DB or Supabase instance is required. Run via: npm run test:no-db
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import supertest from "supertest";

// ── Static hoisted mocks ───────────────────────────────────────────────────────

vi.mock("../../src/middleware/auth", () => ({
  requireAuth: vi.fn((_req: any, res: any, next: any) => {
    res.locals.userId = "test-user-apikeys-clean05";
    res.locals.userEmail = "apikeys-test@example.com";
    next();
  }),
}));

vi.mock("../../src/lib/supabase", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/supabase")>();
  return {
    ...original,
    createServerSupabase: vi.fn(),
  };
});

import { createServerSupabase } from "../../src/lib/supabase";
import { app } from "../../src/app";

const mockCreateServerSupabase = createServerSupabase as ReturnType<typeof vi.fn>;

// ── Query-builder mock factories ───────────────────────────────────────────────

/**
 * Builds a mock Supabase client that captures update() calls.
 * Returns a handle object whose `.payload` and `.table` getters expose what was written.
 */
function makeUpdateCapture() {
  let capturedPayload: Record<string, unknown> | null = null;
  let capturedTable: string | null = null;

  const client = {
    from(table: string) {
      capturedTable = table;
      return {
        update(payload: Record<string, unknown>) {
          capturedPayload = payload;
          return {
            eq(_col: string, _val: string) {
              return { error: null };
            },
          };
        },
        select(_cols: string) {
          return {
            eq(_col: string, _val: string) {
              return {
                single() {
                  return { data: null, error: null };
                },
              };
            },
          };
        },
      };
    },
  };

  return {
    client,
    get payload(): Record<string, unknown> | null {
      return capturedPayload;
    },
    get table(): string | null {
      return capturedTable;
    },
  };
}

/**
 * Builds a mock Supabase client that returns a fixed row from select().
 */
function makeSelectStub(row: Record<string, unknown>) {
  return {
    from(_table: string) {
      return {
        update(_payload: Record<string, unknown>) {
          return {
            eq(_col: string, _val: string) {
              return { error: null };
            },
          };
        },
        select(_cols: string) {
          return {
            eq(_col: string, _val: string) {
              return {
                single() {
                  return { data: row, error: null };
                },
              };
            },
          };
        },
      };
    },
  };
}

// ── PATCH /user/api-keys ───────────────────────────────────────────────────────

describe("PATCH /user/api-keys", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("PATCH /user/api-keys with provider=claude writes ciphertext+iv+auth_tag and clears plaintext", async () => {
    const capture = makeUpdateCapture();
    mockCreateServerSupabase.mockReturnValue(capture.client);

    const res = await supertest(app)
      .patch("/user/api-keys")
      .set("Content-Type", "application/json")
      .send({ provider: "claude", key: "sk-ant-test-key-abc123" });

    expect(res.status).toBe(204);
    expect(capture.table).toBe("user_profiles");
    expect(capture.payload).not.toBeNull();
    // Three ciphertext columns must be present and non-null
    expect(capture.payload!["claude_api_key_ciphertext"]).toBeTruthy();
    expect(capture.payload!["claude_api_key_iv"]).toBeTruthy();
    expect(capture.payload!["claude_api_key_auth_tag"]).toBeTruthy();
    // Plaintext must NOT appear in the serialized payload
    const payloadStr = JSON.stringify(capture.payload);
    expect(payloadStr).not.toContain("sk-ant-test-key-abc123");
  });

  it("PATCH /user/api-keys with provider=gemini writes ciphertext+iv+auth_tag", async () => {
    const capture = makeUpdateCapture();
    mockCreateServerSupabase.mockReturnValue(capture.client);

    const res = await supertest(app)
      .patch("/user/api-keys")
      .set("Content-Type", "application/json")
      .send({ provider: "gemini", key: "AIza-gemini-test-key-xyz" });

    expect(res.status).toBe(204);
    expect(capture.table).toBe("user_profiles");
    expect(capture.payload!["gemini_api_key_ciphertext"]).toBeTruthy();
    expect(capture.payload!["gemini_api_key_iv"]).toBeTruthy();
    expect(capture.payload!["gemini_api_key_auth_tag"]).toBeTruthy();
    // Gemini columns written, not claude columns
    expect(capture.payload).not.toHaveProperty("claude_api_key_ciphertext");
    const payloadStr = JSON.stringify(capture.payload);
    expect(payloadStr).not.toContain("AIza-gemini-test-key-xyz");
  });

  it("PATCH /user/api-keys with key=null clears all three columns", async () => {
    const capture = makeUpdateCapture();
    mockCreateServerSupabase.mockReturnValue(capture.client);

    const res = await supertest(app)
      .patch("/user/api-keys")
      .set("Content-Type", "application/json")
      .send({ provider: "claude", key: null });

    expect(res.status).toBe(204);
    expect(capture.payload!["claude_api_key_ciphertext"]).toBeNull();
    expect(capture.payload!["claude_api_key_iv"]).toBeNull();
    expect(capture.payload!["claude_api_key_auth_tag"]).toBeNull();
  });

  it("PATCH /user/api-keys with malformed body returns 400", async () => {
    const capture = makeUpdateCapture();
    mockCreateServerSupabase.mockReturnValue(capture.client);

    const res = await supertest(app)
      .patch("/user/api-keys")
      .set("Content-Type", "application/json")
      .send({});

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("detail");
    // DB must NOT have been called
    expect(capture.payload).toBeNull();
  });
});

// ── GET /user/api-keys/status ─────────────────────────────────────────────────

describe("GET /user/api-keys/status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("GET /user/api-keys/status returns { has_claude: bool, has_gemini: bool } only", async () => {
    const stub = makeSelectStub({
      claude_api_key_ciphertext: Buffer.from("some-ciphertext"),
      gemini_api_key_ciphertext: null,
    });
    mockCreateServerSupabase.mockReturnValue(stub);

    const res = await supertest(app).get("/user/api-keys/status");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ has_claude: true, has_gemini: false });
  });

  it("GET /user/api-keys/status never includes ciphertext or plaintext fields", async () => {
    const stub = makeSelectStub({
      claude_api_key_ciphertext: Buffer.from("encrypted"),
      gemini_api_key_ciphertext: Buffer.from("encrypted-gemini"),
    });
    mockCreateServerSupabase.mockReturnValue(stub);

    const res = await supertest(app).get("/user/api-keys/status");

    expect(res.status).toBe(200);
    // Exactly two keys, sorted
    const keys = Object.keys(res.body).sort();
    expect(keys).toEqual(["has_claude", "has_gemini"]);
    // No ciphertext/plaintext/iv/auth_tag in the response
    expect(res.body).not.toHaveProperty("claude_api_key_ciphertext");
    expect(res.body).not.toHaveProperty("gemini_api_key_ciphertext");
    expect(res.body).not.toHaveProperty("iv");
    expect(res.body).not.toHaveProperty("auth_tag");
  });
});
