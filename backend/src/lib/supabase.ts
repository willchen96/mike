/**
 * Supabase admin client + token-verification cache.
 *
 * Required env vars:
 *   SUPABASE_URL        — project URL (e.g. https://xxx.supabase.co)
 *   SUPABASE_SECRET_KEY — service-role JWT (bypasses RLS)
 *
 * The admin client is constructed once at module-load.  Repeated calls to
 * `createServerSupabase()` return the same instance so callers that still use
 * the factory function don't break.
 *
 * `verifyToken` verifies bearer tokens via JWKS (for ES256/RS256 asymmetric
 * keys used by Supabase CLI v2+) or via HMAC when SUPABASE_JWT_SECRET is set
 * (HS256, used by older Supabase versions).  Results are cached in an LRU for
 * 60 s so chatty request bursts don't fan out to GoTrue.  Only successful
 * lookups are cached — failures are never stored so revocation takes effect
 * on the next request.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { LRUCache } from "lru-cache";
import { createHash, createHmac, webcrypto } from "crypto";
import { logger } from "./logger";

// ── Module-scope singleton ────────────────────────────────────────────────────

/**
 * Single admin client shared across the entire process lifetime.
 * `persistSession: false` prevents the SDK from writing to disk.
 * `autoRefreshToken: false` is a no-op for service-role keys but avoids
 * background timers that complicate unit-test teardown.
 */
export const adminClient: SupabaseClient = createClient(
  process.env.SUPABASE_URL ?? "",
  process.env.SUPABASE_SECRET_KEY ?? "",
  { auth: { persistSession: false, autoRefreshToken: false } },
);

/**
 * Backward-compatible factory function.  Callers that still use
 * `createServerSupabase()` get the singleton without any refactor cost.
 */
export function createServerSupabase(): SupabaseClient {
  return adminClient;
}

// ── Token-verification cache ──────────────────────────────────────────────────

/** The shape of a verified Supabase user as stored in the LRU cache. */
export type CachedUser = { id: string; email: string };

/**
 * LRU cache for verified token results.
 *
 *   max 1000  — hard cap on number of concurrent sessions cached.
 *   ttl 60 s  — entries expire 60 s after insertion (not after last access).
 *   updateAgeOnGet: false — reading an entry does NOT reset its TTL; expiry is
 *                           always relative to the insertion time so that a
 *                           revoked token expires predictably.
 */
const userCache = new LRUCache<string, CachedUser>({
  max: 1000,
  ttl: 60_000,
  updateAgeOnGet: false,
});

/**
 * Derives a cache key from a bearer token without storing the raw token.
 * sha256 hex is 64 chars and is effectively collision-free for this purpose.
 */
