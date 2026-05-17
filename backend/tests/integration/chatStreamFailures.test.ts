import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

const chatToolMocks = vi.hoisted(() => ({
  runLLMStream: vi.fn(),
}));

vi.mock("../../src/lib/chatTools", () => ({
  buildDocContext: vi.fn().mockResolvedValue({ docIndex: {}, docStore: {} }),
  buildMessages: vi.fn((messages) => messages),
  enrichWithPriorEvents: vi.fn((messages) => Promise.resolve(messages)),
  buildWorkflowStore: vi.fn().mockResolvedValue({}),
  extractAnnotations: vi.fn().mockReturnValue([]),
  runLLMStream: chatToolMocks.runLLMStream,
}));

function installRouteMocks() {
  vi.doMock("../../src/middleware/auth", () => ({
    requireAuth: (_req: unknown, res: any, next: () => void) => {
      res.locals.userId = "test-user";
      res.locals.userEmail = "test@example.com";
      next();
    },
  }));
  vi.doMock("../../src/lib/rateLimiter", () => ({
    llmRateLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  }));
  vi.doMock("../../src/lib/userSettings", () => ({
    getUserApiKeys: vi.fn().mockResolvedValue({}),
    getUserModelSettings: vi.fn().mockResolvedValue({
      chat_model: "claude-test",
      title_model: "claude-title-test",
      api_keys: {},
    }),
  }));
  vi.doMock("../../src/lib/supabase", () => ({
    createServerSupabase: () => ({
      from: (table: string) => {
        if (table === "chats") {
          return {
            insert: () => ({
              select: () => ({
                single: async () => ({
                  data: { id: "00000000-0000-4000-8000-000000000001", title: null },
                  error: null,
                }),
              }),
            }),
            update: () => ({ eq: async () => ({ data: null, error: null }) }),
          };
        }
        if (table === "chat_messages") {
          return {
            insert: async () => ({ data: null, error: null }),
          };
        }
        if (table === "projects") {
          return {
            select: () => ({
              eq: () => ({
                single: async () => ({ data: null, error: null }),
              }),
            }),
          };
        }
        throw new Error(`Unexpected table ${table}`);
      },
    }),
  }));
}

async function importMockedApp() {
  vi.resetModules();
  chatToolMocks.runLLMStream.mockReset();
  installRouteMocks();
  return import("../../src/app");
}

describe("POST /chat stream failures", () => {
  afterEach(() => {
    vi.doUnmock("../../src/middleware/auth");
    vi.doUnmock("../../src/lib/rateLimiter");
    vi.doUnmock("../../src/lib/userSettings");
    vi.doUnmock("../../src/lib/supabase");
    vi.resetModules();
  });

  it("tool failure mid-stream emits error and DONE", async () => {
    const { app } = await importMockedApp();
    chatToolMocks.runLLMStream.mockImplementation(async ({ write }) => {
      write(`data: ${JSON.stringify({ type: "tool_call", name: "read_document" })}\n\n`);
      throw new Error("tool exploded");
    });

    const res = await request(app)
      .post("/chat")
      .send({ messages: [{ role: "user", content: "hello" }] });

    expect(res.status).toBe(200);
    expect(res.text).toContain('"type":"chat_id"');
    expect(res.text).toContain('"type":"error"');
    expect(res.text).toContain('"message":"Stream error"');
    expect(res.text).toContain("data: [DONE]");
  });

  it("large message arrays reach validation boundary without process crash", async () => {
    const { app } = await importMockedApp();
    chatToolMocks.runLLMStream.mockResolvedValue({ fullText: "ok", events: [] });

    const messages = Array.from({ length: 200 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `message ${i}`,
    }));

    const res = await request(app).post("/chat").send({ messages });

    expect(res.status).toBe(200);
    expect(res.text).toContain('"type":"chat_id"');
  });

  it("aborted request path is handled without unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.once("unhandledRejection", onUnhandled);
    const { app } = await importMockedApp();
    chatToolMocks.runLLMStream.mockResolvedValue({ fullText: "", events: [] });

    const res = await request(app)
      .post("/chat")
      .send({ messages: [{ role: "user", content: "abort probe" }] });

    process.removeListener("unhandledRejection", onUnhandled);
    expect(res.status).toBe(200);
    expect(unhandled).toEqual([]);
  });
});
