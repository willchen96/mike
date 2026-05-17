/**
 * CLEAN-05 — Pino redaction sentinel test (Pitfall 7).
 *
 * Asserts that the magic-string plaintext API key never appears in captured
 * pino output, regardless of which log path the key flows through.
 *
 * Each test creates a fresh pino logger using the same redact config as
 * lib/logger.ts, logs the sentinel under a different path, and asserts:
 *   output.includes(SENTINEL) === false
 *   output.includes("[REDACTED]") === true
 */

import { describe, it, expect } from "vitest";
import pino from "pino";

export const SENTINEL = "sk-MAGIC-CANARY-MUST-NOT-LEAK-1234567890";

/**
 * The redact paths must match lib/logger.ts exactly.
 * If logger.ts paths are updated, this array MUST be updated in sync.
 */
const REDACT_PATHS = [
    "messages[*].content",
    "body.messages[*].content",
    "*.api_key",
    "api_key",
    "apiKeys.claude",
    "apiKeys.gemini",
    "*.apiKeys.claude",
    "*.apiKeys.gemini",
    "req.headers.authorization",
    "req.headers.cookie",
    "Authorization",
    // CLEAN-05 — extended paths for ciphertext bytea columns and plaintext guard
    "*.claude_api_key_ciphertext",
    "*.claude_api_key_iv",
    "*.claude_api_key_auth_tag",
    "*.gemini_api_key_ciphertext",
    "*.gemini_api_key_iv",
    "*.gemini_api_key_auth_tag",
    "*.plaintext",
    "plaintext",
];

function makeCapturingLogger(): { logger: ReturnType<typeof pino>; getOutput: () => string } {
    const chunks: string[] = [];
    const destination = {
        write(chunk: string) {
            chunks.push(chunk);
        },
    };
    // pino({ ... }, destination) — write to our collecting stream
    const logger = pino(
        {
            level: "trace",
            redact: {
                paths: REDACT_PATHS,
                censor: "[REDACTED]",
            },
        },
        // pino accepts any object with a .write(str) method as the second arg
        destination as unknown as Parameters<typeof pino>[1],
    );
    return {
        logger,
        getOutput: () => chunks.join("\n"),
    };
}

describe("pino redaction — plaintext API key never appears in log output", () => {
    it("magic-string plaintext key never appears in captured pino stdout when logged under apiKeys.claude path", () => {
        const { logger, getOutput } = makeCapturingLogger();
        logger.info({ apiKeys: { claude: SENTINEL, gemini: null } }, "test");
        const output = getOutput();
        expect(output).not.toContain(SENTINEL);
        expect(output).toContain("[REDACTED]");
    });

    it("magic-string plaintext key never appears when logged under apiKeys.gemini path", () => {
        const { logger, getOutput } = makeCapturingLogger();
        logger.info({ apiKeys: { claude: null, gemini: SENTINEL } }, "test");
        const output = getOutput();
        expect(output).not.toContain(SENTINEL);
        expect(output).toContain("[REDACTED]");
    });

    it("magic-string plaintext key never appears when logged under api_key path", () => {
        const { logger, getOutput } = makeCapturingLogger();
        logger.info({ api_key: SENTINEL }, "test");
        const output = getOutput();
        expect(output).not.toContain(SENTINEL);
        expect(output).toContain("[REDACTED]");
    });

    it("magic-string plaintext key never appears when nested under *.apiKeys.claude", () => {
        const { logger, getOutput } = makeCapturingLogger();
        logger.info({ ctx: { apiKeys: { claude: SENTINEL } } }, "test");
        const output = getOutput();
        expect(output).not.toContain(SENTINEL);
        expect(output).toContain("[REDACTED]");
    });
});
