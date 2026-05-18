import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response, NextFunction } from "express";

// Mock @supabase/supabase-js before any imports
const mockGetUser = vi.fn();
vi.mock("@supabase/supabase-js", () => ({
    createClient: vi.fn(() => ({
        auth: { getUser: mockGetUser },
    })),
}));

describe("requireAuth middleware", () => {
    beforeEach(() => {
        vi.resetModules();
        mockGetUser.mockReset();
    });

    function makeReq(headers: Record<string, string> = {}): Partial<Request> {
        return { headers } as Partial<Request>;
    }

    function makeRes(): { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn>; locals: Record<string, unknown> } {
        const res = { locals: {} } as { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn>; locals: Record<string, unknown> };
        res.json = vi.fn().mockReturnValue(res);
        res.status = vi.fn().mockReturnValue(res);
        return res;
    }

    it("returns 401 when Authorization header is missing", async () => {
        process.env.SUPABASE_URL = "https://project.supabase.co";
        process.env.SUPABASE_SECRET_KEY = "service-key";
        const { requireAuth } = await import("../../middleware/auth.js");
        const req = makeReq({});
        const res = makeRes();
        const next = vi.fn();
        await requireAuth(req as Request, res as unknown as Response, next as NextFunction);
        expect(res.status).toHaveBeenCalledWith(401);
        expect(next).not.toHaveBeenCalled();
    });

    it("returns 500 when SUPABASE_URL is missing", async () => {
        delete process.env.SUPABASE_URL;
        process.env.SUPABASE_SECRET_KEY = "service-key";
        const { requireAuth } = await import("../../middleware/auth.js");
        const req = makeReq({ authorization: "Bearer some-token" });
        const res = makeRes();
        const next = vi.fn();
        await requireAuth(req as Request, res as unknown as Response, next as NextFunction);
        expect(res.status).toHaveBeenCalledWith(500);
    });

    it("calls next with userId when token is valid", async () => {
        process.env.SUPABASE_URL = "https://project.supabase.co";
        process.env.SUPABASE_SECRET_KEY = "service-key";
        mockGetUser.mockResolvedValue({ data: { user: { id: "user-123", email: "user@example.com" } } });
        const { requireAuth } = await import("../../middleware/auth.js");
        const req = makeReq({ authorization: "Bearer valid-token" });
        const res = makeRes();
        const next = vi.fn();
        await requireAuth(req as Request, res as unknown as Response, next as NextFunction);
        expect(next).toHaveBeenCalled();
        expect(res.locals.userId).toBe("user-123");
    });
});
