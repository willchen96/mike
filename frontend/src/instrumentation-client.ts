// Browser-side Sentry bootstrap. Next.js loads this file before any page
// code runs, so errors thrown during hydration are already covered. The
// NEXT_PUBLIC_* references must stay literal: Next inlines them at build
// time, which is also why the DSN is a build argument for the Docker image
// (see frontend/Dockerfile and docs/observability.md).
import * as Sentry from "@sentry/nextjs";
import { browserSentryOptions } from "@/app/lib/errorReporting";

Sentry.init(
    browserSentryOptions({
        dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
        environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT,
        release: process.env.NEXT_PUBLIC_SENTRY_RELEASE,
        tracesSampleRate: process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE,
        nodeEnv: process.env.NODE_ENV,
    }),
);

// Lets Sentry attribute an error to the client-side navigation it happened in.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
