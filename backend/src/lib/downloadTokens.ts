import crypto from "crypto";

/**
 * HMAC-signed, non-expiring download tokens.
 *
 * The token encodes the R2 storage path + filename; the backend route
 * `/download/:token` validates the signature and streams the file. This
 * gives persistent links safe to store in chat history without signed-URL
 * expiry or R2 CORS headaches.
 *
 * The signing secret comes from `DOWNLOAD_SIGNING_SECRET` (preferred) or
 * falls back to `SUPABASE_SECRET_KEY`. If neither is set we throw rather
 * than silently signing every link with a hardcoded literal — a forgeable
 * default would let any caller mint download URLs for arbitrary keys.
 */

function getSecret(): string {
    // Trim and ignore empty/whitespace values so a deploy with
    // `DOWNLOAD_SIGNING_SECRET=` (e.g. an unfilled env template) still
    // falls back to SUPABASE_SECRET_KEY instead of crashing every download.
    const secret =
        process.env.DOWNLOAD_SIGNING_SECRET?.trim() ||
        process.env.SUPABASE_SECRET_KEY?.trim();
    if (!secret) {
        throw new Error(
            "Download signing secret is not configured: set DOWNLOAD_SIGNING_SECRET (preferred) or SUPABASE_SECRET_KEY.",
        );
    }
    return secret;
}

/**
 * Call once at process start so a misconfigured deploy crashes fast at
 * boot with a clear error, instead of returning 500 on every /download
 * request once a user clicks a saved link.
 */
export function assertDownloadSigningConfigured(): void {
    getSecret();
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

function timingSafeEqStr(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function signDownload(path: string, filename: string): string {
    const payload = JSON.stringify({ p: path, f: filename });
    const enc = b64urlEncode(Buffer.from(payload, "utf8"));
    const sig = crypto
        .createHmac("sha256", getSecret())
        .update(enc)
        .digest();
    return `${enc}.${b64urlEncode(sig)}`;
}

export function verifyDownload(
    token: string,
): { path: string; filename: string } | null {
    const parts = token.split(".");
    if (parts.length !== 2) return null;
    const [enc, sigEnc] = parts;
    const expected = crypto
        .createHmac("sha256", getSecret())
        .update(enc)
        .digest();
    if (!timingSafeEqStr(sigEnc, b64urlEncode(expected))) return null;
    try {
        const parsed = JSON.parse(b64urlDecode(enc).toString("utf8")) as {
            p: string;
            f: string;
        };
        if (!parsed?.p || !parsed?.f) return null;
        return { path: parsed.p, filename: parsed.f };
    } catch {
        return null;
    }
}

/**
 * Returns a relative download URL (e.g. "/download/abc.def"). The frontend
 * prefixes it with NEXT_PUBLIC_API_BASE_URL when rendering `<a href=…>`.
 */
export function buildDownloadUrl(path: string, filename: string): string {
    return `/download/${signDownload(path, filename)}`;
}
