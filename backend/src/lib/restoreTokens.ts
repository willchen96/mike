import crypto from "crypto";
import { env } from "../env";

/**
 * HMAC-signed account-restore tokens (CLEAN-44).
 *
 * When `DELETE /user/account` soft-deletes a user, it generates a signed
 * restore token and returns it in the response body.  The user can call
 * `POST /user/account/restore?token=<token>` within the 30-day grace window
 * to reverse the deletion.
 *
 * Token format: `<b64url-encoded-payload>.<b64url-encoded-hmac-sha256-sig>`
 *
 * The payload encodes `{ user_id, action: "restore", exp }` where `exp` is a
 * Unix-millisecond timestamp.  Tokens are verified without a DB lookup;
 * single-use enforcement (replay prevention) is the responsibility of Plan 07
 * via `account_deletion_jobs.restore_token_used_at`.
 *
 * Mirrors `backend/src/lib/downloadTokens.ts` line-for-line; the only
 * differences are the payload shape, the secret variable, and the expiry check.
 */

function getSecret(): string {
    return env.HUGO_RESTORE_TOKEN_SECRET;
}

function b64urlEncode(buf: Buffer): string {
    return buf
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/g, "");
}

function b64urlDecode(s: string): Buffer {
    let t = s.replace(/-/g, "+").replace(/_/g, "/");
    while (t.length % 4) t += "=";
    return Buffer.from(t, "base64");
}

export type RestorePayload = { user_id: string; action: "restore"; exp: number };

export function signRestoreToken(userId: string, expiresAt: Date): string {
    const payload: RestorePayload = {
        user_id: userId,
        action: "restore",
        exp: expiresAt.getTime(),
    };
    const enc = b64urlEncode(Buffer.from(JSON.stringify(payload), "utf8"));
    const sig = crypto
        .createHmac("sha256", getSecret())
        .update(enc)
        .digest();
    return `${enc}.${b64urlEncode(sig)}`;
}

export function verifyRestoreToken(token: string): RestorePayload | null {
    const parts = token.split(".");
    if (parts.length !== 2) return null;
    const [enc, sigEnc] = parts;
    const expected = crypto
        .createHmac("sha256", getSecret())
        .update(enc)
        .digest();
    // Compare raw HMAC bytes via timingSafeEqual on Buffers — comparing
    // base64url strings leaks length via early-return and uses a different
    // bit-level comparison than the digest. (CLEAN-44 CR-03)
    let provided: Buffer;
    try {
        provided = b64urlDecode(sigEnc);
    } catch {
        return null;
    }
    if (provided.length !== expected.length) return null;
    if (!crypto.timingSafeEqual(provided, expected)) return null;
    try {
        const parsed = JSON.parse(b64urlDecode(enc).toString("utf8")) as RestorePayload;
        if (!parsed?.user_id || typeof parsed.user_id !== "string") return null;
        if (parsed.action !== "restore") return null;
        if (typeof parsed.exp !== "number") return null;
        if (parsed.exp <= Date.now()) return null;
        return parsed;
    } catch {
        return null;
    }
}
