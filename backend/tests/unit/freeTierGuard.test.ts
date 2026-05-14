import { vi, describe, it, expect, afterEach } from "vitest";
import {
  assertFreeTierAllowed,
  isFreeTierModel,
} from "../../src/lib/llm/freeTierGuard";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isFreeTierModel", () => {
  it("recognises Gemini flash and flash-lite IDs as free-tier", () => {
    expect(isFreeTierModel("gemini-2.5-flash-lite")).toBe(true);
    expect(isFreeTierModel("gemini-2.5-flash")).toBe(true);
    expect(isFreeTierModel("gemini-1.5-flash")).toBe(true);
    expect(isFreeTierModel("gemini-3-flash-preview")).toBe(true);
    expect(isFreeTierModel("gemini-3.1-flash-lite-preview")).toBe(true);
  });

  it("treats Claude, GPT, and pro Gemini models as not free-tier", () => {
    expect(isFreeTierModel("claude-opus-4-7")).toBe(false);
    expect(isFreeTierModel("claude-sonnet-4-6")).toBe(false);
    expect(isFreeTierModel("gpt-5.5")).toBe(false);
    expect(isFreeTierModel("gemini-3.1-pro-preview")).toBe(false);
  });
});

describe("assertFreeTierAllowed", () => {
  it("is a no-op for paid models regardless of env config", () => {
    vi.stubEnv("ALLOW_FREE_TIER_LLM", "");
    vi.stubEnv("FREE_TIER_FIXTURE_ALLOWLIST", "");
    expect(() =>
      assertFreeTierAllowed({ model: "claude-opus-4-7", documentFilenames: ["foo.pdf"] }),
    ).not.toThrow();
  });

  it("throws for a free-tier model when ALLOW_FREE_TIER_LLM is not 'true'", () => {
    vi.stubEnv("ALLOW_FREE_TIER_LLM", "");
    expect(() => assertFreeTierAllowed({ model: "gemini-2.5-flash-lite" })).toThrow(
      /ALLOW_FREE_TIER_LLM/,
    );
  });

  it("throws when ALLOW_FREE_TIER_LLM='true' but no allowlist is configured", () => {
    vi.stubEnv("ALLOW_FREE_TIER_LLM", "true");
    vi.stubEnv("FREE_TIER_FIXTURE_ALLOWLIST", "");
    expect(() => assertFreeTierAllowed({ model: "gemini-2.5-flash-lite" })).toThrow(
      /FREE_TIER_FIXTURE_ALLOWLIST/,
    );
  });

  it("allows a call carrying only allowlisted filenames", () => {
    vi.stubEnv("ALLOW_FREE_TIER_LLM", "true");
    vi.stubEnv("FREE_TIER_FIXTURE_ALLOWLIST", "sample.pdf,test-cim.pdf");
    expect(() =>
      assertFreeTierAllowed({
        model: "gemini-2.5-flash-lite",
        documentFilenames: ["sample.pdf"],
      }),
    ).not.toThrow();
  });

  it("allows a call with no documents at all (no offenders to check)", () => {
    vi.stubEnv("ALLOW_FREE_TIER_LLM", "true");
    vi.stubEnv("FREE_TIER_FIXTURE_ALLOWLIST", "sample.pdf");
    expect(() => assertFreeTierAllowed({ model: "gemini-2.5-flash-lite" })).not.toThrow();
  });

  it("throws when any document filename is outside the allowlist", () => {
    vi.stubEnv("ALLOW_FREE_TIER_LLM", "true");
    vi.stubEnv("FREE_TIER_FIXTURE_ALLOWLIST", "sample.pdf");
    expect(() =>
      assertFreeTierAllowed({
        model: "gemini-2.5-flash-lite",
        documentFilenames: ["sample.pdf", "customer-cim.pdf"],
      }),
    ).toThrow(/customer-cim\.pdf/);
  });

  it("ignores whitespace and empty entries in the allowlist", () => {
    vi.stubEnv("ALLOW_FREE_TIER_LLM", "true");
    vi.stubEnv("FREE_TIER_FIXTURE_ALLOWLIST", " sample.pdf , , test-cim.pdf ");
    expect(() =>
      assertFreeTierAllowed({
        model: "gemini-2.5-flash-lite",
        documentFilenames: ["test-cim.pdf"],
      }),
    ).not.toThrow();
  });
});
