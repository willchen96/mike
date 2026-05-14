/**
 * Centralized, validated environment variables for the backend.
 *
 * Required env vars (process throws on missing):
 *   SUPABASE_URL             — Supabase project URL
 *   SUPABASE_SECRET_KEY      — Supabase service role key (never exposed to clients)
 *   DOWNLOAD_SIGNING_SECRET  — HMAC secret for signed download tokens (CLEAN-07)
 *   FRONTEND_URL             — CORS allow-list origin
 *   R2_ENDPOINT_URL          — Cloudflare R2 endpoint, https://<account>.r2.cloudflarestorage.com
 *   R2_ACCESS_KEY_ID         — R2 API token (Access Key ID)
 *   R2_SECRET_ACCESS_KEY     — R2 API token (Secret Access Key)
 *   R2_BUCKET_NAME           — R2 bucket name
 *   HUGO_MASTER_KEY          — AES-256-GCM master key for at-rest encryption of user LLM API keys (CLEAN-05).
 *                              Must be exactly 64 hex characters (32 bytes). Generate with: openssl rand -hex 32
 *   HUGO_RESTORE_TOKEN_SECRET — HMAC secret for account-restore tokens (CLEAN-44).
 *                              Must be at least 32 characters. Generate with: openssl rand -base64 48
 *
 * Optional:
 *   ANTHROPIC_API_KEY        — Claude provider key (operators may configure one provider only)
 *   GEMINI_API_KEY           — Gemini provider key (operators may configure one provider only)
 *   PORT                     — HTTP port (default 3001 in index.ts)
 *   LLM_STREAM_DEBUG         — when set, enables raw LLM stream console logging (CLEAN-06)
 *
 * Note: The 30-day account deletion grace window is a hardcoded constant
 * (`DELETE_GRACE_DAYS` in lib/accountDeletion.ts), not an env var (D-04).
 *
 * Importing this module at startup validates process.env and throws with
 * a helpful, aggregated error if any required var is missing.
 */
import { z } from "zod";

export const envSchema = z.object({
    SUPABASE_URL:              z.string().min(1),
    SUPABASE_SECRET_KEY:       z.string().min(1),
    DOWNLOAD_SIGNING_SECRET:   z.string().min(1),
    FRONTEND_URL:              z.string().min(1),
    R2_ENDPOINT_URL:           z.string().min(1),
    R2_ACCESS_KEY_ID:          z.string().min(1),
    R2_SECRET_ACCESS_KEY:      z.string().min(1),
    R2_BUCKET_NAME:            z.string().min(1),
    HUGO_MASTER_KEY:           z.string().regex(/^[0-9a-fA-F]{64}$/, "HUGO_MASTER_KEY must be exactly 64 hex characters (32 bytes). Generate with: openssl rand -hex 32"),
    HUGO_RESTORE_TOKEN_SECRET: z.string().min(32, "HUGO_RESTORE_TOKEN_SECRET must be at least 32 characters. Generate with: openssl rand -base64 48"),
    ANTHROPIC_API_KEY:         z.string().min(1).optional(),
    GEMINI_API_KEY:            z.string().min(1).optional(),
    PORT:                      z.string().optional(),
    LLM_STREAM_DEBUG:          z.string().optional(),
});

const result = envSchema.safeParse(process.env);
if (!result.success) {
    const issues = result.error.issues
        .map((i) => `  ${i.path.join(".")}: ${i.message}`)
        .join("\n");
    throw new Error(
        `[env] Server cannot start — missing or invalid environment variables:\n${issues}\n` +
        `See backend/.env.example for required variables.`,
    );
}

export const env = result.data;
