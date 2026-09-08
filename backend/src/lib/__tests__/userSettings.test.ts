import { beforeEach, describe, expect, it, vi } from "vitest";

const { getUserApiKeys, getAllUserRouterModels } = vi.hoisted(() => ({
    getUserApiKeys: vi.fn(),
    getAllUserRouterModels: vi.fn(),
}));

vi.mock("../userApiKeys", () => ({
    getUserApiKeys: (...args: unknown[]) => getUserApiKeys(...args),
}));

vi.mock("../routerModels", async () => ({
    ...(await vi.importActual<typeof import("../routerModels")>(
        "../routerModels",
    )),
    getAllUserRouterModels: (...args: unknown[]) =>
        getAllUserRouterModels(...args),
}));

vi.mock("../supabase", () => ({ createServerSupabase: vi.fn() }));

import { getUserModelSettings } from "../userSettings";

function profileDb(row: Record<string, unknown> | null) {
    const chain: Record<string, unknown> = {};
    for (const method of ["from", "select", "eq"]) {
        chain[method] = vi.fn(() => chain);
    }
    chain.single = vi.fn(async () => ({ data: row, error: null }));
    return chain as never;
}

const NO_KEYS = {
    claude: null,
    gemini: "env-gemini-key",
    openai: null,
    openrouter: "env-openrouter-key",
    vercel: null,
    courtlistener: null,
};

beforeEach(() => {
    vi.clearAllMocks();
    getUserApiKeys.mockResolvedValue(NO_KEYS);
    getAllUserRouterModels.mockResolvedValue({
        openrouter: ["allowed/model"],
        vercel: [],
        "opencode-go": [],
    });
});

describe("getUserModelSettings router-model allowlist", () => {
    it("loads the professional profile used to personalise prompts", async () => {
        const settings = await getUserModelSettings(
            "user-1",
            profileDb({
                title_model: "claude-haiku-4-5",
                tabular_model: "claude-sonnet-5",
                legal_research_us: true,
                display_name: "Ada",
                organisation: "Acme LLP",
                jurisdiction: "Singapore",
                practice_setting: "private_practice",
                professional_title: "Partner",
                practice_areas: ["Litigation"],
            }),
        );

        expect(settings.personalisation).toEqual({
            displayName: "Ada",
            organisation: "Acme LLP",
            jurisdiction: "Singapore",
            practiceSetting: "private_practice",
            professionalTitle: "Partner",
            practiceAreas: ["Litigation"],
        });
    });

    it("keeps a stored router preference that is in the saved selection", async () => {
        const settings = await getUserModelSettings(
            "user-1",
            profileDb({
                title_model: "openrouter/allowed/model",
                tabular_model: "openrouter/allowed/model",
                legal_research_us: true,
            }),
        );

        expect(settings.title_model).toBe("openrouter/allowed/model");
        expect(settings.tabular_model).toBe("openrouter/allowed/model");
    });

    it("clears stored router preferences outside the saved selection", async () => {
        const settings = await getUserModelSettings(
            "user-1",
            profileDb({
                title_model: "openrouter/pricy/frontier-model",
                tabular_model: "vercel/pricy/frontier-model",
                legal_research_us: true,
            }),
        );

        expect(settings.title_model).toBeNull();
        expect(settings.tabular_model).toBeNull();
    });

    it("keeps first-party preferences untouched", async () => {
        const settings = await getUserModelSettings(
            "user-1",
            profileDb({
                title_model: "claude-haiku-4-5",
                tabular_model: "claude-sonnet-5",
                legal_research_us: true,
            }),
        );

        expect(settings.title_model).toBe("claude-haiku-4-5");
        expect(settings.tabular_model).toBe("claude-sonnet-5");
    });
});

// A database without the 20260821 onboarding migration rejects the widened
// select outright (42703). The retry with the pre-migration column set must
// preserve the user's saved models and legal-research choice — silently
// resetting them was the severe half of the un-migrated-DB bug.
function retryingProfileDb(
    first: { data: unknown; error: unknown },
    second: { data: unknown; error: unknown },
) {
    const results = [first, second];
    const chain: Record<string, unknown> = {};
    for (const method of ["from", "select", "eq"]) {
        chain[method] = vi.fn(() => chain);
    }
    chain.single = vi.fn(async () => results.shift() ?? second);
    return chain as never;
}

describe("getUserModelSettings on an un-migrated database", () => {
    it("retries without the onboarding columns and keeps saved settings", async () => {
        const settings = await getUserModelSettings(
            "user-1",
            retryingProfileDb(
                {
                    data: null,
                    error: {
                        code: "42703",
                        message:
                            "column user_profiles.jurisdiction does not exist",
                    },
                },
                {
                    data: {
                        title_model: "claude-haiku-4-5",
                        tabular_model: "claude-sonnet-5",
                        legal_research_us: false,
                    },
                    error: null,
                },
            ),
        );

        expect(settings.title_model).toBe("claude-haiku-4-5");
        expect(settings.tabular_model).toBe("claude-sonnet-5");
        expect(settings.legal_research_us).toBe(false);
        expect(settings.personalisation).toMatchObject({
            displayName: null,
            practiceAreas: [],
        });
    });

    it("returns empty optional preferences when the retry also fails", async () => {
        const settings = await getUserModelSettings(
            "user-1",
            retryingProfileDb(
                {
                    data: null,
                    error: {
                        code: "42703",
                        message:
                            "column user_profiles.jurisdiction does not exist",
                    },
                },
                {
                    data: null,
                    error: { code: "42703", message: "even older database" },
                },
            ),
        );

        expect(settings.legal_research_us).toBe(true);
        expect(settings.title_model).toBeNull();
        expect(settings.tabular_model).toBeNull();
    });
});


it("uses gateway defaults for unavailable saved title and tabular preferences", async () => {
    vi.stubEnv("GATEWAY_BASE_URL", "http://localhost:8080/v1");
    vi.stubEnv("GATEWAY_MODELS", "legal-chat,review");
    vi.stubEnv("GATEWAY_DEFAULT_MODEL", "review");
    getUserApiKeys.mockResolvedValue({});
    try {
        const settings = await getUserModelSettings("user-1", profileDb({
            title_model: "claude-haiku-4-5", tabular_model: "gemini-3.7-flash",
        }));
        expect(settings.title_model).toBe("gateway/review");
        expect(settings.tabular_model).toBe("gateway/review");
        expect(settings.last_selected_chat_model).toBe("gateway/review");
    } finally { vi.unstubAllEnvs(); }
});
