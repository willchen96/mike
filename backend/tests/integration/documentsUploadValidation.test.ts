import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { MAX_UPLOAD_SIZE_BYTES } from "../../src/lib/upload";

function mockAuth() {
  vi.doMock("../../src/middleware/auth", () => ({
    requireAuth: (_req: unknown, res: any, next: () => void) => {
      res.locals.userId = "test-user";
      res.locals.userEmail = "test@example.com";
      next();
    },
  }));
}

function mockDocumentLookup() {
  vi.doMock("../../src/lib/supabase", () => ({
    createServerSupabase: () => ({
      from: (table: string) => {
        if (table !== "documents") throw new Error(`Unexpected table ${table}`);
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({
                data: {
                  id: "doc-validation",
                  filename: "contract.docx",
                  file_type: "docx",
                  user_id: "test-user",
                  project_id: null,
                },
                error: null,
              }),
            }),
          }),
        };
      },
    }),
  }));
}

describe("document version upload validation", () => {
  afterEach(() => {
    vi.doUnmock("../../src/middleware/auth");
    vi.doUnmock("../../src/lib/supabase");
    vi.resetModules();
  });

  it("POST /single-documents/:documentId/versions with an oversize file returns 413", async () => {
    vi.resetModules();
    mockAuth();
    const { app } = await import("../../src/app");

    const res = await request(app)
      .post("/single-documents/doc-validation/versions")
      .attach("file", Buffer.alloc(MAX_UPLOAD_SIZE_BYTES + 1), "huge.docx");

    expect(res.status).toBe(413);
  });

  it("POST /single-documents/:documentId/versions with wrong extension returns 400", async () => {
    vi.resetModules();
    mockAuth();
    mockDocumentLookup();
    const { app } = await import("../../src/app");

    const res = await request(app)
      .post("/single-documents/doc-validation/versions")
      .attach("file", Buffer.from("pdf bytes"), "wrong.pdf");

    expect(res.status).toBe(400);
    expect(res.body.detail).toContain("does not match document type");
  });
});
