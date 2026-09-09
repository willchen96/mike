import * as Sentry from "@sentry/nextjs";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function backendOrigin() {
    const configuredUrl = process.env.API_BASE_URL?.trim();
    if (!configuredUrl && process.env.NODE_ENV === "production") {
        throw new Error("API_BASE_URL is required at runtime.");
    }

    const backendUrl = new URL(configuredUrl || "http://localhost:3001");
    if (!["http:", "https:"].includes(backendUrl.protocol)) {
        throw new Error("API_BASE_URL must use http or https.");
    }
    return backendUrl.toString().replace(/\/$/, "");
}

type RouteContext = { params: Promise<{ path: string[] }> };

async function proxy(request: NextRequest, context: RouteContext) {
    const { path } = await context.params;
    const requestPath = `/${path.map(encodeURIComponent).join("/")}`;

    try {
        const upstreamUrl = new URL(`${backendOrigin()}${requestPath}`);
        upstreamUrl.search = request.nextUrl.search;

        const headers = new Headers(request.headers);
        headers.delete("host");
        headers.delete("connection");
        headers.delete("content-length");
        headers.set("x-forwarded-host", request.nextUrl.host);
        headers.set(
            "x-forwarded-proto",
            request.nextUrl.protocol.replace(":", ""),
        );

        const init: RequestInit & { duplex?: "half" } = {
            method: request.method,
            headers,
            cache: "no-store",
            redirect: "manual",
        };
        if (request.method !== "GET" && request.method !== "HEAD") {
            init.body = request.body;
            init.duplex = "half";
        }

        const upstream = await fetch(upstreamUrl, init);
        const responseHeaders = new Headers(upstream.headers);
        // Fetch implementations may transparently decompress the response.
        responseHeaders.delete("content-encoding");
        responseHeaders.delete("content-length");

        return new Response(upstream.body, {
            status: upstream.status,
            statusText: upstream.statusText,
            headers: responseHeaders,
        });
    } catch (error) {
        // The backend was unreachable from the Next server: a deployment or
        // network fault rather than an application bug, but the browser only
        // sees a bare 502, so this is the one place it can be diagnosed.
        Sentry.captureException(error, {
            tags: { component: "api-gateway", http_method: request.method },
            extra: { path: requestPath },
        });
        console.error("[api-gateway] upstream request failed", {
            path: requestPath,
            error: error instanceof Error ? error.message : String(error),
        });
        return Response.json(
            { detail: "The API is temporarily unavailable." },
            { status: 502 },
        );
    }
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const OPTIONS = proxy;
