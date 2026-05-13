import { describe, it, expect, vi, beforeEach } from "vitest";

// Stable mock reference shared across module resets
const { mockGetUser } = vi.hoisted(() => ({
    mockGetUser: vi
        .fn()
        .mockResolvedValue({ data: { user: { id: "real-user-id" } } }),
}));

vi.mock("@supabase/supabase-js", () => ({
    createClient: vi.fn(() => ({
        auth: { getUser: mockGetUser },
    })),
}));

describe("getUserIdFromRequest", () => {
    beforeEach(() => {
        vi.resetModules();
        mockGetUser.mockResolvedValue({ data: { user: { id: "real-user-id" } } });
        delete process.env.NEXT_PUBLIC_SUPABASE_URL;
        delete process.env.SUPABASE_SECRET_KEY;
    });

    it("throws 500 when NEXT_PUBLIC_SUPABASE_URL is missing", async () => {
        process.env.SUPABASE_SECRET_KEY = "some-secret";
        const { getUserIdFromRequest } = await import("../supabase-server");
        const req = new Request("http://localhost", {
            headers: { authorization: "Bearer any-uuid-here" },
        });
        const err = await getUserIdFromRequest(req).catch((r) => r);
        expect(err).toBeInstanceOf(Response);
        expect((err as Response).status).toBe(500);
    });

    it("throws 500 when SUPABASE_SECRET_KEY is missing", async () => {
        process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
        const { getUserIdFromRequest } = await import("../supabase-server");
        const req = new Request("http://localhost", {
            headers: { authorization: "Bearer any-uuid-here" },
        });
        const err = await getUserIdFromRequest(req).catch((r) => r);
        expect(err).toBeInstanceOf(Response);
        expect((err as Response).status).toBe(500);
    });

    it("throws 500 when both env vars are missing", async () => {
        const { getUserIdFromRequest } = await import("../supabase-server");
        const req = new Request("http://localhost", {
            headers: { authorization: "Bearer any-uuid-here" },
        });
        const err = await getUserIdFromRequest(req).catch((r) => r);
        expect(err).toBeInstanceOf(Response);
        expect((err as Response).status).toBe(500);
    });

    it("throws 401 when Authorization header is missing", async () => {
        process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
        process.env.SUPABASE_SECRET_KEY = "service-key";
        const { getUserIdFromRequest } = await import("../supabase-server");
        const req = new Request("http://localhost");
        const err = await getUserIdFromRequest(req).catch((r) => r);
        expect(err).toBeInstanceOf(Response);
        expect((err as Response).status).toBe(401);
    });

    it("returns the user ID for a valid token", async () => {
        process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
        process.env.SUPABASE_SECRET_KEY = "service-key";
        const { getUserIdFromRequest } = await import("../supabase-server");
        const req = new Request("http://localhost", {
            headers: { authorization: "Bearer valid-jwt-token" },
        });
        const userId = await getUserIdFromRequest(req);
        expect(userId).toBe("real-user-id");
    });

    it("throws 401 when the token is invalid or expired", async () => {
        mockGetUser.mockResolvedValueOnce({ data: { user: null } });
        process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
        process.env.SUPABASE_SECRET_KEY = "service-key";
        const { getUserIdFromRequest } = await import("../supabase-server");
        const req = new Request("http://localhost", {
            headers: { authorization: "Bearer expired-token" },
        });
        const err = await getUserIdFromRequest(req).catch((r) => r);
        expect(err).toBeInstanceOf(Response);
        expect((err as Response).status).toBe(401);
    });
});
