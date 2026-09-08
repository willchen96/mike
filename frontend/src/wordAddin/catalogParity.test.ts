/**
 * Cross-package drift guard: the Word add-in mirrors the web app's model
 * catalog by hand (word-addin/src/taskpane/lib/modelCatalog.ts) until both
 * clients share one package. These tests import BOTH copies so a hand-edit
 * that drifts them apart fails CI instead of shipping two different pickers.
 */
import { describe, expect, it } from "vitest";
import {
    MODELS,
    DEFAULT_MODEL_ID,
    LEGACY_MODEL_IDS,
    canonicalModelId,
    modelDisplayName,
    openCodeGoModelOptions,
    openRouterModelOptions,
    vercelModelOptions,
} from "../app/components/assistant/ModelToggle";
import {
    STATIC_MODELS,
    DEFAULT_MODEL_ID as ADDIN_DEFAULT_MODEL_ID,
    LEGACY_MODEL_IDS as ADDIN_LEGACY_MODEL_IDS,
    canonicalModelId as addinCanonicalModelId,
    isAllowedModelId as addinIsAllowedModelId,
    isModelAvailable as addinIsModelAvailable,
    modelDisplayName as addinModelDisplayName,
    openCodeGoModelOptions as addinOpenCodeGoModelOptions,
    openRouterModelOptions as addinOpenRouterModelOptions,
    vercelModelOptions as addinVercelModelOptions,
} from "../../../word-addin/src/taskpane/lib/modelCatalog";
import type { ApiKeyStatus } from "../../../word-addin/src/taskpane/api/client";
import { isModelAvailable as webIsModelAvailable } from "../app/lib/modelAvailability";
import { isAllowedModelId as webIsAllowedModelId } from "../app/hooks/useSelectedModel";
import type { ApiKeyState } from "../app/lib/mikeApi";

