import type { Response } from "express";
import { reportError } from "./observability/sentry";

export const INTERNAL_ERROR_CODE = "internal_error";
export const INTERNAL_ERROR_MESSAGE =
  "Something went wrong. Please try again.";

export function sendInternalError(
  res: Response,
  error: unknown,
  status = 500,
): Response {
  const requestId =
    typeof res.locals.requestId === "string" ? res.locals.requestId : null;

  // Every unexpected 5xx the API returns passes through here, which makes it
  // THE place a backend bug becomes a Sentry issue. The request id is the
  // same one the client gets in the response body, so a user report ("I got
  // request_id X") finds the exact event. Report before logging: the console
  // bridge then knows this error is already accounted for.
  reportError(error, {
    tags: {
      component: "http",
      http_status: status,
      request_id: requestId,
      http_method: res.req?.method,
      // The route pattern, not the URL: /projects/:projectId groups as one
      // issue instead of one per project.
      http_route: res.req?.route?.path ?? res.req?.originalUrl?.split("?")[0],
    },
    extra: { path: res.req?.originalUrl },
  });

  console.error("[http/internal-error]", {
    requestId,
    method: res.req?.method,
    path: res.req?.originalUrl,
    error: error,
  });

  return res.status(status).json({
    code: INTERNAL_ERROR_CODE,
    detail: INTERNAL_ERROR_MESSAGE,
    ...(requestId ? { request_id: requestId } : {}),
  });
}
