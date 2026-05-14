import crypto from "crypto";
import { env } from "../env";

/**
 * AES-256-GCM envelope encryption for at-rest storage of user LLM API keys.
 *
 * CLEAN-05: user-supplied API keys (stored in user_profiles) are never held
 * as plaintext in the database. Each key is encrypted with a fresh random IV
 * under the operator-supplied HUGO_MASTER_KEY.
 *
 * Key design decisions (from 12-CONTEXT.md):
 * - 96-bit (12-byte) IV per record, generated fresh by crypto.randomBytes each call.
 *   IV reuse under the same master key would break GCM's security guarantees.
 * - 128-bit (16-byte) authentication tag — GCM default, provides integrity.
 * - setAuthTag MUST be called before update/final on the decipher (Node.js requirement).
 * - decryptApiKey returns null on any error (tampered ciphertext, wrong IV, wrong tag)
 *   rather than throwing — per CLAUDE.md "libs return null, do not throw".
 */

const ALG = "aes-256-gcm" as const;
const KEY_LEN = 32;
const IV_LEN = 12;
const TAG_LEN = 16;

const MASTER_KEY: Buffer = Buffer.from(env.HUGO_MASTER_KEY, "hex");
if (MASTER_KEY.length !== KEY_LEN) {
    throw new Error("[crypto] HUGO_MASTER_KEY must decode to 32 bytes (64 hex chars)");
}

export type Encrypted = {
    ciphertext: Buffer;
    iv: Buffer;       // 12 bytes — GCM standard nonce length
    authTag: Buffer;  // 16 bytes — GCM authentication tag
};

/**
 * Encrypts a plaintext API key string and returns the ciphertext + IV + authTag.
 *
 * A fresh random IV is generated per call — 1000 calls produce 1000 distinct IVs.
 */
export function encryptApiKey(plaintext: string): Encrypted {
    const iv = crypto.randomBytes(IV_LEN);
    const cipher = crypto.createCipheriv(ALG, MASTER_KEY, iv, { authTagLength: TAG_LEN });
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return { ciphertext, iv, authTag };
}

/**
 * Decrypts an encrypted API key. Returns null on any error (tampering, wrong key,
 * invalid IV/tag) — never throws.
 *
 * Order is load-bearing: createDecipheriv → setAuthTag → update → final.
 * Node.js requires setAuthTag before update/final for GCM mode.
 */
export function decryptApiKey(enc: Encrypted): string | null {
    try {
        const decipher = crypto.createDecipheriv(ALG, MASTER_KEY, enc.iv, { authTagLength: TAG_LEN });
        decipher.setAuthTag(enc.authTag);
        const plain = Buffer.concat([decipher.update(enc.ciphertext), decipher.final()]);
        return plain.toString("utf8");
    } catch {
        return null;
    }
}
