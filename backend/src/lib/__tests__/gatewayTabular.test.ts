import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { createServerSupabase } from "../supabase";
const { getUserModelSettings } = vi.hoisted(() => ({
  getUserModelSettings: vi.fn(),
}));
vi.mock("../userSettings", () => ({ getUserModelSettings }));
import { validateSelectedModel } from "../tabular/tabular.shared";
const db = {} as ReturnType<typeof createServerSupabase>;
beforeEach(() => {
  vi.stubEnv("GATEWAY_BASE_URL", "http://localhost:8080/v1");
  vi.stubEnv("GATEWAY_MODELS", "chat,review");
  vi.stubEnv("GATEWAY_DEFAULT_MODEL", "review");
  getUserModelSettings.mockResolvedValue({ api_keys: {}, tabular_model: null });
});
afterEach(() => vi.unstubAllEnvs());
it("uses the gateway default for a stored native model without a key", async () => {
  expect(
    await validateSelectedModel("claude-sonnet-5", "u", db, true),
  ).toMatchObject({ ok: true, model: "gateway/review" });
});
it("preserves a usable stored model and a saved preference for new reviews", async () => {
  getUserModelSettings.mockResolvedValue({
    api_keys: { claude: "key" },
    tabular_model: "claude-sonnet-5",
  });
  expect(
    await validateSelectedModel("claude-sonnet-5", "u", db, true),
  ).toMatchObject({ ok: true, model: "claude-sonnet-5" });
  expect(await validateSelectedModel(undefined, "u", db)).toMatchObject({
    ok: true,
    model: "claude-sonnet-5",
  });
});
it("does not silently replace an explicit unavailable native request", async () => {
  expect(await validateSelectedModel("claude-sonnet-5", "u", db)).toMatchObject(
    { ok: false, status: 422 },
  );
});
it("rejects an unlisted explicit gateway model but recovers a stale stored one", async () => {
  expect(await validateSelectedModel("gateway/removed", "u", db)).toMatchObject(
    { ok: false, status: 400 },
  );
  expect(
    await validateSelectedModel("gateway/removed", "u", db, true),
  ).toMatchObject({ ok: true, model: "gateway/review" });
});
