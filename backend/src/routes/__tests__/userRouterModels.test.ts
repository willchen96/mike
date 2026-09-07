import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
    getUserApiKeyStatus,
    getAllUserRouterModels,
    replaceUserRouterModels,
} = vi.hoisted(() => ({
    getUserApiKeyStatus: vi.fn(),
    getAllUserRouterModels: vi.fn(),
    replaceUserRouterModels: vi.fn(),
}));

vi.mock("../../middleware/auth", () => ({
    requireAuth: (
        _req: unknown,
        res: { locals: Record<string, unknown> },
        next: () => void,
    ) => {
        res.locals.userId = "user-1";
        next();
    },
    requireMfaIfEnrolled: (_req: unknown, _res: unknown, next: () => void) =>
        next(),
}));

// user.ts only needs the model constants + resolveModel from the llm barrel;
// importing the real barrel would load every provider adapter.
vi.mock("../../lib/llm", async () => vi.importActual("../../lib/llm/models"));

vi.mock("../../lib/audit", () => ({ recordAudit: vi.fn() }));
vi.mock("../../lib/userLookup", () => ({ findProfileUserByEmail: vi.fn() }));
vi.mock("../../lib/userDataCleanup", () => ({
    deleteAllUserChats: vi.fn(),
    deleteAllUserTabularReviews: vi.fn(),
    deleteUserAccountData: vi.fn(),
    deleteUserProjects: vi.fn(),
}));
vi.mock("../../lib/userDataExport", () => ({
    buildUserAccountExport: vi.fn(),
    buildUserChatsExport: vi.fn(),
    buildUserTabularReviewsExport: vi.fn(),
    userExportFilename: vi.fn(),
}));
vi.mock("../../lib/mcpConnectors", () => ({
    completeUserMcpConnectorOAuth: vi.fn(),
    createUserMcpConnector: vi.fn(),
    deleteUserMcpConnector: vi.fn(),
    getUserMcpConnector: vi.fn(),
    listUserMcpConnectors: vi.fn(),
    McpOAuthRequiredError: class McpOAuthRequiredError extends Error {},
    refreshUserMcpConnectorTools: vi.fn(),
    setUserMcpToolEnabled: vi.fn(),
    startUserMcpConnectorOAuth: vi.fn(),
    updateUserMcpConnector: vi.fn(),
}));
vi.mock("../../lib/userApiKeys", () => ({
    getUserApiKeyStatus: (...args: unknown[]) => getUserApiKeyStatus(...args),
    hasEnvApiKey: vi.fn(() => false),
    normalizeApiKeyProvider: vi.fn(),
    saveUserApiKey: vi.fn(),
}));
vi.mock("../../lib/routerModels", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../lib/routerModels")>()),
    getAllUserRouterModels: (...args: unknown[]) =>
        getAllUserRouterModels(...args),
    replaceUserRouterModels: (...args: unknown[]) =>
        replaceUserRouterModels(...args),
}));

const PROFILE_ROW = {
    display_name: "Dev",
    organisation: null,
    message_credits_used: 0,
    // Far future so loadProfile's credit-reset branch never runs in tests.
    credits_reset_date: "2999-01-01T00:00:00.000Z",
    tier: "Free",
    title_model: null,
    tabular_model: "gemini-3-flash-preview",
    mfa_on_login: false,
    legal_research_us: true,
    quick_actions_visible: true,
};

// A permissive supabase mock: every query-builder call chains, awaiting the
// chain resolves { data, error }, and maybeSingle/single resolve the profile
// row. That covers ensureProfileRow (upsert), the profile update, and
// selectProfile without modelling PostgREST.
function chainDb() {
    const chain: Record<string, unknown> = {};
    for (const method of ["from", "select", "eq", "update", "upsert"]) {
        chain[method] = vi.fn(() => chain);
    }
    chain.maybeSingle = vi.fn(async () => ({ data: PROFILE_ROW, error: null }));
    chain.single = vi.fn(async () => ({ data: PROFILE_ROW, error: null }));
    chain.then = (
        resolve: (value: unknown) => unknown,
        reject?: (reason: unknown) => unknown,
    ) => Promise.resolve({ data: null, error: null }).then(resolve, reject);
    return chain;
}

vi.mock("../../lib/supabase", () => ({
    createServerSupabase: vi.fn(() => chainDb()),
}));

import { userRouter, normalizeRouterModels } from "../user";

const app = express();
app.use(express.json());
app.use("/user", userRouter);

const API_KEY_STATUS = {
    claude: false,
    gemini: false,
    openai: false,
    openrouter: true,
    vercel: true,
    "opencode-go": true,
    courtlistener: false,
    sources: {
        claude: null,
        gemini: null,
        openai: null,
        openrouter: "user",
        vercel: "user",
        "opencode-go": "user",
        courtlistener: null,
    },
};

beforeEach(() => {
    vi.clearAllMocks();
    getUserApiKeyStatus.mockResolvedValue(API_KEY_STATUS);
    getAllUserRouterModels.mockResolvedValue({
        openrouter: [],
        vercel: [],
        "opencode-go": [],
    });
    replaceUserRouterModels.mockResolvedValue(undefined);
});

