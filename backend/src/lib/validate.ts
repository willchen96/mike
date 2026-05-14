import { ZodSchema } from "zod";
import type { Request, Response } from "express";

/**
 * Validates req.body against the given zod schema.
 * On failure: sends 400 { detail, fields } and returns null.
 * On success: returns the validated, stripped data.
 *
 * Usage:
 *   const body = parseBody(MySchema, req, res);
 *   if (!body) return; // 400 already sent
 */
export function parseBody<T>(
    schema: ZodSchema<T>,
    req: Request,
    res: Response,
): T | null {
    const result = schema.safeParse(req.body);
    if (!result.success) {
        const fields = Object.fromEntries(
            result.error.issues.map((i) => [i.path.join("."), i.message]),
        );
        res.status(400).json({ detail: "Validation failed", fields });
        return null;
    }
    return result.data;
}
