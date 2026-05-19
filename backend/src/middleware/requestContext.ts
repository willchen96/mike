import { randomUUID } from "crypto";
import type { NextFunction, Request, Response } from "express";
import { logger } from "../lib/logger";

/**
 * Adds a per-request id, an access log line on response close, and a
 * request-scoped logger on `res.locals.log`. The id is taken from the
 * inbound `X-Request-Id` header when present so it can stitch with
 * upstream traces; otherwise a UUID is generated. It's echoed back on
 * the response so a curl user can grep their request out of the logs.
 */
export function requestContext() {
    return (req: Request, res: Response, next: NextFunction) => {
        const inbound = req.header("x-request-id");
        const requestId = inbound && inbound.length <= 200 ? inbound : randomUUID();
        res.setHeader("X-Request-Id", requestId);

        const startNs = process.hrtime.bigint();
        const reqLog = logger.child({ request_id: requestId });
        res.locals.requestId = requestId;
        res.locals.log = reqLog;

        res.on("close", () => {
            const elapsedMs = Number(process.hrtime.bigint() - startNs) / 1e6;
            // route is set by Express after match; fall back to the raw url
            // when the response closed before a route was attached.
            const route = req.route?.path ?? req.originalUrl ?? req.url;
            reqLog.info(
                {
                    method: req.method,
                    route,
                    status: res.statusCode,
                    elapsed_ms: Math.round(elapsedMs),
                    user_id: (res.locals.userId as string | undefined) ?? null,
                },
                "request",
            );
        });

        next();
    };
}
