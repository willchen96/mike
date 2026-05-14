import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

const llmMocks = vi.hoisted(() => ({
  completeText: vi.fn(),
  streamChatWithTools: vi.fn(),
}));

vi.mock("../../src/lib/llm", () => ({
  completeText: llmMocks.completeText,
  streamChatWithTools: llmMocks.streamChatWithTools,
}));

describe("tabular regenerate race handling", () => {
  afterEach(() => {
    vi.doUnmock("../../src/middleware/auth");
    vi.doUnmock("../../src/lib/rateLimiter");
    vi.doUnmock("../../src/lib/userSettings");
    vi.doUnmock("../../src/lib/storage");
    vi.doUnmock("../../src/lib/documentVersions");
    vi.doUnmock("../../src/lib/supabase");
    vi.resetModules();
  });

  it("covers the /tabular-review/:reviewId regenerate route and leaves no final generating state", async () => {
    vi.resetModules();
    const capturedUpdates: Array<Record<string, unknown>> = [];
    let generation = 0;

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
                      id: "review-race",
                      user_id: "test-user",
                      project_id: null,
                      columns_config: [{ index: 0, name: "A", prompt: "Extract A" }],
                    },
                    error: null,
                  }),
                }),
              }),
            };
          }
          if (table === "documents") {
            return {
              select: () => ({
                eq: () => ({
                  single: async () => ({
                    data: { id: "doc-race", filename: "race.docx", file_type: "docx" },
                    error: null,
                  }),
                }),
              }),
            };
          }
          if (table === "tabular_cells") {
            return {
              update: (payload: Record<string, unknown>) => {
                capturedUpdates.push(payload);
                return {
                  eq: () => ({
                    eq: () => ({
                      eq: async () => ({ data: null, error: null }),
                    }),
                  }),
                };
              },
            };
          }
          throw new Error(`Unexpected table ${table}`);
        },
      }),
    }));
    llmMocks.completeText.mockImplementation(async () => {
      generation += 1;
      return JSON.stringify({
        summary: `final ${generation}`,
        flag: "green",
        reasoning: "ok",
      });
    });

    const { app } = await import("../../src/app");

    const [first, second] = await Promise.all([
      request(app)
        .post("/tabular-review/review-race/regenerate-cell")
        .send({ document_id: "doc-race", column_index: 0 }),
      request(app)
        .post("/tabular-review/review-race/regenerate-cell")
        .send({ document_id: "doc-race", column_index: 0 }),
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(capturedUpdates.filter((u) => u.status === "generating")).toHaveLength(2);
    const finalUpdates = capturedUpdates.filter((u) => u.status !== "generating");
    expect(finalUpdates.some((u) => u.status === "done")).toBe(true);
    expect(finalUpdates).not.toContainEqual(expect.objectContaining({ status: "generating" }));
  });
});
