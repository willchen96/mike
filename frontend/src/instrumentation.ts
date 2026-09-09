// Server-side Sentry bootstrap (Next.js instrumentation hook). Runs once per
// server runtime at boot; `onRequestError` catches errors thrown while
// rendering a route or running a route handler (the /api gateway, sitemaps).
import * as Sentry from "@sentry/nextjs";

export async function register() {
    if (process.env.NEXT_RUNTIME === "nodejs") {
        await import("../sentry.server.config");
    }
    if (process.env.NEXT_RUNTIME === "edge") {
        await import("../sentry.edge.config");
    }
}

export const onRequestError = Sentry.captureRequestError;
