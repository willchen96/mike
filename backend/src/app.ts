import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { chatRouter } from "./routes/chat";
import { wordChatRouter } from "./routes/wordChat";
import { projectsRouter } from "./routes/projects";
import { orgsRouter } from "./routes/orgs";
import { projectChatRouter } from "./routes/projectChat";
import { documentsRouter } from "./routes/documents";
import { libraryRouter } from "./routes/library";
import { tabularRouter } from "./routes/tabular";
import { workflowsRouter } from "./routes/workflows";
import { quickActionsRouter } from "./routes/quickActions";
import { workflowAddonsRouter } from "./routes/workflowAddons";
import { userRouter } from "./routes/user";
import { modelsRouter } from "./routes/models";
import { downloadsRouter } from "./routes/downloads";
import { sourceDocumentsRouter } from "./routes/sourceDocuments";
import { auditRouter } from "./routes/audit";
import { authRouter } from "./routes/auth";
import { uploadSessionsRouter } from "./routes/uploadSessions";
import { manifestPublicKey } from "./lib/manifestSigning";
import {
  handleUnhandledError,
  protectInternalErrorResponses,
} from "./middleware/internalErrorResponse";
import { configuredAllowedOrigins } from "./lib/origins";
import { envInt } from "./lib/runtimeConfig";
import { tagCurrentRequest } from "./lib/observability/sentry";

export const app = express();
const isProduction = process.env.NODE_ENV === "production";

// Ceiling for JSON API requests. File bytes upload directly to object storage;
// only small upload-session manifests and control requests reach Express.
const JSON_BODY_LIMIT = "50mb";

function minutes(value: number): number {
  return value * 60 * 1000;
}

function hours(value: number): number {
  return minutes(value * 60);
}

function makeLimiter(options: {
  windowMs: number;
  max: number;
  message?: string;
  skip?: (req: express.Request) => boolean;
  keyGenerator?: (req: express.Request) => string;
  skipSuccessfulRequests?: boolean;
}) {
  return rateLimit({
    windowMs: options.windowMs,
    max: options.max,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.method === "OPTIONS" || options.skip?.(req) === true,
    keyGenerator: options.keyGenerator,
    skipSuccessfulRequests: options.skipSuccessfulRequests,
    message: {
      detail: options.message ?? "Too many requests. Please try again later.",
    },
  });
}

// The Word tool-result return channel gets its own lane: an edit-heavy turn
// makes one POST per forwarded tool call, and letting those drain the shared
// 300-request budget (per office NAT egress IP) turns a 429 into a full
// tool-deadline stall per call inside a held SSE stream.
const TOOL_RESULT_PATH = "/word-chat/tool-result";

const generalLimiter = makeLimiter({
  windowMs: minutes(envInt("RATE_LIMIT_GENERAL_WINDOW_MINUTES", 15)),
  max: envInt("RATE_LIMIT_GENERAL_MAX", 300),
  // Upload status polling has its own authenticated per-user limiter. Keep it
  // and the dedicated Word tool-result lane out of the shared IP budget.
  skip: (req) =>
    req.path === TOOL_RESULT_PATH ||
    req.path === "/upload-sessions" ||
    req.path.startsWith("/upload-sessions/"),
});

const toolResultLimiter = makeLimiter({
  windowMs: minutes(envInt("RATE_LIMIT_TOOL_RESULT_WINDOW_MINUTES", 15)),
  max: envInt("RATE_LIMIT_TOOL_RESULT_MAX", 2000),
  message: "Too many tool results. Please try again later.",
});

const chatLimiter = makeLimiter({
  windowMs: minutes(envInt("RATE_LIMIT_CHAT_WINDOW_MINUTES", 15)),
  max: envInt("RATE_LIMIT_CHAT_MAX", 30),
  message: "Too many chat requests. Please try again later.",
});

const chatCreateLimiter = makeLimiter({
  windowMs: minutes(envInt("RATE_LIMIT_CHAT_CREATE_WINDOW_MINUTES", 15)),
  max: envInt("RATE_LIMIT_CHAT_CREATE_MAX", 60),
});

const exportLimiter = makeLimiter({
  windowMs: hours(envInt("RATE_LIMIT_EXPORT_WINDOW_HOURS", 1)),
  max: envInt("RATE_LIMIT_EXPORT_MAX", 10),
  message: "Too many export requests. Please try again later.",
});

const workflowImportLimiter = makeLimiter({
  windowMs: hours(envInt("RATE_LIMIT_UPLOAD_WINDOW_HOURS", 1)),
  max: envInt("RATE_LIMIT_UPLOAD_MAX", 50),
  message: "Too many workflow imports. Please try again later.",
});

