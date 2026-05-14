/**
 * CLEAN-25 — /single-documents/download-zip emits X-Docs-Skipped header.
 *
 * Verifies:
 *   1. Mixed access (200 + X-Docs-Skipped): request with a,b accessible and c
 *      inaccessible → HTTP 200, X-Docs-Skipped: "c", response body is a ZIP.
 *   2. All inaccessible (404): HTTP 404, NO X-Docs-Skipped header.
 *   3. All accessible (200, no header): HTTP 200, X-Docs-Skipped header absent.
 *   4. CORS expose-headers: Access-Control-Expose-Headers contains "X-Docs-Skipped".
 *
 * Strategy: mock createServerSupabase, ensureDocAccess, loadActiveVersion,
 * and downloadFile so no real network or DB is needed.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import supertest from "supertest";

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("../../src/middleware/auth", () => ({
    requireAuth: vi.fn((req, res, next) => {
        res.locals.userId = "user-owner";
        res.locals.userEmail = "owner@example.com";
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

// We mock the access helper at the module level so that each test can control
// which docs are accessible.
vi.mock("../../src/lib/access", async (importOriginal) => {
    const original = await importOriginal<typeof import("../../src/lib/access")>();
    return {
        ...original,
        ensureDocAccess: vi.fn(),
    };
});

vi.mock("../../src/lib/documentVersions", async (importOriginal) => {
    const original = await importOriginal<typeof import("../../src/lib/documentVersions")>();
    return {
        ...original,
        loadActiveVersion: vi.fn(),
    };
});

vi.mock("../../src/lib/storage", async (importOriginal) => {
    const original = await importOriginal<typeof import("../../src/lib/storage")>();
    return {
        ...original,
        downloadFile: vi.fn(),
    };
});

import { createServerSupabase } from "../../src/lib/supabase";
import { ensureDocAccess } from "../../src/lib/access";
import { loadActiveVersion } from "../../src/lib/documentVersions";
import { downloadFile } from "../../src/lib/storage";
import { app } from "../../src/app";

const mockDb = createServerSupabase as ReturnType<typeof vi.fn>;
const mockEnsureDocAccess = ensureDocAccess as ReturnType<typeof vi.fn>;
const mockLoadActiveVersion = loadActiveVersion as ReturnType<typeof vi.fn>;
const mockDownloadFile = downloadFile as ReturnType<typeof vi.fn>;

const DOC_A = "00000000-0000-4000-8000-00000000000a";
const DOC_B = "00000000-0000-4000-8000-00000000000b";
const DOC_C = "00000000-0000-4000-8000-00000000000c";
const DOC_D = "00000000-0000-4000-8000-00000000000d";
const DOC_E = "00000000-0000-4000-8000-00000000000e";
const DOC_F = "00000000-0000-4000-8000-00000000000f";
const DOC_X = "00000000-0000-4000-8000-000000000010";

// Minimal in-memory buffer to satisfy the ZIP generator.
const FAKE_DOC_BYTES = Buffer.from("fake-docx-bytes");

// ── Shared DB mock factory ────────────────────────────────────────────────────

function makeDbMockFor(docs: Array<{ id: string; filename: string; user_id: string; project_id: string | null }>) {
    const inChain = {
        // selectResult is resolved after the .in() call
    };
    const selectChain = {
        in: vi.fn().mockResolvedValue({ data: docs, error: null }),
    };
    const fromChain = {
        select: vi.fn().mockReturnValue(selectChain),
    };
    mockDb.mockReturnValue({
        from: vi.fn().mockReturnValue(fromChain),
    });
}

// ── Test 1: Mixed access → 200 + X-Docs-Skipped ──────────────────────────────

describe("POST /single-documents/download-zip — mixed access", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("returns 200, zips accessible docs, sets X-Docs-Skipped for inaccessible", async () => {
        const docs = [
            { id: DOC_A, filename: "doc-a.docx", user_id: "user-owner", project_id: null },
            { id: DOC_B, filename: "doc-b.docx", user_id: "user-owner", project_id: null },
            { id: DOC_C, filename: "doc-c.docx", user_id: "user-other", project_id: null },
        ];

        makeDbMockFor(docs);

        // a and b accessible; c is not
        mockEnsureDocAccess.mockImplementation(async (doc) => {
            if (doc.user_id === "user-owner") return { ok: true, isOwner: true };
            return { ok: false };
        });

        mockLoadActiveVersion.mockResolvedValue({ id: "v1", storage_path: "docs/v1" });
        mockDownloadFile.mockResolvedValue(FAKE_DOC_BYTES.buffer);

        const res = await supertest(app)
            .post("/single-documents/download-zip")
            .set("Authorization", "Bearer test-token")
            .send({ document_ids: [DOC_A, DOC_B, DOC_C] });

        expect(res.status).toBe(200);
        expect(res.headers["content-type"]).toContain("application/zip");
        expect(res.headers["x-docs-skipped"]).toBe(DOC_C);
    });
});

// ── Test 2: All inaccessible → 404 ───────────────────────────────────────────

describe("POST /single-documents/download-zip — all inaccessible", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("returns 404 and does NOT set X-Docs-Skipped", async () => {
        const docs = [
            { id: DOC_X, filename: "doc-x.docx", user_id: "user-other", project_id: null },
        ];

        makeDbMockFor(docs);
        mockEnsureDocAccess.mockResolvedValue({ ok: false });

        const res = await supertest(app)
            .post("/single-documents/download-zip")
            .set("Authorization", "Bearer test-token")
            .send({ document_ids: [DOC_X] });

        expect(res.status).toBe(404);
        expect(res.headers["x-docs-skipped"]).toBeUndefined();
    });
});

// ── Test 3: All accessible → 200, no X-Docs-Skipped ─────────────────────────

describe("POST /single-documents/download-zip — all accessible", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("returns 200 and does NOT set X-Docs-Skipped when all docs are accessible", async () => {
        const docs = [
            { id: DOC_D, filename: "doc-d.docx", user_id: "user-owner", project_id: null },
            { id: DOC_E, filename: "doc-e.docx", user_id: "user-owner", project_id: null },
        ];

        makeDbMockFor(docs);
        mockEnsureDocAccess.mockResolvedValue({ ok: true, isOwner: true });
        mockLoadActiveVersion.mockResolvedValue({ id: "v2", storage_path: "docs/v2" });
        mockDownloadFile.mockResolvedValue(FAKE_DOC_BYTES.buffer);

        const res = await supertest(app)
            .post("/single-documents/download-zip")
            .set("Authorization", "Bearer test-token")
            .send({ document_ids: [DOC_D, DOC_E] });

        expect(res.status).toBe(200);
        expect(res.headers["x-docs-skipped"]).toBeUndefined();
    });
});

// ── Test 4: CORS expose-headers includes X-Docs-Skipped ──────────────────────

describe("CORS — Access-Control-Expose-Headers includes X-Docs-Skipped", () => {
    it("OPTIONS preflight response exposes X-Docs-Skipped", async () => {
        const res = await supertest(app)
            .options("/single-documents/download-zip")
            .set("Origin", "http://localhost:3000")
            .set("Access-Control-Request-Method", "POST")
            .set("Access-Control-Request-Headers", "Authorization,Content-Type");

        // cors() should add Access-Control-Expose-Headers in the preflight.
        // Some cors configurations only add expose headers on actual requests,
        // so we test a real POST as well.
        expect(
            res.headers["access-control-expose-headers"] ?? "",
        ).toMatch(/X-Docs-Skipped/i);
    });

    it("actual POST response exposes X-Docs-Skipped in Access-Control-Expose-Headers", async () => {
        const docs = [
            { id: DOC_F, filename: "doc-f.docx", user_id: "user-owner", project_id: null },
        ];
        makeDbMockFor(docs);
        mockEnsureDocAccess.mockResolvedValue({ ok: true, isOwner: true });
        mockLoadActiveVersion.mockResolvedValue({ id: "v3", storage_path: "docs/v3" });
        mockDownloadFile.mockResolvedValue(FAKE_DOC_BYTES.buffer);

        const res = await supertest(app)
            .post("/single-documents/download-zip")
            .set("Origin", "http://localhost:3000")
            .set("Authorization", "Bearer test-token")
            .send({ document_ids: [DOC_F] });

        expect(res.status).toBe(200);
        expect(
            res.headers["access-control-expose-headers"] ?? "",
        ).toMatch(/X-Docs-Skipped/i);
    });
});
