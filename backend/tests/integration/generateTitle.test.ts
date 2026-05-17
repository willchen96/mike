/**
 * CLEAN-24 — /generate-title UPDATE drops redundant eq("user_id", userId).
 *
 * Verifies:
 *   1. Owner can persist a title (UPDATE with eq("id", chatId) only — no user_id predicate).
 *   2. Shared-project member can persist a title (UPDATE issued, not skipped).
 *   3. No-access caller receives 404 and UPDATE is NOT issued.
 *
 * Strategy: mock createServerSupabase, requireAuth, and completeText so no
 * real network or DB is needed. Use supertest against the Express app.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import supertest from "supertest";

// ── Mocks must be declared before imports that trigger module execution ───────

// Mock requireAuth so tests can set userId / userEmail freely.
vi.mock("../../src/middleware/auth", () => ({
    requireAuth: vi.fn((req, res, next) => {
        res.locals.userId = req.headers["x-test-user-id"] ?? "user-owner";
        res.locals.userEmail = req.headers["x-test-user-email"] ?? "owner@example.com";
        next();
    }),
}));

// Mock completeText to return a fixed title string without calling any LLM.
vi.mock("../../src/lib/llm", async (importOriginal) => {
    const original = await importOriginal<typeof import("../../src/lib/llm")>();
    return {
        ...original,
        completeText: vi.fn().mockResolvedValue("Test Title"),
    };
});

// Mock getUserModelSettings so it doesn't need a real DB call.
vi.mock("../../src/lib/userSettings", async (importOriginal) => {
    const original = await importOriginal<typeof import("../../src/lib/userSettings")>();
    return {
        ...original,
        getUserModelSettings: vi.fn().mockResolvedValue({
            title_model: "claude-haiku-4-5",
            api_keys: {},
        }),
    };
});

// Mock createServerSupabase at the lib level so the router picks up the mock.
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

// ── Query-builder mock factory ────────────────────────────────────────────────

/**
 * Builds a minimal Supabase query-builder mock. The chain captures which
 * .eq() calls happen on the `update` builder so tests can assert them.
 */
function makeQueryBuilder() {
    const eqCalls: Array<[string, string]> = [];

    const updateBuilder = {
        eq(col: string, val: string) {
            eqCalls.push([col, val]);
            return updateBuilder;
        },
        // Resolves to a successful update response.
        then(resolve: (v: { error: null }) => void) {
            resolve({ error: null });
        },
    };

    return { eqCalls, updateBuilder };
}

// ── Test 1: Owner persists title ──────────────────────────────────────────────

describe("POST /chat/:chatId/generate-title — owner", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("issues UPDATE with eq(\"id\", chatId) only — no user_id predicate", async () => {
        const chatId = "chat-owner-123";
        const userId = "user-owner";

        const { eqCalls, updateBuilder } = makeQueryBuilder();

        // db.from("chats").select(...).eq("id", chatId).single()
        const selectChain = {
            eq: vi.fn().mockReturnThis(),
            single: vi.fn().mockResolvedValue({
                data: { id: chatId, user_id: userId, project_id: null },
                error: null,
            }),
        };

        // db.from("chats").update({ title }).eq("id", chatId)
        const updateChain = {
            update: vi.fn().mockReturnValue(updateBuilder),
        };

        mockCreateServerSupabase.mockReturnValue({
            from: vi.fn((table: string) => {
                if (table === "chats") {
                    return {
                        select: vi.fn().mockReturnValue(selectChain),
                        ...updateChain,
                    };
                }
                return {};
            }),
        });

        const res = await supertest(app)
            .post(`/chat/${chatId}/generate-title`)
            .set("x-test-user-id", userId)
            .set("x-test-user-email", "owner@example.com")
            .send({ message: "What is the legal definition of consideration?" });

        expect(res.status).toBe(200);
        expect(res.body.title).toBe("Test Title");

        // The UPDATE must NOT include a user_id predicate — that's CLEAN-24.
        const colNames = eqCalls.map(([col]) => col);
        expect(colNames).toContain("id");
        expect(colNames).not.toContain("user_id");
    });
});

