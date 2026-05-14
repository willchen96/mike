import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { chatRouter } from "../../src/routes/chat";
import { projectsRouter } from "../../src/routes/projects";
import { projectChatRouter } from "../../src/routes/projectChat";
import { documentsRouter } from "../../src/routes/documents";
import { tabularRouter } from "../../src/routes/tabular";
import { workflowsRouter } from "../../src/routes/workflows";
import { userRouter } from "../../src/routes/user";
import { downloadsRouter } from "../../src/routes/downloads";

// Permissive limiter so tests are never rate-limited.
const noopLimiter = rateLimit({
  windowMs: 60_000,
  max: 100_000,
  standardHeaders: false,
  legacyHeaders: false,
});

/**
 * Builds an Express app instance that mirrors production middleware but is
 * safe for testing: no listen(), no process.exit(), and no rate limits.
 *
 * Callers are responsible for loading .env.test before calling this (Vitest
 * does so automatically via vitest.config.ts envFile).
 */
export function buildTestApp() {
  const app = express();

  app.disable("x-powered-by");
  app.set("trust proxy", 1);

  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
      hsts: false,
      referrerPolicy: { policy: "no-referrer" },
    })
  );

  app.use(cors({ origin: "*", credentials: true }));
  app.use(noopLimiter);
  app.use(express.json({ limit: "50mb" }));

  app.use("/chat", chatRouter);
  app.use("/projects", projectsRouter);
  app.use("/projects/:projectId/chat", projectChatRouter);
  app.use("/single-documents", documentsRouter);
  app.use("/tabular-review", tabularRouter);
  app.use("/workflows", workflowsRouter);
  app.use("/user", userRouter);
  app.use("/users", userRouter);
  app.use("/download", downloadsRouter);

  app.get("/health", (_req, res) => res.json({ ok: true }));

  return app;
}
