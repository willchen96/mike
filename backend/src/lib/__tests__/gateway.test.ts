import { getUserApiKeyStatus } from "../userApiKeys";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  gatewayConfig,
  gatewayModelId,
  parseGatewayModels,
} from "../llm/gateway";
import { providerForModel, resolveModel } from "../llm/models";
import {
  gatewayAwarePreference,
  resolveEffectiveChatModel,
  titleModelForChat,
} from "../modelSelection";
import { resolveRequestedModel } from "../routerModels";
import type { createServerSupabase } from "../supabase";

beforeEach(() => {
  for (const name of [
    "BASE_URL",
    "MODELS",
    "API_KEY",
    "LABEL",
    "DEFAULT_MODEL",
  ])
    vi.stubEnv(`GATEWAY_${name}`, "");
});
afterEach(() => vi.unstubAllEnvs());
const db = {} as ReturnType<typeof createServerSupabase>;
function configure() {
  vi.stubEnv("GATEWAY_BASE_URL", " http://localhost:8080/v1/// ");
  vi.stubEnv(
    "GATEWAY_MODELS",
    "legal-chat=Legal chat,vendor/model,gateway/nested/model",
  );
}
describe("gateway configuration", () => {
  it("trims entries and preserves catalog order and names", () => {
    expect(
      parseGatewayModels(" a = First , vendor/model , gateway/x=Last "),
    ).toEqual([
      { id: "a", label: "First" },
      { id: "vendor/model", label: "vendor/model" },
      { id: "gateway/x", label: "Last" },
    ]);
  });
  it.each([
    "",
    "a,",
    ",a",
    "a,,b",
    "a,a=Duplicate",
    "=Name",
    "a=",
    "a=b=c",
    "bad id",
  ])("rejects invalid catalog %s", (catalog) => {
    expect(() => parseGatewayModels(catalog)).toThrow("GATEWAY_MODELS");
  });
  it("has no public endpoint fallback and validates the default", () => {
    expect(gatewayConfig()).toBeNull();
    vi.stubEnv("GATEWAY_MODELS", "a");
    expect(() => gatewayConfig()).toThrow("GATEWAY_BASE_URL");
    configure();
    expect(gatewayConfig()).toMatchObject({
      baseURL: "http://localhost:8080/v1",
      defaultModel: "gateway/legal-chat",
      label: "Gateway",
    });
    vi.stubEnv("GATEWAY_DEFAULT_MODEL", "vendor/model");
    expect(gatewayConfig()?.defaultModel).toBe("gateway/vendor/model");
    vi.stubEnv("GATEWAY_DEFAULT_MODEL", "unknown");
    expect(() => gatewayConfig()).toThrow("GATEWAY_DEFAULT_MODEL");
  });
  it.each([
    "ftp://host/v1",
    "https://user:password@host/v1",
    "https://host/v1?key=x",
    "not a URL",
  ])("rejects unsafe base %s", (base) => {
    configure();
    vi.stubEnv("GATEWAY_BASE_URL", base);
    expect(() => gatewayConfig()).toThrow("GATEWAY_BASE_URL");
  });
  it("removes exactly one prefix and checks membership without user selections", async () => {
    configure();
    expect(gatewayModelId("gateway/gateway/nested/model")).toBe(
      "gateway/nested/model",
    );
    expect(providerForModel("gateway/legal-chat")).toBe("gateway");
    expect(resolveModel("gateway/unlisted", "fallback")).toBe("fallback");
    expect(
      await resolveRequestedModel("gateway/vendor/model", "", "u", db, "throw"),
    ).toBe("gateway/vendor/model");
    await expect(
      resolveRequestedModel("gateway/unlisted", "", "u", db, "throw"),
    ).rejects.toThrow("not available");
  });
  it("falls back for stale preferences but keeps usable and explicit selections", async () => {
    configure();
    const args = {
      userId: "u",
      db,
      apiKeys: {},
      chatModel: "gemini-3.7-flash",
    };
    expect(await resolveEffectiveChatModel(args)).toMatchObject({
      ok: true,
      model: "gateway/legal-chat",
    });
    expect(
      await resolveEffectiveChatModel({
        ...args,
        requested: "gateway/vendor/model",
      }),
    ).toMatchObject({ ok: true, model: "gateway/vendor/model" });
    expect(
      await resolveEffectiveChatModel({
        ...args,
        requested: "gateway/unlisted",
      }),
    ).toMatchObject({ ok: false, status: 400 });
    expect(
      await resolveEffectiveChatModel({
        ...args,
        requested: "gemini-3.7-flash",
      }),
    ).toMatchObject({ ok: false, status: 422 });
    expect(
      await resolveEffectiveChatModel({ ...args, apiKeys: { gemini: "key" } }),
    ).toMatchObject({ ok: true, model: "gemini-3.7-flash" });
    expect(gatewayAwarePreference("gemini-3.7-flash", () => false)).toBe(
      "gateway/legal-chat",
    );
    expect(titleModelForChat("gateway/vendor/model")).toBe(
      "gateway/legal-chat",
    );
  });
  it("keeps the original no-selection behavior when unconfigured", async () => {
    expect(
      await resolveEffectiveChatModel({ userId: "u", db, apiKeys: {} }),
    ).toMatchObject({ ok: false, code: "model_required" });
    expect(gatewayAwarePreference(null, () => false)).toBeNull();
  });
});

it("exposes gateway availability without a user key, endpoint or bearer token", async () => {
  configure();
  vi.stubEnv("GATEWAY_API_KEY", "deployment-secret");
  const client = {
    from: () => ({
      select: () => ({ eq: async () => ({ data: [], error: null }) }),
    }),
  } as unknown as ReturnType<typeof createServerSupabase>;
  const status = await getUserApiKeyStatus("u", client);
  expect(status.gateway).toMatchObject({
    available: true,
    provider: "gateway",
    label: "Gateway",
  });
  expect(JSON.stringify(status)).not.toMatch(
    /deployment-secret|localhost|baseURL|apiKey/,
  );
});
