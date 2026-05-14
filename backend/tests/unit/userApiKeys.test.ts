import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  encryptionKey,
  getUserApiKeyStatus,
  getUserApiKeys,
  saveUserApiKey,
  type ApiKeyProvider,
} from "../../src/lib/userApiKeys";

// A stable, deterministic secret used throughout the file.
// We pin it in process.env before each test so that stubs or restores in one
// test cannot affect the next, regardless of vi.stubEnv/vi.unstubAllEnvs
// timing across sibling describe blocks.
const TEST_SECRET = "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";

beforeEach(() => {
  process.env.USER_API_KEYS_ENCRYPTION_SECRET = TEST_SECRET;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ── mock DB factory ───────────────────────────────────────────────────────────
//
// The Supabase query builder is a fluent, thenable object.  We replicate that
// shape here: every builder method returns `this`, making the chain awaitable
// at any point.  `upsert` and `delete` also return awaitables.

function makeSelectableChain(
  result: { data?: unknown; error?: unknown } = { data: [], error: null },
) {
  const chain: Record<string, unknown> = {};
  const ret = () => chain;
  for (const m of ["select", "eq", "neq", "in", "filter"]) {
    chain[m] = ret;
  }
  chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  chain.catch = (reject: (e: unknown) => unknown) => Promise.resolve(result).catch(reject);
  chain.finally = (cb: () => void) => Promise.resolve(result).finally(cb);
  return chain;
}

function makeDeleteChain(error: unknown = null) {
  const chain: Record<string, unknown> = {};
  chain.eq = () => chain;
  chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve({ error }).then(resolve, reject);
  return chain;
}

interface FakeDbOptions {
  selectResult?: { data?: unknown; error?: unknown };
  upsertError?: unknown;
  deleteError?: unknown;
  onUpsert?: (data: Record<string, unknown>) => void;
}

function makeFakeDb({
  selectResult = { data: [], error: null },
  upsertError = null,
  deleteError = null,
  onUpsert = (_d: Record<string, unknown>) => {},
}: FakeDbOptions = {}) {
  return {
    from: (_table: string) => ({
      select: () => makeSelectableChain(selectResult),
      upsert: (data: Record<string, unknown>) => {
        onUpsert(data);
        return Promise.resolve({ error: upsertError });
      },
      delete: () => makeDeleteChain(deleteError),
    }),
  };
}

// ── encryptionKey ─────────────────────────────────────────────────────────────

describe("encryptionKey", () => {
  it("returns a 32-byte Buffer derived from the env secret", () => {
    const key = encryptionKey();
    expect(key).toBeInstanceOf(Buffer);
    expect(key.byteLength).toBe(32);
  });

  it("throws (mentioning the var name) when the secret is absent or empty", () => {
    vi.stubEnv("USER_API_KEYS_ENCRYPTION_SECRET", "");
    expect(() => encryptionKey()).toThrow("USER_API_KEYS_ENCRYPTION_SECRET");
  });
});

// ── encrypt / decrypt roundtrip (via saveUserApiKey → getUserApiKeys) ─────────

describe("encrypt / decrypt roundtrip", () => {
  const PROVIDERS: ApiKeyProvider[] = ["claude", "gemini", "openai"];

  it.each(PROVIDERS)(
    'preserves plaintext through save→load cycle for provider "%s"',
    async (provider) => {
      const plaintext = `sk-${provider}-test-abc123`;
      let captured: Record<string, unknown> = {};

      const saveDb = makeFakeDb({ onUpsert: (d) => { captured = d; } });
      await saveUserApiKey("user-1", provider, plaintext, saveDb as never);

      // Feed the encrypted row back through getUserApiKeys
      const loadDb = {
        from: () => ({
          select: () =>
            makeSelectableChain({
              data: [
                {
                  provider,
                  encrypted_key: captured.encrypted_key,
                  iv: captured.iv,
                  auth_tag: captured.auth_tag,
                },
              ],
              error: null,
            }),
        }),
      };

      const keys = await getUserApiKeys("user-1", loadDb as never);
      expect(keys[provider]).toBe(plaintext);
    },
  );

  it("produces a unique IV on each encrypt call", async () => {
    const ivs: string[] = [];
    const capture = (d: Record<string, unknown>) => ivs.push(d.iv as string);

    await saveUserApiKey("user-1", "claude", "key-one", makeFakeDb({ onUpsert: capture }) as never);
    await saveUserApiKey("user-1", "claude", "key-two", makeFakeDb({ onUpsert: capture }) as never);

    expect(ivs).toHaveLength(2);
    expect(ivs[0]).not.toBe(ivs[1]);
  });

  it("returns null for a key decrypted with the wrong secret", async () => {
    // Encrypt with the current (test) secret
    let captured: Record<string, unknown> = {};
    const saveDb = makeFakeDb({ onUpsert: (d) => { captured = d; } });
    await saveUserApiKey("user-1", "openai", "sk-real-key", saveDb as never);

    // Switch to a different secret — GCM auth-tag check will fail
    vi.stubEnv("USER_API_KEYS_ENCRYPTION_SECRET", "wrong-secret-completely-different");
    // No env key for openai so we can observe the null coming from decrypt
    vi.stubEnv("OPENAI_API_KEY", "");

    const loadDb = {
      from: () => ({
        select: () =>
          makeSelectableChain({
            data: [
              {
                provider: "openai",
                encrypted_key: captured.encrypted_key,
                iv: captured.iv,
                auth_tag: captured.auth_tag,
              },
            ],
            error: null,
          }),
      }),
    };

    const keys = await getUserApiKeys("user-1", loadDb as never);
    expect(keys.openai).toBeNull();
    // afterEach restores env vars — no inline cleanup needed
  });
});

// ── getUserApiKeyStatus ───────────────────────────────────────────────────────

describe("getUserApiKeyStatus", () => {
  beforeEach(() => {
    // Start each test with no env-level API keys so results are predictable.
    // The file-level afterEach calls vi.unstubAllEnvs() to clean these up.
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("CLAUDE_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("GEMINI_API_KEY", "");
  });

  it("reports source='env' when the provider key is set in the environment", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-env-key");
    const db = makeFakeDb({ selectResult: { data: [], error: null } });
    const status = await getUserApiKeyStatus("user-1", db as never);
    expect(status.claude).toBe(true);
    expect(status.sources.claude).toBe("env");
  });

  it("reports source='user' when the key only exists in the DB", async () => {
    const db = makeFakeDb({
      selectResult: { data: [{ provider: "gemini" }], error: null },
    });
    const status = await getUserApiKeyStatus("user-1", db as never);
    expect(status.gemini).toBe(true);
    expect(status.sources.gemini).toBe("user");
  });

  it("env source wins when both env and DB have a key for the same provider", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-openai-env");
    const db = makeFakeDb({
      selectResult: { data: [{ provider: "openai" }], error: null },
    });
    const status = await getUserApiKeyStatus("user-1", db as never);
    expect(status.openai).toBe(true);
    expect(status.sources.openai).toBe("env"); // env must win
  });

  it("returns false / null when no key exists from any source", async () => {
    const db = makeFakeDb({ selectResult: { data: [], error: null } });
    const status = await getUserApiKeyStatus("user-1", db as never);
    expect(status.claude).toBe(false);
    expect(status.sources.claude).toBeNull();
  });

  it("throws when Supabase returns an error object", async () => {
    const db = makeFakeDb({
      selectResult: { data: null, error: { message: "db error" } },
    });
    await expect(getUserApiKeyStatus("user-1", db as never)).rejects.toMatchObject({
      message: "db error",
    });
  });
});

// ── saveUserApiKey ────────────────────────────────────────────────────────────

describe("saveUserApiKey", () => {
  it("upserts an encrypted payload containing all three ciphertext fields", async () => {
    let payload: Record<string, unknown> = {};
    const db = makeFakeDb({ onUpsert: (d) => { payload = d; } });

    await saveUserApiKey("user-1", "claude", "sk-test-key", db as never);

    expect(payload).toMatchObject({
      user_id: "user-1",
      provider: "claude",
      encrypted_key: expect.any(String),
      iv: expect.any(String),
      auth_tag: expect.any(String),
    });
  });

  it("calls delete (not upsert) when value is null", async () => {
    const upsertFn = vi.fn();
    let deleteCalled = false;
    const db = {
      from: () => ({
        upsert: upsertFn,
        delete: () => {
          deleteCalled = true;
          return makeDeleteChain();
        },
      }),
    };

    await saveUserApiKey("user-1", "claude", null, db as never);

    expect(deleteCalled).toBe(true);
    expect(upsertFn).not.toHaveBeenCalled();
  });

  it("treats a whitespace-only string as null (calls delete)", async () => {
    const upsertFn = vi.fn();
    let deleteCalled = false;
    const db = {
      from: () => ({
        upsert: upsertFn,
        delete: () => {
          deleteCalled = true;
          return makeDeleteChain();
        },
      }),
    };

    await saveUserApiKey("user-1", "gemini", "   ", db as never);

    expect(deleteCalled).toBe(true);
    expect(upsertFn).not.toHaveBeenCalled();
  });

  it("throws when the DB upsert returns an error", async () => {
    const db = makeFakeDb({ upsertError: { message: "upsert failed" } });
    await expect(saveUserApiKey("user-1", "gemini", "sk-key", db as never))
      .rejects.toMatchObject({ message: "upsert failed" });
  });

  it("throws when the DB delete returns an error", async () => {
    const db = makeFakeDb({ deleteError: { message: "delete failed" } });
    await expect(saveUserApiKey("user-1", "openai", null, db as never))
      .rejects.toMatchObject({ message: "delete failed" });
  });
});
