export function assertSecretIsolation(): void {
    const supabaseKey = process.env.SUPABASE_SECRET_KEY;
    const downloadSecret = process.env.DOWNLOAD_SIGNING_SECRET;
    const encryptionSecret = process.env.USER_API_KEYS_ENCRYPTION_SECRET;

    const missing: string[] = [];
    if (!downloadSecret) missing.push("DOWNLOAD_SIGNING_SECRET");
    if (!encryptionSecret) missing.push("USER_API_KEYS_ENCRYPTION_SECRET");
    if (missing.length > 0) {
        throw new Error(
            `Missing required environment variables: ${missing.join(", ")}. ` +
                "Generate strong random values (e.g. `openssl rand -hex 32`) for each.",
        );
    }

    if (supabaseKey && downloadSecret === supabaseKey) {
        throw new Error(
            "DOWNLOAD_SIGNING_SECRET must not be the same as SUPABASE_SECRET_KEY.",
        );
    }
    if (supabaseKey && encryptionSecret === supabaseKey) {
        throw new Error(
            "USER_API_KEYS_ENCRYPTION_SECRET must not be the same as SUPABASE_SECRET_KEY.",
        );
    }
    if (downloadSecret === encryptionSecret) {
        throw new Error(
            "DOWNLOAD_SIGNING_SECRET and USER_API_KEYS_ENCRYPTION_SECRET must not be the same value.",
        );
    }
}
