/**
 * Structured pino logger for the Hugo backend.
 *
 * Optional env vars:
 *   LOG_LEVEL  — pino log level (default: "info")
 *   NODE_ENV   — when !== "production", enables pino-pretty dev transport
 *
 * Redacted paths (never appear in logs):
 *   messages[*].content  — legal document content in chat messages
 *   body.messages[*].content
 *   *.api_key            — user-supplied LLM provider keys
 *   api_key
 *   apiKeys.claude       — resolved per-request Claude provider key
 *   apiKeys.gemini       — resolved per-request Gemini provider key
 *   *.apiKeys.claude     — nested variants (e.g. req.body.apiKeys.claude)
 *   *.apiKeys.gemini     — nested variants (e.g. ctx.apiKeys.gemini)
 *   req.headers.authorization
 *   req.headers.cookie   — session cookies
 *   Authorization
 *   *.claude_api_key_ciphertext — CLEAN-05: bytea ciphertext column (user_profiles)
 *   *.claude_api_key_iv         — CLEAN-05: bytea IV column
 *   *.claude_api_key_auth_tag   — CLEAN-05: bytea auth tag column
 *   *.gemini_api_key_ciphertext — CLEAN-05: bytea ciphertext column (user_profiles)
 *   *.gemini_api_key_iv         — CLEAN-05: bytea IV column
 *   *.gemini_api_key_auth_tag   — CLEAN-05: bytea auth tag column
 *   *.plaintext                 — CLEAN-05: defensive guard against any "plaintext" variable
 *   plaintext                   — CLEAN-05: top-level plaintext guard
 */
import pino from "pino";
import pinoHttp from "pino-http";
import { randomUUID } from "crypto";

const isDev = process.env.NODE_ENV !== "production";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: {
    paths: [
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
      // CLEAN-05: Pino redaction misses new variable names (Pitfall 7).
      // *.api_key matches a literal property named "api_key" — NOT "api_key_ciphertext".
      // These paths must be listed explicitly.
      "*.claude_api_key_ciphertext",
      "*.claude_api_key_iv",
      "*.claude_api_key_auth_tag",
      "*.gemini_api_key_ciphertext",
      "*.gemini_api_key_iv",
      "*.gemini_api_key_auth_tag",
      "*.plaintext",
      "plaintext",
    ],
    censor: "[REDACTED]",
  },
  transport: isDev
    ? { target: "pino-pretty", options: { colorize: true } }
    : undefined,
});

export const httpLogger = pinoHttp({
  logger,
  genReqId: (req, res) => {
    const existing = req.headers["x-request-id"];
    if (existing) return Array.isArray(existing) ? existing[0] : existing;
    const id = randomUUID();
    res.setHeader("X-Request-Id", id);
    return id;
  },
  customLogLevel: (_req, res) => {
    if (res.statusCode >= 500) return "error";
    if (res.statusCode >= 400) return "warn";
    return "info";
  },
});
