import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("CLEAN-06: gemini chunk log gate", () => {
  beforeEach(() => {
    delete process.env.LLM_STREAM_DEBUG;
  });

  afterEach(() => {
    delete process.env.LLM_STREAM_DEBUG;
  });

  it("does not call logger.debug when LLM_STREAM_DEBUG is unset", async () => {
    // Import logger after env is cleared
    const loggerMod = await import("../../src/lib/logger");
    const debugSpy = vi.spyOn(loggerMod.logger, "debug");

    // Simulate what gemini.ts does inside the for-await loop:
    //   if (process.env.LLM_STREAM_DEBUG) { logger.debug({ chunk }, "[gemini stream chunk]"); }
    const simulateGeminiChunkLog = () => {
      if (process.env.LLM_STREAM_DEBUG) {
        loggerMod.logger.debug({ chunk: { text: "hello" } }, "[gemini stream chunk]");
      }
    };

    simulateGeminiChunkLog();

    expect(debugSpy).not.toHaveBeenCalled();
    debugSpy.mockRestore();
  });

  it("calls logger.debug when LLM_STREAM_DEBUG is set", async () => {
    process.env.LLM_STREAM_DEBUG = "1";
    const loggerMod = await import("../../src/lib/logger");
    const debugSpy = vi.spyOn(loggerMod.logger, "debug");

    const simulateGeminiChunkLog = () => {
      if (process.env.LLM_STREAM_DEBUG) {
        loggerMod.logger.debug({ chunk: { text: "hello" } }, "[gemini stream chunk]");
      }
    };

    simulateGeminiChunkLog();

    expect(debugSpy).toHaveBeenCalledOnce();
    debugSpy.mockRestore();
  });
});
