import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequestSupabase } from "../authSession";

// Exercise the real SSR/Auth SDK; only the upstream HTTP boundary is mocked.
describe("SSO PKCE session", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("sends a PKCE challenge and persists an HttpOnly verifier for the callback", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SUPABASE_URL", "https://auth.example.test");
    vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "test-key");
    const upstream = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ url: "https://idp.example/saml" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", upstream);
    const app = express();
    app.post("/sso", async (req, res) => {
      const client = createRequestSupabase(req, res);
      const { data, error } = await client.auth.signInWithSSO({
        domain: "example.com",
        options: {
          redirectTo: "https://app.example.test/auth/callback",
          skipBrowserRedirect: true,
        },
      });
      if (error) return res.status(500).end();
      return res.json(data);
    });
    const response = await request(app)
      .post("/sso")
      .set("Origin", "https://app.example.test");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ url: "https://idp.example/saml" });
    expect(upstream).toHaveBeenCalledTimes(1);
    const [url, init] = upstream.mock.calls[0];
    expect(url).toBe("https://auth.example.test/auth/v1/sso");
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      domain: "example.com",
      skip_http_redirect: true,
      code_challenge_method: "s256",
    });
    expect(body.code_challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.redirect_to).toContain(
      "https://app.example.test/auth/callback",
    );
    const cookies = response.headers["set-cookie"] as unknown as string[];
    const verifier = cookies.find((cookie) =>
      cookie.includes("-code-verifier="),
    );
    expect(verifier).toContain("__Host-mike-session");
    expect(verifier).toContain("HttpOnly");
    expect(verifier).toContain("Secure");
    expect(verifier).toContain("SameSite=Lax");
    expect(verifier).toContain("Path=/");
  });
});
