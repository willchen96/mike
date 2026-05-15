import { describe, it, expect, beforeEach } from "vitest";

describe("createServerSupabase", () => {
    beforeEach(() => {
        delete process.env.SUPABASE_URL;
        delete process.env.SUPABASE_SECRET_KEY;
    });

    it("throws when SUPABASE_URL is missing", async () => {
        process.env.SUPABASE_SECRET_KEY = "some-key";
        const { createServerSupabase } = await import("../supabase.js");
        expect(() => createServerSupabase()).toThrow("SUPABASE_URL and SUPABASE_SECRET_KEY must be set");
    });

    it("throws when SUPABASE_SECRET_KEY is missing", async () => {
        process.env.SUPABASE_URL = "https://project.supabase.co";
        const { createServerSupabase } = await import("../supabase.js");
        expect(() => createServerSupabase()).toThrow("SUPABASE_URL and SUPABASE_SECRET_KEY must be set");
    });

    it("throws when both are missing", async () => {
        const { createServerSupabase } = await import("../supabase.js");
        expect(() => createServerSupabase()).toThrow();
    });

    it("returns a client when both env vars are set", async () => {
        process.env.SUPABASE_URL = "https://project.supabase.co";
        process.env.SUPABASE_SECRET_KEY = "service-key";
        const { createServerSupabase } = await import("../supabase.js");
        expect(() => createServerSupabase()).not.toThrow();
    });
});
