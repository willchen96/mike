import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

const llmMocks = vi.hoisted(() => ({
  streamChatWithTools: vi.fn(),
  completeText: vi.fn(),
}));

vi.mock("../../src/lib/llm", () => ({
  streamChatWithTools: llmMocks.streamChatWithTools,
  completeText: llmMocks.completeText,
}));

function installMocks(capturedUpdates: unknown[]) {
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
      tabular_model: "gemini-test",
      api_keys: {},
    }),
  }));
  vi.doMock("../../src/lib/storage", () => ({
    downloadFile: vi.fn().mockResolvedValue(new ArrayBuffer(0)),
  }));
  vi.doMock("../../src/lib/documentVersions", () => ({
    loadActiveVersion: vi.fn().mockResolvedValue(null),
  }));
  vi.doMock("../../src/lib/supabase", () => ({
    createServerSupabase: () => ({
      from: (table: string) => {
        if (table === "tabular_reviews") {
          return {
            select: () => ({
              eq: () => ({
                single: async () => ({
                  data: {
                    id: "review-generate",
                    user_id: "test-user",
                    project_id: null,
                    columns_config: [
                      { index: 0, name: "A", prompt: "Extract A" },
                      { index: 1, name: "B", prompt: "Extract B" },
                    ],
                  },
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === "tabular_cells") {
          return {
            select: () => ({
              eq: async () => ({
                data: [
                  { id: "cell-0", document_id: "doc-1", column_index: 0, status: "pending" },
                  { id: "cell-1", document_id: "doc-1", column_index: 1, status: "pending" },
                ],
                error: null,
              }),
            }),
            update: (payload: unknown) => {
              capturedUpdates.push(payload);
              return {
                eq: () => ({
                  eq: () => ({
                    eq: async () => ({ data: null, error: null }),
                  }),
                }),
              };
            },
            insert: async (payload: unknown) => {
              capturedUpdates.push(payload);
              return { data: null, error: null };
            },
          };
        }
        if (table === "documents") {
          return {
            select: () => ({
              in: async () => ({
                data: [{ id: "doc-1", filename: "contract.docx", file_type: "docx", page_count: 1 }],
                error: null,
              }),
              eq: () => ({
                order: async () => ({ data: [], error: null }),
              }),
            }),
          };
        }
        throw new Error(`Unexpected table ${table}`);
      },
    }),
  }));
}

async function importApp(capturedUpdates: unknown[]) {
  vi.resetModules();
  llmMocks.streamChatWithTools.mockReset();
  llmMocks.completeText.mockReset();
  installMocks(capturedUpdates);
  return import("../../src/app");
}

describe("tabular generate failure handling", () => {
  afterEach(() => {
    vi.doUnmock("../../src/middleware/auth");
    vi.doUnmock("../../src/lib/rateLimiter");
    vi.doUnmock("../../src/lib/userSettings");
    vi.doUnmock("../../src/lib/storage");
    vi.doUnmock("../../src/lib/documentVersions");
    vi.doUnmock("../../src/lib/supabase");
    vi.resetModules();
  });

  it("malformed LLM JSON emits parse error event and does not crash stream", async () => {
    const capturedUpdates: unknown[] = [];
    const { app } = await importApp(capturedUpdates);
    llmMocks.streamChatWithTools.mockImplementation(async ({ callbacks }) => {
      callbacks.onContentDelta("not json\n");
    });

    const res = await request(app).post("/tabular-review/review-generate/generate");

    expect(res.status).toBe(200);
    expect(res.text).toContain("tabular_cell_parse_error");
    expect(res.text).toContain("data: [DONE]");
  });

  it("partial column response marks missing columns error", async () => {
    const capturedUpdates: unknown[] = [];
    const { app } = await importApp(capturedUpdates);
    llmMocks.streamChatWithTools.mockImplementation(async ({ callbacks }) => {
      callbacks.onContentDelta(
        '{"column_index":0,"summary":"Found A","flag":"green","reasoning":"ok"}\n',
      );
    });

    const res = await request(app).post("/tabular-review/review-generate/generate");

    expect(res.status).toBe(200);
    expect(capturedUpdates).toContainEqual({ status: "error" });
    expect(res.text).toContain('"column_index":1');
    expect(res.text).toContain('"status":"error"');
    expect(res.text).toContain('"content":null');
  });
});