// ── Test 2: Shared-project member persists title ──────────────────────────────

describe("POST /chat/:chatId/generate-title — shared-project member", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("issues UPDATE (not skipped) when checkProjectAccess returns ok", async () => {
        const chatId = "chat-shared-456";
        const ownerId = "user-owner";
        const memberId = "user-member";
        const memberEmail = "member@example.com";
        const projectId = "proj-1";

        const { eqCalls, updateBuilder } = makeQueryBuilder();
        let updateCalled = false;

        // chat lookup: owned by ownerId, in projectId
        const selectChatChain = {
            eq: vi.fn().mockReturnThis(),
            single: vi.fn().mockResolvedValue({
                data: { id: chatId, user_id: ownerId, project_id: projectId },
                error: null,
            }),
        };

        // project lookup for checkProjectAccess: member is in shared_with
        const selectProjectChain = {
            eq: vi.fn().mockReturnThis(),
            single: vi.fn().mockResolvedValue({
                data: {
                    id: projectId,
                    user_id: ownerId,
                    shared_with: [memberEmail],
                },
                error: null,
            }),
        };

        const updateChain = {
            update: vi.fn().mockImplementation(() => {
                updateCalled = true;
                return updateBuilder;
            }),
        };

        mockCreateServerSupabase.mockReturnValue({
            from: vi.fn((table: string) => {
                if (table === "chats") {
                    return {
                        select: vi.fn().mockReturnValue(selectChatChain),
                        ...updateChain,
                    };
                }
                if (table === "projects") {
                    return {
                        select: vi.fn().mockReturnValue(selectProjectChain),
                    };
                }
                return {};
            }),
        });

        const res = await supertest(app)
            .post(`/chat/${chatId}/generate-title`)
            .set("x-test-user-id", memberId)
            .set("x-test-user-email", memberEmail)
            .send({ message: "Review this NDA clause." });

        expect(res.status).toBe(200);
        expect(res.body.title).toBe("Test Title");
        // UPDATE must have been called — the shared member can persist the title.
        expect(updateCalled).toBe(true);
        // And must not carry a user_id predicate.
        const colNames = eqCalls.map(([col]) => col);
        expect(colNames).toContain("id");
        expect(colNames).not.toContain("user_id");
    });
});

// ── Test 3: No access → 404, UPDATE NOT issued ────────────────────────────────

describe("POST /chat/:chatId/generate-title — no access", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("returns 404 and does NOT call update when checkProjectAccess returns ok=false", async () => {
        const chatId = "chat-noaccess-789";
        const ownerId = "user-owner";
        const strangerId = "user-stranger";
        const projectId = "proj-2";

        let updateCalled = false;

        const selectChatChain = {
            eq: vi.fn().mockReturnThis(),
            single: vi.fn().mockResolvedValue({
                data: { id: chatId, user_id: ownerId, project_id: projectId },
                error: null,
            }),
        };

        // project: stranger is NOT in shared_with
        const selectProjectChain = {
            eq: vi.fn().mockReturnThis(),
            single: vi.fn().mockResolvedValue({
                data: {
                    id: projectId,
                    user_id: ownerId,
                    shared_with: ["somebody-else@example.com"],
                },
                error: null,
            }),
        };

        mockCreateServerSupabase.mockReturnValue({
            from: vi.fn((table: string) => {
                if (table === "chats") {
                    return {
                        select: vi.fn().mockReturnValue(selectChatChain),
                        update: vi.fn().mockImplementation(() => {
                            updateCalled = true;
                            return { eq: vi.fn().mockReturnThis() };
                        }),
                    };
                }
                if (table === "projects") {
                    return {
                        select: vi.fn().mockReturnValue(selectProjectChain),
                    };
                }
                return {};
            }),
        });

        const res = await supertest(app)
            .post(`/chat/${chatId}/generate-title`)
            .set("x-test-user-id", strangerId)
            .set("x-test-user-email", "stranger@example.com")
            .send({ message: "Analyze this contract." });

        expect(res.status).toBe(404);
        expect(updateCalled).toBe(false);
    });
});
