import { afterEach, describe, expect, it } from "vitest";
import { maxOutputTokensFor } from "./aiSdk";

afterEach(() => {
  delete process.env.LLM_MAX_OUTPUT_TOKENS;
});

describe("maxOutputTokensFor", () => {
  it("gives Gemini its real ceiling, natively and through a router", () => {
    // Thinking tokens count against this ceiling, so the conservative default
    // truncates a long deliberation before the model emits its tool call.
    expect(maxOutputTokensFor("gemini", "gemini-3.8-flash")).toBe(65_536);
    expect(
      maxOutputTokensFor("openrouter", "openrouter/google/gemini-3.8-flash"),
    ).toBe(65_536);
    expect(
      maxOutputTokensFor("vercel", "vercel/google/gemini-3.7-flash"),
    ).toBe(65_536);
  });

  it("leaves every other model on the conservative default", () => {
    expect(maxOutputTokensFor("claude", "claude-opus-5")).toBe(16_384);
    expect(maxOutputTokensFor("openai", "gpt-5.6-sol")).toBe(16_384);
    expect(
      maxOutputTokensFor("openrouter", "openrouter/x-ai/grok-4.6"),
    ).toBe(16_384);
    // "gemini" must appear as a model id segment, not anywhere in the string.
    expect(
      maxOutputTokensFor("openrouter", "openrouter/vendor/not-gemini-ish"),
    ).toBe(16_384);
  });

  it("lets LLM_MAX_OUTPUT_TOKENS override any built-in value", () => {
    process.env.LLM_MAX_OUTPUT_TOKENS = "8192";
    expect(maxOutputTokensFor("gemini", "gemini-3.8-flash")).toBe(8_192);
    expect(maxOutputTokensFor("claude", "claude-opus-5")).toBe(8_192);
  });

  it("ignores an unusable override rather than sending it upstream", () => {
    for (const value of ["", "0", "-1", "banana", "1.5"]) {
      process.env.LLM_MAX_OUTPUT_TOKENS = value;
      expect(maxOutputTokensFor("claude", "claude-opus-5")).toBe(16_384);
    }
  });
});