const dataDeleteLimiter = makeLimiter({
  windowMs: hours(envInt("RATE_LIMIT_DATA_DELETE_WINDOW_HOURS", 1)),
  max: envInt("RATE_LIMIT_DATA_DELETE_MAX", 20),
  message: "Too many data deletion requests. Please try again later.",
});

const authLoginIpLimiter = makeLimiter({
  windowMs: minutes(envInt("RATE_LIMIT_AUTH_LOGIN_WINDOW_MINUTES", 15)),
  max: envInt("RATE_LIMIT_AUTH_LOGIN_MAX", 30),
  message: "Too many login attempts. Please try again later.",
  skipSuccessfulRequests: true,
});

const authLoginAccountLimiter = makeLimiter({
  windowMs: minutes(envInt("RATE_LIMIT_AUTH_ACCOUNT_WINDOW_MINUTES", 15)),
  max: envInt("RATE_LIMIT_AUTH_ACCOUNT_MAX", 10),
  message: "Too many login attempts. Please try again later.",
  skipSuccessfulRequests: true,
  keyGenerator: (req) => {
    const email =
      typeof req.body?.email === "string"
        ? req.body.email.trim().toLowerCase()
        : "";
    if (!email) {
      return `ip:${ipKeyGenerator(
        req.ip ?? req.socket.remoteAddress ?? "unknown",
      )}`;
    }
    return `email:${createHash("sha256").update(email).digest("hex")}`;
  },
});

const authEmailLimiter = makeLimiter({
  windowMs: hours(envInt("RATE_LIMIT_AUTH_EMAIL_WINDOW_HOURS", 1)),
  max: envInt("RATE_LIMIT_AUTH_EMAIL_MAX", 10),
  message: "Too many authentication requests. Please try again later.",
});

const authFlowLimiter = makeLimiter({
  windowMs: minutes(envInt("RATE_LIMIT_AUTH_FLOW_WINDOW_MINUTES", 15)),
  max: envInt("RATE_LIMIT_AUTH_FLOW_MAX", 30),
  message: "Too many authentication requests. Please try again later.",
});

const authMfaLimiter = makeLimiter({
  windowMs: minutes(envInt("RATE_LIMIT_AUTH_MFA_WINDOW_MINUTES", 15)),
  max: envInt("RATE_LIMIT_AUTH_MFA_MAX", 20),
  message: "Too many verification attempts. Please try again later.",
});

app.disable("x-powered-by");
app.set("trust proxy", envInt("TRUST_PROXY_HOPS", 1));
app.use((_req, res, next) => {
  const requestId = randomUUID();
  res.locals.requestId = requestId;
  res.setHeader("X-Request-ID", requestId);
  // Same id on the Sentry event, the response body, and the access log.
  tagCurrentRequest(requestId);
  next();
});
app.use(protectInternalErrorResponses);

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        baseUri: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    hsts: isProduction
      ? {
          maxAge: 15552000,
          includeSubDomains: true,
        }
      : false,
    referrerPolicy: { policy: "no-referrer" },
  }),
);

export { configuredAllowedOrigins } from "./lib/origins";

const allowedOrigins = configuredAllowedOrigins();

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow server-to-server requests (no Origin header) and any
      // explicitly listed origin. A disallowed origin resolves to `false`
      // (cors omits the Access-Control-Allow-Origin header and the browser
      // blocks the response) rather than calling back with an Error —
      // throwing here would propagate to Express's default handler and turn
      // every disallowed cross-origin request, including preflight, into an
      // HTTP 500.
      callback(null, !origin || allowedOrigins.has(origin));
    },
    credentials: true,
    allowedHeaders: ["Authorization", "Content-Type"],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  }),
);

app.use(generalLimiter);

app.post("/auth/login", authLoginIpLimiter);
app.post(["/auth/signup", "/auth/password-reset"], authEmailLimiter);
app.post(["/auth/oauth", "/auth/exchange", "/auth/handoff"], authFlowLimiter);
app.post(
  ["/auth/mfa/verify", "/auth/mfa/challenge-and-verify"],
  authMfaLimiter,
);