function tokenKey(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// ── JWKS-based JWT verification ───────────────────────────────────────────────

interface JwkKey {
  kty: string;
  alg?: string;
  kid?: string;
  use?: string;
  [k: string]: unknown;
}

let _jwksCache: JwkKey[] | null = null;
let _jwksCachedAt = 0;

async function getJwks(): Promise<JwkKey[]> {
  const now = Date.now();
  if (_jwksCache && now - _jwksCachedAt < 5 * 60_000) return _jwksCache;

  const url = `${process.env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`JWKS fetch failed: ${resp.status}`);
  const json = (await resp.json()) as { keys: JwkKey[] };
  _jwksCache = json.keys ?? [];
  _jwksCachedAt = now;
  return _jwksCache;
}

async function verifyAsymmetricJwt(
  parts: string[],
  kid: string | undefined,
  alg: string,
): Promise<boolean> {
  const keys = await getJwks();
  const jwk = kid ? keys.find((k) => k.kid === kid) : keys[0];
  if (!jwk) return false;

  const namedCurve = alg === "ES384" ? "P-384" : "P-256";
  const hashName = alg === "ES384" ? "SHA-384" : "SHA-256";
  const keyAlg =
    alg.startsWith("RS") ? { name: "RSASSA-PKCS1-v1_5", hash: hashName }
      : { name: "ECDSA", namedCurve };
  const verifyAlg =
    alg.startsWith("RS") ? { name: "RSASSA-PKCS1-v1_5" }
      : { name: "ECDSA", hash: { name: hashName } };

  const cryptoKey = await (webcrypto.subtle as SubtleCrypto).importKey(
    "jwk",
    jwk as JsonWebKey,
    keyAlg as AlgorithmIdentifier,
    false,
    ["verify"],
  );

  const data = Buffer.from(`${parts[0]}.${parts[1]}`);
  const sig = Buffer.from(parts[2], "base64url");

  return (webcrypto.subtle as SubtleCrypto).verify(
    verifyAlg as AlgorithmIdentifier,
    cryptoKey,
    sig,
    data,
  );
}

async function verifyJwtLocally(token: string): Promise<CachedUser | null> {
  const parts = token.split(".");
  if (parts.length !== 3) {
    const { data } = await adminClient.auth.getUser(token);
    if (!data.user) return null;
    return {
      id: data.user.id,
      email: (data.user.email ?? "").toLowerCase(),
    };
  }

  let header: { alg?: string; kid?: string };
  let payload: { sub?: string; email?: string; exp?: number };
  try {
    header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }

  // Expiry check
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
  if (!payload.sub) return null;

  const alg = header.alg ?? "HS256";

  if (alg === "HS256") {
    const secret = process.env.SUPABASE_JWT_SECRET;
    if (!secret) {
      // No local secret — fall back to GoTrue admin round-trip.
      const { data } = await adminClient.auth.getUser(token);
      if (!data.user) return null;
    } else {
      const expected = createHmac("sha256", secret)
        .update(`${parts[0]}.${parts[1]}`)
        .digest("base64url");
      if (expected !== parts[2]) return null;
    }
  } else if (alg.startsWith("ES") || alg.startsWith("RS")) {
    const valid = await verifyAsymmetricJwt(parts, header.kid, alg);
    if (!valid) return null;
  } else {
    logger.warn({ alg }, "[auth] verifyToken: unsupported JWT algorithm");
    return null;
  }

  return {
    id: payload.sub,
    email: (payload.email ?? "").toLowerCase(),
  };
}

/**
 * Verifies a bearer token and returns the authenticated user.
 *
 * Supports ES256/RS256 (Supabase CLI v2+, asymmetric keys via JWKS) and HS256
 * (older Supabase, requires SUPABASE_JWT_SECRET in env or falls back to the
 * GoTrue admin round-trip).
 *
 * Returns `null` on failure.  Never caches failures.
 */
export async function verifyToken(token: string): Promise<CachedUser | null> {
  const key = tokenKey(token);
  const cached = userCache.get(key);
  if (cached !== undefined) return cached;

  try {
    const user = await verifyJwtLocally(token);
    if (!user) return null;
    userCache.set(key, user);
    return user;
  } catch (err) {
    logger.error({ err }, "[auth] verifyToken threw unexpectedly");
    return null;
  }
}

/**
 * Clears the token cache.  Exposed for test isolation — call in `beforeEach`.
 * NOT intended for production use.
 */
export function _resetAuthCache(): void {
  userCache.clear();
}

// ── Legacy / unused helpers ───────────────────────────────────────────────────

// ── Auth user lookup helpers (RPC-backed, CLEAN-15) ──────────────────────────

/**
 * Look up a single auth user by email via the `get_auth_user_by_email` RPC.
 *
 * The RPC is SECURITY DEFINER with `search_path = ''` and is only callable by
 * service_role — so this helper is safe for backend use and does not expose
 * the full auth.users table to callers.
 *
 * Returns null if the user is not found or if the RPC call fails.
 */
export async function getUserByEmail(
    email: string,
): Promise<{ id: string; email: string } | null> {
    const { data, error } = await adminClient.rpc(
        "get_auth_user_by_email",
        { p_email: email },
    );
    if (error || !Array.isArray(data) || data.length === 0) return null;
    const row = data[0] as { id: string; email: string };
    return { id: row.id, email: row.email };
}

/**
 * Look up multiple auth users by email.  Returns a Map keyed on the
 * lowercased email so callers can do O(1) lookups after a single fan-out.
 *
 * Unknown emails are silently omitted from the result (matching the prior
 * behaviour where unregistered shared_with entries were simply absent).
 */
export async function getUsersByEmails(
    emails: string[],
): Promise<Map<string, { id: string; email: string }>> {
    const map = new Map<string, { id: string; email: string }>();
    await Promise.all(
        emails.map(async (e) => {
            const u = await getUserByEmail(e);
            if (u) map.set(e.toLowerCase(), u);
        }),
    );
    return map;
}

/**
 * Look up a single auth user by UUID via the `get_auth_user_by_id` RPC.
 *
 * Used for owner email resolution in /people endpoints — avoids the
 * listUsers paging approach and resolves in O(log N) via the auth.users PK.
 *
 * Returns null if the user is not found or if the RPC call fails.
 */
export async function getUserById(
    userId: string,
): Promise<{ id: string; email: string } | null> {
    const { data, error } = await adminClient.rpc(
        "get_auth_user_by_id",
        { p_id: userId },
    );
    if (error || !Array.isArray(data) || data.length === 0) return null;
    const row = data[0] as { id: string; email: string };
    return { id: row.id, email: row.email };
}

// ── Legacy / unused helpers ───────────────────────────────────────────────────

/**
 * Extract and verify the Supabase JWT from a Next.js-style Request.
 *
 * @deprecated  This function is unused in the backend (per CLAUDE.md "Dead
 *              Code").  It is kept here to avoid breaking any external consumer
 *              that may have referenced it.  Do not call from new code.
 */
export async function getUserIdFromRequest(req: Request): Promise<string> {
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) {
    throw new Response("Missing or invalid Authorization header", {
      status: 401,
    });
  }
  const token = auth.slice(7).trim();
  const user = await verifyToken(token);
  if (!user) {
    throw new Response("Invalid or expired token", { status: 401 });
  }
  return user.id;
}
