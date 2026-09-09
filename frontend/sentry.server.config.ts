// Next.js Node runtime. SENTRY_DSN is read at container start, not build.
import * as Sentry from "@sentry/nextjs";
import { serverSentryOptions } from "@/app/lib/errorReporting";

Sentry.init(serverSentryOptions("server", process.env));
