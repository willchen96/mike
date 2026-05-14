import { rateLimit } from "express-rate-limit";

const WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000);
const MAX = Number(process.env.RATE_LIMIT_MAX ?? 20);

/**
 * Per-user LLM rate limiter.
 *
 * MUST run AFTER requireAuth in the middleware chain — reads res.locals.userId.
 *
 * Env vars (optional — defaults used if absent):
 *   RATE_LIMIT_WINDOW_MS  — sliding window in milliseconds (default: 60000 = 1 minute)
 *   RATE_LIMIT_MAX        — max requests per user per window (default: 20)
 */
export const llmRateLimiter = rateLimit({
  windowMs: WINDOW_MS,
  limit: MAX,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: (_req, res) => `user:${res.locals.userId as string}`,
  handler: (_req, res) => {
    res.setHeader("Retry-After", String(Math.ceil(WINDOW_MS / 1000)));
    res.status(429).json({ detail: "Rate limit exceeded. Try again later." });
  },
});
