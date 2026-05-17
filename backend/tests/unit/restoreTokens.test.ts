/**
 * CLEAN-44 — HMAC-signed restore-token sign / verify / expiry / tamper tests.
 *
 * The vitest.no-db.config.ts already sets HUGO_RESTORE_TOKEN_SECRET so we can
 * import the production module directly without vi.stubEnv here.
 */

import { describe, it, expect } from "vitest";
import { signRestoreToken, verifyRestoreToken } from "../../src/lib/restoreTokens";

describe("signRestoreToken / verifyRestoreToken", () => {
  it("signRestoreToken + verifyRestoreToken round-trip recovers payload", () => {
    const userId = "user-abc";
    const expiresAt = new Date(Date.now() + 86_400_000); // 24 hours from now
    const token = signRestoreToken(userId, expiresAt);
    const payload = verifyRestoreToken(token);
    expect(payload).not.toBeNull();
    expect(payload?.user_id).toBe(userId);
    expect(payload?.action).toBe("restore");
    expect(typeof payload?.exp).toBe("number");
    expect(payload?.exp).toBeGreaterThan(Date.now());
  });

  it("verifyRestoreToken returns null when signature is tampered", () => {
    const token = signRestoreToken("user-abc", new Date(Date.now() + 86_400_000));
    // Change last 4 chars of the signature part (after the dot)
    const [enc, sig] = token.split(".");
    const tamperedSig = sig.slice(0, -4) + (sig.endsWith("AAAA") ? "BBBB" : "AAAA");
    const tampered = `${enc}.${tamperedSig}`;
    expect(verifyRestoreToken(tampered)).toBeNull();
  });

  it("verifyRestoreToken returns null when payload is tampered (HMAC mismatch)", () => {
    const token = signRestoreToken("user-abc", new Date(Date.now() + 86_400_000));
    const [enc, sig] = token.split(".");
    // Flip one char in the payload (base64url encoded)
    const tamperedEnc = enc.slice(0, -1) + (enc.endsWith("A") ? "B" : "A");
    const tampered = `${tamperedEnc}.${sig}`;
    expect(verifyRestoreToken(tampered)).toBeNull();
  });

  it("verifyRestoreToken returns null when exp <= Date.now()", () => {
    // Token with past expiry
    const token = signRestoreToken("user-abc", new Date(Date.now() - 1000));
    expect(verifyRestoreToken(token)).toBeNull();
  });

  it("verifyRestoreToken returns null on malformed token (missing dot)", () => {
    expect(verifyRestoreToken("no-dot-here")).toBeNull();
  });
});
