import { describe, it, expect } from "vitest";
import pino from "pino";

describe("logger redact config", () => {
  it("redacts messages[*].content", () => {
    const records: unknown[] = [];
    const testLogger = pino(
      {
        level: "info",
        redact: {
          paths: [
            "messages[*].content",
            "body.messages[*].content",
            "*.api_key",
            "api_key",
            "req.headers.authorization",
            "Authorization",
          ],
          censor: "[REDACTED]",
        },
      },
      { write: (chunk: string) => records.push(JSON.parse(chunk)) },
    );
    testLogger.info(
      { messages: [{ role: "user", content: "secret legal text" }] },
      "test",
    );
    const record = records[0] as { messages: { content: string }[] };
    expect(record.messages[0].content).toBe("[REDACTED]");
  });

  it("redacts api_key at top level", () => {
    const records: unknown[] = [];
    const testLogger = pino(
      {
        level: "info",
        redact: {
          paths: ["*.api_key", "api_key"],
          censor: "[REDACTED]",
        },
      },
      { write: (chunk: string) => records.push(JSON.parse(chunk)) },
    );
    testLogger.info({ api_key: "sk-real-key-here" }, "test");
    const record = records[0] as { api_key: string };
    expect(record.api_key).toBe("[REDACTED]");
  });

  it("does not redact non-sensitive fields", () => {
    const records: unknown[] = [];
    const testLogger = pino(
      {
        level: "info",
        redact: { paths: ["messages[*].content"], censor: "[REDACTED]" },
      },
      { write: (chunk: string) => records.push(JSON.parse(chunk)) },
    );
    testLogger.info({ userId: "abc-123", route: "/chat" }, "audit");
    const record = records[0] as { userId: string; route: string };
    expect(record.userId).toBe("abc-123");
    expect(record.route).toBe("/chat");
  });
});
