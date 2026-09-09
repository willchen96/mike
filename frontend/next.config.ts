import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs/config";

const nextConfig: NextConfig = {
    /* config options here */
    reactCompiler: true,
    turbopack: {
        root: __dirname,
    },
    async rewrites() {
        return [
            {
                source: "/sitemap.xml",
                destination: "/api/sitemap/sitemap.xml",
            },
            {
                source: "/sitemap_:slug.xml",
                destination: "/api/sitemap/sitemap_:slug.xml",
            },
        ];
    },
    async redirects() {
        return [
            {
                source: "/account",
                destination: "/settings",
                permanent: true,
            },
            {
                source: "/account/:path*",
                destination: "/settings/:path*",
                permanent: true,
            },
        ];
    },
    skipTrailingSlashRedirect: true,
};

// Sentry's build plugin wires the instrumentation files above into the
// bundle. Source-map upload (readable stack traces in Sentry) only happens
// when SENTRY_AUTH_TOKEN + SENTRY_ORG + SENTRY_PROJECT are present at build
// time; without them the build is unchanged and no maps leave the machine.
const sourceMapUploadConfigured = Boolean(
    process.env.SENTRY_AUTH_TOKEN &&
        process.env.SENTRY_ORG &&
        process.env.SENTRY_PROJECT,
);

export default withSentryConfig(nextConfig, {
    org: process.env.SENTRY_ORG,
    project: process.env.SENTRY_PROJECT,
    authToken: process.env.SENTRY_AUTH_TOKEN,
    silent: !process.env.CI,
    telemetry: false,
    sourcemaps: {
        disable: !sourceMapUploadConfigured,
        // Upload the maps for debugging, then keep them out of the image.
        deleteSourcemapsAfterUpload: true,
    },
    widenClientFileUpload: sourceMapUploadConfigured,
    // Route browser events through this origin so ad blockers that block
    // *.sentry.io do not hide client-side errors. Only applies to sentry.io
    // DSNs; self-hosted or local DSNs post directly.
    tunnelRoute: "/monitoring",
});