app.post("/chat", chatLimiter);
app.post("/word-chat", chatLimiter);
// Own limiter lane plus a tight body cap: the largest legitimate payload is
// one live document read, which the backend truncates at 200k characters
// anyway — 2mb leaves headroom for UTF-8 and JSON escaping while keeping the
// global 50mb ceiling out of reach of this endpoint. This parser runs before
// the global one; body-parser skips a request whose body is already parsed,
// so the smaller limit wins for this path.
app.post(TOOL_RESULT_PATH, toolResultLimiter, express.json({ limit: "2mb" }));
app.post("/projects/:projectId/chat", chatLimiter);
app.post("/tabular-review/:reviewId/chat", chatLimiter);
app.post("/tabular-review/:reviewId/generate", chatLimiter);
app.post("/chat/create", chatCreateLimiter);
app.post("/chat/:chatId/generate-title", chatCreateLimiter);
app.post("/workflow-addons/:addonId/import", workflowImportLimiter);
const legacyUploadRemoved = (_req: express.Request, res: express.Response) => {
  res.status(410).json({
    code: "upload_session_required",
    detail: "This upload endpoint has been replaced by /upload-sessions.",
  });
};

// Reject the former multipart endpoints before any body parser or route-level
// body-reading middleware can consume file bytes. Browser clients use the
// direct object-storage upload-session protocol instead.
app.post("/single-documents", legacyUploadRemoved);
app.post("/library/:kind/documents", legacyUploadRemoved);
app.post("/single-documents/:documentId/versions", legacyUploadRemoved);
app.put(
  "/single-documents/:documentId/versions/:versionId/file",
  legacyUploadRemoved,
);
app.post("/projects/:projectId/documents", legacyUploadRemoved);
app.get("/projects/:projectId/export", exportLimiter);
app.get("/user/export", exportLimiter);
app.get("/user/chats/export", exportLimiter);
app.get("/user/tabular-reviews/export", exportLimiter);
app.get("/audit/export", exportLimiter);
// Scheduling an async export costs exactly what the synchronous GETs above
// cost — the same whole-corpus walk, just on a worker — so it shares their
// budget. Deliberately POST-only: the /user/exports/:id poll and its download
// stay on the general limiter, because a client polls every couple of seconds
// while an export builds and a 10/hour budget would lock the user out of an
// export they legitimately scheduled.
app.post("/user/exports", exportLimiter);
app.delete("/user/account", dataDeleteLimiter);
app.delete("/user/chats", dataDeleteLimiter);
app.delete("/user/projects", dataDeleteLimiter);
app.delete("/user/tabular-reviews", dataDeleteLimiter);

app.use(express.json({ limit: JSON_BODY_LIMIT }));

// Body-aware account throttling complements the per-IP login limiter. The key
// is a one-way digest, so email addresses never enter the limiter store.
app.post("/auth/login", authLoginAccountLimiter);

app.use("/auth", authRouter);
app.use("/chat", chatRouter);
app.use("/word-chat", wordChatRouter);
app.use("/models", modelsRouter);
app.use("/projects", projectsRouter);
app.use("/orgs", orgsRouter);
app.use("/projects/:projectId/chat", projectChatRouter);
app.use("/single-documents", documentsRouter);
app.use("/library", libraryRouter);
app.use("/tabular-review", tabularRouter);
app.use("/workflows", workflowsRouter);
app.use("/quick-actions", quickActionsRouter);
app.use("/workflow-addons", workflowAddonsRouter);
app.use("/user", userRouter);
app.use("/users", userRouter);
app.use("/download", downloadsRouter);
app.use("/documents", sourceDocumentsRouter);
app.use("/audit", auditRouter);
app.use("/upload-sessions", uploadSessionsRouter);

app.get("/health", (_req, res) => res.json({ ok: true }));

// Deliberate failure for verifying the error pipeline end to end (a real
// thrown error through the real 500 path, so the Sentry event carries the
// request id the caller sees). Opt-in per deployment: it is an unauthenticated
// way to generate events, so leave it off once the DSN is confirmed working.
if (process.env.SENTRY_ENABLE_TEST_ROUTE === "true") {
  app.get("/observability/sentry-test", () => {
    throw new Error("Sentry backend test error (SENTRY_ENABLE_TEST_ROUTE)");
  });
}

// The Ed25519 public key this deployment signs project export manifests with,
// or null when no key is configured. Deliberately open: whoever checks a
// manifest is usually outside the workspace, and they need to get the key from
// the server rather than trust the copy inside the file they were handed.
app.get("/manifest-signing-key", (_req, res) => {
  try {
    res.json(manifestPublicKey());
  } catch (err) {
    console.error("[manifest-signing-key] failed", err);
    res.status(500).json({
      detail: "Manifest signing key is misconfigured",
    });
  }
});

app.use(handleUnhandledError);
