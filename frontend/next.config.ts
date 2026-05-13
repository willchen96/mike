import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV !== "production";

const nextConfig: NextConfig = {
    /* config options here */
    reactCompiler: true,
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
    skipTrailingSlashRedirect: true,
    async headers() {
        const supabaseOrigin = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
        const apiOrigin = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";

        // These env vars must be set at build time for production CSP to allow
        // API and Supabase traffic. Without them, connect-src degrades to 'self'
        // and all API calls will be blocked by the browser.
        if (!isDev && (!supabaseOrigin || !apiOrigin)) {
            throw new Error(
                "NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_API_BASE_URL must be set at build time for production builds.",
            );
        }

        const allowedConnectSrc = ["'self'", supabaseOrigin, apiOrigin]
            .filter(Boolean)
            .join(" ");

        return [
            {
                source: "/(.*)",
                headers: [
                    {
                        key: "Content-Security-Policy",
                        // 'unsafe-inline' required for Next.js hydration inline scripts.
                        // 'unsafe-eval' only allowed in development (React error overlays).
                        // Tighten to nonce-based CSP when Next.js supports it natively.
                        value: [
                            "default-src 'self'",
                            isDev
                                ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
                                : "script-src 'self' 'unsafe-inline'",
                            "style-src 'self' 'unsafe-inline'",
                            "img-src 'self' data: blob:",
                            "font-src 'self' data:",
                            `connect-src ${allowedConnectSrc}`,
                            "object-src 'none'",
                            "frame-ancestors 'none'",
                        ].join("; "),
                    },
                    {
                        key: "X-Frame-Options",
                        value: "DENY",
                    },
                ],
            },
        ];
    },
};

export default nextConfig;
