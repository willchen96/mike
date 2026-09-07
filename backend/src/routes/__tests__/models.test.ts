import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getUserApiKeys } = vi.hoisted(() => ({
    getUserApiKeys: vi.fn(),
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
}));

vi.mock("../../lib/supabase", () => ({
    createServerSupabase: vi.fn(() => ({ from: vi.fn() })),
}));

vi.mock("../../lib/userApiKeys", () => ({
    getUserApiKeys: (...args: unknown[]) => getUserApiKeys(...args),
}));

import { modelsRouter } from "../models";
import {
    INTERNAL_ERROR_CODE,
    INTERNAL_ERROR_MESSAGE,
} from "../../lib/httpError";

const app = express();
app.use("/models", modelsRouter);

describe("GET /models/openrouter", () => {
    beforeEach(() => {
        getUserApiKeys.mockResolvedValue({ openrouter: "or-user-key" });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.clearAllMocks();
        delete process.env.OPENROUTER_BASE_URL;
    });

    it("honors OPENROUTER_BASE_URL like the chat adapter", async () => {
        process.env.OPENROUTER_BASE_URL = "http://localhost:4141/api/v1/";
        const fetchMock = vi
            .fn()
            .mockResolvedValue(
                new Response(JSON.stringify({ data: [] }), { status: 200 }),
            );
        vi.stubGlobal("fetch", fetchMock);

        const response = await request(app).get("/models/openrouter");

        expect(response.status).toBe(200);
        expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(
            /^http:\/\/localhost:4141\/api\/v1\/models\?/,
        );
    });

    it("requires a configured OpenRouter key", async () => {
        getUserApiKeys.mockResolvedValue({});
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);

        const response = await request(app).get("/models/openrouter");

        expect(response.status).toBe(422);
        expect(response.body.code).toBe("missing_api_key");
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("returns the authenticated OpenRouter catalog in selector shape", async () => {
        const fetchMock = vi.fn().mockResolvedValue(
            new Response(
                JSON.stringify({
                    data: [
                        {
                            id: "anthropic/claude-sonnet-4.5",
                            name: "Claude Sonnet 4.5",
                            pricing: {
                                prompt: "0.000003",
                                completion: "0.000015",
                            },
                        },
                        { id: "openai/gpt-5.4" },
                        { id: null, name: "Invalid" },
                    ],
                }),
                {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                },
            ),
        );
        vi.stubGlobal("fetch", fetchMock);

        const response = await request(app).get("/models/openrouter");

        expect(response.status).toBe(200);
        expect(response.body.models).toEqual([
            {
                id: "anthropic/claude-sonnet-4.5",
                label: "Claude Sonnet 4.5",
                pricing: { input: "0.000003", output: "0.000015" },
            },
            { id: "openai/gpt-5.4", label: "openai/gpt-5.4" },
        ]);
        expect(fetchMock).toHaveBeenCalledWith(
            expect.stringContaining("https://openrouter.ai/api/v1/models?"),
            { headers: { Authorization: "Bearer or-user-key" } },
        );
    });

    it("does not expose upstream authentication failures as a success", async () => {
        vi.stubGlobal(
            "fetch",
            vi
                .fn()
                .mockResolvedValue(
                    new Response("invalid key", { status: 401 }),
                ),
        );

        const response = await request(app).get("/models/openrouter");

        expect(response.status).toBe(502);
        expect(response.body).toEqual({
            code: INTERNAL_ERROR_CODE,
            detail: INTERNAL_ERROR_MESSAGE,
        });
        expect(response.text).not.toContain("invalid key");
    });
});

describe("GET /models/vercel", () => {
    beforeEach(() => {
        getUserApiKeys.mockResolvedValue({ vercel: "vercel-user-key" });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.clearAllMocks();
    });

    it("requires a configured Vercel AI Gateway key", async () => {
        getUserApiKeys.mockResolvedValue({});
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);

        const response = await request(app).get("/models/vercel");

        expect(response.status).toBe(422);
        expect(response.body.code).toBe("missing_api_key");
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("returns text, tool-capable models from Vercel's public catalog", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(
                new Response(
                    JSON.stringify({
                        data: [
                            {
                                id: "anthropic/claude-sonnet-4.5",
                                name: "Claude Sonnet 4.5",
                                type: "language",
                                tags: ["tool-use"],
                                modalities: { output: ["text"] },
                                pricing: {
                                    input: "0.000003",
                                    output: "0.000015",
                                    varies_by_provider: true,
                                },
                            },
                            {
                                id: "openai/gpt-5.4",
                                type: "language",
                                supported_parameters: ["tools"],
                                pricing: {
                                    input: "0.00000125",
                                    output: "0.00001",
                                    input_tiers: [
                                        { cost: "0.00000125", min: 0 },
                                    ],
                                },
                            },
                            {
                                id: "image/model",
                                type: "image",
                                modalities: { output: ["image"] },
                            },
                            {
                                id: "text/no-tools",
                                type: "language",
                                modalities: { output: ["text"] },
                            },
                        ],
                    }),
                    {
                        status: 200,
                        headers: { "Content-Type": "application/json" },
                    },
                ),
            ),
        );

        const response = await request(app).get("/models/vercel");

        expect(response.status).toBe(200);
        expect(response.body.models).toEqual([
            {
                id: "anthropic/claude-sonnet-4.5",
                label: "Claude Sonnet 4.5",
                pricing: {
                    input: "0.000003",
                    output: "0.000015",
                    variesByProvider: true,
                },
            },
            {
                id: "openai/gpt-5.4",
                label: "openai/gpt-5.4",
                pricing: {
                    input: "0.00000125",
                    output: "0.00001",
                    tiered: true,
                },
            },
        ]);
        expect(fetch).toHaveBeenCalledWith(
            "https://ai-gateway.vercel.sh/v1/models",
        );
    });
});

