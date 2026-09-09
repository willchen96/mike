// Next.js edge runtime (middleware/proxy, if any is ever added).
import * as Sentry from "@sentry/nextjs";
import { serverSentryOptions } from "@/app/lib/errorReporting";

Sentry.init(serverSentryOptions("edge", process.env));
