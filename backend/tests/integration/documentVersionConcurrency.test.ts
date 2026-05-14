import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

describe("document version upload concurrency", () => {
  afterEach(() => {
    vi.doUnmock("../../src/middleware/auth");
    vi.doUnmock("../../src/lib/storage");
    vi.doUnmock("../../src/lib/pdfQueue");
    vi.doUnmock("../../src/lib/supabase");
    vi.resetModules();
  });

  it("retries 23505 races and stores unique version numbers", async () => {
    vi.resetModules();

    const insertedVersionNumbers: number[] = [];
    let maxLookupCount = 0;
    let versionTwoAlreadyInserted = false;
    let observed23505 = false;

    vi.doMock("../../src/middleware/auth", () => ({
      requireAuth: (_req: unknown, res: any, next: () => void) => {
        res.locals.userId = "test-user";
        res.locals.userEmail = "test@example.com";
        next();
      },
    }));
    vi.doMock("../../src/lib/storage", () => ({
      uploadFile: vi.fn().mockResolvedValue(undefined),
      versionStorageKey: (
        userId: string,
        documentId: string,
        versionSlug: string,
        filename: string,
      ) => `${userId}/${documentId}/versions/${versionSlug}/${filename}`,
      buildContentDisposition: vi.fn(),
      downloadFile: vi.fn(),
      deleteFile: vi.fn(),
      getSignedUrl: vi.fn(),
      storageKey: vi.fn(),
    }));
    vi.doMock("../../src/lib/pdfQueue", () => ({
      enqueueConversionForVersion: vi.fn(),
      enqueueConversionFromBuffer: vi.fn(),
    }));
    vi.doMock("../../src/lib/supabase", () => ({
      createServerSupabase: () => ({
        from: (table: string) => {
          if (table === "documents") {
            return {
              select: () => ({
                eq: () => ({
                  single: async () => ({
                    data: {
                      id: "doc-race",
                      filename: "contract.docx",
                      file_type: "docx",
                      user_id: "test-user",
                      project_id: null,
                    },
                    error: null,
                  }),
                }),
              }),
              update: () => ({ eq: async () => ({ data: null, error: null }) }),
            };
          }
          if (table === "document_versions") {
            return {
              select: (columns?: string) => ({
                eq: () => {
                  if (columns?.includes("version_number") && !columns.includes("storage_path")) {
                    return {
                      in: () => ({
                        order: () => ({
                          limit: () => ({
                            maybeSingle: async () => {
                              maxLookupCount += 1;
                              return {
                                data: {
                                  version_number: maxLookupCount <= 2 ? 1 : 2,
                                },
                                error: null,
                              };
                            },
                          }),
                        }),
                      }),
                    };
                  }
                  return {
                    single: async () => ({
                      data: {
                        id: "version-refetch",
                        version_number: insertedVersionNumbers.at(-1) ?? 2,
                        source: "user_upload",
                        created_at: new Date().toISOString(),
                        display_name: "v.docx",
                        storage_path: "internal",
                      },
                      error: null,
                    }),
                  };
                },
              }),
              insert: (payload: { version_number: number }) => ({
                select: () => ({
                  single: async () => {
                    if (payload.version_number === 2 && versionTwoAlreadyInserted) {
                      observed23505 = true;
                      return { data: null, error: { code: "23505" } };
                    }
                    versionTwoAlreadyInserted ||= payload.version_number === 2;
                    insertedVersionNumbers.push(payload.version_number);
                    return {
                      data: {
                        id: `version-${payload.version_number}`,
                        version_number: payload.version_number,
                      },
                      error: null,
                    };
                  },
                }),
              }),
            };
          }
          throw new Error(`Unexpected table ${table}`);
        },
      }),
    }));

    const { app } = await import("../../src/app");

    const [first, second] = await Promise.all([
      request(app)
        .post("/single-documents/doc-race/versions")
        .attach("file", Buffer.from("docx bytes"), "v.docx"),
      request(app)
        .post("/single-documents/doc-race/versions")
        .attach("file", Buffer.from("docx bytes"), "v.docx"),
    ]);

    expect([200, 201]).toContain(first.status);
    expect([200, 201]).toContain(second.status);
    expect(new Set(insertedVersionNumbers).size).toBe(insertedVersionNumbers.length);
    expect(observed23505).toBe(true);
  });
});
