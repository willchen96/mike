import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Agent } from "undici";

// Mock DNS resolution so the SSRF guard is exercised deterministically without
// touching the network. `lookupMock` is hoisted so the vi.mock factory can
// reference it.
const { lookupMock } = vi.hoisted(() => ({ lookupMock: vi.fn() }));
vi.mock("dns/promises", () => ({
    default: { lookup: lookupMock },
}));

import {
    guardedFetch,
    mcpOAuthCallbackUrl,
    validateRemoteMcpUrl,
} from "../client";

const originalNodeEnv = process.env.NODE_ENV;
const originalApiPublicUrl = process.env.API_PUBLIC_URL;
const originalBackendUrl = process.env.BACKEND_URL;

function resolvesTo(...addresses: string[]) {
    lookupMock.mockResolvedValue(
        addresses.map((address) => ({
            address,
            family: address.includes(":") ? 6 : 4,
        })),
    );
}

beforeEach(() => {
    lookupMock.mockReset();
});

afterEach(() => {
    vi.restoreAllMocks();
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalApiPublicUrl === undefined) delete process.env.API_PUBLIC_URL;
    else process.env.API_PUBLIC_URL = originalApiPublicUrl;
    if (originalBackendUrl === undefined) delete process.env.BACKEND_URL;
    else process.env.BACKEND_URL = originalBackendUrl;
});

describe("validateRemoteMcpUrl", () => {
    it("rejects non-HTTPS URLs", async () => {
        await expect(validateRemoteMcpUrl("http://example.com/")).rejects.toThrow(
            /HTTPS/,
        );
    });

    it("rejects invalid URLs", async () => {
        await expect(validateRemoteMcpUrl("not a url")).rejects.toThrow(
            /valid URL/,
        );
    });

    it("rejects localhost and metadata hosts without a DNS lookup", async () => {
        for (const host of [
            "https://localhost/",
            "https://foo.localhost/",
            "https://metadata.google.internal/",
            "https://instance-data/",
        ]) {
            await expect(validateRemoteMcpUrl(host), host).rejects.toThrow(
                /blocked host/,
            );
        }
        expect(lookupMock).not.toHaveBeenCalled();
    });

    it("rejects private IPv4/IPv6 literals without a DNS lookup", async () => {
        for (const host of [
            "https://127.0.0.1/",
            "https://10.0.0.1/",
            "https://169.254.169.254/",
            "https://[::1]/",
            "https://[fd00::1]/",
            "https://[fec0::1]/",
            "https://[ff02::1]/",
            "https://[100::1]/",
            "https://[2001:db8::1]/",
            "https://[3fff::1]/",
            "https://[64:ff9b:1::1]/",
            // IPv4-compatible ::/96 embeds (deprecated per RFC 4291 but still
            // parseable) — `::127.0.0.1` in hex, uncompressed, and dotted forms
            "https://[::7f00:1]/",
            "https://[0:0:0:0:0:0:7f00:1]/",
            "https://[::10.0.0.1]/",
        ]) {
            await expect(validateRemoteMcpUrl(host), host).rejects.toThrow(
                /blocked network address/,
            );
        }
        expect(lookupMock).not.toHaveBeenCalled();
    });

    it("rejects a hostname that resolves to a private address", async () => {
        resolvesTo("10.0.0.5");
        await expect(
            validateRemoteMcpUrl("https://rebind.example.com/"),
        ).rejects.toThrow(/blocked network address/);
    });

    it("rejects when ANY resolved address is private (mixed record set)", async () => {
        resolvesTo("93.184.216.34", "192.168.1.1");
        await expect(
            validateRemoteMcpUrl("https://mixed.example.com/"),
        ).rejects.toThrow(/blocked network address/);
    });

    it("accepts a public host and strips credentials/hash", async () => {
        resolvesTo("93.184.216.34");
        const out = await validateRemoteMcpUrl(
            "https://user:secret@public.example.com/path?q=1#frag",
        );
        expect(out).toBe("https://public.example.com/path?q=1");
        expect(out).not.toContain("secret");
        expect(out).not.toContain("frag");
    });
});