describe("GET /models/opencode-go", () => {
    beforeEach(() => {
        getUserApiKeys.mockResolvedValue({ "opencode-go": "oc-user-key" });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.clearAllMocks();
        delete process.env.OPENCODE_GO_BASE_URL;
    });

    it("requires a configured OpenCode Go key", async () => {
        getUserApiKeys.mockResolvedValue({});
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);

        const response = await request(app).get("/models/opencode-go");

        expect(response.status).toBe(422);
        expect(response.body.code).toBe("missing_api_key");
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("returns supported Chat Completions and Messages models with the key server-side", async () => {
        const fetchMock = vi.fn().mockResolvedValue(
            new Response(
                JSON.stringify({
                    data: [
                        // Qwen and MiniMax use Anthropic Messages; GPT uses the
                        // unsupported Responses protocol.
                        { id: "qwen3.8-max", name: "Qwen3.8 Max" },
                        { id: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
                        { id: "minimax-m3", name: "MiniMax M3" },
                        { id: "glm-5.3", name: "GLM-5.3" },
                        { id: "qwen3.8-max", name: "Qwen3.8 Max (updated)" },
                        { id: "kimi-k3" },
                        // The upstream response has no protocol metadata, so
                        // unknown future models must fail closed too.
                        { id: "future-model", name: "Future Model" },
                        { id: "bad id" },
                        { id: "   " },
                        null,
                    ],
                }),
                {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                },
            ),
        );
        vi.stubGlobal("fetch", fetchMock);

        const response = await request(app).get("/models/opencode-go");

        expect(response.status).toBe(200);
        expect(response.body.models).toEqual([
            { id: "glm-5.3", label: "GLM-5.3" },
            { id: "kimi-k3", label: "kimi-k3" },
            { id: "minimax-m3", label: "MiniMax M3" },
            { id: "qwen3.8-max", label: "Qwen3.8 Max (updated)" },
        ]);
        expect(fetchMock).toHaveBeenCalledWith(
            "https://opencode.ai/zen/go/v1/models",
            { headers: { Authorization: "Bearer oc-user-key" } },
        );
        // The user's key must never reach the browser.
        expect(JSON.stringify(response.body)).not.toContain("oc-user-key");
    });

    it("honors OPENCODE_GO_BASE_URL like the chat adapter", async () => {
        process.env.OPENCODE_GO_BASE_URL = "http://localhost:4242/v1/";
        const fetchMock = vi
            .fn()
            .mockResolvedValue(
                new Response(JSON.stringify({ data: [] }), { status: 200 }),
            );
        vi.stubGlobal("fetch", fetchMock);

        const response = await request(app).get("/models/opencode-go");

        expect(response.status).toBe(200);
        expect(fetchMock.mock.calls[0]?.[0]).toBe(
            "http://localhost:4242/v1/models",
        );
    });

    it("reports an upstream failure as a bad gateway", async () => {
        const consoleError = vi
            .spyOn(console, "error")
            .mockImplementation(() => {});
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(new Response("nope", { status: 401 })),
        );

        const response = await request(app).get("/models/opencode-go");

        expect(response.status).toBe(502);
        expect(response.body).toEqual({
            code: INTERNAL_ERROR_CODE,
            detail: INTERNAL_ERROR_MESSAGE,
        });
        expect(response.text).not.toContain("nope");
        expect(consoleError).toHaveBeenCalledOnce();
        consoleError.mockRestore();
    });
});


describe("GET /models/gateway", () => {
    afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
    it("exposes only the configured catalog without discovery or secrets", async () => {
        vi.stubEnv("GATEWAY_BASE_URL", "https://gateway.example/v1");
        vi.stubEnv("GATEWAY_MODELS", "legal-chat=Legal chat,vendor/model=Review");
        vi.stubEnv("GATEWAY_LABEL", "Legal models");
        vi.stubEnv("GATEWAY_API_KEY", "deployment-secret");
        vi.stubEnv("GATEWAY_DEFAULT_MODEL", "vendor/model");
        const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
        const res = await request(app).get("/models/gateway");
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ provider: "gateway", label: "Legal models", available: true,
            defaultModel: "gateway/vendor/model", models: [
                { id: "gateway/legal-chat", label: "Legal chat", group: "Legal models", source: "Legal models", provider: "gateway", available: true },
                { id: "gateway/vendor/model", label: "Review", group: "Legal models", source: "Legal models", provider: "gateway", available: true },
            ] });
        expect(JSON.stringify(res.body)).not.toMatch(/deployment-secret|gateway.example|Authorization/);
        expect(fetchMock).not.toHaveBeenCalled();
    });
    it("returns an empty catalog when unconfigured", async () => {
        for (const name of ["BASE_URL", "MODELS", "API_KEY", "LABEL", "DEFAULT_MODEL"]) vi.stubEnv(`GATEWAY_${name}`, "");
        const res = await request(app).get("/models/gateway");
        expect(res.body).toEqual({ provider: "gateway", label: "Gateway", available: false, defaultModel: null, models: [] });
    });
});
