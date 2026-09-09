import type {
  ErrorRequestHandler,
  NextFunction,
  Request,
  Response,
} from "express";
import {
  INTERNAL_ERROR_CODE,
  INTERNAL_ERROR_MESSAGE,
  sendInternalError,
} from "../lib/httpError";
import { reportMessage } from "../lib/observability/sentry";

type ErrorBody = {
  code?: unknown;
  detail?: unknown;
  request_id?: unknown;
};

export function protectInternalErrorResponses(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const originalJson = res.json.bind(res);

  res.json = ((body?: unknown) => {
    if (res.statusCode < 500) return originalJson(body);

    const requestId =
      typeof res.locals.requestId === "string" ? res.locals.requestId : null;
    const publicBody = {
      code: INTERNAL_ERROR_CODE,
      detail: INTERNAL_ERROR_MESSAGE,
      ...(requestId ? { request_id: requestId } : {}),
    };
    const errorBody =
      body && typeof body === "object" && !Array.isArray(body)
        ? (body as ErrorBody)
        : null;
    const hasUnexpectedFields =
      errorBody &&
      Object.keys(errorBody).some(
        (key) => !["code", "detail", "request_id"].includes(key),
      );
    if (
      errorBody?.code === INTERNAL_ERROR_CODE &&
      errorBody.detail === INTERNAL_ERROR_MESSAGE &&
      !hasUnexpectedFields
    ) {
      return originalJson(publicBody);
    }

    // A handler wrote its own 5xx body instead of going through
    // sendInternalError: still a server failure, still a Sentry event. The
    // detail is the developer's message (never shown to the client), so it
    // is the best title we have.
    reportMessage(
      typeof errorBody?.detail === "string"
        ? errorBody.detail
        : `Unexpected ${res.statusCode} response`,
      {
        tags: {
          component: "http",
          http_status: res.statusCode,
          request_id: requestId,
          http_method: req.method,
          http_route: req.route?.path ?? req.originalUrl.split("?")[0],
        },
        extra: { path: req.originalUrl, body: errorBody ?? body },
        fingerprint: [
          "sanitized-5xx",
          req.method,
          req.route?.path ?? req.originalUrl.split("?")[0],
        ],
      },
    );
    console.error("[http/sanitized-internal-error]", {
      requestId,
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      error: errorBody?.detail ?? body,
    });

    return originalJson(publicBody);
  }) as Response["json"];

  next();
}

/**
 * Final Express error boundary. Route handlers should still return intentional
 * 4xx responses themselves, but an unexpected thrown/rejected error must never
 * fall through to Express's HTML error response (which can include a stack in
 * development).
 */
export const handleUnhandledError: ErrorRequestHandler = (
  error,
  _req,
  res,
  next,
) => {
  if (res.headersSent) {
    next(error);
    return;
  }

  const bodyParserError = error as { status?: unknown; type?: unknown };
  const requestId =
    typeof res.locals.requestId === "string" ? res.locals.requestId : null;
  if (
    bodyParserError.status === 400 &&
    bodyParserError.type === "entity.parse.failed"
  ) {
    res.status(400).json({
      code: "invalid_json",
      detail: "Request body must contain valid JSON.",
      ...(requestId ? { request_id: requestId } : {}),
    });
    return;
  }
  if (
    bodyParserError.status === 413 &&
    bodyParserError.type === "entity.too.large"
  ) {
    res.status(413).json({
      code: "request_too_large",
      detail: "The request body is too large.",
      ...(requestId ? { request_id: requestId } : {}),
    });
    return;
  }

  sendInternalError(res, error);
};
