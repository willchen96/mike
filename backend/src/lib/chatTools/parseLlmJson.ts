/**
 * parseLlmJson — zod-validated JSON parse helper for LLM output.
 *
 * Returns a Result-shaped value and NEVER throws. Parse failures are
 * categorised as either JSON syntax errors or schema validation errors.
 * Callers emit typed SSE error events on failure; this helper is solely
 * responsible for producing the Result.
 *
 * Separate from parseBody (backend/src/lib/validate.ts) which validates
 * HTTP request bodies and returns 400 — a different concern.
 */

import { z } from "zod";

export type ParseLlmJsonResult<T> =
    | { ok: true; data: T }
    | { ok: false; error: string; raw: string };

export function parseLlmJson<T>(
    raw: string,
    schema: z.ZodSchema<T>,
): ParseLlmJsonResult<T> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (e) {
        return {
            ok: false,
            error: `JSON syntax: ${(e as Error).message}`,
            raw,
        };
    }
    const result = schema.safeParse(parsed);
    if (!result.success) {
        return {
            ok: false,
            error: result.error.message,
            raw,
        };
    }
    return { ok: true, data: result.data };
}
