import type { NextConfig } from "next";

const nextConfig: NextConfig = {
    /* config options here */
    reactCompiler: true,
    turbopack: {
        // Pin Turbopack's workspace root to this directory (frontend/).
        // Without this, Turbopack walks up to the repo root, finds the
        // package-lock.json there (which exists for the Playwright e2e
        // suite — see the "//" comment in ../package.json), picks that
        // as the workspace root, and fails to resolve frontend deps
        // against the empty root node_modules. On Next 16 this triggered
        // an HMR-retry loop that OOM'd the host.
        //
        // `__dirname` works here because Next compiles next.config.ts as
        // CommonJS. Do NOT switch to `import.meta.url` / fileURLToPath —
        // that flips the compiled output into a half-ESM state and breaks
        // config loading with "exports is not defined".
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
    skipTrailingSlashRedirect: true,
};

export default nextConfig;