describe("PATCH /user/profile router model selections", () => {
    it("accepts a catalog id that begins with the router's own slug", async () => {
        // OpenRouter's catalog really contains "openrouter/auto". Stripping
        // the router prefix before validating would leave "auto", fail the
        // vendor/model shape check, and 400 the whole profile PATCH.
        const response = await request(app)
            .patch("/user/profile")
            .send({ openRouterModels: ["openrouter/auto"] });

        expect(response.status).toBe(200);
        expect(replaceUserRouterModels).toHaveBeenCalledWith(
            "user-1",
            "openrouter",
            ["openrouter/auto"],
            expect.anything(),
        );
    });

    it("accepts Vercel catalog ids that begin with the vercel slug", async () => {
        const response = await request(app)
            .patch("/user/profile")
            .send({ vercelModels: ["vercel/v0-1.5-md"] });

        expect(response.status).toBe(200);
        expect(replaceUserRouterModels).toHaveBeenCalledWith(
            "user-1",
            "vercel",
            ["vercel/v0-1.5-md"],
            expect.anything(),
        );
    });

    it("still canonicalizes composer-form ids to the raw catalog id", async () => {
        const response = await request(app)
            .patch("/user/profile")
            .send({
                openRouterModels: [
                    "openrouter/anthropic/claude-sonnet-4.5",
                    "openai/gpt-5.4",
                ],
            });

        expect(response.status).toBe(200);
        expect(replaceUserRouterModels).toHaveBeenCalledWith(
            "user-1",
            "openrouter",
            ["anthropic/claude-sonnet-4.5", "openai/gpt-5.4"],
            expect.anything(),
        );
    });

    it("reports the 50-model cap instead of 'invalid or duplicate'", async () => {
        const models = Array.from(
            { length: 51 },
            (_, index) => `vendor/model-${index}`,
        );

        const response = await request(app)
            .patch("/user/profile")
            .send({ openRouterModels: models });

        expect(response.status).toBe(400);
        expect(response.body.detail).toBe(
            "openRouterModels can include at most 50 models",
        );
        expect(replaceUserRouterModels).not.toHaveBeenCalled();
    });

    it("rejects ids that are not vendor/model shaped", async () => {
        const response = await request(app)
            .patch("/user/profile")
            .send({ openRouterModels: ["not a model"] });

        expect(response.status).toBe(400);
        expect(replaceUserRouterModels).not.toHaveBeenCalled();
    });

    it("accepts OpenCode Go's single-segment catalog ids", async () => {
        // OpenCode Go publishes bare model names, so the vendor/model shape
        // the other two routers are validated against would reject its whole
        // catalog.
        const response = await request(app)
            .patch("/user/profile")
            .send({ openCodeGoModels: ["glm-5", "opencode-go/kimi-k3"] });

        expect(response.status).toBe(200);
        expect(replaceUserRouterModels).toHaveBeenCalledWith(
            "user-1",
            "opencode-go",
            ["glm-5", "kimi-k3"],
            expect.anything(),
        );
    });

    it("still rejects an OpenCode Go id containing whitespace", async () => {
        const response = await request(app)
            .patch("/user/profile")
            .send({ openCodeGoModels: ["not a model"] });

        expect(response.status).toBe(400);
        expect(response.body.detail).toBe(
            "openCodeGoModels contains an invalid or duplicate model ID",
        );
        expect(replaceUserRouterModels).not.toHaveBeenCalled();
    });

    it("rejects OpenCode Go models that require an unsupported protocol", async () => {
        const response = await request(app)
            .patch("/user/profile")
            .send({ openCodeGoModels: ["gpt-5.6-luna"] });

        expect(response.status).toBe(400);
        expect(response.body.detail).toBe(
            "openCodeGoModels contains an invalid or duplicate model ID",
        );
        expect(replaceUserRouterModels).not.toHaveBeenCalled();
    });
});

describe("normalizeRouterModels", () => {
    it("keeps router-slug catalog ids verbatim", () => {
        expect(
            normalizeRouterModels(["openrouter/auto"], "openrouter"),
        ).toEqual(["openrouter/auto"]);
        expect(normalizeRouterModels(["vercel/v0-1.5-md"], "vercel")).toEqual([
            "vercel/v0-1.5-md",
        ]);
    });

    it("strips the router prefix only when the remainder is a full id", () => {
        expect(
            normalizeRouterModels(
                ["openrouter/deepseek/deepseek-v3", "deepseek/deepseek-v3"],
                "openrouter",
            ),
        ).toEqual(["deepseek/deepseek-v3"]);
    });

    it("accepts bare model names for OpenCode Go only", () => {
        expect(normalizeRouterModels(["glm-5"], "opencode-go")).toEqual([
            "glm-5",
        ]);
        expect(normalizeRouterModels(["glm-5"], "openrouter")).toEqual([]);
    });

    it("keeps Chat Completions and Messages models but filters unsupported protocols", () => {
        expect(
            normalizeRouterModels(
                [
                    "glm-5.3",
                    "qwen3.8-max",
                    "minimax-m3",
                    "gpt-5.6-luna",
                ],
                "opencode-go",
            ),
        ).toEqual(["glm-5.3", "qwen3.8-max", "minimax-m3"]);
    });
});


describe("gateway profile defaults", () => {
    it("replaces stale native preferences without requiring router selections", async () => {
        vi.stubEnv("GATEWAY_BASE_URL", "http://localhost:8080/v1");
        vi.stubEnv("GATEWAY_MODELS", "legal-chat=Legal chat");
        vi.stubEnv("GATEWAY_DEFAULT_MODEL", "");
        try {
            const res = await request(app).get("/user/profile");
            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({ titleModel: "gateway/legal-chat", tabularModel: "gateway/legal-chat", lastSelectedChatModel: "gateway/legal-chat" });
        } finally { vi.unstubAllEnvs(); }
    });
});