describe("word add-in catalog parity", () => {
    it("offers exactly the web app's static models (id, label, group)", () => {
        const webModels = MODELS.map(({ id, label, group }) => ({
            id,
            label,
            group,
        }));
        const addinModels = STATIC_MODELS.map(({ id, label, group }) => ({
            id,
            label,
            group,
        }));
        expect(addinModels).toEqual(webModels);
    });

    it("shares the web app's default model", () => {
        expect(ADDIN_DEFAULT_MODEL_ID).toBe(DEFAULT_MODEL_ID);
    });

    it("maps the same retired ids to the same current ids", () => {
        // A rename is only survivable if BOTH clients map the old id. The web
        // app maps it and the add-in did not, so the same localStorage value
        // (chat/profile selections are shared by API contract) resolved differently
        // depending on which client read it.
        expect(ADDIN_LEGACY_MODEL_IDS).toEqual(LEGACY_MODEL_IDS);
        for (const id of [
            ...Object.keys(LEGACY_MODEL_IDS),
            ...Object.values(LEGACY_MODEL_IDS),
            ...MODELS.map((model) => model.id),
            "openrouter/openai/gpt-5.4",
            "opencode-go/glm-5",
            "ollama/llama3:8b",
            "not-a-model",
        ]) {
            expect.soft(addinCanonicalModelId(id), id).toBe(
                canonicalModelId(id),
            );
        }
    });

    it("accepts exactly the same set of stored selection ids", () => {
        const probes = [
            ...MODELS.map((model) => model.id),
            ...Object.keys(LEGACY_MODEL_IDS),
            ...Object.values(LEGACY_MODEL_IDS),
            "claude-haiku-4-5",
            "openrouter/openai/gpt-5.4",
            "openrouter/openrouter/auto",
            "vercel/openai/gpt-5.4",
            "opencode-go/glm-5",
            "ollama/llama3:8b",
            "openrouter",
            "opencode-go",
            "",
            "gpt-5.4-turbo-imaginary",
        ];
        for (const id of probes) {
            expect
                .soft(addinIsAllowedModelId(id), id)
                .toBe(webIsAllowedModelId(id));
        }
    });

    it("renders identical display names for every shared id", () => {
        const sharedIds = [
            ...MODELS.map((model) => model.id),
            "openrouter/anthropic/claude-sonnet-4.5",
            "openrouter/meta-llama/llama-3-3-70b-instruct",
            "openrouter/openrouter/auto",
            "vercel/openai/gpt-5.4",
            "vercel/vercel/v0-1.5-md",
            "opencode-go/glm-5",
            "opencode-go/qwen3.8-max",
            "ollama/llama3:8b",
        ];
        for (const id of sharedIds) {
            expect(addinModelDisplayName(id)).toBe(modelDisplayName(id));
        }
    });

    it("builds the same composer model id from a stored selection", () => {
        // A stored selection is the router's raw catalog id. Both clients must
        // send `router/<catalog-id>` verbatim — including ids that begin with
        // the router's own slug, where a defensive inner strip would make the
        // add-in send a different model than the web app for the same row.
        const stored = [
            "anthropic/claude-sonnet-4.5",
            "openrouter/auto",
            "vercel/v0-1.5-md",
        ];
        expect(
            addinOpenRouterModelOptions(stored).map((option) => option.id),
        ).toEqual(openRouterModelOptions(stored).map((option) => option.id));
        expect(
            addinVercelModelOptions(stored).map((option) => option.id),
        ).toEqual(vercelModelOptions(stored).map((option) => option.id));
        expect(
            addinOpenCodeGoModelOptions(["glm-5", "opencode-go/kimi-k3"]).map(
                (option) => option.id,
            ),
        ).toEqual(
            openCodeGoModelOptions(["glm-5", "opencode-go/kimi-k3"]).map(
                (option) => option.id,
            ),
        );
        expect(
            addinOpenRouterModelOptions(["openrouter/auto"])[0]?.id,
        ).toBe("openrouter/openrouter/auto");
    });

    it("gates every shared model on the same provider key in both clients", () => {
        const providers = [
            "claude",
            "gemini",
            "openai",
            "openrouter",
            "vercel",
            "opencode-go",
        ] as const;
        const sharedIds = [
            ...MODELS.map((model) => model.id),
            "openrouter/openai/gpt-5.4",
            "vercel/openai/gpt-5.4",
            "opencode-go/glm-5",
        ];
        for (const configured of providers) {
            const addinStatus = {
                claude: false,
                gemini: false,
                openai: false,
                openrouter: false,
                vercel: false,
                "opencode-go": false,
                courtlistener: false,
                [configured]: true,
            } as unknown as ApiKeyStatus;
            const webState = Object.fromEntries(
                [...providers, "courtlistener"].map((provider) => [
                    provider,
                    {
                        configured: provider === configured,
                        source: provider === configured ? "user" : null,
                    },
                ]),
            ) as unknown as ApiKeyState;
            for (const id of sharedIds) {
                expect
                    .soft(
                        addinIsModelAvailable(id, addinStatus),
                        `${id} with only ${configured} configured`,
                    )
                    .toBe(webIsModelAvailable(id, webState));
            }
        }
    });
});


it("keeps gateway membership and availability identical across clients", () => {
    const gateway = { provider: "gateway" as const, label: "Legal models", available: true, defaultModel: "gateway/legal-chat", models: [
        { id: "gateway/legal-chat", label: "Legal chat", group: "Legal models", source: "Legal models", provider: "gateway" as const, available: true },
        { id: "gateway/offline", label: "Offline", group: "Legal models", source: "Legal models", provider: "gateway" as const, available: false },
    ] };
    const web = { gateway } as ApiKeyState;
    const addin = { gateway } as unknown as ApiKeyStatus;
    for (const id of ["gateway/legal-chat", "gateway/offline", "gateway/unlisted"]) {
        expect(addinIsModelAvailable(id, addin)).toBe(webIsModelAvailable(id, web));
        expect(webIsModelAvailable(id, web)).toBe(id === "gateway/legal-chat");
    }
});