describe("guardedFetch", () => {
    it("throws and never calls fetch when the URL fails validation", async () => {
        resolvesTo("10.0.0.5");
        const fetchSpy = vi.spyOn(globalThis, "fetch");
        await expect(
            guardedFetch("https://rebind.example.com/"),
        ).rejects.toThrow(/blocked network address/);
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("reuses a pinned dispatcher and disables redirects for public hosts", async () => {
        resolvesTo("93.184.216.34");
        const fetchSpy = vi
            .spyOn(globalThis, "fetch")
            .mockResolvedValue(new Response("ok", { status: 200 }));

        const res = await guardedFetch("https://public.example.com/x", {
            method: "GET",
        });
        expect(res.status).toBe(200);
        expect(fetchSpy).toHaveBeenCalledTimes(1);

        const init = fetchSpy.mock.calls[0][1] as RequestInit & {
            dispatcher?: unknown;
        };
        expect(init.redirect).toBe("manual");
        expect(init.dispatcher).toBeInstanceOf(Agent);
        // Original request options are preserved.
        expect(init.method).toBe("GET");

        await guardedFetch("https://public.example.com/y");
        const nextInit = fetchSpy.mock.calls[1][1] as RequestInit & {
            dispatcher?: unknown;
        };
        expect(nextInit.dispatcher).toBe(init.dispatcher);
    });
});

describe("mcpOAuthCallbackUrl", () => {
    it("routes provider callbacks through the public same-origin gateway", () => {
        process.env.NODE_ENV = "production";
        process.env.API_PUBLIC_URL = "https://app.example.test/api/";

        expect(mcpOAuthCallbackUrl()).toBe(
            "https://app.example.test/api/user/mcp-connectors/oauth/callback",
        );
    });

    it("does not fall back to an internal production host", () => {
        process.env.NODE_ENV = "production";
        delete process.env.API_PUBLIC_URL;
        delete process.env.BACKEND_URL;

        expect(() => mcpOAuthCallbackUrl()).toThrow(
            /API_PUBLIC_URL is required/,
        );
    });
});

describe("guardedFetch redirect following", () => {
    function redirectTo(location: string, status = 302) {
        return new Response(null, { status, headers: { location } });
    }

    it("follows a redirect and returns the final response", async () => {
        resolvesTo("93.184.216.34");
        const fetchSpy = vi
            .spyOn(globalThis, "fetch")
            .mockResolvedValueOnce(
                redirectTo("https://public.example.com/mcp/.well-known/x"),
            )
            .mockResolvedValueOnce(new Response("{}", { status: 200 }));

        const res = await guardedFetch(
            "https://public.example.com/.well-known/x/mcp",
        );

        expect(res.status).toBe(200);
        expect(fetchSpy).toHaveBeenCalledTimes(2);
        expect(fetchSpy.mock.calls[1][0]).toBe(
            "https://public.example.com/mcp/.well-known/x",
        );
    });

    it("resolves a relative Location against the current URL", async () => {
        resolvesTo("93.184.216.34");
        const fetchSpy = vi
            .spyOn(globalThis, "fetch")
            .mockResolvedValueOnce(redirectTo("/elsewhere", 307))
            .mockResolvedValueOnce(new Response("{}", { status: 200 }));

        await guardedFetch("https://public.example.com/a/b");

        expect(fetchSpy.mock.calls[1][0]).toBe(
            "https://public.example.com/elsewhere",
        );
    });

    it("re-validates each hop and refuses a redirect to a private address", async () => {
        lookupMock.mockImplementation(async (hostname: string) =>
            hostname === "public.example.com"
                ? [{ address: "93.184.216.34", family: 4 }]
                : [{ address: "169.254.169.254", family: 4 }],
        );
        vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
            redirectTo("https://internal.example.com/latest/meta-data/"),
        );

        await expect(
            guardedFetch("https://public.example.com/mcp"),
        ).rejects.toThrow(/blocked network address/);
    });

    it("drops the Authorization header when the origin changes", async () => {
        resolvesTo("93.184.216.34");
        const fetchSpy = vi
            .spyOn(globalThis, "fetch")
            .mockResolvedValueOnce(redirectTo("https://other.example.com/x"))
            .mockResolvedValueOnce(new Response("{}", { status: 200 }));

        await guardedFetch("https://public.example.com/mcp", {
            headers: { authorization: "Bearer secret", accept: "application/json" },
        });

        const headers = new Headers(
            (fetchSpy.mock.calls[1][1] as RequestInit).headers,
        );
        expect(headers.get("authorization")).toBeNull();
        expect(headers.get("accept")).toBe("application/json");
    });

    it("keeps the Authorization header on a same-origin redirect", async () => {
        resolvesTo("93.184.216.34");
        const fetchSpy = vi
            .spyOn(globalThis, "fetch")
            .mockResolvedValueOnce(redirectTo("https://public.example.com/x"))
            .mockResolvedValueOnce(new Response("{}", { status: 200 }));

        await guardedFetch("https://public.example.com/mcp", {
            headers: { authorization: "Bearer secret" },
        });

        const headers = new Headers(
            (fetchSpy.mock.calls[1][1] as RequestInit).headers,
        );
        expect(headers.get("authorization")).toBe("Bearer secret");
    });

    it("does not follow redirects for non-GET requests", async () => {
        resolvesTo("93.184.216.34");
        const fetchSpy = vi
            .spyOn(globalThis, "fetch")
            .mockResolvedValue(redirectTo("https://public.example.com/x"));

        const res = await guardedFetch("https://public.example.com/mcp", {
            method: "POST",
            body: "{}",
        });

        expect(res.status).toBe(302);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it("stops after the redirect cap instead of looping forever", async () => {
        resolvesTo("93.184.216.34");
        const fetchSpy = vi
            .spyOn(globalThis, "fetch")
            .mockResolvedValue(redirectTo("https://public.example.com/loop"));

        const res = await guardedFetch("https://public.example.com/loop");

        expect(res.status).toBe(302);
        // 1 initial + MAX_MCP_REDIRECTS follows.
        expect(fetchSpy).toHaveBeenCalledTimes(6);
    });
});
